import { createHash } from 'node:crypto';
import { request, type IncomingHttpHeaders } from 'node:http';
import { connect, Server as NetServer, type Socket } from 'node:net';
import type { AssetShare } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AssetShares,
  TunnelError,
  type GuestRequest,
  type GuestRoutes,
  type AssetSharesOptions,
  type Tunnel,
  type TunnelAdapter,
} from './share-listener.ts';

/**
 * The share listener (spec `.ai/specs/2026-11-28-asset-share-link.md` § Mechanism 2–7, § Exposure,
 * § States). A fake tunnel hands the listener's own address back, so every gate decision is made
 * on a real socket. What the shell and the asset files hold is `share-guest-routes.test.ts`.
 */

const ASSET = 'settings-mockup.html';
const TITLE = 'Settings mockup';
const GONE = 'This link is no longer active.';
const WAIT = '/__cezar_share__/wait';
const HOUR = 60 * 60_000;

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}
interface Change {
  projectId: string;
  runId: string;
  share: AssetShare | null;
  ended: string | undefined;
}

/** One request to the listener's port, with the `Host` a tunnel would have sent. No redirects followed. */
function send(port: number, host: string, path: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { host, ...init.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface Held {
  opened: boolean;
  socket: Socket;
  closed: Promise<true>;
}

/** A WebSocket handshake; `opened` if anything but a closed socket comes back. */
function upgrade(port: number, host: string, path: string, cookie?: string): Promise<Held> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    const closed = new Promise<true>((done) => socket.on('close', () => done(true)));
    socket.on('connect', () => {
      const cookieLine = cookie === undefined ? '' : `Cookie: theme=dark; __cezar_share=${cookie}\r\n`;
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${cookieLine}Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    });
    socket.on('data', () => resolve({ opened: true, socket, closed }));
    socket.on('error', () => {});
    socket.on('close', () => resolve({ opened: false, socket, closed }));
  });
}

/** A GET left open on the wire; `opened` once a 200's first bytes (`first`) came back. */
function hold(port: number, host: string, path: string, cookie?: string): Promise<Held> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    const closed = new Promise<true>((done) => socket.on('close', () => done(true)));
    let data = '';
    socket.on('connect', () => {
      const cookieLine = cookie === undefined ? '' : `Cookie: __cezar_share=${cookie}\r\n`;
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${cookieLine}\r\n`);
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!data.includes('\r\n\r\n')) return;
      if (!data.startsWith('HTTP/1.1 200')) {
        socket.destroy();
        resolve({ opened: false, socket, closed });
      } else if (data.includes('first')) {
        resolve({ opened: true, socket, closed });
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => resolve({ opened: false, socket, closed }));
  });
}

class FakeTunnels implements TunnelAdapter {
  started: number[] = [];
  stopped = 0;
  exits: Array<(reason: string) => void> = [];
  fail: Error | null = null;
  /** Held open to keep a start in flight. */
  gate: Promise<void> | null = null;
  origin: (port: number) => string = (port) => `http://127.0.0.1:${port}`;
  /** The signal each start was given. */
  signals: Array<AbortSignal | undefined> = [];
  /** A start that answers only by rejecting once it is aborted, as a killed child would. */
  untilAborted = false;
  stopThrows = false;

  async start(port: number, signal?: AbortSignal): Promise<Tunnel> {
    this.started.push(port);
    this.signals.push(signal);
    if (this.untilAborted) {
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new TunnelError('cloudflared was killed', 'tunnel-failed')), { once: true });
      });
    }
    if (this.gate) await this.gate;
    if (this.fail) throw this.fail;
    return {
      origin: this.origin(port),
      stop: () => {
        this.stopped += 1;
        if (this.stopThrows) throw new Error('stop failed');
      },
      onExit: (listener) => {
        this.exits.push(listener);
      },
    };
  }
}

function expectUncacheable(res: Answer): void {
  expect(res.headers['cache-control']).toBe('private, no-store');
  expect(res.headers['cdn-cache-control']).toBe('no-store');
  expect(res.headers.expires).toBeUndefined();
  expect(res.headers['cloudflare-cdn-cache-control']).toBeUndefined();
  expect(res.headers['surrogate-control']).toBeUndefined();
}

/** `cut` when the answer was torn down before it ended. */
function outcome(port: number, host: string, path: string, cookie: string, onData?: () => void): Promise<'cut' | 'ended'> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host, cookie: `__cezar_share=${cookie}` } }, (res) => {
      res.once('data', () => onData?.());
      res.on('error', () => resolve('cut'));
      res.on('end', () => resolve('ended'));
      res.on('close', () => resolve('cut'));
    });
    req.on('error', () => resolve('cut'));
    req.end();
  });
}

const idOf = (cookie: string): string => createHash('sha256').update(cookie).digest('hex').slice(0, 16);

interface CapturedTimer {
  fire(): void;
  cleared: boolean;
}

/**
 * The timers armed with exactly `ms`, held instead of started: the test fires them itself, so no
 * case waits on a clock. Every other timer stays real. Undone by `vi.restoreAllMocks()`.
 */
function captureTimers(ms: number): CapturedTimer[] {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const held = new Map<object, CapturedTimer>();
  const timers: CapturedTimer[] = [];
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, delay?: number) => {
    if (delay !== ms) return realSet(run, delay);
    const handle = { unref: () => handle, ref: () => handle, hasRef: () => false };
    const timer: CapturedTimer = { fire: run, cleared: false };
    held.set(handle, timer);
    timers.push(timer);
    return handle;
  }) as unknown as typeof setTimeout);
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle?: unknown) => {
    const timer = typeof handle === 'object' && handle !== null ? held.get(handle) : undefined;
    if (timer) timer.cleared = true;
    else realClear(handle as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout);
  return timers;
}

async function refuses(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(true));
  });
}

describe('the share listener', () => {
  let tunnels: FakeTunnels;
  let guestCalls: GuestRequest[];
  let shellCalls: GuestRequest[];
  let assetCalls: Array<{ ctx: GuestRequest; name: string }>;
  let changes: Change[];
  let clock: number | null;
  let shares: AssetShares;
  let extra: AssetShares[];

  let port: number;
  let host: string;
  let joinPath: string;
  let token: string;
  let addresses: number;

  const guestRoutes: GuestRoutes = {
    handle(ctx, req, res) {
      guestCalls.push(ctx);
      if (ctx.path === '/__cezar_share__/unknown') return false;
      if (ctx.path === '/__cezar_share__/half') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('half an answer');
        throw new Error('boom');
      }
      if (ctx.path === '/__cezar_share__/pending') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('first');
        return true;
      }
      if (ctx.path === '/__cezar_share__/ask') {
        const name = new URL(req.url ?? '/', 'http://guest').searchParams.get('name') ?? '';
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ctx.ask(name)));
        return true;
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`guest:${ctx.path}:${ctx.guest?.state}`);
      return true;
    },
    shell(ctx, _req, res) {
      shellCalls.push(ctx);
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`shell:${ctx.viewBase}`);
    },
    asset(ctx, name, _req, res) {
      assetCalls.push({ ctx, name });
      res.writeHead(200, { 'content-type': 'text/plain' });
      // Left open: what Remove and the share's end must cut.
      if (name === 'stream.png') res.write('first');
      else res.end(`asset:${name}`);
    },
  };

  function build(options: Partial<AssetSharesOptions> = {}): AssetShares {
    const built = new AssetShares({
      tunnel: tunnels,
      guestRoutes,
      onChange: (projectId, runId, share, ended) => changes.push({ projectId, runId, share, ended }),
      now: () => clock ?? Date.now(),
      ...options,
    });
    extra.push(built);
    return built;
  }

  beforeEach(() => {
    guestCalls = [];
    shellCalls = [];
    assetCalls = [];
    changes = [];
    clock = null;
    extra = [];
    addresses = 0;
    tunnels = new FakeTunnels();
    shares = build();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const built of extra) built.closeAll();
  });

  const start = (input: Partial<Parameters<AssetShares['start']>[0]> = {}, on: AssetShares = shares) =>
    on.start({ runId: 'r1', projectId: 'p1', asset: ASSET, assetTitle: TITLE, ...input });

  /** A live share on `r1`, with `port`/`host`/`joinPath`/`token` pointing at it. */
  async function open(input: Partial<Parameters<AssetShares['start']>[0]> = {}, on: AssetShares = shares): Promise<AssetShare> {
    const started = await start(input, on);
    if (!started.ok) throw new Error(started.error);
    const url = new URL(started.share.url);
    port = tunnels.started.at(-1)!;
    host = url.host;
    joinPath = url.pathname + url.search;
    token = url.pathname.split('/').at(-1)!;
    return started.share;
  }

  const visitor = (cookie?: string) => ({
    get: (path: string, headers: Record<string, string> = {}): Promise<Answer> =>
      send(port, host, path, { headers: { ...(cookie === undefined ? {} : { cookie: `theme=dark; __cezar_share=${cookie}` }), ...headers } }),
  });

  /** Opens the link as a new browser (its own address, so the join limit never bites) and returns its cookie. */
  async function join(address = `198.51.100.${(addresses += 1)}`): Promise<string> {
    const res = await send(port, host, joinPath, { headers: { 'cf-connecting-ip': address } });
    const cookie = /__cezar_share=([a-f0-9]{64})/.exec(String(res.headers['set-cookie']));
    if (res.status !== 302 || cookie === null) throw new Error(`join answered ${res.status}`);
    return cookie[1]!;
  }

  const ask = async (cookie: string, name = 'Ana'): Promise<{ code?: string; error?: string }> =>
    JSON.parse((await visitor(cookie).get(`/__cezar_share__/ask?name=${encodeURIComponent(name)}`)).body) as { code?: string; error?: string };

  async function waitingGuest(name = 'Ana'): Promise<string> {
    const cookie = await join();
    expect((await ask(cookie, name)).code).toMatch(/^\d{4}$/);
    return cookie;
  }

  async function allowedGuest(name = 'Ana'): Promise<string> {
    const cookie = await waitingGuest(name);
    expect(shares.decide('r1', idOf(cookie), 'allow')).toBe(true);
    return cookie;
  }

  const stateOf = async (cookie: string): Promise<string> => (await visitor(cookie).get('/__cezar_share__/status')).body;

  /** Where an allowed guest's frame reads the asset: what the shell is handed as `viewBase`. */
  async function viewBaseOf(cookie: string): Promise<string> {
    const res = await visitor(cookie).get('/');
    const base = /^shell:(\/__cezar_share__\/a\/[a-f0-9]{64}\/)$/.exec(res.body);
    if (res.status !== 200 || base === null) throw new Error(`the shell answered ${res.status}: ${res.body}`);
    return base[1]!;
  }

  describe('start', () => {
    it('binds 127.0.0.1 on an ephemeral port and hands that port to the tunnel', async () => {
      const listen = vi.spyOn(NetServer.prototype, 'listen');
      await open();
      expect(listen.mock.calls.map((call) => call.slice(0, 2))).toEqual([[0, '127.0.0.1']]);
      expect(tunnels.started).toHaveLength(1);
      expect(await refuses(port)).toBe(false);
    });

    it('gives a link made of the tunnel origin and a 256-bit token, and names the asset', async () => {
      const share = await open();
      expect(share.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/__cezar_share__/join/[a-f0-9]{64}$`));
      expect(share).toMatchObject({ runId: 'r1', asset: ASSET, assetTitle: TITLE, guests: [] });
      expect(Date.parse(share.expiresAt) - Date.parse(share.startedAt)).toBe(8 * HOUR);
    });

    it('mints a different token for every share', async () => {
      await open();
      const first = token;
      shares.stop('r1');
      await open();
      expect(token).not.toBe(first);
    });

    it('answers the live share for the same run and asset', async () => {
      const first = await open();
      const again = await start({ assetTitle: 'Renamed since' });
      expect(again).toEqual({ ok: true, share: first });
      expect(tunnels.started).toHaveLength(1);
      expect(changes).toHaveLength(1);
    });

    it('refuses another asset on the same run until the first is stopped (C9)', async () => {
      const first = await open();
      expect(await start({ asset: 'other.html', assetTitle: 'Other' })).toEqual({ ok: false, status: 409, error: `Already sharing “${TITLE}” — stop it first` });
      expect(shares.get('r1')).toEqual(first);
      expect(tunnels.started).toHaveLength(1);
    });

    it('refuses a fifth share', async () => {
      for (const runId of ['r1', 'r2', 'r3', 'r4']) expect((await start({ runId })).ok).toBe(true);
      expect(await start({ runId: 'r5' })).toMatchObject({ ok: false, status: 409 });
      expect(tunnels.started).toHaveLength(4);
      expect(shares.list().map((entry) => entry.share.runId)).toEqual(['r1', 'r2', 'r3', 'r4']);
      shares.stop('r2');
      expect((await start({ runId: 'r5', projectId: 'p2' })).ok).toBe(true);
      expect(shares.list().at(-1)).toMatchObject({ projectId: 'p2', share: { runId: 'r5' } });
    });

    it('closes the listener and reports the adapter error when the tunnel will not start', async () => {
      tunnels.fail = new TunnelError('cloudflared is not installed', 'no-tunnel', 'brew install cloudflared');
      expect(await start()).toEqual({ ok: false, status: 409, error: 'cloudflared is not installed', code: 'no-tunnel', install: 'brew install cloudflared' });
      expect(await refuses(tunnels.started[0]!)).toBe(true);
      tunnels.fail = new TunnelError('cloudflared exited before printing an address', 'tunnel-failed');
      expect(await start()).toEqual({ ok: false, status: 409, error: 'cloudflared exited before printing an address', code: 'tunnel-failed' });
      expect(await refuses(tunnels.started[1]!)).toBe(true);
      expect(shares.get('r1')).toBeNull();
      expect(changes).toHaveLength(0);
    });

    it('refuses a tunnel that hands back something that is not a web origin', async () => {
      tunnels.origin = () => 'not an origin';
      expect(await start()).toMatchObject({ ok: false, status: 409, code: 'tunnel-failed' });
      expect(tunnels.stopped).toBe(1);
      expect(tunnels.signals[0]!.aborted).toBe(true);
      expect(await refuses(tunnels.started[0]!)).toBe(true);
    });

    it('closes the listener even when the adapter throws while it is being stopped', async () => {
      tunnels.stopThrows = true;
      tunnels.origin = () => 'not an origin';
      expect(await start()).toMatchObject({ ok: false, status: 409, code: 'tunnel-failed' });
      expect(await refuses(tunnels.started[0]!)).toBe(true);

      tunnels.origin = (port) => `http://127.0.0.1:${port}`;
      let release!: () => void;
      tunnels.gate = new Promise((resolve) => (release = resolve));
      const stopped = start();
      await vi.waitFor(() => expect(tunnels.started).toHaveLength(2));
      shares.stop('r1');
      release();
      expect(await stopped).toEqual({ ok: false, status: 409, error: 'Sharing was stopped' });
      expect(await refuses(tunnels.started[1]!)).toBe(true);

      tunnels.gate = null;
      await open();
      expect(shares.stop('r1')).toBe(true);
      expect(await refuses(port)).toBe(true);
      expect(tunnels.stopped).toBe(3);
    });

    it('aborts a start that a stop or a shutdown interrupts, and never one that went live', async () => {
      let release!: () => void;
      tunnels.gate = new Promise((resolve) => (release = resolve));
      const stopped = start();
      await vi.waitFor(() => expect(tunnels.started).toHaveLength(1));
      expect(tunnels.signals[0]!.aborted).toBe(false);
      shares.stop('r1');
      expect(tunnels.signals[0]!.aborted).toBe(true);
      release();
      await stopped;

      tunnels.gate = new Promise((resolve) => (release = resolve));
      const shutDown = start();
      await vi.waitFor(() => expect(tunnels.started).toHaveLength(2));
      shares.closeAll();
      expect(tunnels.signals[1]!.aborted).toBe(true);
      release();
      await shutDown;

      tunnels.gate = null;
      await open();
      expect(tunnels.signals[2]!.aborted).toBe(false);
      shares.stop('r1');
      expect(tunnels.signals[2]!.aborted).toBe(false);

      tunnels.fail = new TunnelError('cloudflared is not installed', 'no-tunnel');
      await start();
      expect(tunnels.signals[3]!.aborted).toBe(true);
    });

    it('answers "stopped" when the adapter gives up on the abort, and leaves no listener', async () => {
      tunnels.untilAborted = true;
      const pending = start();
      await vi.waitFor(() => expect(tunnels.started).toHaveLength(1));
      expect(shares.stop('r1')).toBe(true);
      expect(await pending).toEqual({ ok: false, status: 409, error: 'Sharing was stopped' });
      expect(await refuses(tunnels.started[0]!)).toBe(true);
      expect(shares.stop('r1')).toBe(false);
    });

    it('starts a new share after a stop, instead of answering with the start that was stopped', async () => {
      let release!: () => void;
      tunnels.gate = new Promise((resolve) => (release = resolve));
      const first = start();
      await vi.waitFor(() => expect(tunnels.started).toHaveLength(1));
      shares.stop('r1');
      tunnels.gate = null;
      const again = await start();
      expect(again.ok).toBe(true);
      release();
      expect(await first).toEqual({ ok: false, status: 409, error: 'Sharing was stopped' });
      expect(shares.get('r1')).toEqual(again.ok ? again.share : null);
      expect(tunnels.stopped).toBe(1);

      tunnels.gate = new Promise((resolve) => (release = resolve));
      const other = start({ runId: 'r2' });
      await vi.waitFor(() => expect(tunnels.started).toHaveLength(3));
      shares.stop('r2');
      tunnels.gate = null;
      const elsewhere = await start({ runId: 'r2', asset: 'other.html', assetTitle: 'Other' });
      expect(elsewhere).toMatchObject({ ok: true, share: { asset: 'other.html', assetTitle: 'Other' } });
      release();
      await other;
    });

    it('does not count a share that is over, or a start that was stopped, toward the four', async () => {
      clock = Date.parse('2026-11-27T10:00:00Z');
      for (const runId of ['r1', 'r2', 'r3', 'r4']) expect((await start({ runId })).ok).toBe(true);
      clock += 8 * HOUR;
      expect((await start({ runId: 'r5' })).ok).toBe(true);
      expect(changes.filter((change) => change.ended === 'expired').map((change) => change.runId)).toEqual(['r1', 'r2', 'r3', 'r4']);
      expect(shares.list().map((entry) => entry.share.runId)).toEqual(['r5']);

      const single = build({ max: 1 });
      let release!: () => void;
      tunnels.gate = new Promise((resolve) => (release = resolve));
      const stopped = start({ runId: 'a' }, single);
      await vi.waitFor(() => expect(tunnels.started).toHaveLength(6));
      single.stop('a');
      tunnels.gate = null;
      expect((await start({ runId: 'b' }, single)).ok).toBe(true);
      expect(await start({ runId: 'c' }, single)).toMatchObject({ ok: false, status: 409 });
      release();
      await stopped;
    });

    it('serves nothing while the tunnel is still starting', async () => {
      let release!: () => void;
      tunnels.gate = new Promise((resolve) => (release = resolve));
      const pending = start();
      await vi.waitFor(() => expect(tunnels.started).toHaveLength(1));
      const early = await send(tunnels.started[0]!, `127.0.0.1:${tunnels.started[0]!}`, '/');
      expect(early.status).toBe(403);
      expectUncacheable(early);
      release();
      expect((await pending).ok).toBe(true);
    });

    it('starts one tunnel for two requests that race, and none that outlives a stop or a shutdown', async () => {
      let release!: () => void;
      tunnels.gate = new Promise((resolve) => (release = resolve));
      const first = start();
      const second = start();
      const third = start({ asset: 'other.html', assetTitle: 'Other' });
      expect(await third).toEqual({ ok: false, status: 409, error: `Already sharing “${TITLE}” — stop it first` });
      await vi.waitFor(() => expect(tunnels.started).toHaveLength(1));
      expect(shares.stop('r1')).toBe(true);
      release();
      expect(await first).toEqual({ ok: false, status: 409, error: 'Sharing was stopped' });
      expect(await second).toEqual(await first);
      expect(tunnels.started).toHaveLength(1);
      expect(tunnels.stopped).toBe(1);
      expect(await refuses(tunnels.started[0]!)).toBe(true);
      expect(shares.get('r1')).toBeNull();

      tunnels.gate = new Promise((resolve) => (release = resolve));
      const late = start();
      await vi.waitFor(() => expect(tunnels.started).toHaveLength(2));
      shares.closeAll();
      release();
      expect((await late).ok).toBe(false);
      expect(tunnels.stopped).toBe(2);
      expect(changes).toHaveLength(0);
    });

    it('reports the start with the project, the run and the share', async () => {
      const share = await open();
      expect(changes).toEqual([{ projectId: 'p1', runId: 'r1', share, ended: undefined }]);
      expect(shares.get('r1')).toEqual(share);
      expect(shares.list()).toEqual([{ projectId: 'p1', share }]);
      expect(shares.get('nope')).toBeNull();
    });
  });

  describe('the join link', () => {
    beforeEach(async () => {
      await open();
    });

    it('answers a right token with a per-browser cookie, no referrer, and the waiting page', async () => {
      const res = await send(port, host, joinPath);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(WAIT);
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      const cookies = res.headers['set-cookie']!;
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatch(/^__cezar_share=[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\/$/);
      const again = await send(port, host, joinPath);
      expect(again.headers['set-cookie']![0]).not.toBe(cookies[0]);
    });

    it('marks the cookie Secure when the tunnel is https', async () => {
      shares.stop('r1');
      tunnels.origin = () => 'https://calm-river-12.trycloudflare.com';
      const share = await open();
      expect(share.url.startsWith('https://calm-river-12.trycloudflare.com/__cezar_share__/join/')).toBe(true);
      const res = await send(port, 'calm-river-12.trycloudflare.com', joinPath);
      expect(res.headers['set-cookie']![0]).toMatch(/^__cezar_share=[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\/; Secure$/);
    });

    it.each([
      ['a wrong token of the right length', () => `/__cezar_share__/join/${'0'.repeat(64)}`],
      ['a prefix of the token', () => `/__cezar_share__/join/${token.slice(0, 63)}`],
      ['the token with more after it', () => `/__cezar_share__/join/${token}0`],
      ['the token under another path', () => `/__cezar_share__/join/x/${token}`],
      ['no token', () => '/__cezar_share__/join/'],
      ['the token in another case', () => `/__cezar_share__/join/${token.toUpperCase()}`],
    ])('answers %s with the same 404 as no link at all, and no cookie', async (_label, path) => {
      const res = await send(port, host, path());
      expect(res.status).toBe(404);
      expect(res.body).toBe(GONE);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(shares.get('r1')!.guests).toHaveLength(0);
    });

    it('accepts the token only on a GET', async () => {
      const res = await send(port, host, joinPath, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('ignores a next: there is one page to land on', async () => {
      for (const next of ['/settings', 'https://evil.example/x', '//evil.example/x']) {
        const res = await send(port, host, `/__cezar_share__/join/${token}?next=${encodeURIComponent(next)}`, { headers: { 'cf-connecting-ip': '203.0.113.20' } });
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(WAIT);
      }
    });

    it('keeps the cookie a browser already holds when it opens the link again', async () => {
      const cookie = await waitingGuest();
      shares.decide('r1', idOf(cookie), 'deny');
      const res = await visitor(cookie).get(joinPath);
      expect(res.status).toBe(302);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await stateOf(cookie)).toBe('guest:/__cezar_share__/status:denied');
    });

    it('allows 10 joins a minute per client address, then answers 429', async () => {
      clock = Date.parse('2026-11-27T10:00:00Z');
      const from = (address: string): Promise<Answer> => send(port, host, joinPath, { headers: { 'cf-connecting-ip': address } });
      for (let attempt = 0; attempt < 10; attempt += 1) expect((await from('203.0.113.7')).status).toBe(302);
      const limited = await from('203.0.113.7');
      expect(limited.status).toBe(429);
      expect(limited.headers['set-cookie']).toBeUndefined();
      // A wrong token is counted too, and is limited the same way.
      expect((await send(port, host, `/__cezar_share__/join/${'0'.repeat(64)}`, { headers: { 'cf-connecting-ip': '203.0.113.7' } })).status).toBe(429);
      expect((await from('203.0.113.8')).status).toBe(302);
      clock += 61_000;
      expect((await from('203.0.113.7')).status).toBe(302);
    });

    it('limits by the socket address when no tunnel named the client', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) expect((await send(port, host, joinPath)).status).toBe(302);
      expect((await send(port, host, joinPath)).status).toBe(429);
    });
  });

  describe('the gate', () => {
    beforeEach(async () => {
      await open();
    });

    it('refuses a Host that is not the tunnel, even from an allowed browser', async () => {
      const cookie = await allowedGuest();
      for (const wrong of [`evil.example:${port}`, `localhost:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`]) {
        const res = await visitor(cookie).get('/', { host: wrong });
        expect(res.status).toBe(403);
        expect((await send(port, wrong, joinPath)).status).toBe(403);
      }
    });

    it('answers a browser with no cookie, or one it never issued, with a plain 404', async () => {
      for (const who of [visitor(), visitor('f'.repeat(64)), visitor('not-a-cookie')]) {
        for (const path of ['/', '/src/main.ts', '/@fs/etc/passwd', WAIT, '/__cezar_share__/comments', '/__cezar_share__']) {
          const res = await who.get(path);
          expect(res.status).toBe(404);
          expect(res.body).toBe(GONE);
        }
      }
      expect(guestCalls).toHaveLength(0);
    });

    it('gives a browser that joined but has not asked nothing of the asset', async () => {
      const cookie = await join();
      const res = await visitor(cookie).get('/settings');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(WAIT);
      expect(await stateOf(cookie)).toBe('guest:/__cezar_share__/status:new');
    });

    it('gives a waiting browser nothing of the asset', async () => {
      const waiting = visitor(await waitingGuest());
      const res = await waiting.get('/');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/__cezar_share__/wait');
      expect((await waiting.get('/src/main.ts', { 'x-requested-with': 'fetch' })).status).toBe(302);
      expect((await send(port, host, '/api/save', { method: 'POST', headers: { cookie: `__cezar_share=${await waitingGuest('Piotr')}` } })).status).toBe(302);
    });

    it('gives an allowed browser the shell at / and nothing at any other path', async () => {
      const cookie = await allowedGuest();
      const page = await visitor(cookie).get('/');
      expect(page.status).toBe(200);
      expect(page.body).toMatch(/^shell:\/__cezar_share__\/a\/[a-f0-9]{64}\/$/);
      expect(shellCalls).toHaveLength(1);
      expect(shellCalls[0]).toMatchObject({ runId: 'r1', projectId: 'p1', asset: ASSET, assetTitle: TITLE, guest: { id: idOf(cookie), state: 'allowed', name: 'Ana' } });
      expect((await visitor(cookie).get('/?x=1')).status).toBe(200);
      for (const path of ['/settings', '/index.html', '/src/main.ts', '/@fs/etc/passwd', `/${ASSET}`, '//']) {
        const res = await visitor(cookie).get(path);
        expect(res.status, path).toBe(404);
        expect(res.body).toBe(GONE);
      }
      expect((await send(port, host, '/', { method: 'POST', headers: { cookie: `__cezar_share=${cookie}` } })).status).toBe(404);
      expect(shellCalls).toHaveLength(2);
    });

    describe('asset files (C14)', () => {
      it('are served under an allowed guest’s view key, with no cookie at all', async () => {
        const cookie = await allowedGuest();
        const view = await viewBaseOf(cookie);
        const page = await send(port, host, `${view}${ASSET}`);
        expect(page.status).toBe(200);
        expect(page.body).toBe(`asset:${ASSET}`);
        expect((await send(port, host, `${view}shots/a.png?v=2`)).body).toBe('asset:shots/a.png');
        expect(assetCalls.map((call) => call.name)).toEqual([ASSET, 'shots/a.png']);
        expect(assetCalls[0]!.ctx).toMatchObject({ runId: 'r1', projectId: 'p1', asset: ASSET, viewBase: view, tunnelOrigin: `http://${host}`, guest: { id: idOf(cookie), state: 'allowed' } });
        expect(JSON.stringify(assetCalls)).not.toContain(cookie);
        expect(JSON.stringify(assetCalls)).not.toContain(token);
      });

      it('mints a different 256-bit key for every guest, and none before the Allow', async () => {
        const waiting = await waitingGuest('Ola');
        const first = await viewBaseOf(await allowedGuest('Ana'));
        const second = await viewBaseOf(await allowedGuest('Piotr'));
        expect(first).not.toBe(second);
        expect(guestCalls.every((ctx) => ctx.viewBase === undefined)).toBe(true);
        expect(shares.decide('r1', idOf(waiting), 'allow')).toBe(true);
        expect(await viewBaseOf(waiting)).toMatch(/^\/__cezar_share__\/a\/[a-f0-9]{64}\/$/);
      });

      it.each([
        ['a key nobody was given', () => `/__cezar_share__/a/${'0'.repeat(64)}/${ASSET}`],
        ['the link token used as a key', () => `/__cezar_share__/a/${token}/${ASSET}`],
        ['no key', () => `/__cezar_share__/a/${ASSET}`],
        ['nothing after the prefix', () => '/__cezar_share__/a/'],
      ])('answer %s with the plain 404, even from an allowed browser', async (_label, path) => {
        const cookie = await allowedGuest();
        for (const who of [visitor(), visitor(cookie)]) {
          const res = await who.get(path());
          expect(res.status).toBe(404);
          expect(res.body).toBe(GONE);
        }
        expect(assetCalls).toHaveLength(0);
      });

      it('answer a guest’s own cookie value used as a key with 404: the key is not the cookie', async () => {
        const cookie = await allowedGuest();
        expect((await send(port, host, `/__cezar_share__/a/${cookie}/${ASSET}`)).status).toBe(404);
        expect((await send(port, host, `/__cezar_share__/a/${idOf(cookie)}/${ASSET}`)).status).toBe(404);
        expect(assetCalls).toHaveLength(0);
      });

      it.each([
        ['a parent path', '../secrets.txt'],
        ['an encoded parent path', '%2e%2e/secrets.txt'],
        ['an encoded slash', 'shots%2Fa.png'],
        ['a dot file', '.env'],
        ['a kept version', '.versions/1/mockup.html'],
        ['two folders down', 'a/b/c.png'],
        ['no name', ''],
        ['a folder', 'shots/'],
      ])('never hand the routes %s, under a valid key', async (_label, name) => {
        const view = await viewBaseOf(await allowedGuest());
        // A raw socket: a client library would fold `..` before it left.
        const res = await send(port, host, `${view}${name}`);
        expect(res.status).toBe(404);
        expect(res.body).toBe(GONE);
        expect(assetCalls).toHaveLength(0);
      });

      it('answer only a GET', async () => {
        const view = await viewBaseOf(await allowedGuest());
        for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
          expect((await send(port, host, `${view}${ASSET}`, { method })).status, method).toBe(404);
        }
        expect(assetCalls).toHaveLength(0);
      });

      it('refuse a Host that is not the tunnel', async () => {
        const view = await viewBaseOf(await allowedGuest());
        expect((await send(port, 'evil.example', `${view}${ASSET}`)).status).toBe(403);
        expect(assetCalls).toHaveLength(0);
      });

      it('die with the share', async () => {
        const view = await viewBaseOf(await allowedGuest());
        shares.stop('r1');
        await open();
        const res = await send(port, host, `${view}${ASSET}`);
        expect(res.status).toBe(404);
        expect(res.body).toBe(GONE);
        expect(assetCalls).toHaveLength(0);
      });
    });
  });

  describe('a shared cache in front of the gate', () => {
    beforeEach(async () => {
      await open();
    });

    it('is told to keep nothing of any answer the listener gives itself', async () => {
      const waiting = await waitingGuest();
      const allowed = await allowedGuest('Piotr');
      const view = await viewBaseOf(allowed);
      const answers: Array<[number, Answer]> = [
        [404, await visitor().get('/assets/app.js')],
        [200, await visitor(allowed).get('/')],
        [200, await send(port, host, `${view}${ASSET}`)],
        [404, await send(port, host, `/__cezar_share__/a/${'0'.repeat(64)}/${ASSET}`)],
        [403, await visitor(allowed).get('/', { host: 'evil.example' })],
        [400, await visitor(allowed).get('http://127.0.0.1:1/x')],
        [404, await visitor(allowed).get(`/assets/app.js?t=${token}`)],
        [302, await visitor(waiting).get('/assets/app.js')],
        [302, await send(port, host, joinPath, { headers: { 'cf-connecting-ip': '203.0.113.9' } })],
        [404, await send(port, host, `/__cezar_share__/join/${'0'.repeat(64)}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } })],
        [200, await visitor(waiting).get(WAIT)],
        [404, await visitor(waiting).get('/__cezar_share__/unknown')],
      ];
      for (let attempt = 0; attempt < 10; attempt += 1) await send(port, host, joinPath, { headers: { 'cf-connecting-ip': '203.0.113.10' } });
      answers.push([429, await send(port, host, joinPath, { headers: { 'cf-connecting-ip': '203.0.113.10' } })]);
      for (const [status, answer] of answers) {
        expect(answer.status).toBe(status);
        expectUncacheable(answer);
      }
    });
  });

  describe('a failure inside the listener', () => {
    it('answers 500, serves nothing and leaves the cockpit running', async () => {
      let broken = false;
      const fragile = build({
        now: () => {
          if (broken) throw new Error('clock');
          return Date.now();
        },
      });
      await open({}, fragile);
      const cookie = await join();
      await ask(cookie);
      expect(fragile.decide('r1', idOf(cookie), 'allow')).toBe(true);
      const view = await viewBaseOf(cookie);
      const served = shellCalls.length + assetCalls.length;

      broken = true;
      for (const path of ['/', `${view}${ASSET}`]) {
        const failed = await visitor(cookie).get(path);
        expect(failed.status).toBe(500);
        expect(failed.body).toBe('error');
        expectUncacheable(failed);
      }
      expect(shellCalls.length + assetCalls.length).toBe(served);

      broken = false;
      expect((await visitor(cookie).get('/')).status).toBe(200);
    });
  });

  describe('paths under /__cezar_share__/', () => {
    beforeEach(async () => {
      await open();
    });

    it('cut an answer a guest route abandoned by throwing, instead of leaving it open', async () => {
      const cookie = await join();
      expect(await outcome(port, host, '/__cezar_share__/half', cookie)).toBe('cut');
      expect(await stateOf(cookie)).toBe('guest:/__cezar_share__/status:new');
    });

    it('go to the guest routes for any cookie-holder, with the public id and nothing secret', async () => {
      const cookie = await join();
      const res = await visitor(cookie).get(`${WAIT}?x=1`);
      expect(res.status).toBe(200);
      expect(res.body).toBe('guest:/__cezar_share__/wait:new');
      expect(guestCalls).toHaveLength(1);
      expect(guestCalls[0]).toMatchObject({
        runId: 'r1',
        projectId: 'p1',
        path: WAIT,
        tunnelOrigin: `http://${host}`,
        asset: ASSET,
        assetTitle: TITLE,
        guest: { id: idOf(cookie), state: 'new' },
      });
      expect(guestCalls[0]).not.toHaveProperty('viewBase');
      expect(JSON.stringify(guestCalls)).not.toContain(cookie);
      expect(JSON.stringify(guestCalls)).not.toContain(token);
    });

    it('are answered by the guest routes or with 404, even for an allowed browser', async () => {
      const allowed = visitor(await allowedGuest());
      expect((await allowed.get('/__cezar_share__/status')).body).toBe('guest:/__cezar_share__/status:allowed');
      for (const path of ['/__cezar_share__/unknown', '/__cezar_share__/unknown?x=1']) {
        const res = await allowed.get(path);
        expect(res.status).toBe(404);
        expect(res.body).toBe(GONE);
      }
      expect((await allowed.get('/__cezar_share__')).status).toBe(200);
      // A name that only starts like the reserved one is no page of this listener.
      const beside = await allowed.get('/__cezar_share__x');
      expect(beside.status).toBe(404);
      expect(beside.body).toBe(GONE);
    });

    it('answer 404 when the guest routes throw', async () => {
      const throwing = build({
        guestRoutes: {
          ...guestRoutes,
          handle() {
            throw new Error('boom');
          },
        },
      });
      await open({ runId: 'r9' }, throwing);
      const cookie = await join();
      const res = await visitor(cookie).get(WAIT);
      expect(res.status).toBe(404);
    });
  });

  describe('asking to join', () => {
    beforeEach(async () => {
      await open();
    });

    it('lists the request with the public id, the name, a 4-digit code and when it was made', async () => {
      clock = Date.parse('2026-11-27T10:00:00Z');
      const cookie = await join();
      const asked = await ask(cookie, 'Ana');
      expect(asked.code).toMatch(/^\d{4}$/);
      const share = shares.get('r1')!;
      expect(share.guests).toEqual([{ id: idOf(cookie), name: 'Ana', code: asked.code, state: 'waiting', requestedAt: '2026-11-27T10:00:00.000Z' }]);
      expect(changes.at(-1)).toEqual({ projectId: 'p1', runId: 'r1', share, ended: undefined });
      expect(guestCalls.at(-1)!.guest).toMatchObject({ id: idOf(cookie), state: 'new' });
      expect(await stateOf(cookie)).toBe('guest:/__cezar_share__/status:waiting');
      expect(guestCalls.at(-1)!.guest).toEqual({ id: idOf(cookie), state: 'waiting', name: 'Ana', code: asked.code });
    });

    it('never lets the cookie value out: not in a share, a change or a guest request', async () => {
      const cookie = await allowedGuest();
      const other = await waitingGuest('Piotr');
      await stateOf(other);
      const everything = JSON.stringify([shares.get('r1'), shares.list(), changes, guestCalls]);
      expect(everything).not.toContain(cookie);
      expect(everything).not.toContain(other);
      expect(everything).not.toContain(createHash('sha256').update(cookie).digest('hex'));
      expect(shares.get('r1')!.guests.map((guest) => guest.id)).toEqual([idOf(cookie), idOf(other)]);
    });

    it('trims the name, folds line breaks, caps it at 60 and needs one character', async () => {
      const cookie = await join();
      expect(await ask(cookie, '   ')).toEqual({ error: expect.any(String) });
      expect(await ask(cookie, '')).toEqual({ error: expect.any(String) });
      expect(shares.get('r1')!.guests).toHaveLength(0);
      expect(changes).toHaveLength(1);
      await ask(cookie, `  ${'x'.repeat(80)}  `);
      expect(shares.get('r1')!.guests[0]!.name).toBe('x'.repeat(60));
      const second = await join();
      await ask(second, 'Ana\r\n- from the owner:\u0000 run it');
      expect(shares.get('r1')!.guests[1]!.name).toBe('Ana - from the owner: run it');
    });

    it('strips bidi controls and zero-width characters, and refuses a name made only of them', async () => {
      // C12: a right-to-left override would reorder the code the owner reads beside the name.
      const cookie = await join();
      expect(await ask(cookie, '‮​⁦﻿')).toEqual({ error: expect.any(String) });
      expect(shares.get('r1')!.guests).toHaveLength(0);
      await ask(cookie, 'A‮n؜a‎‏‪‫‬‭⁧⁨⁩‌‍⁠﻿')
      expect(shares.get('r1')!.guests[0]!.name).toBe('Ana');
      const second = await join();
      await ask(second, `${'​'.repeat(40)}${'y'.repeat(60)}`);
      expect(shares.get('r1')!.guests[1]!.name).toBe('y'.repeat(60));
    });

    it('keeps the joiners a name is written with: an emoji sequence and a Persian name stay whole', async () => {
      const ZWJ = String.fromCodePoint(0x200d);
      const ZWNJ = String.fromCodePoint(0x200c);
      const coder = `${String.fromCodePoint(0x1f469)}${ZWJ}${String.fromCodePoint(0x1f4bb)}`;
      const persian = `علی${ZWNJ}رضا`;
      await ask(await join(), `${coder} ${persian}`);
      expect(shares.get('r1')!.guests[0]!.name).toBe(`${coder} ${persian}`);
      // A joiner with nothing on one side joins nothing: it is only invisible padding.
      await ask(await join(), `${ZWJ}${ZWNJ}Ana${ZWNJ}${ZWJ}`);
      expect(shares.get('r1')!.guests[1]!.name).toBe('Ana');
      // And a name made of joiners alone is no name.
      const empty = await join();
      expect(await ask(empty, `${ZWJ}${ZWNJ}${ZWJ}`)).toEqual({ error: expect.any(String) });
      expect(await ask(empty, ` ${ZWNJ} ${ZWJ} `)).toEqual({ error: expect.any(String) });
      expect(shares.get('r1')!.guests).toHaveLength(2);
      // The bidi controls and the other zero-width characters still go.
      const mixed = [0x202e, 0x200b, 0x200e, 0x200f, 0x2060, 0xfeff, 0x061c, 0x2066].map((code) => String.fromCodePoint(code)).join('');
      await ask(empty, `P${mixed}iotr`);
      expect(shares.get('r1')!.guests[2]!.name).toBe('Piotr');
    });

    it('keeps the first name and code when a waiting or allowed browser asks again', async () => {
      const cookie = await join();
      const first = await ask(cookie, 'Ana');
      expect(await ask(cookie, 'Somebody else')).toEqual(first);
      shares.decide('r1', idOf(cookie), 'allow');
      const before = changes.length;
      expect(await ask(cookie, 'The owner')).toEqual(first);
      expect(shares.get('r1')!.guests).toMatchObject([{ name: 'Ana', code: first.code, state: 'allowed' }]);
      expect(changes).toHaveLength(before);
    });

    it('lets 5 wait at once and turns the sixth away', async () => {
      for (const name of ['a', 'b', 'c', 'd', 'e']) await waitingGuest(name);
      const sixth = await join();
      expect(await ask(sixth, 'f')).toEqual({ error: expect.any(String) });
      expect(shares.get('r1')!.guests).toHaveLength(5);
      expect(await stateOf(sixth)).toBe('guest:/__cezar_share__/status:new');
      shares.decide('r1', shares.get('r1')!.guests[0]!.id, 'allow');
      expect((await ask(sixth, 'f')).code).toMatch(/^\d{4}$/);
    });

    it('expires a request nobody answered after 10 minutes, and lets that browser ask again', async () => {
      clock = Date.parse('2026-11-27T10:00:00Z');
      const cookie = await waitingGuest();
      clock += 10 * 60_000 - 1;
      expect(shares.get('r1')!.guests).toHaveLength(1);
      clock += 1;
      const before = changes.length;
      expect(await stateOf(cookie)).toBe('guest:/__cezar_share__/status:expired');
      expect(changes).toHaveLength(before + 1);
      expect(changes.at(-1)!.share!.guests).toHaveLength(0);
      expect(shares.decide('r1', idOf(cookie), 'allow')).toBe(false);
      expect((await visitor(cookie).get('/')).headers.location).toBe(WAIT);
      expect((await ask(cookie, 'Ana')).code).toMatch(/^\d{4}$/);
      expect(shares.get('r1')!.guests).toMatchObject([{ state: 'waiting', requestedAt: '2026-11-27T10:10:00.000Z' }]);
    });

    it('expires a request on its own timer and tells the cockpit', async () => {
      const waitingMs = 7_777_001;
      const timers = captureTimers(waitingMs);
      const brief = build({ waitingMs });
      await open({ runId: 'r7' }, brief);
      const cookie = await join();
      await ask(cookie);
      expect(changes.at(-1)).toMatchObject({ runId: 'r7', share: { guests: [{ state: 'waiting' }] } });
      expect(timers).toHaveLength(1);
      // The wall clock has not moved: only the timer can have expired it.
      timers[0]!.fire();
      expect(changes.at(-1)).toMatchObject({ runId: 'r7', share: { guests: [] } });
      expect(await stateOf(cookie)).toBe('guest:/__cezar_share__/status:expired');
    });

    it('does not answer a request that arrives after the share ended', async () => {
      const cookie = await join();
      await stateOf(cookie);
      const held = guestCalls.at(-1)!;
      shares.stop('r1');
      expect(held.ask('Ana')).toEqual({ error: expect.any(String) });
    });
  });

  describe('the owner’s decision', () => {
    beforeEach(async () => {
      await open();
    });

    it('lets in only the browser that was allowed', async () => {
      const ana = await waitingGuest('Ana');
      const piotr = await waitingGuest('Piotr');
      expect(shares.decide('r1', idOf(ana), 'allow')).toBe(true);
      expect(shares.get('r1')!.guests.map((guest) => [guest.name, guest.state])).toEqual([['Ana', 'allowed'], ['Piotr', 'waiting']]);
      expect(changes.at(-1)!.share).toEqual(shares.get('r1'));
      expect((await visitor(ana).get('/')).status).toBe(200);
      expect((await visitor(piotr).get('/')).status).toBe(302);
    });

    it('decides only a request that is waiting on a live share', async () => {
      const cookie = await join();
      expect(shares.decide('r1', idOf(cookie), 'allow')).toBe(false);
      expect(shares.decide('r1', '0'.repeat(16), 'allow')).toBe(false);
      expect(shares.decide('nope', idOf(cookie), 'allow')).toBe(false);
      await ask(cookie);
      expect(shares.decide('r1', idOf(cookie), 'allow')).toBe(true);
      expect(shares.decide('r1', idOf(cookie), 'deny')).toBe(false);
      expect((await visitor(cookie).get('/')).status).toBe(200);
    });

    it('keeps a denied browser refused until the share ends', async () => {
      const cookie = await waitingGuest();
      expect(shares.decide('r1', idOf(cookie), 'deny')).toBe(true);
      expect(shares.get('r1')!.guests).toHaveLength(0);
      expect(changes.at(-1)!.share!.guests).toHaveLength(0);
      expect(await stateOf(cookie)).toBe('guest:/__cezar_share__/status:denied');
      expect(await ask(cookie, 'Ana again')).toEqual({ error: expect.any(String) });
      expect(shares.decide('r1', idOf(cookie), 'allow')).toBe(false);
      const res = await visitor(cookie).get('/');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(WAIT);
      expect(shellCalls).toHaveLength(0);
      // Another browser can still ask.
      expect((await ask(await join(), 'Piotr')).code).toMatch(/^\d{4}$/);
    });

    it('cuts a removed guest off at once: open answers destroyed, the view key dead, the next request refused', async () => {
      const cookie = await allowedGuest();
      const other = await allowedGuest('Piotr');
      const view = await viewBaseOf(cookie);
      const otherView = await viewBaseOf(other);
      const live = await hold(port, host, `${view}stream.png`);
      const kept = await hold(port, host, `${otherView}stream.png`);
      expect(live.opened && kept.opened).toBe(true);
      expect(shares.removeGuest('r1', idOf(cookie))).toBe(true);
      expect(await live.closed).toBe(true);
      expect(shares.get('r1')!.guests.map((guest) => guest.name)).toEqual(['Piotr']);
      expect(changes.at(-1)!.share).toEqual(shares.get('r1'));
      const served = assetCalls.length;
      expect((await visitor(cookie).get('/')).status).toBe(302);
      const dead = await send(port, host, `${view}${ASSET}`);
      expect(dead.status).toBe(404);
      expect(dead.body).toBe(GONE);
      expect(assetCalls).toHaveLength(served);
      expect(await ask(cookie, 'Ana')).toEqual({ error: expect.any(String) });
      expect(kept.socket.destroyed).toBe(false);
      expect((await visitor(other).get('/')).status).toBe(200);
      expect((await send(port, host, `${otherView}${ASSET}`)).status).toBe(200);
      kept.socket.destroy();
      expect(shares.removeGuest('r1', idOf(cookie))).toBe(false);
      expect(shares.removeGuest('nope', idOf(other))).toBe(false);
    });
  });

  describe('a removed guest’s request to the listener’s own pages', () => {
    beforeEach(async () => {
      await open();
    });

    it('is cut like one for the asset, so a write still on its way cannot land', async () => {
      const cookie = await allowedGuest();
      const other = await allowedGuest('Piotr');
      let othersFirstByte = (): void => {};
      const othersStarted = new Promise<void>((resolve) => {
        othersFirstByte = resolve;
      });
      const others = outcome(port, host, '/__cezar_share__/pending', other, othersFirstByte);
      await othersStarted;
      expect(await outcome(port, host, '/__cezar_share__/pending', cookie, () => shares.removeGuest('r1', idOf(cookie)))).toBe('cut');
      // Only the removed guest's: another guest's pending request lasts until the share ends.
      expect(await Promise.race([others, new Promise((resolve) => setTimeout(() => resolve('open'), 50))])).toBe('open');
      shares.stop('r1');
      expect(await others).toBe('cut');
    });
  });

  describe('WebSocket upgrades', () => {
    it('are all destroyed: nothing here speaks WebSocket and nothing is forwarded', async () => {
      await open();
      const cookie = await allowedGuest();
      const view = await viewBaseOf(cookie);
      for (const path of ['/', '/hmr', WAIT, `${view}${ASSET}`]) expect((await upgrade(port, host, path, cookie)).opened).toBe(false);
      expect((await upgrade(port, host, '/hmr')).opened).toBe(false);
      // The share itself is untouched by them.
      expect((await visitor(cookie).get('/')).status).toBe(200);
    });
  });

  describe('Extend (C5)', () => {
    it('extends a live share to a full lifetime from now and keeps the link and guests', async () => {
      const t0 = Date.parse('2026-11-27T10:00:00Z');
      clock = t0;
      const share = await open();
      const allowed = await allowedGuest('Ana');
      clock = t0 + 8 * HOUR - 5 * 60_000;
      const waiting = await waitingGuest('Piotr');
      const denied = await waitingGuest('Ola');
      shares.decide('r1', idOf(denied), 'deny');
      const before = shares.get('r1')!;
      const seen = changes.length;

      clock = t0 + 8 * HOUR - 1;
      const extended = shares.extend('r1')!;
      expect(extended).toEqual({ ...before, expiresAt: new Date(clock + 8 * HOUR).toISOString() });
      expect(extended.url).toBe(share.url);
      expect(extended.startedAt).toBe(share.startedAt);
      expect(changes.slice(seen)).toEqual([{ projectId: 'p1', runId: 'r1', share: extended, ended: undefined }]);

      // Past the old end: the allowed guest still gets the shell, the denied one is still refused.
      clock = t0 + 8 * HOUR + 1;
      expect((await visitor(allowed).get('/')).status).toBe(200);
      expect(await stateOf(denied)).toBe('guest:/__cezar_share__/status:denied');
      expect(await stateOf(waiting)).toBe('guest:/__cezar_share__/status:waiting');
      // A waiting guest keeps its own 10 minutes.
      clock = t0 + 8 * HOUR + 5 * 60_000;
      expect(await stateOf(waiting)).toBe('guest:/__cezar_share__/status:expired');

      clock = Date.parse(extended.expiresAt) - 1;
      expect(shares.get('r1')).not.toBeNull();
      clock += 1;
      expect(shares.get('r1')).toBeNull();
      expect(changes.at(-1)).toEqual({ projectId: 'p1', runId: 'r1', share: null, ended: 'expired' });
    });

    it('keeps the join limit and arms only one lifetime timer', async () => {
      const lifetimeMs = 3_600_001;
      const timers = captureTimers(lifetimeMs);
      clock = Date.parse('2026-11-27T10:00:00Z');
      const brief = build({ lifetimeMs });
      await open({}, brief);
      for (let i = 0; i < 10; i += 1) expect((await send(port, host, joinPath, { headers: { 'cf-connecting-ip': '203.0.113.9' } })).status).toBe(302);
      expect(timers.map((timer) => timer.cleared)).toEqual([false]);
      clock += 500;
      const extended = brief.extend('r1')!;
      expect(extended.expiresAt).toBe(new Date(clock + lifetimeMs).toISOString());
      expect((await send(port, host, joinPath, { headers: { 'cf-connecting-ip': '203.0.113.9' } })).status).toBe(429);
      // The first timer is gone, so the old end cannot end it; exactly one is armed.
      expect(timers.map((timer) => timer.cleared)).toEqual([true, false]);
      expect(brief.get('r1')?.expiresAt).toBe(extended.expiresAt);
      expect(changes.every((change) => change.share !== null)).toBe(true);
      timers[1]!.fire();
      expect(changes.at(-1)).toEqual({ projectId: 'p1', runId: 'r1', share: null, ended: 'expired' });
      expect(tunnels.stopped).toBe(1);
      expect(timers.map((timer) => timer.cleared)).toEqual([true, true]);
    });

    it('never shortens a share and cannot revive an ended one', async () => {
      const t0 = Date.parse('2026-11-27T10:00:00Z');
      clock = t0 + HOUR;
      await open();
      const first = shares.extend('r1')!;
      expect(first.expiresAt).toBe(new Date(t0 + 9 * HOUR).toISOString());
      // A clock stepped back must not pull the end in.
      clock = t0;
      expect(shares.extend('r1')!.expiresAt).toBe(first.expiresAt);
      clock = t0 + HOUR;
      expect(shares.extend('r1')!.expiresAt).toBe(first.expiresAt);

      shares.stop('r1');
      const ended = changes.length;
      expect(shares.extend('r1')).toBeNull();
      expect(shares.get('r1')).toBeNull();
      expect(changes).toHaveLength(ended);

      await open();
      clock = Date.parse(shares.get('r1')!.expiresAt);
      expect(shares.extend('r1')).toBeNull();
      expect(changes.at(-1)).toMatchObject({ share: null, ended: 'expired' });
      expect(shares.extend('nope')).toBeNull();
    });

    it('does not extend a start that is still waiting for its tunnel', async () => {
      let release!: () => void;
      tunnels.gate = new Promise((resolve) => (release = resolve));
      const starting = start();
      await vi.waitFor(() => expect(tunnels.started).toHaveLength(1));
      expect(shares.extend('r1')).toBeNull();
      release();
      tunnels.gate = null;
      expect((await starting).ok).toBe(true);
      expect(changes.filter((change) => change.share !== null)).toHaveLength(1);
    });
  });

  describe('every way a share ends', () => {
    /** A live share with an allowed browser holding an answer open. */
    async function live(on: AssetShares = shares): Promise<{ cookie: string; socket: Held }> {
      await open({}, on);
      const cookie = await join();
      await ask(cookie);
      on.decide('r1', idOf(cookie), 'allow');
      const socket = await hold(port, host, '/__cezar_share__/pending', cookie);
      expect(socket.opened).toBe(true);
      return { cookie, socket };
    }

    async function expectGone(session: { cookie: string; socket: Held }, on: AssetShares, ended: string | undefined): Promise<void> {
      expect(changes.at(-1)).toEqual({ projectId: 'p1', runId: 'r1', share: null, ended });
      expect(on.get('r1')).toBeNull();
      expect(on.list()).toEqual([]);
      expect(tunnels.stopped).toBe(1);
      expect(await session.socket.closed).toBe(true);
      expect(await refuses(port)).toBe(true);
      expect(on.decide('r1', idOf(session.cookie), 'deny')).toBe(false);
    }

    it('Stop sharing', async () => {
      const session = await live();
      expect(shares.stop('r1')).toBe(true);
      await expectGone(session, shares, undefined);
      expect(shares.stop('r1')).toBe(false);
      expect(changes.filter((change) => change.share === null)).toHaveLength(1);
    });

    it('a stop with a reason, as the server gives when the task is archived', async () => {
      const session = await live();
      shares.stop('r1', 'the task was archived');
      await expectGone(session, shares, 'the task was archived');
    });

    it('the lifetime running out', async () => {
      const lifetimeMs = 3_600_002;
      const timers = captureTimers(lifetimeMs);
      const brief = build({ lifetimeMs });
      const session = await live(brief);
      expect(timers).toHaveLength(1);
      expect(brief.get('r1')).not.toBeNull();
      // The wall clock is nowhere near the end: only the timer can have ended it.
      timers[0]!.fire();
      await expectGone(session, brief, 'expired');
    });

    it('the wall clock passing the expiry even when no timer fired', async () => {
      clock = Date.parse('2026-11-27T10:00:00Z');
      const session = await live();
      expect(shares.get('r1')!.expiresAt).toBe('2026-11-27T18:00:00.000Z');
      clock += 8 * HOUR - 1;
      expect((await visitor(session.cookie).get('/')).status).toBe(200);
      clock += 1;
      const seen = shellCalls.length;
      // The request that finds the share over is cut with every other socket: nothing answers any more.
      await expect(visitor(session.cookie).get('/')).rejects.toThrow();
      expect(shellCalls).toHaveLength(seen);
      await expectGone(session, shares, 'expired');
    });

    it('the tunnel exiting', async () => {
      const session = await live();
      tunnels.exits[0]!('exit code 1');
      await expectGone(session, shares, 'cloudflared exited: exit code 1');
      tunnels.exits[0]!('again');
      expect(changes.filter((change) => change.share === null)).toHaveLength(1);
    });

    it('the server shutting down', async () => {
      const session = await live();
      await start({ runId: 'r2', projectId: 'p2' });
      shares.closeAll();
      expect(changes.slice(-2)).toEqual([
        { projectId: 'p1', runId: 'r1', share: null, ended: undefined },
        { projectId: 'p2', runId: 'r2', share: null, ended: undefined },
      ]);
      expect(tunnels.stopped).toBe(2);
      expect(shares.list()).toEqual([]);
      expect(await session.socket.closed).toBe(true);
      expect(await refuses(port)).toBe(true);
    });

    it('leaves nothing of the old share in a new one on the same run', async () => {
      const session = await live();
      const denied = await join();
      await ask(denied, 'Piotr');
      shares.decide('r1', idOf(denied), 'deny');
      const oldToken = token;
      shares.stop('r1');
      await open();
      expect(shares.get('r1')!.guests).toEqual([]);
      for (const cookie of [session.cookie, denied]) {
        const res = await visitor(cookie).get('/');
        expect(res.status).toBe(404);
        expect(res.body).toBe(GONE);
      }
      expect((await send(port, host, `/__cezar_share__/join/${oldToken}`)).status).toBe(404);
    });

    it('survives an onChange that throws', async () => {
      const loud = build({
        onChange: () => {
          throw new Error('boom');
        },
      });
      await open({}, loud);
      const cookie = await join();
      expect((await ask(cookie)).code).toMatch(/^\d{4}$/);
      expect(loud.decide('r1', idOf(cookie), 'allow')).toBe(true);
      expect((await visitor(cookie).get('/')).status).toBe(200);
      expect(loud.stop('r1')).toBe(true);
    });
  });

  describe('what a stranger with the link can grow', () => {
    beforeEach(async () => {
      clock = Date.parse('2026-11-27T10:00:00Z');
      await open();
    });

    it('holds at most 50 browsers that have not asked, dropping the oldest', async () => {
      const first = await join();
      const second = await join();
      const asked = await waitingGuest();
      for (let extraJoin = 0; extraJoin < 48; extraJoin += 1) await join();
      expect(await stateOf(first)).toBe('guest:/__cezar_share__/status:new');
      await join();
      const dropped = await visitor(first).get('/__cezar_share__/status');
      expect(dropped.status).toBe(404);
      expect(dropped.body).toBe(GONE);
      expect(await stateOf(second)).toBe('guest:/__cezar_share__/status:new');
      // A browser that already asked is not what gets dropped.
      expect(await stateOf(asked)).toBe('guest:/__cezar_share__/status:waiting');
    });

    it('holds at most 100 denied browsers, dropping the oldest', async () => {
      const denied: string[] = [];
      for (let index = 0; index < 101; index += 1) {
        const cookie = await waitingGuest(`guest ${index}`);
        expect(shares.decide('r1', idOf(cookie), 'deny')).toBe(true);
        denied.push(cookie);
      }
      expect((await visitor(denied[0]!).get('/__cezar_share__/status')).status).toBe(404);
      expect(await stateOf(denied[1]!)).toBe('guest:/__cezar_share__/status:denied');
      expect(await stateOf(denied[100]!)).toBe('guest:/__cezar_share__/status:denied');
    });

    it('holds at most 1000 addresses in the join limit, and refuses the next until the minute passes', async () => {
      const wrong = `/__cezar_share__/join/${'0'.repeat(64)}`;
      for (let index = 0; index < 1000; index += 1) {
        expect((await send(port, host, wrong, { headers: { 'cf-connecting-ip': `10.0.${index >> 8}.${index & 255}` } })).status).toBe(404);
      }
      const from = (address: string): Promise<Answer> => send(port, host, joinPath, { headers: { 'cf-connecting-ip': address } });
      expect((await from('192.0.2.1')).status).toBe(429);
      // An address already in the table keeps its own allowance.
      expect((await from('10.0.0.0')).status).toBe(302);
      clock! += 61_000;
      expect((await from('192.0.2.1')).status).toBe(302);
    }, 30_000);

    it('keys the join limit on a bounded slice of whatever the client address header says', async () => {
      const long = 'a'.repeat(4000);
      for (let attempt = 0; attempt < 10; attempt += 1) expect((await send(port, host, joinPath, { headers: { 'cf-connecting-ip': long } })).status).toBe(302);
      expect((await send(port, host, joinPath, { headers: { 'cf-connecting-ip': `${'a'.repeat(64)}-other` } })).status).toBe(429);
    });
  });
});
