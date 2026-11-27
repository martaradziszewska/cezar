import { createHash } from 'node:crypto';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, Server as NetServer, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { PreviewShare } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PreviewShares,
  safeNext,
  TunnelError,
  type CezarVerdict,
  type GuestRequest,
  type GuestRoutes,
  type PreviewSharesOptions,
  type Tunnel,
  type TunnelAdapter,
} from './share-listener.ts';

/**
 * The share listener (spec `.ai/specs/2026-11-26-preview-share-link.md` § Mechanism 2–7, § Exposure,
 * § States). A real loopback server stands in for the task's app and a fake tunnel hands the
 * listener's own address back, so every gate decision is made on a real socket.
 */

const COCKPIT = 'http://localhost:4321';
const GONE = 'This link is no longer active.';
const WAIT = '/__cezar_share__/wait';
const HOUR = 60 * 60_000;

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}
interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}
interface Change {
  projectId: string;
  runId: string;
  share: PreviewShare | null;
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

interface Upgraded {
  opened: boolean;
  socket: Socket;
  closed: Promise<true>;
}

/** A WebSocket handshake; `opened` only when the app's own `hello` came back through the splice. */
function upgrade(port: number, host: string, path: string, cookie?: string): Promise<Upgraded> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    const closed = new Promise<true>((done) => socket.on('close', () => done(true)));
    let data = '';
    socket.on('connect', () => {
      const cookieLine = cookie === undefined ? '' : `Cookie: theme=dark; __cezar_share=${cookie}\r\n`;
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${cookieLine}Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.endsWith('hello')) resolve({ opened: true, socket, closed });
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
  let upstream: Server;
  let app: string;
  let appPort: number;
  let upstreamRequests: Seen[];
  let upstreamUpgrades: number;
  let upgraded: Duplex[];
  /** What `/api/v1/health` on the app answers; `null` leaves it to the app's HTML. */
  let health: unknown;

  let tunnels: FakeTunnels;
  let guestCalls: GuestRequest[];
  let changes: Change[];
  let cezarProbes: string[];
  /** What the fake probe answers; a function is awaited, so a test can hold a probe open. */
  let verdict: CezarVerdict | (() => Promise<CezarVerdict>);
  let clock: number | null;
  let shares: PreviewShares;
  let extra: PreviewShares[];

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
  };

  function build(options: Partial<PreviewSharesOptions> = {}): PreviewShares {
    const built = new PreviewShares({
      tunnel: tunnels,
      guestRoutes,
      isCezar: async (origin) => {
        cezarProbes.push(origin);
        return typeof verdict === 'function' ? verdict() : verdict;
      },
      onChange: (projectId, runId, share, ended) => changes.push({ projectId, runId, share, ended }),
      now: () => clock ?? Date.now(),
      ...options,
    });
    extra.push(built);
    return built;
  }

  beforeEach(async () => {
    upstreamRequests = [];
    upstreamUpgrades = 0;
    upgraded = [];
    health = null;
    guestCalls = [];
    changes = [];
    cezarProbes = [];
    verdict = 'not-cezar';
    clock = null;
    extra = [];
    addresses = 0;
    upstream = createServer((req, res) => {
      upstreamRequests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      if (req.url === '/api/v1/health' && health !== null) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(health));
        return;
      }
      if (req.url === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.headers));
        return;
      }
      if (req.url === '/assets/app.js') {
        res
          .writeHead(200, {
            'content-type': 'application/javascript',
            'cache-control': 'public, max-age=31536000, immutable',
            'cloudflare-cdn-cache-control': 'max-age=600',
            'surrogate-control': 'max-age=600',
            expires: 'Thu, 26 Nov 2037 10:00:00 GMT',
            etag: '"v1"',
          })
          .end('console.log("app")');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html><head><title>t</title></head><body>app</body></html>');
    });
    upstream.on('upgrade', (req, socket) => {
      upstreamUpgrades += 1;
      upstreamRequests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      upgraded.push(socket);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello');
      socket.on('data', () => {});
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    appPort = (upstream.address() as AddressInfo).port;
    app = `http://127.0.0.1:${appPort}`;
    tunnels = new FakeTunnels();
    shares = build();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const built of extra) built.closeAll();
    for (const socket of upgraded) socket.destroy();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  async function stopApp(): Promise<void> {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }

  const startApp = (): Promise<void> => new Promise((resolve) => upstream.listen(appPort, '127.0.0.1', resolve));

  const start = (input: Partial<Parameters<PreviewShares['start']>[0]> = {}, on: PreviewShares = shares) =>
    on.start({ runId: 'r1', projectId: 'p1', target: `${app}/settings?tab=1`, parentOrigin: COCKPIT, forbidden: [], ...input });

  /** A live share on `r1`, with `port`/`host`/`joinPath`/`token` pointing at it. */
  async function open(input: Partial<Parameters<PreviewShares['start']>[0]> = {}, on: PreviewShares = shares): Promise<PreviewShare> {
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

  describe('start', () => {
    it.each([
      ['an external site', 'http://example.com', 'Sharing works on local addresses only'],
      ['a rebinding-shaped hostname', 'http://127.0.0.1.evil.example:3000', 'Sharing works on local addresses only'],
      ['a loopback origin used as userinfo', 'http://localhost:3000@evil.example/', 'Sharing works on local addresses only'],
      ['https', 'https://localhost:3000', 'Sharing works on local http:// addresses'],
      ['a non-http scheme', 'file:///etc/passwd', 'Sharing works on local http:// addresses'],
      ['not an address', 'nope', 'not an address'],
    ])('refuses %s with 400 and opens nothing', async (_label, target, error) => {
      const listen = vi.spyOn(NetServer.prototype, 'listen');
      expect(await start({ target })).toEqual({ ok: false, status: 400, error });
      expect(listen).not.toHaveBeenCalled();
      expect(tunnels.started).toHaveLength(0);
      expect(cezarProbes).toHaveLength(0);
    });

    it('refuses the cockpit and every forbidden origin, under any loopback spelling', async () => {
      const itself = { ok: false, status: 400, error: 'Sharing cannot be pointed at cezar itself' };
      expect(await start({ target: 'http://localhost:4321/x' })).toEqual(itself);
      expect(await start({ target: 'http://127.0.0.1:4321' })).toEqual(itself);
      expect(await start({ target: 'http://localhost:9999', forbidden: ['http://127.0.0.1:8888', 'http://127.0.0.1:9999'] })).toEqual(itself);
      expect(tunnels.started).toHaveLength(0);
    });

    it('refuses a target that answers as a cezar, whatever its port (C10)', async () => {
      const guarded = build({ isCezar: async (origin) => (origin === app ? 'cezar' : 'not-cezar') });
      expect(await start({}, guarded)).toEqual({ ok: false, status: 400, error: 'Sharing cannot be pointed at cezar itself' });
      expect(tunnels.started).toHaveLength(0);
      expect(guarded.get('r1')).toBeNull();
    });

    it('refuses a cockpit that is not local', async () => {
      expect(await start({ parentOrigin: 'https://cezar.example.com' })).toEqual({ ok: false, status: 400, error: 'Sharing needs a local cockpit' });
      expect(await start({ parentOrigin: 'nope' })).toMatchObject({ ok: false, status: 400 });
      expect(tunnels.started).toHaveLength(0);
    });

    it('binds 127.0.0.1 on an ephemeral port and hands that port to the tunnel', async () => {
      const listen = vi.spyOn(NetServer.prototype, 'listen');
      await open();
      expect(listen.mock.calls.map((call) => call.slice(0, 2))).toEqual([[0, '127.0.0.1']]);
      expect(tunnels.started).toHaveLength(1);
      expect(port).not.toBe(appPort);
      expect(await refuses(port)).toBe(false);
    });

    it('gives a link made of the tunnel origin, a 256-bit token and the page the owner was on', async () => {
      const share = await open();
      expect(share.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/__cezar_share__/join/[a-f0-9]{64}\\?next=%2Fsettings%3Ftab%3D1$`));
      expect(share).toMatchObject({ runId: 'r1', target: app, guests: [] });
      expect(Date.parse(share.expiresAt) - Date.parse(share.startedAt)).toBe(8 * HOUR);
      shares.stop('r1');
      expect((await open({ target: `${app}#top` })).url).toMatch(/\?next=%2F$/);
    });

    it('mints a different token for every share', async () => {
      await open();
      const first = token;
      shares.stop('r1');
      await open();
      expect(token).not.toBe(first);
    });

    it('answers the live share for the same run and origin, whatever the path', async () => {
      const first = await open();
      const again = await start({ target: `${app}/another/page` });
      expect(again).toEqual({ ok: true, share: first });
      expect(tunnels.started).toHaveLength(1);
      expect(changes).toHaveLength(1);
    });

    it('refuses another target on the same run until the first is stopped (C9)', async () => {
      const first = await open();
      expect(await start({ target: 'http://localhost:5999/' })).toEqual({ ok: false, status: 409, error: `Already sharing ${app} — stop it first` });
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

    it.each([
      ['throws', (() => { throw new Error('boom'); }) as unknown as (origin: string) => Promise<CezarVerdict>],
      ['rejects', (): Promise<CezarVerdict> => Promise.reject(new Error('boom'))],
      ['answers something that is not a verdict', (async () => false) as unknown as (origin: string) => Promise<CezarVerdict>],
    ])('refuses the target when the cezar probe %s, as if it had said yes', async (_label, isCezar) => {
      expect(await start({}, build({ isCezar }))).toEqual({ ok: false, status: 400, error: 'Sharing cannot be pointed at cezar itself' });
      expect(tunnels.started).toHaveLength(0);
    });

    it('refuses an app that is not answering, and opens nothing (C10)', async () => {
      const listen = vi.spyOn(NetServer.prototype, 'listen');
      verdict = 'no-answer';
      expect(await start()).toEqual({ ok: false, status: 400, error: `The app at ${app} is not answering. Start it, then share.` });
      expect(listen).not.toHaveBeenCalled();
      expect(tunnels.started).toHaveLength(0);
      expect(shares.get('r1')).toBeNull();
      expect(changes).toHaveLength(0);
      // Once it answers, the same click works.
      verdict = 'not-cezar';
      expect((await start()).ok).toBe(true);
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
      const again = await start({ target: `${app}/again` });
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
      const elsewhere = await start({ runId: 'r2', target: `http://localhost:${appPort}` });
      expect(elsewhere).toMatchObject({ ok: true, share: { target: `http://localhost:${appPort}` } });
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
      expect(upstreamRequests).toHaveLength(0);
      release();
      expect((await pending).ok).toBe(true);
    });

    it('starts one tunnel for two requests that race, and none that outlives a stop or a shutdown', async () => {
      let release!: () => void;
      tunnels.gate = new Promise((resolve) => (release = resolve));
      const first = start();
      const second = start({ target: `${app}/other` });
      const third = start({ target: 'http://localhost:5999' });
      expect(await third).toEqual({ ok: false, status: 409, error: `Already sharing ${app} — stop it first` });
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

  describe('the default cezar probe', () => {
    const unprobed = (): PreviewShares => build({ isCezar: undefined });

    it('refuses an app whose /api/v1/health carries the marks of a cezar, of any version', async () => {
      health = { version: '0.1.0', repoRoot: '/somewhere', capabilities: { localHandoff: true }, defaultRunner: 'a-runner-from-the-future' };
      expect(await start({}, unprobed())).toEqual({ ok: false, status: 400, error: 'Sharing cannot be pointed at cezar itself' });
      expect(upstreamRequests.map((seen) => seen.url)).toEqual(['/api/v1/health']);
      expect(tunnels.started).toHaveLength(0);
    });

    it.each([
      ['answers that path with its own page', null],
      ['answers JSON of another shape', { status: 'ok', version: '1.2.3' }],
      ['answers JSON that is not an object', ['version', 'repoRoot', 'capabilities']],
    ])('shares an app that %s', async (_label, answer) => {
      health = answer;
      expect((await start({}, unprobed())).ok).toBe(true);
    });

    it('does not follow a redirect to a real cezar, and refuses an app that is down', async () => {
      const cezar = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: '1', repoRoot: '/r', capabilities: {} }));
      });
      await new Promise<void>((resolve) => cezar.listen(0, '127.0.0.1', resolve));
      const cezarOrigin = `http://127.0.0.1:${(cezar.address() as AddressInfo).port}`;
      let probed = 0;
      cezar.on('request', () => (probed += 1));
      const redirecting = createServer((_req, res) => {
        res.writeHead(302, { location: `${cezarOrigin}/api/v1/health` }).end();
      });
      await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
      const redirectingOrigin = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`;
      try {
        const probing = unprobed();
        expect((await start({ target: redirectingOrigin }, probing)).ok).toBe(true);
        expect(probed).toBe(0);
        // The control: the same probe does refuse that cezar when pointed at it.
        expect((await start({ runId: 'r2', target: cezarOrigin }, probing)).ok).toBe(false);
        redirecting.closeAllConnections();
        await new Promise<void>((resolve) => redirecting.close(() => resolve()));
        expect(await start({ runId: 'r3', target: redirectingOrigin }, probing)).toEqual({
          ok: false,
          status: 400,
          error: `The app at ${redirectingOrigin} is not answering. Start it, then share.`,
        });
        expect(tunnels.started).toHaveLength(1);
      } finally {
        cezar.closeAllConnections();
        redirecting.closeAllConnections();
        await new Promise<void>((resolve) => cezar.close(() => resolve()));
        await new Promise<void>((resolve) => redirecting.close(() => resolve()));
      }
    });
  });

  describe('the join link', () => {
    beforeEach(async () => {
      await open();
    });

    it('answers a right token with a per-browser cookie, no referrer, and the waiting page', async () => {
      const res = await send(port, host, joinPath);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${WAIT}?next=%2Fsettings%3Ftab%3D1`);
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      const cookies = res.headers['set-cookie']!;
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatch(/^__cezar_share=[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\/$/);
      const again = await send(port, host, joinPath);
      expect(again.headers['set-cookie']![0]).not.toBe(cookies[0]);
      expect(upstreamRequests).toHaveLength(0);
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
      expect(upstreamRequests).toHaveLength(0);
    });

    it('accepts the token only on a GET', async () => {
      const res = await send(port, host, joinPath, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it.each([
      ['another site', 'https://evil.example/x'],
      ['a protocol-relative address', '//evil.example/x'],
      ['a backslash a browser reads as a slash', '/\\evil.example/x'],
      ['a tab a browser drops', '/\t/evil.example/x'],
      ['a relative path', 'settings'],
      ['nothing', ''],
    ])('drops a next that is %s', async (_label, next) => {
      const res = await send(port, host, `/__cezar_share__/join/${token}?next=${encodeURIComponent(next)}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(WAIT);
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
      for (const wrong of [`evil.example:${port}`, `localhost:${port}`, '127.0.0.1', `127.0.0.1:${appPort}`]) {
        const res = await visitor(cookie).get('/', { host: wrong });
        expect(res.status).toBe(403);
        expect((await send(port, wrong, joinPath)).status).toBe(403);
      }
      expect(upstreamRequests).toHaveLength(0);
    });

    it('answers a browser with no cookie, or one it never issued, with a plain 404', async () => {
      for (const who of [visitor(), visitor('f'.repeat(64)), visitor('not-a-cookie')]) {
        for (const path of ['/', '/src/main.ts', '/@fs/etc/passwd', `${WAIT}?next=%2F`, '/__cezar_share__/guest.js', '/__cezar_share__']) {
          const res = await who.get(path);
          expect(res.status).toBe(404);
          expect(res.body).toBe(GONE);
        }
      }
      expect(guestCalls).toHaveLength(0);
      expect(upstreamRequests).toHaveLength(0);
    });

    it('gives a browser that joined but has not asked nothing of the app', async () => {
      const cookie = await join();
      const res = await visitor(cookie).get('/settings');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(WAIT);
      expect(await stateOf(cookie)).toBe('guest:/__cezar_share__/status:new');
      expect(upstreamRequests).toHaveLength(0);
    });

    it('gives a waiting browser nothing of the app', async () => {
      const waiting = visitor(await waitingGuest());
      const res = await waiting.get('/');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/__cezar_share__/wait');
      expect((await waiting.get('/src/main.ts', { 'x-requested-with': 'fetch' })).status).toBe(302);
      expect((await send(port, host, '/api/save', { method: 'POST', headers: { cookie: `__cezar_share=${await waitingGuest('Piotr')}` } })).status).toBe(302);
      expect(upstreamRequests).toHaveLength(0);
    });

    it('forwards an allowed browser to the app, with the guest script in its pages', async () => {
      const allowed = visitor(await allowedGuest());
      const page = await allowed.get('/settings?tab=1');
      expect(page.status).toBe(200);
      expect(page.body).toContain('<head><script src="/__cezar_share__/guest.js" data-cezar-design></script><title>');
      expect(Number(page.headers['content-length'])).toBe(Buffer.byteLength(page.body));
      expect(upstreamRequests.at(-1)).toMatchObject({ method: 'GET', url: '/settings?tab=1' });
      expect(upstreamRequests.at(-1)!.headers.host).toBe(`127.0.0.1:${appPort}`);
    });

    it('presents only its own pages as same-origin to the app', async () => {
      const allowed = visitor(await allowedGuest());
      const own = `http://${host}`;
      await allowed.get('/echo', { origin: own, referer: `${own}/page` });
      expect(upstreamRequests.at(-1)!.headers).toMatchObject({ origin: app, referer: `${app}/page` });
      await allowed.get('/echo', { origin: 'https://evil.example' });
      expect(upstreamRequests.at(-1)!.headers.origin).toBe('https://evil.example');
    });

    it('never forwards the share cookie or the token to the app', async () => {
      const allowed = visitor(await allowedGuest());
      const echoed = await allowed.get('/echo');
      expect(echoed.status).toBe(200);
      const lastUpstreamHeaders = upstreamRequests.at(-1)!.headers;
      expect(lastUpstreamHeaders.cookie).toBe('theme=dark');
      expect(lastUpstreamHeaders.cookie ?? '').not.toContain('__cezar_share');
      // A mangled link from a browser already let in must not carry the token to the app either.
      for (const path of [`//__cezar_share__/join/${token}`, `/x/../__cezar_share__/join/${token}`, `/search?q=${token}`]) {
        expect((await allowed.get(path)).status).toBe(404);
      }
      expect(upstreamRequests).toHaveLength(1);
      expect(JSON.stringify(upstreamRequests)).not.toContain(token);
    });

    it('forwards to the one origin it was opened for, whatever the request line or Host says', async () => {
      const decoySeen: string[] = [];
      const decoy = createServer((req, res) => {
        decoySeen.push(req.url ?? '');
        res.end('decoy');
      });
      await new Promise<void>((resolve) => decoy.listen(0, '127.0.0.1', resolve));
      const decoyPort = (decoy.address() as AddressInfo).port;
      try {
        const allowed = visitor(await allowedGuest());
        const absolute = await allowed.get(`http://127.0.0.1:${decoyPort}/secret`);
        expect(absolute.status).toBe(400);
        expect((await allowed.get('/', { host: `127.0.0.1:${decoyPort}` })).status).toBe(403);
        expect((await upgrade(port, host, `http://127.0.0.1:${decoyPort}/hmr`, await allowedGuest('Piotr'))).opened).toBe(false);
        expect((await allowed.get('/echo', { 'x-forwarded-host': `127.0.0.1:${decoyPort}`, forwarded: `host=127.0.0.1:${decoyPort}` })).status).toBe(200);
        expect(decoySeen).toHaveLength(0);
        expect(upstreamRequests.map((seen) => seen.url)).toEqual(['/echo']);
        expect(upstreamRequests[0]!.headers.host).toBe(`127.0.0.1:${appPort}`);
      } finally {
        decoy.closeAllConnections();
        await new Promise<void>((resolve) => decoy.close(() => resolve()));
      }
    });

    it('answers 502 while the app is down and forwards again once it is back and one probe passed', async () => {
      clock = Date.now();
      const guest = visitor(await allowedGuest());
      await stopApp();
      expect((await guest.get('/')).status).toBe(502);
      expect((await guest.get('/')).body).toBe('The app is not running right now.');
      await startApp();
      clock += 1_000;
      expect((await guest.get('/')).status).toBe(200);
      expect(cezarProbes).toHaveLength(2);
      expect(shares.get('r1')).not.toBeNull();
      expect(changes.every((change) => change.share !== null)).toBe(true);
    });
  });

  describe('an app that stops answering while it is shared (C10)', () => {
    const DOWN = 'The app is not running right now.';
    const TURNED = 'the app turned out to be cezar';
    let cookie: string;

    beforeEach(async () => {
      clock = Date.parse('2026-11-27T10:00:00Z');
      await open();
      cookie = await allowedGuest();
    });

    /** The app goes away, one forward finds out, and the app (or whatever took its port) is back. */
    async function doubted(): Promise<void> {
      await stopApp();
      expect((await visitor(cookie).get('/')).status).toBe(502);
      await startApp();
      upstreamRequests.length = 0;
    }

    /** A probe the test answers when it chooses. */
    function heldProbe(): (answer: CezarVerdict) => void {
      let release!: (answer: CezarVerdict) => void;
      verdict = () => new Promise<CezarVerdict>((resolve) => (release = resolve));
      return (answer) => release(answer);
    }

    it('forwards nothing after a failed connect, even to an app that is back, until a probe has passed', async () => {
      await doubted();
      clock! += 999;
      for (const path of ['/', '/assets/app.js', '/api/v1/runs']) {
        const res = await visitor(cookie).get(path);
        expect(res.status).toBe(502);
        expect(res.body).toBe(DOWN);
        expectUncacheable(res);
      }
      expect((await upgrade(port, host, '/hmr', cookie)).opened).toBe(false);
      expect(upstreamRequests).toHaveLength(0);
      expect(upstreamUpgrades).toBe(0);
      expect(cezarProbes).toHaveLength(1);
      expect(shares.get('r1')).not.toBeNull();
    });

    it('probes once after a second and forwards the request that asked, when the app is still not a cezar', async () => {
      await doubted();
      clock! += 1_000;
      expect((await visitor(cookie).get('/settings')).status).toBe(200);
      expect(cezarProbes).toEqual([app, app]);
      expect(upstreamRequests.map((seen) => seen.url)).toEqual(['/settings']);
      // Verified again: no probe per request.
      expect((await visitor(cookie).get('/echo')).status).toBe(200);
      const live = await upgrade(port, host, '/hmr', cookie);
      expect(live.opened).toBe(true);
      live.socket.destroy();
      expect(cezarProbes).toHaveLength(2);
    });

    it('stays shut while the probe gets no answer, and asks again only a second later', async () => {
      await doubted();
      verdict = 'no-answer';
      clock! += 1_000;
      expect((await visitor(cookie).get('/')).status).toBe(502);
      expect(cezarProbes).toHaveLength(2);
      clock! += 999;
      expect((await visitor(cookie).get('/')).status).toBe(502);
      expect(cezarProbes).toHaveLength(2);
      clock! += 1;
      verdict = 'not-cezar';
      expect((await visitor(cookie).get('/')).status).toBe(200);
      expect(cezarProbes).toHaveLength(3);
      expect(upstreamRequests).toHaveLength(1);
      expect(shares.get('r1')).not.toBeNull();
    });

    it.each([
      ['says it is a cezar', async (): Promise<CezarVerdict> => 'cezar'],
      ['rejects', (): Promise<CezarVerdict> => Promise.reject(new Error('boom'))],
    ])('ends the share when the probe %s, and forwards nothing', async (_label, answer) => {
      await doubted();
      verdict = answer;
      clock! += 1_000;
      await expect(visitor(cookie).get('/')).rejects.toThrow();
      expect(changes.at(-1)).toEqual({ projectId: 'p1', runId: 'r1', share: null, ended: TURNED });
      expect(shares.get('r1')).toBeNull();
      expect(tunnels.stopped).toBe(1);
      expect(await refuses(port)).toBe(true);
      expect(upstreamRequests).toHaveLength(0);
    });

    it('ends the share when a cezar comes up on the port the app left, and no request reaches it', async () => {
      const probing = build({ isCezar: undefined });
      await open({ runId: 'r5' }, probing);
      const guest = await join();
      await ask(guest);
      expect(probing.decide('r5', idOf(guest), 'allow')).toBe(true);
      await stopApp();
      expect((await visitor(guest).get('/')).status).toBe(502);
      health = { version: '1.0.0', repoRoot: '/r', capabilities: { localHandoff: true } };
      await startApp();
      upstreamRequests.length = 0;

      expect((await visitor(guest).get('/api/v1/runs')).status).toBe(502);
      expect((await upgrade(port, host, '/api/v1/ws', guest)).opened).toBe(false);
      expect(upstreamRequests).toHaveLength(0);
      clock! += 1_000;
      await expect(visitor(guest).get('/api/v1/runs')).rejects.toThrow();
      expect(changes.at(-1)).toEqual({ projectId: 'p1', runId: 'r5', share: null, ended: TURNED });
      expect(probing.get('r5')).toBeNull();
      // Only cezar's own question reached it.
      expect(upstreamRequests.map((seen) => seen.url)).toEqual(['/api/v1/health']);
      expect(upstreamUpgrades).toBe(0);
    });

    it('asks once for ten requests that arrive together', async () => {
      await doubted();
      const answer = heldProbe();
      clock! += 1_000;
      const waiting = Array.from({ length: 10 }, () => visitor(cookie).get('/echo'));
      await vi.waitFor(() => expect(cezarProbes).toHaveLength(2));
      // Held: nothing is forwarded before the verdict.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(upstreamRequests).toHaveLength(0);
      answer('not-cezar');
      expect((await Promise.all(waiting)).map((res) => res.status)).toEqual(Array.from({ length: 10 }, () => 200));
      expect(cezarProbes).toHaveLength(2);
      expect(upstreamRequests).toHaveLength(10);
    });

    it('does not forward a request whose guest was removed while the probe was out', async () => {
      await doubted();
      const answer = heldProbe();
      clock! += 1_000;
      const cut = outcome(port, host, '/echo', cookie);
      await vi.waitFor(() => expect(cezarProbes).toHaveLength(2));
      expect(shares.removeGuest('r1', idOf(cookie))).toBe(true);
      answer('not-cezar');
      expect(await cut).toBe('cut');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(upstreamRequests).toHaveLength(0);
    });

    it('lets an upgrade start the probe too, and never splices one before the verdict', async () => {
      await doubted();
      const answer = heldProbe();
      clock! += 1_000;
      expect((await upgrade(port, host, '/hmr', cookie)).opened).toBe(false);
      expect(cezarProbes).toHaveLength(2);
      expect(upstreamUpgrades).toBe(0);
      answer('not-cezar');
      await vi.waitFor(async () => {
        const live = await upgrade(port, host, '/hmr', cookie);
        live.socket.destroy();
        expect(live.opened).toBe(true);
      });
      expect(cezarProbes).toHaveLength(2);
    });

    it('doubts the app when an upgrade cannot connect', async () => {
      await stopApp();
      expect((await upgrade(port, host, '/hmr', cookie)).opened).toBe(false);
      await startApp();
      expect((await visitor(cookie).get('/')).status).toBe(502);
      expect(upstreamRequests).toHaveLength(0);
    });

    it('does not doubt the app when it is the guest who hangs up', async () => {
      upstream.removeAllListeners('request');
      const reached = new Promise<void>((resolve) => upstream.once('request', () => resolve()));
      const req = request({ host: '127.0.0.1', port, path: '/slow', headers: { host, cookie: `__cezar_share=${cookie}` } });
      req.on('error', () => {});
      req.end();
      await reached;
      req.destroy();
      upstream.on('request', (_req, res) => res.end('back'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await visitor(cookie).get('/')).body).toBe('back');
      expect(cezarProbes).toHaveLength(1);
    });

    it('asks again in the background once the verdict is a minute old, without holding the request', async () => {
      clock! += 59_999;
      expect((await visitor(cookie).get('/')).status).toBe(200);
      expect(cezarProbes).toHaveLength(1);

      const answer = heldProbe();
      clock! += 1;
      expect((await visitor(cookie).get('/')).status).toBe(200);
      expect((await visitor(cookie).get('/echo')).status).toBe(200);
      expect(cezarProbes).toHaveLength(2);
      answer('not-cezar');
      await new Promise((resolve) => setTimeout(resolve, 20));
      // A fresh minute starts at the verdict.
      verdict = 'not-cezar';
      clock! += 59_999;
      expect((await visitor(cookie).get('/')).status).toBe(200);
      expect(cezarProbes).toHaveLength(2);
      clock! += 1;
      expect((await visitor(cookie).get('/')).status).toBe(200);
      expect(cezarProbes).toHaveLength(3);
      expect(shares.get('r1')).not.toBeNull();
    });

    it('ends the share when the background probe finds a cezar', async () => {
      const live = await upgrade(port, host, '/hmr', cookie);
      expect(live.opened).toBe(true);
      verdict = 'cezar';
      clock! += 60_000;
      await visitor(cookie).get('/').catch(() => undefined);
      await vi.waitFor(() => expect(changes.at(-1)).toEqual({ projectId: 'p1', runId: 'r1', share: null, ended: TURNED }));
      expect(await live.closed).toBe(true);
      expect(await refuses(port)).toBe(true);
    });

    it('shuts the gate when the background probe gets no answer', async () => {
      verdict = 'no-answer';
      clock! += 60_000;
      expect((await visitor(cookie).get('/')).status).toBe(200);
      expect(cezarProbes).toHaveLength(2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      upstreamRequests.length = 0;
      expect((await visitor(cookie).get('/')).status).toBe(502);
      expect(upstreamRequests).toHaveLength(0);
      expect(shares.get('r1')).not.toBeNull();
    });

    it('drops a verdict that arrives after the share ended', async () => {
      await doubted();
      const answer = heldProbe();
      clock! += 1_000;
      const cut = outcome(port, host, '/echo', cookie);
      await vi.waitFor(() => expect(cezarProbes).toHaveLength(2));
      shares.stop('r1');
      const ended = changes.length;
      answer('cezar');
      expect(await cut).toBe('cut');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(changes).toHaveLength(ended);
    });
  });

  describe('a shared cache in front of the gate', () => {
    beforeEach(async () => {
      await open();
    });

    it('is told to keep nothing of the app, whatever the app asked for', async () => {
      const allowed = visitor(await allowedGuest());
      const asset = await allowed.get('/assets/app.js');
      expect(asset.status).toBe(200);
      expect(asset.body).toBe('console.log("app")');
      expectUncacheable(asset);
      expect(asset.headers.etag).toBe('"v1"');
      const page = await allowed.get('/');
      expect(page.body).toContain('/__cezar_share__/guest.js');
      expectUncacheable(page);
      expectUncacheable(await allowed.get('/echo'));
    });

    it('is told to keep nothing of the 502 page', async () => {
      const allowed = visitor(await allowedGuest());
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      const down = await allowed.get('/assets/app.js');
      expect(down.status).toBe(502);
      expectUncacheable(down);
    });

    it('is told to keep nothing of any answer the listener gives itself', async () => {
      const waiting = await waitingGuest();
      const allowed = await allowedGuest('Piotr');
      const answers: Array<[number, Answer]> = [
        [404, await visitor().get('/assets/app.js')],
        [403, await visitor(allowed).get('/', { host: 'evil.example' })],
        [400, await visitor(allowed).get('http://127.0.0.1:1/x')],
        [404, await visitor(allowed).get(`/assets/app.js?t=${token}`)],
        [302, await visitor(waiting).get('/assets/app.js')],
        [302, await send(port, host, joinPath, { headers: { 'cf-connecting-ip': '203.0.113.9' } })],
        [404, await send(port, host, `/__cezar_share__/join/${'0'.repeat(64)}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } })],
        [200, await visitor(waiting).get(`${WAIT}?next=%2F`)],
        [404, await visitor(waiting).get('/__cezar_share__/unknown')],
      ];
      for (let attempt = 0; attempt < 10; attempt += 1) await send(port, host, joinPath, { headers: { 'cf-connecting-ip': '203.0.113.10' } });
      answers.push([429, await send(port, host, joinPath, { headers: { 'cf-connecting-ip': '203.0.113.10' } })]);
      for (const [status, answer] of answers) {
        expect(answer.status).toBe(status);
        expectUncacheable(answer);
      }
      expect(upstreamRequests).toHaveLength(0);
    });
  });

  describe('a failure inside the listener', () => {
    it('answers 500, forwards nothing and leaves the cockpit running', async () => {
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
      const live = await upgrade(port, host, '/hmr', cookie);
      expect(live.opened).toBe(true);
      live.socket.destroy();
      const seen = upstreamRequests.length;

      broken = true;
      const failed = await visitor(cookie).get('/assets/app.js');
      expect(failed.status).toBe(500);
      expect(failed.body).toBe('error');
      expectUncacheable(failed);
      expect((await upgrade(port, host, '/hmr', cookie)).opened).toBe(false);
      expect(upstreamRequests).toHaveLength(seen);

      broken = false;
      expect((await visitor(cookie).get('/assets/app.js')).status).toBe(200);
    });
  });

  describe('safeNext', () => {
    it.each(['/', '/settings?tab=1', '/a/b#c', '/__cezar_share__/wait'])('keeps the same-origin path %s', (next) => {
      expect(safeNext(next)).toBe(next);
    });

    it.each([
      ['nothing', null],
      ['an empty string', ''],
      ['another site', 'https://evil.example/x'],
      ['a protocol-relative address', '//evil.example/x'],
      ['a backslash a browser reads as a slash', '/\\evil.example/x'],
      ['a tab a browser drops', '/\t/evil.example/x'],
      ['a line break', '/a\nb'],
      ['a relative path', 'settings'],
      ['a javascript: address', 'javascript:alert(1)'],
      ['more than 2048 characters', `/${'a'.repeat(2048)}`],
    ])('drops %s', (_label, next) => {
      expect(safeNext(next)).toBeNull();
    });
  });

  describe('paths under /__cezar_share__/', () => {
    beforeEach(async () => {
      await open();
    });

    it('cut an answer a guest route abandoned by throwing, instead of leaving it open', async () => {
      const cookie = await join();
      expect(await outcome(port, host, '/__cezar_share__/half', cookie)).toBe('cut');
      expect(upstreamRequests).toHaveLength(0);
      expect(await stateOf(cookie)).toBe('guest:/__cezar_share__/status:new');
    });

    it('go to the guest routes for any cookie-holder, with the public id and nothing secret', async () => {
      const cookie = await join();
      const res = await visitor(cookie).get(`${WAIT}?next=%2Fsettings`);
      expect(res.status).toBe(200);
      expect(res.body).toBe('guest:/__cezar_share__/wait:new');
      expect(guestCalls).toHaveLength(1);
      expect(guestCalls[0]).toMatchObject({
        runId: 'r1',
        projectId: 'p1',
        path: WAIT,
        tunnelOrigin: `http://${host}`,
        upstreamOrigin: app,
        guest: { id: idOf(cookie), state: 'new' },
      });
      expect(JSON.stringify(guestCalls)).not.toContain(cookie);
      expect(JSON.stringify(guestCalls)).not.toContain(token);
    });

    it('are never forwarded to the app, not even for an allowed browser or a route nobody answers', async () => {
      const allowed = visitor(await allowedGuest());
      expect((await allowed.get('/__cezar_share__/status')).body).toBe('guest:/__cezar_share__/status:allowed');
      for (const path of ['/__cezar_share__/unknown', '/__cezar_share__/unknown?x=1']) {
        const res = await allowed.get(path);
        expect(res.status).toBe(404);
        expect(res.body).toBe(GONE);
      }
      expect((await allowed.get('/__cezar_share__')).status).toBe(200);
      expect(upstreamRequests).toHaveLength(0);
      // A name that only starts like the reserved one is the app's own path.
      expect((await allowed.get('/__cezar_share__x')).status).toBe(200);
      expect(upstreamRequests.map((seen) => seen.url)).toEqual(['/__cezar_share__x']);
    });

    it('answer 404 when the guest routes throw, without touching the app', async () => {
      const throwing = build({
        guestRoutes: {
          handle() {
            throw new Error('boom');
          },
        },
      });
      await open({ runId: 'r9' }, throwing);
      const cookie = await join();
      const res = await visitor(cookie).get(WAIT);
      expect(res.status).toBe(404);
      expect(upstreamRequests).toHaveLength(0);
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
      expect(upstreamRequests).toHaveLength(0);
      expect((await ask(cookie, 'Ana')).code).toMatch(/^\d{4}$/);
      expect(shares.get('r1')!.guests).toMatchObject([{ state: 'waiting', requestedAt: '2026-11-27T10:10:00.000Z' }]);
    });

    it('expires a request on its own timer and tells the cockpit', async () => {
      const brief = build({ waitingMs: 40 });
      await open({ runId: 'r7' }, brief);
      const cookie = await join();
      await ask(cookie);
      expect(changes.some((change) => change.share?.guests.length === 1)).toBe(true);
      await vi.waitFor(() => expect(changes.at(-1)).toMatchObject({ runId: 'r7', share: { guests: [] } }));
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
      expect(upstreamRequests).toHaveLength(1);
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
      expect((await upgrade(port, host, '/hmr', cookie)).opened).toBe(false);
      expect(upstreamRequests).toHaveLength(0);
      // Another browser can still ask.
      expect((await ask(await join(), 'Piotr')).code).toMatch(/^\d{4}$/);
    });

    it('cuts a removed guest off at once: live sockets destroyed, the next request refused', async () => {
      const cookie = await allowedGuest();
      const other = await allowedGuest('Piotr');
      const live = await upgrade(port, host, '/hmr', cookie);
      const kept = await upgrade(port, host, '/hmr', other);
      expect(live.opened && kept.opened).toBe(true);
      expect(shares.removeGuest('r1', idOf(cookie))).toBe(true);
      expect(await live.closed).toBe(true);
      expect(shares.get('r1')!.guests.map((guest) => guest.name)).toEqual(['Piotr']);
      expect(changes.at(-1)!.share).toEqual(shares.get('r1'));
      const seen = upstreamRequests.length;
      expect((await visitor(cookie).get('/')).status).toBe(302);
      expect((await upgrade(port, host, '/hmr', cookie)).opened).toBe(false);
      expect(await ask(cookie, 'Ana')).toEqual({ error: expect.any(String) });
      expect(upstreamRequests).toHaveLength(seen);
      expect(kept.socket.destroyed).toBe(false);
      expect((await visitor(other).get('/')).status).toBe(200);
      kept.socket.destroy();
      expect(shares.removeGuest('r1', idOf(cookie))).toBe(false);
      expect(shares.removeGuest('nope', idOf(other))).toBe(false);
    });

    it('cuts a removed guest off in the middle of a response', async () => {
      const cookie = await allowedGuest();
      upstream.removeAllListeners('request');
      upstream.on('request', (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('first');
      });
      const cut = new Promise<string>((resolve) => {
        const req = request({ host: '127.0.0.1', port, path: '/stream', headers: { host, cookie: `__cezar_share=${cookie}` } }, (res) => {
          res.once('data', () => shares.removeGuest('r1', idOf(cookie)));
          res.on('error', () => resolve('cut'));
          res.on('end', () => resolve('ended'));
          res.on('close', () => resolve('cut'));
        });
        req.on('error', () => resolve('cut'));
        req.end();
      });
      expect(await cut).toBe('cut');
    });
  });

  describe('a removed guest’s request to the listener’s own pages', () => {
    beforeEach(async () => {
      await open();
    });

    it('is cut like one to the app, so a write still on its way cannot land', async () => {
      const cookie = await allowedGuest();
      const other = await allowedGuest('Piotr');
      let othersFirstByte = (): void => {};
      const othersStarted = new Promise<void>((resolve) => {
        othersFirstByte = resolve;
      });
      const others = outcome(port, host, '/__cezar_share__/pending', other, othersFirstByte);
      await othersStarted;
      expect(await outcome(port, host, '/__cezar_share__/pending', cookie, () => shares.removeGuest('r1', idOf(cookie)))).toBe('cut');
      expect(upstreamRequests).toHaveLength(0);
      // Only the removed guest's: another guest's pending request lasts until the share ends.
      expect(await Promise.race([others, new Promise((resolve) => setTimeout(() => resolve('open'), 50))])).toBe('open');
      shares.stop('r1');
      expect(await others).toBe('cut');
    });
  });

  describe('WebSocket upgrades', () => {
    beforeEach(async () => {
      await open();
    });

    it('splices an allowed browser through, without the share cookie', async () => {
      const cookie = await allowedGuest();
      const live = await upgrade(port, host, '/hmr?x=1', cookie);
      expect(live.opened).toBe(true);
      live.socket.destroy();
      expect(upstreamUpgrades).toBe(1);
      const seen = upstreamRequests.find((entry) => entry.url === '/hmr?x=1')!;
      expect(seen.headers.upgrade).toBe('websocket');
      expect(seen.headers.host).toBe(`127.0.0.1:${appPort}`);
      expect(seen.headers.cookie).toBe('theme=dark');
      expect(JSON.stringify(upstreamRequests)).not.toContain('__cezar_share');
      expect(JSON.stringify(upstreamRequests)).not.toContain(cookie);
    });

    it('destroys a WebSocket upgrade from a browser that was never allowed', async () => {
      const waitingGuestCookie = await waitingGuest();
      const closed = await (await upgrade(port, host, '/hmr', waitingGuestCookie)).closed;
      expect(closed).toBe(true);
      expect(upstreamUpgrades).toBe(0);
    });

    it('destroys an upgrade with no cookie, an unknown one, or from a browser that only joined', async () => {
      for (const cookie of [undefined, 'f'.repeat(64), await join()]) {
        const attempt = await upgrade(port, host, '/hmr', cookie);
        expect(attempt.opened).toBe(false);
        expect(await attempt.closed).toBe(true);
      }
      expect(upstreamUpgrades).toBe(0);
      expect(upstreamRequests).toHaveLength(0);
    });

    it('destroys an upgrade whose request expired while it waited', async () => {
      clock = Date.parse('2026-11-27T10:00:00Z');
      const cookie = await waitingGuest();
      clock += 10 * 60_000;
      expect((await upgrade(port, host, '/hmr', cookie)).opened).toBe(false);
      expect(upstreamUpgrades).toBe(0);
    });

    it('destroys an allowed browser’s upgrade on a wrong Host, a reserved path or a path carrying the token', async () => {
      const cookie = await allowedGuest();
      expect((await upgrade(port, `evil.example:${port}`, '/hmr', cookie)).opened).toBe(false);
      expect((await upgrade(port, host, '/__cezar_share__/socket', cookie)).opened).toBe(false);
      expect((await upgrade(port, host, `/hmr?t=${token}`, cookie)).opened).toBe(false);
      expect(upstreamUpgrades).toBe(0);
      expect(guestCalls.some((call) => call.path === '/__cezar_share__/socket')).toBe(false);
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

      // Past the old end: the allowed guest still gets the app, the denied one is still refused.
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
      const brief = build({ lifetimeMs: 1_000 });
      const opened = Date.now();
      await open({}, brief);
      for (let i = 0; i < 10; i += 1) expect((await send(port, host, joinPath, { headers: { 'cf-connecting-ip': '203.0.113.9' } })).status).toBe(302);
      await new Promise((resolve) => setTimeout(resolve, 500 - (Date.now() - opened)));
      const extended = brief.extend('r1')!;
      expect((await send(port, host, joinPath, { headers: { 'cf-connecting-ip': '203.0.113.9' } })).status).toBe(429);
      // The first timer would have ended it here.
      await new Promise((resolve) => setTimeout(resolve, 1_200 - (Date.now() - opened)));
      expect(brief.get('r1')?.expiresAt).toBe(extended.expiresAt);
      await vi.waitFor(() => expect(changes.at(-1)).toEqual({ projectId: 'p1', runId: 'r1', share: null, ended: 'expired' }), { timeout: 5_000 });
      expect(tunnels.stopped).toBe(1);
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
    /** A live share with an allowed browser holding a socket open. */
    async function live(on: PreviewShares = shares): Promise<{ cookie: string; socket: Upgraded }> {
      await open({}, on);
      const cookie = await join();
      await ask(cookie);
      on.decide('r1', idOf(cookie), 'allow');
      const socket = await upgrade(port, host, '/hmr', cookie);
      expect(socket.opened).toBe(true);
      return { cookie, socket };
    }

    async function expectGone(session: { cookie: string; socket: Upgraded }, on: PreviewShares, ended: string | undefined): Promise<void> {
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
      const brief = build({ lifetimeMs: 600 });
      const session = await live(brief);
      await vi.waitFor(() => expect(changes.at(-1)!.share).toBeNull(), { timeout: 5_000 });
      await expectGone(session, brief, 'expired');
    });

    it('the wall clock passing the expiry even when no timer fired', async () => {
      clock = Date.parse('2026-11-27T10:00:00Z');
      const session = await live();
      expect(shares.get('r1')!.expiresAt).toBe('2026-11-27T18:00:00.000Z');
      clock += 8 * HOUR - 1;
      expect((await visitor(session.cookie).get('/')).status).toBe(200);
      clock += 1;
      const seen = upstreamRequests.length;
      // The request that finds the share over is cut with every other socket: nothing answers any more.
      await expect(visitor(session.cookie).get('/')).rejects.toThrow();
      expect(upstreamRequests).toHaveLength(seen);
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
