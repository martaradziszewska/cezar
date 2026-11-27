import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  guestCommentsEventSchema,
  guestCommentsResponseSchema,
  guestCommentsSentResponseSchema,
  liveSharesResponseSchema,
  previewShareErrorSchema,
  previewShareEventSchema,
  previewShareResponseSchema,
  previewShareStateResponseSchema,
  type GuestCommentInput,
  type PreviewShare,
} from '@open-mercato/cezar-contract';
import { createWorktree } from '../git-worktree.ts';
import { runInRelayScope } from '../relay/scope.ts';
import { addGuestComment, readGuestComments, updateGuestComment } from '../runs/guest-comments.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { PreviewShares, TunnelError, type Tunnel, type TunnelAdapter } from './preview/share-listener.ts';
import { guestCommentsFrame, previewShareFrame } from './preview-share-routes.ts';
import { ProjectContexts } from './project-context.ts';
import { createApp } from './server.ts';

/**
 * The cockpit's side of Preview Share (spec `.ai/specs/2026-11-26-preview-share-link.md` § API and
 * contract, § States and their exits). The listener and its gate are `preview/share-listener.test.ts`;
 * under test here is what the routes decide, what reaches the SSE streams, and what ends a share.
 * The share listener is real: a fake tunnel hands its own loopback address back.
 */

const COCKPIT = 'http://localhost:4321';
const BOOT = 'boot';
const OFF = { error: 'Sharing is not available on this cockpit' };
const REMOVED = 'the task was removed';
const exec = promisify(execFile);

class FakeTunnel implements TunnelAdapter {
  started: number[] = [];
  stopped = 0;
  fail: Error | null = null;
  /** What `cloudflared` dying on its own calls. */
  exit: (reason: string) => void = () => {};

  async start(port: number): Promise<Tunnel> {
    this.started.push(port);
    if (this.fail) throw this.fail;
    return {
      origin: `http://127.0.0.1:${port}`,
      stop: () => { this.stopped += 1; },
      onExit: (listener) => { this.exit = listener; },
    };
  }
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** One request a guest's browser would make: the tunnel's `Host` and `Origin`, no redirects followed. */
function asGuest(url: string, init: { method?: string; cookie?: string; json?: unknown } = {}): Promise<Answer> {
  const target = new URL(url);
  const payload = init.json === undefined ? undefined : JSON.stringify(init.json);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: init.method ?? 'GET',
        headers: {
          host: target.host,
          origin: target.origin,
          ...(init.cookie !== undefined ? { cookie: `__cezar_share=${init.cookie}` } : {}),
          ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://localhost:${(server.address() as AddressInfo).port}`));
  });
}

describe('the preview-share API', () => {
  const env = { remote: process.env.CEZ_REMOTE, share: process.env.CEZ_PREVIEW_SHARE, single: process.env.CEZ_SINGLE_PROJECT };
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let tunnel: FakeTunnel;
  let shares: PreviewShares;
  let contexts: ProjectContexts;
  let app: Hono;
  let disposers: Array<() => void>;
  let upstream: Server;
  let upstreamOrigin: string;
  /** A second local server that answers health the way a cezar does. */
  let otherCezar: Server;
  let otherCezarOrigin: string;
  let runId: string;
  let body: { target: string; parentOrigin: string };
  const manager = {
    isActive: () => false,
    cancel: () => true,
    reclaimWorktreesOf: async () => [],
    sweepPrHeadRefs: async () => undefined,
  } as unknown as RunManager;

  const json = (method: string, payload?: unknown): RequestInit => ({
    method,
    ...(payload !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}),
  });
  const api = (path: string, init?: RequestInit) => apiRequest(app, `/api/v1${path}`, init);
  const post = (id: string, payload: unknown = body) => api(`/runs/${id}/preview-share`, json('POST', payload));
  const get = async (id: string) => previewShareStateResponseSchema.parse(await (await api(`/runs/${id}/preview-share`)).json());
  const del = async (id: string) => previewShareStateResponseSchema.parse(await (await api(`/runs/${id}/preview-share`, json('DELETE'))).json());
  const start = async (id = runId): Promise<PreviewShare> => {
    const res = await post(id);
    expect(res.status).toBe(200);
    return previewShareResponseSchema.parse(await res.json()).share;
  };
  /** Opens the link in a new browser and asks to join; `cookie` is that browser's. */
  const joinAs = async (share: PreviewShare, name: string): Promise<{ cookie: string; origin: string }> => {
    const opened = await asGuest(share.url);
    expect(opened.status).toBe(302);
    const cookie = /__cezar_share=([a-f0-9]{64})/.exec(String(opened.headers['set-cookie']))![1]!;
    const origin = new URL(share.url).origin;
    expect((await asGuest(`${origin}/__cezar_share__/ask`, { method: 'POST', cookie, json: { name } })).status).toBe(200);
    return { cookie, origin };
  };
  const comment = (text: string): GuestCommentInput => ({
    url: `${upstreamOrigin}/settings`,
    selector: 'main > button',
    label: 'Save',
    excerpt: '<button>Save</button>',
    body: text,
  });
  const seed = (text: string) => {
    const saved = addGuestComment(dataDir, runId, { ...comment(text), author: 'Ana', guestId: 'a'.repeat(16) });
    if (!saved.ok) throw new Error(saved.reason);
    return saved.comment;
  };

  /** Everything `path` sends from the moment it is subscribed until `done` reads true. */
  const streamed = async (path: string, act: () => Promise<void>, done: (text: string) => boolean): Promise<string> => {
    const controller = new AbortController();
    const res = await api(path, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (ready: () => boolean): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!ready() && Date.now() < deadline) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        text += decoder.decode(value, { stream: true });
      }
    };
    // The first ping is written after the stream's listeners are attached.
    await readUntil(() => text.includes('event: ping'));
    await act();
    await readUntil(() => done(text));
    controller.abort();
    await reader.cancel().catch(() => undefined);
    return text;
  };
  const framesOf = (text: string, event: string): unknown[] =>
    [...text.matchAll(new RegExp(`event: ${event}\\ndata: (.*)\\n`, 'g'))].map((match) => JSON.parse(match[1]!) as unknown);

  beforeEach(async () => {
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_PREVIEW_SHARE;
    delete process.env.CEZ_SINGLE_PROJECT;
    clearProjectProbeCache();
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-share-api-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
    runId = store.createRun({ title: 'Settings page', workflow: 'quick-task', task: 't', steps: [] }).id;
    upstream = createServer((req, res) => {
      if (req.url === '/api/v1/health') res.writeHead(404).end();
      else res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>app</body></html>');
    });
    otherCezar = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: '1.0.0', repoRoot: '/elsewhere', capabilities: {} }));
    });
    upstreamOrigin = await listen(upstream);
    otherCezarOrigin = await listen(otherCezar);
    body = { target: `${upstreamOrigin}/settings`, parentOrigin: COCKPIT };
    tunnel = new FakeTunnel();
    disposers = [];
    contexts = new ProjectContexts({ listProjects });
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      bootProjectId: BOOT,
      contexts,
      onDispose: (cleanup) => disposers.push(cleanup),
      previewShares: (wiring) => (shares = new PreviewShares({ ...wiring, tunnel })),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dispose of disposers) dispose();
    contexts.disposeAll();
    upstream.close();
    upstream.closeAllConnections();
    otherCezar.close();
    otherCezar.closeAllConnections();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    for (const [name, value] of [['CEZ_REMOTE', env.remote], ['CEZ_PREVIEW_SHARE', env.share], ['CEZ_SINGLE_PROJECT', env.single]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('opens nothing until the first share is asked for', () => {
    expect(tunnel.started).toEqual([]);
    expect(shares.list()).toEqual([]);
  });

  describe('the capability', () => {
    it('409s with the reason when sharing is off, and on a hosted cockpit', async () => {
      for (const name of ['CEZ_PREVIEW_SHARE', 'CEZ_REMOTE'] as const) {
        process.env[name] = name === 'CEZ_REMOTE' ? '1' : '0';
        const res = await post(runId);
        expect(res.status, name).toBe(409);
        expect(await res.json(), name).toEqual(OFF);
        delete process.env[name];
      }
      expect(tunnel.started).toEqual([]);
      expect(shares.get(runId)).toBeNull();
    });

    it('409s for a paired phone: a relay request cannot start a public listener', async () => {
      const res = await runInRelayScope({ deviceId: 'phone' }, () => post(runId));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(OFF);
      expect(tunnel.started).toEqual([]);
    });

    it('refuses to let a guest in, or to remove one, once the capability is off', async () => {
      const share = await start();
      await joinAs(share, 'Ana');
      const guest = (await get(runId)).share!.guests[0]!;
      const decide = () => api(`/runs/${runId}/preview-share/guests/${guest.id}`, json('POST', { decision: 'allow' }));
      const remove = () => api(`/runs/${runId}/preview-share/guests/${guest.id}`, json('DELETE'));

      for (const steer of [decide, remove]) {
        process.env.CEZ_PREVIEW_SHARE = '0';
        const off = await steer();
        delete process.env.CEZ_PREVIEW_SHARE;
        expect(off.status).toBe(409);
        expect(await off.json()).toEqual(OFF);
        process.env.CEZ_REMOTE = '1';
        expect((await steer()).status).toBe(409);
        delete process.env.CEZ_REMOTE;
        expect((await runInRelayScope({ deviceId: 'phone' }, steer)).status).toBe(409);
      }
      expect((await get(runId)).share!.guests).toEqual([{ ...guest, state: 'waiting' }]);
    });

    it('still reports, stops and serves comments with the capability off: a live share must be stoppable', async () => {
      await start();
      const saved = seed('Make this green');
      process.env.CEZ_PREVIEW_SHARE = '0';

      expect((await get(runId)).share?.target).toBe(upstreamOrigin);
      expect(guestCommentsResponseSchema.parse(await (await api(`/runs/${runId}/guest-comments`)).json()).comments).toHaveLength(1);
      expect(liveSharesResponseSchema.parse(await (await api('/workspace/preview-shares')).json()).shares).toHaveLength(1);
      const sent = await api(`/runs/${runId}/guest-comments/sent`, json('POST', { comments: [{ id: saved.id, revision: 1 }] }));
      expect(await sent.json()).toEqual({ removed: [saved.id] });
      expect((await del(runId)).share).toBeNull();
      expect(shares.get(runId)).toBeNull();
      expect(tunnel.stopped).toBe(1);
    });
  });

  describe('POST /runs/:id/preview-share', () => {
    it('starts a share, reports it, and stops it', async () => {
      const started = previewShareResponseSchema.parse(await (await post(runId)).json());
      expect(started.share.url).toContain('/__cezar_share__/join/');
      expect(started.share.runId).toBe(runId);
      expect((await get(runId)).share?.target).toBe(upstreamOrigin);
      expect((await del(runId)).share).toBeNull();
      expect(shares.get(runId)).toBeNull();
      expect((await get(runId)).share).toBeNull();
      expect(tunnel.stopped).toBe(1);
      // Idempotent: nothing is live, and the answer is the same.
      expect((await del(runId)).share).toBeNull();
    });

    it('answers the same link for the same target and refuses a second target (C9)', async () => {
      const first = await start();
      expect((await start()).url).toBe(first.url);
      const second = await post(runId, { ...body, target: 'http://localhost:9' });
      expect(second.status).toBe(409);
      expect(Object.keys(previewShareErrorSchema.parse(await second.json()))).toEqual(['error']);
      expect(tunnel.started).toHaveLength(1);
    });

    it('refuses to share this server and any other cezar', async () => {
      const from = (host: string, payload: unknown) =>
        api(`/runs/${runId}/preview-share`, { method: 'POST', headers: { 'content-type': 'application/json', host }, body: JSON.stringify(payload) });
      // The API's own Host, on a port the body's cockpit origin does not name (the Vite dev proxy):
      // only `forbidden`, passed as the design-proxy route passes it, can refuse this one.
      const own = await from('127.0.0.1:4399', { ...body, target: 'http://localhost:4399/x' });
      expect(own.status).toBe(400);
      expect(await own.json()).toEqual({ error: 'Sharing cannot be pointed at cezar itself' });
      // The cockpit's origin from the body, under another loopback spelling.
      const cockpit = await from('127.0.0.1:4399', { ...body, target: 'http://127.0.0.1:4321/x' });
      expect(cockpit.status).toBe(400);
      expect(await cockpit.json()).toEqual({ error: 'Sharing cannot be pointed at cezar itself' });
      // A second cezar on another port: neither origin check sees it, its health answer does (C10).
      const other = await post(runId, { ...body, target: otherCezarOrigin });
      expect(other.status).toBe(400);
      expect(await other.json()).toEqual({ error: 'Sharing cannot be pointed at cezar itself' });
      // Not a local http dev server.
      expect((await post(runId, { ...body, target: 'https://github.com' })).status).toBe(400);

      expect(tunnel.started).toEqual([]);
      expect(shares.get(runId)).toBeNull();
    });

    it('refuses an app that is not answering: it may be a cezar that is still booting (C10)', async () => {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      const res = await post(runId);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: `The app at ${upstreamOrigin} is not answering. Start it, then share.` });
      expect(tunnel.started).toEqual([]);
      expect(shares.get(runId)).toBeNull();
    });

    it('carries the install command when no tunnel binary is found', async () => {
      tunnel.fail = new TunnelError('Sharing needs cloudflared', 'no-tunnel', 'brew install cloudflared');
      const res = await post(runId);
      expect(res.status).toBe(409);
      const answer: unknown = await res.json();
      expect(answer).toMatchObject({ code: 'no-tunnel', install: 'brew install cloudflared' });
      expect(previewShareErrorSchema.parse(answer)).toEqual({ error: 'Sharing needs cloudflared', code: 'no-tunnel', install: 'brew install cloudflared' });
      expect(shares.get(runId)).toBeNull();
    });

    it('says a tunnel that would not start, without an install key', async () => {
      tunnel.fail = new TunnelError('failed to request quick Tunnel', 'tunnel-failed');
      const res = await post(runId);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'failed to request quick Tunnel', code: 'tunnel-failed' });
    });

    it('404s an unknown run, 409s an archived one and 400s a malformed body', async () => {
      expect((await post('no-such-run')).status).toBe(404);
      store.setArchived(runId, true);
      const archived = await post(runId);
      expect(archived.status).toBe(409);
      expect(Object.keys(previewShareErrorSchema.parse(await archived.json()))).toEqual(['error']);
      expect((await post(runId, { target: 5 })).status).toBe(400);
      expect(tunnel.started).toEqual([]);
    });
  });

  describe('guests', () => {
    it('lists a visitor who asked, lets them in, and removes them', async () => {
      const share = await start();
      const { cookie, origin } = await joinAs(share, 'Ana');
      const waiting = (await get(runId)).share!.guests;
      expect(waiting).toEqual([{ id: expect.stringMatching(/^[a-f0-9]{16}$/), name: 'Ana', code: expect.stringMatching(/^\d{4}$/), state: 'waiting', requestedAt: expect.any(String) }]);
      // Nothing of the app before the owner's Allow.
      expect((await asGuest(`${origin}/settings`, { cookie })).status).toBe(302);

      const guest = waiting[0]!;
      const allowed = await api(`/runs/${runId}/preview-share/guests/${guest.id}`, json('POST', { decision: 'allow' }));
      expect(allowed.status).toBe(200);
      expect(previewShareStateResponseSchema.parse(await allowed.json()).share!.guests[0]!.state).toBe('allowed');
      expect((await asGuest(`${origin}/settings`, { cookie })).body).toContain('app');

      const removed = await api(`/runs/${runId}/preview-share/guests/${guest.id}`, json('DELETE'));
      expect(removed.status).toBe(200);
      expect(previewShareStateResponseSchema.parse(await removed.json()).share!.guests).toEqual([]);
      expect((await asGuest(`${origin}/settings`, { cookie })).status).toBe(302);
    });

    it('denies a visitor', async () => {
      const share = await start();
      const { cookie, origin } = await joinAs(share, 'Mallory');
      const guest = (await get(runId)).share!.guests[0]!;
      const denied = await api(`/runs/${runId}/preview-share/guests/${guest.id}`, json('POST', { decision: 'deny' }));
      expect(previewShareStateResponseSchema.parse(await denied.json()).share!.guests).toEqual([]);
      expect(JSON.parse((await asGuest(`${origin}/__cezar_share__/status`, { cookie })).body)).toMatchObject({ state: 'denied' });
    });

    it('404s an unknown guest and 400s a malformed id or decision', async () => {
      await start();
      const unknown = 'f'.repeat(16);
      for (const init of [json('POST', { decision: 'allow' }), json('DELETE')]) {
        const res = await api(`/runs/${runId}/preview-share/guests/${unknown}`, init);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: expect.any(String) });
        expect((await api(`/runs/${runId}/preview-share/guests/NOT-AN-ID`, init)).status).toBe(400);
      }
      expect((await api(`/runs/${runId}/preview-share/guests/${unknown}`, json('POST', { decision: 'maybe' }))).status).toBe(400);
    });
  });

  describe('POST /runs/:id/preview-share/extend', () => {
    const extend = (id: string) => api(`/runs/${id}/preview-share/extend`, json('POST'));

    it('extends a live share, 404s without one, and 409s when sharing is off', async () => {
      expect((await extend('no-such-run')).status).toBe(404);
      const missing = await extend(runId);
      expect(missing.status).toBe(404);
      expect(Object.keys(previewShareErrorSchema.parse(await missing.json()))).toEqual(['error']);

      const share = await start();
      const { cookie, origin } = await joinAs(share, 'Ana');
      const guest = (await get(runId)).share!.guests[0]!;
      await api(`/runs/${runId}/preview-share/guests/${guest.id}`, json('POST', { decision: 'allow' }));

      for (const off of [
        () => { process.env.CEZ_PREVIEW_SHARE = '0'; return extend(runId); },
        () => { process.env.CEZ_REMOTE = '1'; return extend(runId); },
        () => runInRelayScope({ deviceId: 'phone' }, () => extend(runId)),
      ]) {
        const refused = await off();
        delete process.env.CEZ_PREVIEW_SHARE;
        delete process.env.CEZ_REMOTE;
        expect(refused.status).toBe(409);
        expect(await refused.json()).toEqual(OFF);
      }
      expect((await get(runId)).share!.expiresAt).toBe(share.expiresAt);

      const asked = Date.now();
      const res = await extend(runId);
      expect(res.status).toBe(200);
      const extended = previewShareStateResponseSchema.strict().parse(await res.json()).share!;
      expect(Date.parse(extended.expiresAt)).toBeGreaterThanOrEqual(asked + 8 * 60 * 60_000);
      expect(extended).toMatchObject({ url: share.url, startedAt: share.startedAt, guests: [{ ...guest, state: 'allowed' }] });
      expect((await get(runId)).share).toEqual(extended);
      expect((await asGuest(`${origin}/settings`, { cookie })).body).toContain('app');
      expect(tunnel.started).toHaveLength(1);

      await del(runId);
      expect((await extend(runId)).status).toBe(404);
    });

    it('answers the extend route under /api/v1/p/<boot>/ as well', async () => {
      const share = await start();
      const res = await api(`/p/${BOOT}/runs/${runId}/preview-share/extend`, json('POST'));
      expect(res.status).toBe(200);
      expect(previewShareStateResponseSchema.parse(await res.json()).share?.url).toBe(share.url);
      expect((await api(`/p/${BOOT}/runs/no-such-run/preview-share/extend`, json('POST'))).status).toBe(404);
    });
  });

  describe('guest comments', () => {
    it('lists them without the guest id, and publishes the list a deletion leaves', async () => {
      const first = seed('one');
      const second = seed('two');
      const published: unknown[] = [];
      store.on('guest-comments', (payload: unknown) => published.push(payload));

      const listed = guestCommentsResponseSchema.parse(await (await api(`/runs/${runId}/guest-comments`)).json());
      expect(listed.comments.map((c) => c.id)).toEqual([first.id, second.id]);
      expect(Object.keys((await (await api(`/runs/${runId}/guest-comments`)).json() as { comments: object[] }).comments[0]!)).not.toContain('guestId');

      const after = await api(`/runs/${runId}/guest-comments/${first.id}`, json('DELETE'));
      expect(after.status).toBe(200);
      const left = guestCommentsResponseSchema.parse(await after.json());
      expect(left.comments.map((c) => c.id)).toEqual([second.id]);
      expect(published).toEqual([{ runId, comments: left.comments }]);

      // Already gone: the same answer, and nothing to tell anyone.
      expect(guestCommentsResponseSchema.parse(await (await api(`/runs/${runId}/guest-comments/${first.id}`, json('DELETE'))).json())).toEqual(left);
      expect(published).toHaveLength(1);
      expect((await api(`/runs/${runId}/guest-comments/..%2F..%2Fx`, json('DELETE'))).status).toBe(400);
    });

    it('removes only sent comments still at the sent revision', async () => {
      const sent = seed('carried by the review');
      const edited = seed('first words');
      // The guest edited it while the send was in flight.
      expect(updateGuestComment(dataDir, runId, edited.id, 'a'.repeat(16), 'second words').ok).toBe(true);
      const published: unknown[] = [];
      store.on('guest-comments', (payload: unknown) => published.push(payload));

      const res = await api(`/runs/${runId}/guest-comments/sent`, json('POST', { comments: [{ id: sent.id, revision: 1 }, { id: edited.id, revision: 1 }] }));
      expect(res.status).toBe(200);
      expect(guestCommentsSentResponseSchema.parse(await res.json())).toEqual({ removed: [sent.id] });
      expect(readGuestComments(dataDir, runId).map((c) => [c.id, c.revision])).toEqual([[edited.id, 2]]);
      expect(published).toEqual([{ runId, comments: [expect.objectContaining({ id: edited.id, revision: 2, body: 'second words' })] }]);

      // Nothing matched: nothing removed, nothing published.
      const again = await api(`/runs/${runId}/guest-comments/sent`, json('POST', { comments: [{ id: sent.id, revision: 1 }] }));
      expect(await again.json()).toEqual({ removed: [] });
      expect(published).toHaveLength(1);
      expect((await api(`/runs/${runId}/guest-comments/sent`, json('POST', { comments: 'all' }))).status).toBe(400);
    });
  });

  describe('GET /workspace/preview-shares', () => {
    it('lists every live share with its task, and never the link', async () => {
      store.updateRun(runId, { titleSummary: 'Brand the Save button' });
      const share = await start();
      await joinAs(share, 'Ana');
      const res = await api('/workspace/preview-shares');
      const answer = await res.json() as { shares: object[] };
      expect(liveSharesResponseSchema.parse(answer).shares).toEqual([
        { projectId: BOOT, runId, title: 'Brand the Save button', target: upstreamOrigin, expiresAt: share.expiresAt, waiting: 1 },
      ]);
      expect(Object.keys(answer.shares[0]!).sort()).toEqual(['expiresAt', 'projectId', 'runId', 'target', 'title', 'waiting']);
      expect(JSON.stringify(answer)).not.toContain('__cezar_share__');

      await del(runId);
      expect(await (await api('/workspace/preview-shares')).json()).toEqual({ shares: [] });
    });

    it('is workspace-level: not mirrored under a project', async () => {
      expect((await api(`/p/${BOOT}/workspace/preview-shares`)).status).toBe(404);
    });
  });

  it('answers every route under /api/v1/p/<boot>/ as well', async () => {
    const scoped = (path: string, init?: RequestInit) => api(`/p/${BOOT}${path}`, init);
    const started = await scoped(`/runs/${runId}/preview-share`, json('POST', body));
    expect(started.status).toBe(200);
    const share = previewShareResponseSchema.parse(await started.json()).share;
    // One share, whichever spelling asked.
    expect((await get(runId)).share?.url).toBe(share.url);
    expect(previewShareStateResponseSchema.parse(await (await scoped(`/runs/${runId}/preview-share`)).json()).share?.url).toBe(share.url);

    await joinAs(share, 'Ana');
    const guest = (await get(runId)).share!.guests[0]!;
    expect((await scoped(`/runs/${runId}/preview-share/guests/${guest.id}`, json('POST', { decision: 'allow' }))).status).toBe(200);
    expect((await scoped(`/runs/${runId}/preview-share/guests/${guest.id}`, json('DELETE'))).status).toBe(200);

    const saved = seed('one');
    const other = seed('two');
    expect(guestCommentsResponseSchema.parse(await (await scoped(`/runs/${runId}/guest-comments`)).json()).comments).toHaveLength(2);
    expect((await scoped(`/runs/${runId}/guest-comments/${saved.id}`, json('DELETE'))).status).toBe(200);
    expect(await (await scoped(`/runs/${runId}/guest-comments/sent`, json('POST', { comments: [{ id: other.id, revision: 1 }] }))).json()).toEqual({ removed: [other.id] });

    expect(previewShareStateResponseSchema.parse(await (await scoped(`/runs/${runId}/preview-share`, json('DELETE'))).json()).share).toBeNull();
    expect(shares.get(runId)).toBeNull();
  });

  describe('live frames', () => {
    it('match the contract on both streams', () => {
      const share = { runId: 'r1', target: 'http://localhost:5173', url: 'https://x.trycloudflare.com/__cezar_share__/join/t', startedAt: 'a', expiresAt: 'b', guests: [] };
      expect(previewShareEventSchema.parse(previewShareFrame({ runId: 'r1', share }))).toEqual({ type: 'preview-share', runId: 'r1', share });
      expect(previewShareFrame({ runId: 'r1', share: null, ended: 'expired' }, 'proj')).toEqual({ type: 'preview-share', runId: 'r1', share: null, ended: 'expired', project: 'proj' });
      expect(Object.keys(previewShareFrame({ runId: 'r1', share: null }))).toEqual(['type', 'runId', 'share']);
      expect(guestCommentsEventSchema.parse(guestCommentsFrame({ runId: 'r1', comments: [] }))).toEqual({ type: 'guest-comments', runId: 'r1', comments: [] });
      expect(guestCommentsFrame({ runId: 'r1', comments: [] }, 'proj')).toEqual({ type: 'guest-comments', runId: 'r1', comments: [], project: 'proj' });
    });

    /** A guest joins, is let in and saves a comment through the real listener, then the owner stops. */
    const session = async (): Promise<void> => {
      const share = await start();
      const { cookie, origin } = await joinAs(share, 'Ana');
      const guest = (await get(runId)).share!.guests[0]!;
      await api(`/runs/${runId}/preview-share/guests/${guest.id}`, json('POST', { decision: 'allow' }));
      const saved = await asGuest(`${origin}/__cezar_share__/comments`, { method: 'POST', cookie, json: comment('Make this the brand green') });
      expect(saved.status).toBe(201);
      await del(runId);
    };
    const over = (text: string): boolean => /event: preview-share\ndata: [^\n]*"share":null[^\n]*\n/.test(text) && text.includes('event: guest-comments\ndata: ');

    it('sends a preview-share frame and a guest-comments frame on the workspace stream', async () => {
      const text = await streamed('/workspace/events', session, over);
      const shareFrames = framesOf(text, 'preview-share').map((frame) => previewShareEventSchema.parse(frame));
      // Started, asked, allowed, stopped: each frame is the whole current value.
      expect(shareFrames.map((frame) => frame.share?.guests.map((guest) => guest.state) ?? null)).toEqual([[], ['waiting'], ['allowed'], null]);
      expect(shareFrames.every((frame) => frame.project === BOOT && frame.runId === runId)).toBe(true);
      expect(shareFrames[0]!.share!.url).toContain('/__cezar_share__/join/');
      expect(shareFrames.at(-1)).toEqual({ type: 'preview-share', runId, project: BOOT, share: null });

      const commentFrames = framesOf(text, 'guest-comments').map((frame) => guestCommentsEventSchema.parse(frame));
      expect(commentFrames).toEqual([
        { type: 'guest-comments', runId, project: BOOT, comments: [expect.objectContaining({ author: 'Ana', body: 'Make this the brand green', url: `${upstreamOrigin}/settings`, revision: 1 })] },
      ]);
      expect(text).not.toContain('guestId');
    });

    it('sends both frames on the project stream too, without a project', async () => {
      const text = await streamed('/events', session, over);
      const shareFrames = framesOf(text, 'preview-share').map((frame) => previewShareEventSchema.parse(frame));
      expect(shareFrames.map((frame) => frame.share?.guests.map((guest) => guest.state) ?? null)).toEqual([[], ['waiting'], ['allowed'], null]);
      expect(shareFrames.every((frame) => frame.project === undefined && frame.runId === runId)).toBe(true);
      const commentFrames = framesOf(text, 'guest-comments').map((frame) => guestCommentsEventSchema.parse(frame));
      expect(commentFrames).toHaveLength(1);
      expect(commentFrames[0]!.project).toBeUndefined();
      expect(commentFrames[0]!.comments[0]!.body).toBe('Make this the brand green');
    });

    it('unsubscribes both frames when a stream closes', async () => {
      const before = [store.listenerCount('preview-share'), store.listenerCount('guest-comments')];
      for (const path of ['/events', '/workspace/events']) {
        await streamed(path, async () => {
          expect([store.listenerCount('preview-share'), store.listenerCount('guest-comments')]).toEqual([before[0]! + 1, before[1]! + 1]);
        }, () => true);
        await vi.waitFor(() => expect([store.listenerCount('preview-share'), store.listenerCount('guest-comments')]).toEqual(before));
      }
    });

    it('says why a share ended on its own', async () => {
      await start();
      const ended: unknown[] = [];
      store.on('preview-share', (payload: unknown) => ended.push(payload));
      tunnel.exit('exited with code 1');
      expect(ended).toEqual([{ runId, share: null, ended: 'cloudflared exited: exited with code 1' }]);
      expect((await get(runId)).share).toBeNull();
    });
  });

  describe('a share ends with its task', () => {
    let ended: unknown[];
    const live = async (): Promise<void> => {
      await start();
      ended = [];
      store.on('preview-share', (payload: unknown) => ended.push(payload));
    };
    const expectEnded = (): void => {
      expect(shares.get(runId)).toBeNull();
      expect(tunnel.stopped).toBe(1);
      expect(ended).toEqual([{ runId, share: null, ended: REMOVED }]);
    };
    const expectLive = (): void => {
      expect(shares.get(runId)?.target).toBe(upstreamOrigin);
      expect(tunnel.stopped).toBe(0);
      expect(ended).toEqual([]);
    };
    /** Rebuilds the app on a manager whose removals are lifecycle operations: accepted now, done later. */
    const useLifecycle = (): void => {
      const lifecycle = { startRemoval: async () => ({ id: 'op-1' }), requiresGate: async () => false };
      app = createApp({
        repoRoot,
        store,
        manager: { ...manager, lifecycle } as unknown as RunManager,
        version: '0.0.0-test',
        bootProjectId: BOOT,
        contexts,
        onDispose: (cleanup) => disposers.push(cleanup),
        previewShares: (wiring) => (shares = new PreviewShares({ ...wiring, tunnel })),
      });
    };

    it('ends the share when its run is deleted', async () => {
      await live();
      expect((await api(`/runs/${runId}`, json('DELETE'))).status).toBe(200);
      expectEnded();
    });

    it('ends the share when its run is archived', async () => {
      await live();
      expect((await api(`/runs/${runId}/archive`, json('POST', {}))).status).toBe(200);
      expectEnded();
    });

    it('ends the share when the finished-tasks sweep archives its run', async () => {
      store.updateRun(runId, { status: 'done' });
      await live();
      expect(await (await api('/runs/archive-finished', json('POST'))).json()).toEqual({ archived: 1 });
      expectEnded();
    });

    it('ends the share of a variant that lost the pick', async () => {
      const winner = store.createRun({ title: 'A', workflow: 'quick-task', task: 't', steps: [], groupId: 'g1', variant: 'a' }).id;
      const loser = store.createRun({ title: 'B', workflow: 'quick-task', task: 't', steps: [], groupId: 'g1', variant: 'b' }).id;
      for (const id of [winner, loser]) store.updateRun(id, { status: 'done' });
      await start(loser);
      await start(winner);
      expect((await api('/groups/g1/pick', json('POST', { runId: winner }))).status).toBe(200);
      expect(shares.get(loser)).toBeNull();
      // The picked variant is still a task: its link stays.
      expect(shares.get(winner)?.target).toBe(upstreamOrigin);
    });

    it('ends the share when its worktree is removed', async () => {
      store.updateRun(runId, { worktreePath: join(repoRoot, 'gone-tree') });
      await live();
      expect((await api(`/runs/${runId}/remove-worktree`, json('POST'))).status).toBe(200);
      expectEnded();
    });

    it('ends the share, and says so on the stream, when a reclaim takes its worktree', async () => {
      await exec('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
      writeFileSync(join(repoRoot, 'base.txt'), 'base\n');
      await exec('git', ['add', 'base.txt'], { cwd: repoRoot });
      await exec('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
      const tree = await createWorktree(repoRoot, runId, 'main');
      store.updateRun(runId, { status: 'done', worktreePath: tree.path, branch: tree.branch, baseBranch: 'main' });
      await start();

      // The pass "Reclaim now", the hourly retention sweep and the disk guard all run.
      const text = await streamed(
        '/workspace/events',
        async () => {
          const res = await api('/worktrees/reclaim', json('POST', { runIds: [runId] }));
          expect(await res.json()).toEqual({ reclaimed: [runId] });
        },
        (seen) => seen.includes('event: preview-share\n'),
      );
      expect(existsSync(tree.path)).toBe(false);
      expect(store.getRun(runId)?.worktreeReclaimedAt).toBeDefined();
      expect(shares.get(runId)).toBeNull();
      expect(tunnel.stopped).toBe(1);
      expect(framesOf(text, 'preview-share')).toEqual([{ type: 'preview-share', runId, project: BOOT, share: null, ended: REMOVED }]);
    });

    it('ends the share when anything stamps its worktree reclaimed, or drops it', async () => {
      for (const loss of [{ worktreeReclaimedAt: new Date().toISOString() }, { worktreePath: undefined, branch: undefined }]) {
        store.updateRun(runId, { worktreePath: join(repoRoot, 'tree'), worktreeReclaimedAt: undefined });
        await start();
        store.updateRun(runId, loss);
        expect(shares.get(runId), JSON.stringify(loss)).toBeNull();
      }
    });

    it('ends a share started while a lifecycle delete was still running, once the run goes', async () => {
      useLifecycle();
      expect((await api('/worktree-lifecycle/operations', json('POST', { requestId: randomUUID(), runId, intent: 'delete-task' }))).status).toBe(202);
      // Teardown is still running, so the task is still there and can be shared.
      await live();
      store.deleteRun(runId);
      expectEnded();
    });

    it('ends the share when the run is archived or deleted behind the routes', async () => {
      await live();
      store.setArchived(runId, true);
      expectEnded();

      const other = store.createRun({ title: 'Other', workflow: 'quick-task', task: 't', steps: [] }).id;
      await start(other);
      store.deleteRun(other);
      expect(shares.get(other)).toBeNull();
    });

    it('keeps the share through changes that keep the task', async () => {
      store.updateRun(runId, { worktreePath: join(repoRoot, 'tree') });
      await live();
      expect((await api(`/runs/${runId}`, json('PATCH', { title: 'Renamed' }))).status).toBe(200);
      expect((await api(`/runs/${runId}/pin`, json('POST', {}))).status).toBe(200);
      store.updateRun(runId, { status: 'review' });
      store.updateRun(runId, { status: 'done' });
      // Unarchiving is a change too, and not a removal.
      store.setArchived(runId, false);
      expectLive();
    });

    it('keeps a share started on a task whose worktree was already reclaimed', async () => {
      store.updateRun(runId, { worktreePath: join(repoRoot, 'tree'), worktreeReclaimedAt: new Date().toISOString() });
      await live();
      store.updateRun(runId, { status: 'review' });
      expectLive();
    });

    it('ends the share when a lifecycle operation is asked to remove, delete or reclaim its task', async () => {
      useLifecycle();
      for (const intent of ['remove-worktree', 'delete-task', 'reclaim'] as const) {
        await start();
        expect((await api('/worktree-lifecycle/operations', json('POST', { requestId: randomUUID(), runId, intent }))).status, intent).toBe(202);
        expect(shares.get(runId), intent).toBeNull();
      }
    });

    /** A second registered project, opened by its first request, with one finished run. */
    const otherProject = async (use: (other: { id: string; store: RunStore; run: string }) => Promise<void>): Promise<void> => {
      const otherRoot = mkdtempSync(join(tmpdir(), 'cez-share-api-other-'));
      mkdirSync(join(otherRoot, '.ai/cezar'), { recursive: true });
      try {
        const { id } = await registerProject(otherRoot);
        expect((await api(`/p/${id}/runs`)).status).toBe(200);
        const otherStore = contexts.peek(id)!.store;
        const run = otherStore.createRun({ title: 'Elsewhere', workflow: 'quick-task', task: 't', steps: [] }).id;
        // A project with a running task is not removable.
        otherStore.updateRun(run, { status: 'done' });
        await use({ id, store: otherStore, run });
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    };

    it('ends the share when its project is removed from the workspace', async () => {
      await otherProject(async (other) => {
        const published: unknown[] = [];
        other.store.on('preview-share', (payload: unknown) => published.push(payload));

        const started = await api(`/p/${other.id}/runs/${other.run}/preview-share`, json('POST', body));
        expect(started.status).toBe(200);
        // The frame travels on the share's own project, never the boot one.
        expect(published).toHaveLength(1);
        expect(liveSharesResponseSchema.parse(await (await api('/workspace/preview-shares')).json()).shares).toEqual([
          expect.objectContaining({ projectId: other.id, runId: other.run, title: 'Elsewhere' }),
        ]);

        expect((await api(`/projects/${other.id}`, json('DELETE'))).status).toBe(200);
        expect(shares.get(other.run)).toBeNull();
        expect(tunnel.stopped).toBe(1);
        expect(published.at(-1)).toEqual({ runId: other.run, share: null, ended: REMOVED });
      });
    });

    it('watches every project: one opened after the app was built, and one already open', async () => {
      await otherProject(async (other) => {
        const share = () => api(`/p/${other.id}/runs/${other.run}/preview-share`, json('POST', body));
        expect((await share()).status).toBe(200);
        other.store.setArchived(other.run, true);
        expect(shares.get(other.run)).toBeNull();

        // A second app over the same contexts finds this project already open.
        other.store.setArchived(other.run, false);
        useLifecycle();
        expect((await share()).status).toBe(200);
        other.store.deleteRun(other.run);
        expect(shares.get(other.run)).toBeNull();
      });
    });

    it('keeps a share out of reach of another project’s routes: read, stop, extend, allow and remove', async () => {
      await otherProject(async (other) => {
        const share = await start();
        await joinAs(share, 'Ana');
        const guest = (await get(runId)).share!.guests[0]!;
        const elsewhere = (path: string, init?: RequestInit) => api(`/p/${other.id}${path}`, init);

        const read = await elsewhere(`/runs/${runId}/preview-share`);
        expect(read.status).toBe(200);
        expect(await read.json()).toEqual({ share: null });
        expect(await (await elsewhere(`/runs/${runId}/preview-share`, json('DELETE'))).json()).toEqual({ share: null });
        const extended = await elsewhere(`/runs/${runId}/preview-share/extend`, json('POST'));
        expect(extended.status).toBe(404);
        expect(await extended.json()).toEqual({ error: 'This task is not sharing' });
        const allowed = await elsewhere(`/runs/${runId}/preview-share/guests/${guest.id}`, json('POST', { decision: 'allow' }));
        expect(allowed.status).toBe(404);
        expect(await allowed.json()).toEqual({ error: 'That visitor is no longer waiting' });
        const removed = await elsewhere(`/runs/${runId}/preview-share/guests/${guest.id}`, json('DELETE'));
        expect(removed.status).toBe(404);
        expect(await removed.json()).toEqual({ error: 'That visitor is not on this link' });

        // Untouched: still live, same end, the visitor still waiting.
        expect(tunnel.stopped).toBe(0);
        expect((await get(runId)).share).toEqual({ ...share, guests: [guest] });
        // Its own project still steers it, under both spellings.
        expect((await api(`/p/${BOOT}/runs/${runId}/preview-share/guests/${guest.id}`, json('POST', { decision: 'allow' }))).status).toBe(200);

        // The other way round: the other project's share under the boot project's mount.
        expect((await elsewhere(`/runs/${other.run}/preview-share`, json('POST', body))).status).toBe(200);
        expect((await get(other.run)).share).toBeNull();
        expect((await del(other.run)).share).toBeNull();
        expect((await api(`/runs/${other.run}/preview-share/extend`, json('POST'))).status).toBe(404);
        expect(shares.get(other.run)).not.toBeNull();
        expect(previewShareStateResponseSchema.parse(await (await elsewhere(`/runs/${other.run}/preview-share`, json('DELETE'))).json()).share).toBeNull();
        expect(shares.get(other.run)).toBeNull();
        expect(shares.get(runId)).not.toBeNull();
      });
    });

    it('ends only its own project’s share when a store says a task is gone', async () => {
      await otherProject(async (other) => {
        await live();
        // Another project's store naming this run id: not this share's task.
        other.store.emit('deleted', runId);
        other.store.emit('run', { ...store.getRun(runId)!, archived: true });
        expectLive();
        store.emit('deleted', runId);
        expectEnded();
      });
    });

    it('keeps the share when the agent is only stopped: the task is still there', async () => {
      await live();
      await api(`/runs/${runId}/cancel`, json('POST', {}));
      expectLive();
    });

    it('ends every share when the server shuts down', async () => {
      await live();
      for (const dispose of disposers.splice(0)) dispose();
      expect(shares.get(runId)).toBeNull();
      expect(tunnel.stopped).toBe(1);
    });
  });

  it('never logs the link', async () => {
    const logged: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args); });
    }
    const share = await start();
    const token = /\/join\/([a-f0-9]{64})/.exec(share.url)![1]!;
    await joinAs(share, 'Ana');
    await post(runId, { ...body, target: 'http://localhost:9' });
    await api('/workspace/preview-shares');
    await api(`/runs/${runId}`, json('DELETE'));
    expect(JSON.stringify(logged)).not.toContain(token);
  });
});
