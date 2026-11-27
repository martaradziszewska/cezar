import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { GUEST_NAME_MAX, type PreviewShare, type PreviewShareGuest } from '@open-mercato/cezar-contract';

import { injectTag, loopbackAliases, parseDesignTarget, parseParentOrigin } from './design-proxy.ts';
import { forwardRequest, spliceUpgrade, type ForwardOptions } from './forward.ts';

/**
 * The share listener (spec 2026-11-26-preview-share-link § Mechanism 2–7): the only thing between
 * one dev server and the internet. Nothing of the app is forwarded without an allowed guest.
 */

export interface Tunnel {
  origin: string;
  stop(): void;
  onExit(listener: (reason: string) => void): void;
}

/** `start` rejects with a `TunnelError`. `signal` aborts a start that has not answered yet: the
 *  adapter must then leave no process behind. */
export interface TunnelAdapter {
  start(port: number, signal?: AbortSignal): Promise<Tunnel>;
}

export class TunnelError extends Error {
  constructor(
    message: string,
    readonly code: 'no-tunnel' | 'tunnel-failed',
    readonly install?: string,
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

export type ShareStart =
  | { ok: true; share: PreviewShare }
  | { ok: false; status: 400 | 409; error: string; code?: 'no-tunnel' | 'tunnel-failed'; install?: string };

export interface GuestRoutes {
  /** Called only for a cookie-holder on a path under `/__cezar_share__/` other than the join link.
   *  `true` = it answers, now or later; `false` gets the 404. Never the app's. */
  handle(ctx: GuestRequest, req: IncomingMessage, res: ServerResponse): boolean;
}

export interface GuestRequest {
  runId: string;
  projectId: string;
  /** The request path without its query. */
  path: string;
  tunnelOrigin: string;
  upstreamOrigin: string;
  /** `id` is the PUBLIC guest id. Never `null` when `handle` is called. */
  guest: { id: string; state: GuestState; name?: string; code?: string } | null;
  /** Creates this browser's join request. */
  ask(name: string): { code: string } | { error: string };
}

type GuestState = 'new' | 'waiting' | 'allowed' | 'denied' | 'expired';

export interface PreviewSharesOptions {
  tunnel: TunnelAdapter;
  guestRoutes: GuestRoutes;
  /** C10. The default probes `${origin}/api/v1/health`. */
  isCezar?(origin: string): Promise<boolean>;
  /** Fires on start, on every change to the listed guests, and with `null` when the share ends. */
  onChange(projectId: string, runId: string, share: PreviewShare | null, ended?: string): void;
  now?(): number;
  lifetimeMs?: number;
  max?: number;
  maxWaiting?: number;
  waitingMs?: number;
}

export const SHARE_PREFIX = '/__cezar_share__';
export const SHARE_COOKIE = '__cezar_share';
const JOIN_PREFIX = `${SHARE_PREFIX}/join/`;
const WAIT_PATH = `${SHARE_PREFIX}/wait`;
const GUEST_TAG = `<script src="${SHARE_PREFIX}/guest.js" data-cezar-design></script>`;
const GONE = 'This link is no longer active.';
const CEZAR_ITSELF = 'Sharing cannot be pointed at cezar itself';
const STOPPED = 'Sharing was stopped';
// A tunnel's edge caches static files whatever cookie asked for them, and a cached byte is served
// without reaching the gate (spec 2026-11-26-preview-share-link § Anti-goals).
const UNCACHEABLE = { 'cache-control': 'private, no-store', 'cdn-cache-control': 'no-store' } as const;
/** What the app could send to outrank `UNCACHEABLE` or to date a copy. */
const APP_CACHE_HEADERS = ['expires', 'cloudflare-cdn-cache-control', 'surrogate-control'] as const;

const JOINS_PER_MINUTE = 10;
const JOIN_WINDOW_MS = 60_000;
// Bounds on what a stranger holding the link can make this process remember (spec § Exposure).
const MAX_JOIN_ADDRESSES = 1000;
const MAX_IDLE_GUESTS = 50;
const MAX_DENIED_GUESTS = 100;
const ADDRESS_MAX = 64;
const NEXT_MAX = 2048;
const PROBE_BODY_MAX = 1024 * 1024;

interface Guest {
  /** SHA-256 of the cookie, in full: what a request is matched on. */
  key: string;
  /** The first 16 hex of `key`: the only part that leaves this class. */
  id: string;
  state: GuestState;
  /** When it entered `state`; the oldest is dropped first at a cap. */
  since: number;
  name?: string;
  code?: string;
  requestedAt?: number;
  timer?: NodeJS.Timeout;
  /** In-flight answers and spliced sockets, so Remove cuts them at once. */
  live: Set<{ destroy(): unknown }>;
}

interface Entry {
  runId: string;
  projectId: string;
  upstream: URL;
  /** The tunnel's origin, and its `Host`. */
  origin: string;
  host: string;
  secure: boolean;
  token: string;
  url: string;
  startedAt: number;
  expiresAt: number;
  server: Server;
  sockets: Set<Socket>;
  tunnel: Tunnel;
  timer: NodeJS.Timeout;
  forward: ForwardOptions;
  guests: Map<string, Guest>;
  joins: Map<string, number[]>;
}

interface Listener {
  server: Server;
  port: number;
  sockets: Set<Socket>;
  /** Until a share is bound, every request is refused. */
  slot: { entry: Entry | null };
}

interface Pending {
  origin: string;
  /** Aborted by Stop, by shutdown and by a start that failed: the adapter's cue to leave nothing behind. */
  abort: AbortController;
  result: Promise<ShareStart>;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Constant time, and of equal length whatever was sent: both sides are digests. */
function sameSecret(candidate: string, secret: string): boolean {
  return timingSafeEqual(sha256(candidate), sha256(secret));
}

function plain(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...UNCACHEABLE, ...headers }).end(body);
}

function uncacheable(headers: Record<string, string | string[]>): void {
  for (const name of APP_CACHE_HEADERS) delete headers[name];
  Object.assign(headers, UNCACHEABLE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A same-origin relative path or nothing: a browser reads `//`, `/\` and a dropped tab as another site.
 *  The waiting page is directly addressable, so it applies this to its own `next` too. */
export function safeNext(next: string | null): string | null {
  if (next === null || next.length > NEXT_MAX) return null;
  return /^\/(?![/\\])[^\u0000-\u001f\u007f]*$/.test(next) ? next : null;
}

/** The name goes into the owner's review message, so it stays on one line. */
function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, GUEST_NAME_MAX).trim();
}

function clientAddress(req: IncomingMessage): string {
  const named = req.headers['cf-connecting-ip'];
  const address = typeof named === 'string' && named !== '' ? named : (req.socket.remoteAddress ?? 'unknown');
  return address.slice(0, ADDRESS_MAX);
}

/**
 * C10's default. A narrow mark instead of `healthResponseSchema`: the cezar a task previews is
 * another version of it, and one the strict schema rejects would be shared.
 */
export async function answersAsCezar(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/api/v1/health`, {
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok || res.body === null) return false;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > PROBE_BODY_MAX) return false;
      chunks.push(chunk);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(body) && typeof body.version === 'string' && typeof body.repoRoot === 'string' && isRecord(body.capabilities);
  } catch {
    // An app that is down is not a cezar; the gate and the 502 page take it from there.
    return false;
  }
}

export class PreviewShares {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Pending>();
  private readonly tunnel: TunnelAdapter;
  private readonly guestRoutes: GuestRoutes;
  private readonly isCezar: (origin: string) => Promise<boolean>;
  private readonly onChange: PreviewSharesOptions['onChange'];
  private readonly now: () => number;
  private readonly lifetimeMs: number;
  private readonly max: number;
  private readonly maxWaiting: number;
  private readonly waitingMs: number;

  constructor(options: PreviewSharesOptions) {
    this.tunnel = options.tunnel;
    this.guestRoutes = options.guestRoutes;
    this.isCezar = options.isCezar ?? answersAsCezar;
    this.onChange = options.onChange;
    this.now = options.now ?? Date.now;
    this.lifetimeMs = options.lifetimeMs ?? 8 * 60 * 60_000;
    this.max = options.max ?? 4;
    this.maxWaiting = options.maxWaiting ?? 5;
    this.waitingMs = options.waitingMs ?? 10 * 60_000;
  }

  start(input: { runId: string; projectId: string; target: string; parentOrigin: string; forbidden: readonly string[] }): Promise<ShareStart> {
    return Promise.resolve(this.begin(input));
  }

  get(runId: string): PreviewShare | null {
    const entry = this.entries.get(runId);
    return entry !== undefined && this.settle(entry) ? this.snapshot(entry) : null;
  }

  list(): Array<{ projectId: string; share: PreviewShare }> {
    return [...this.entries.values()]
      .filter((entry) => this.settle(entry))
      .map((entry) => ({ projectId: entry.projectId, share: this.snapshot(entry) }));
  }

  /** Also cancels a start still waiting on its tunnel, so no tunnel arrives after a stop. */
  stop(runId: string, ended?: string): boolean {
    const pending = this.pending.get(runId);
    const starting = pending !== undefined && !pending.abort.signal.aborted;
    pending?.abort.abort();
    const entry = this.entries.get(runId);
    if (entry !== undefined) this.end(entry, ended);
    return entry !== undefined || starting;
  }

  decide(runId: string, guestId: string, decision: 'allow' | 'deny'): boolean {
    const entry = this.entries.get(runId);
    if (entry === undefined || !this.settle(entry)) return false;
    const guest = this.find(entry, guestId);
    if (guest === undefined || guest.state !== 'waiting') return false;
    this.move(entry, guest, decision === 'allow' ? 'allowed' : 'denied');
    this.notify(entry);
    return true;
  }

  /** Remove: the browser is refused like a denied one, and what it had open is cut. */
  removeGuest(runId: string, guestId: string): boolean {
    const entry = this.entries.get(runId);
    if (entry === undefined || !this.settle(entry)) return false;
    const guest = this.find(entry, guestId);
    if (guest === undefined || (guest.state !== 'waiting' && guest.state !== 'allowed')) return false;
    this.move(entry, guest, 'denied');
    for (const open of [...guest.live]) open.destroy();
    guest.live.clear();
    this.notify(entry);
    return true;
  }

  closeAll(): void {
    for (const pending of this.pending.values()) pending.abort.abort();
    for (const entry of [...this.entries.values()]) this.end(entry);
  }

  /** Everything decided before the first `await`, so two requests for one run cannot both open. */
  private begin(input: { runId: string; projectId: string; target: string; parentOrigin: string; forbidden: readonly string[] }): ShareStart | Promise<ShareStart> {
    const target = parseDesignTarget(input.target);
    if (!target.ok) return { ok: false, status: 400, error: target.reason.replace('Design Mode', 'Sharing') };
    const upstream = target.url;
    const parentOrigin = parseParentOrigin(input.parentOrigin);
    if (parentOrigin === null) return { ok: false, status: 400, error: 'Sharing needs a local cockpit' };
    const refused = new Set([parentOrigin, ...input.forbidden].flatMap(loopbackAliases));
    if (loopbackAliases(upstream.origin).some((alias) => refused.has(alias))) return { ok: false, status: 400, error: CEZAR_ITSELF };

    const live = this.entries.get(input.runId);
    if (live !== undefined && this.settle(live)) {
      if (live.upstream.origin === upstream.origin) return { ok: true, share: this.snapshot(live) };
      return { ok: false, status: 409, error: `Already sharing ${live.upstream.origin} — stop it first` };
    }
    // A stopped start is still unwinding: it is not a share, and not the answer to a new request.
    const starting = this.pending.get(input.runId);
    if (starting !== undefined && !starting.abort.signal.aborted) {
      if (starting.origin === upstream.origin) return starting.result;
      return { ok: false, status: 409, error: `Already sharing ${starting.origin} — stop it first` };
    }
    const shares = [...this.entries.values()].filter((entry) => this.settle(entry)).length;
    const starts = [...this.pending.values()].filter((other) => !other.abort.signal.aborted).length;
    if (shares + starts >= this.max) {
      return { ok: false, status: 409, error: `${this.max} share links are already live — stop one first` };
    }

    const { pathname, search } = new URL(input.target);
    const pending: Pending = { origin: upstream.origin, abort: new AbortController(), result: Promise.resolve({ ok: false, status: 409, error: STOPPED }) };
    pending.result = this.open(input.runId, input.projectId, upstream, pathname + search, pending)
      .then(
        (started) => {
          if (!started.ok) pending.abort.abort();
          return started;
        },
        (error: unknown) => {
          pending.abort.abort();
          throw error;
        },
      )
      .finally(() => {
        if (this.pending.get(input.runId) === pending) this.pending.delete(input.runId);
      });
    this.pending.set(input.runId, pending);
    return pending.result;
  }

  private async open(runId: string, projectId: string, upstream: URL, path: string, pending: Pending): Promise<ShareStart> {
    const stopped = (): boolean => pending.abort.signal.aborted;
    // Fail closed: a probe that throws or rejects is not a "no".
    let cezar = true;
    try {
      cezar = await this.isCezar(upstream.origin);
    } catch {
      cezar = true;
    }
    if (cezar) return { ok: false, status: 400, error: CEZAR_ITSELF };
    if (stopped()) return { ok: false, status: 409, error: STOPPED };

    let listener: Listener;
    try {
      listener = await this.listen();
    } catch (error) {
      return { ok: false, status: 409, error: `could not open a local port for Sharing: ${(error as Error).message}` };
    }
    /** Undoes a start that will not become a share; an adapter that throws must not keep the port open. */
    const discard = (started?: Tunnel): void => {
      try {
        started?.stop();
      } catch {
        // The listener closes either way.
      }
      listener.server.close();
      listener.server.closeAllConnections();
    };
    if (stopped()) {
      discard();
      return { ok: false, status: 409, error: STOPPED };
    }

    let tunnel: Tunnel;
    try {
      tunnel = await this.tunnel.start(listener.port, pending.abort.signal);
    } catch (error) {
      discard();
      if (stopped()) return { ok: false, status: 409, error: STOPPED };
      const known = error instanceof TunnelError ? error : null;
      return {
        ok: false,
        status: 409,
        error: error instanceof Error ? error.message : 'The tunnel could not start',
        code: known?.code ?? 'tunnel-failed',
        ...(known?.install !== undefined ? { install: known.install } : {}),
      };
    }
    let origin: URL | null = null;
    try {
      origin = new URL(tunnel.origin);
    } catch {
      origin = null;
    }
    if (stopped()) {
      discard(tunnel);
      return { ok: false, status: 409, error: STOPPED };
    }
    if (origin === null || (origin.protocol !== 'https:' && origin.protocol !== 'http:')) {
      discard(tunnel);
      return { ok: false, status: 409, error: 'The tunnel did not give an address', code: 'tunnel-failed' };
    }

    const startedAt = this.now();
    const token = randomBytes(32).toString('hex');
    const entry: Entry = {
      runId,
      projectId,
      upstream,
      origin: origin.origin,
      host: origin.host,
      secure: origin.protocol === 'https:',
      token,
      url: `${origin.origin}${JOIN_PREFIX}${token}?next=${encodeURIComponent(path)}`,
      startedAt,
      expiresAt: startedAt + this.lifetimeMs,
      server: listener.server,
      sockets: listener.sockets,
      tunnel,
      timer: setTimeout(() => this.end(entry, 'expired'), this.lifetimeMs),
      forward: {
        upstream,
        own: origin.origin,
        dropCookies: [SHARE_COOKIE],
        rewriteAnswer: uncacheable,
        injectHtml: (html) => injectTag(html, GUEST_TAG),
        unreachable: 'The app is not running right now.',
      },
      guests: new Map(),
      joins: new Map(),
    };
    // Never the reason a process stays alive.
    entry.timer.unref();
    this.entries.set(runId, entry);
    listener.slot.entry = entry;
    tunnel.onExit((reason) => {
      const why = String(reason ?? '').trim().slice(0, 200);
      this.end(entry, why === '' ? 'cloudflared exited' : `cloudflared exited: ${why}`);
    });
    this.notify(entry);
    return { ok: true, share: this.snapshot(entry) };
  }

  private listen(): Promise<Listener> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      const sockets = new Set<Socket>();
      const slot: Listener['slot'] = { entry: null };
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      // A throw in a listener is an uncaught exception in the cockpit; nothing is forwarded after one.
      server.on('request', (req, res) => {
        try {
          // The default for every answer: the 502 page and the guest routes' included.
          for (const [name, value] of Object.entries(UNCACHEABLE)) res.setHeader(name, value);
          if (slot.entry === null) plain(res, 403, 'forbidden');
          else this.handle(slot.entry, req, res);
        } catch {
          try {
            if (res.headersSent) res.destroy();
            else plain(res, 500, 'error');
          } catch {
            res.destroy();
          }
        }
      });
      server.on('upgrade', (req, socket, head) => {
        try {
          if (slot.entry === null) socket.destroy();
          else this.upgrade(slot.entry, req, socket, head);
        } catch {
          socket.destroy();
        }
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          server.close();
          reject(new Error('no port'));
          return;
        }
        server.off('error', reject);
        // A listener error after boot must not take the process down with an unhandled event.
        server.on('error', () => {});
        resolve({ server, port: address.port, sockets, slot });
      });
    });
  }

  /** The gate (spec § Mechanism 7). Every branch but the last answers without touching the app. */
  private handle(entry: Entry, req: IncomingMessage, res: ServerResponse): void {
    // Over: `end` has already closed this socket with every other one.
    if (!this.settle(entry)) {
      res.destroy();
      return;
    }
    if ((req.headers.host ?? '').toLowerCase() !== entry.host) {
      plain(res, 403, 'forbidden');
      return;
    }
    const url = req.url ?? '';
    // An absolute request line names another server; only a path is ever forwarded.
    if (!url.startsWith('/')) {
      plain(res, 400, 'bad request');
      return;
    }
    const path = url.split('?')[0]!;
    if (path.startsWith(JOIN_PREFIX)) {
      this.join(entry, req, res, url);
      return;
    }
    const guest = this.guestOf(entry, req);
    if (path === SHARE_PREFIX || path.startsWith(`${SHARE_PREFIX}/`)) {
      let handled = false;
      if (guest !== null) {
        try {
          handled = this.guestRoutes.handle(this.context(entry, guest, path), req, res);
        } catch {
          // Half an answer cannot be finished by anyone: cut it instead of leaving it open.
          if (res.headersSent) res.destroy();
          handled = res.headersSent;
        }
      }
      if (!handled && !res.headersSent) plain(res, 404, GONE);
      return;
    }
    if (guest === null) {
      plain(res, 404, GONE);
      return;
    }
    if (guest.state !== 'allowed') {
      res.writeHead(302, { location: WAIT_PATH, ...UNCACHEABLE }).end();
      return;
    }
    // Only a browser already let in gets here, so this is not a guess at the token.
    if (url.includes(entry.token)) {
      plain(res, 404, GONE);
      return;
    }
    guest.live.add(res);
    res.on('close', () => guest.live.delete(res));
    forwardRequest(req, res, entry.forward);
  }

  private upgrade(entry: Entry, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = req.url ?? '';
    const path = url.split('?')[0]!;
    const open =
      this.settle(entry) &&
      (req.headers.host ?? '').toLowerCase() === entry.host &&
      url.startsWith('/') &&
      path !== SHARE_PREFIX &&
      !path.startsWith(`${SHARE_PREFIX}/`) &&
      !url.includes(entry.token);
    const guest = open ? this.guestOf(entry, req) : null;
    if (guest === null || guest.state !== 'allowed') {
      socket.destroy();
      return;
    }
    guest.live.add(socket);
    spliceUpgrade(req, socket, head, entry.forward, () => guest.live.delete(socket));
  }

  private join(entry: Entry, req: IncomingMessage, res: ServerResponse, url: string): void {
    if (!this.admit(entry, clientAddress(req))) {
      plain(res, 429, 'Too many attempts. Try again in a minute.', { 'retry-after': '60' });
      return;
    }
    const mark = url.indexOf('?');
    const candidate = url.slice(JOIN_PREFIX.length, mark === -1 ? undefined : mark);
    if (!sameSecret(candidate, entry.token) || req.method !== 'GET') {
      plain(res, 404, GONE);
      return;
    }
    const next = safeNext(mark === -1 ? null : new URLSearchParams(url.slice(mark + 1)).get('next'));
    const headers: Record<string, string> = {
      location: next === null ? WAIT_PATH : `${WAIT_PATH}?next=${encodeURIComponent(next)}`,
      'referrer-policy': 'no-referrer',
      ...UNCACHEABLE,
    };
    // A browser that already holds a cookie keeps it: a denied one must not become new by reloading.
    if (this.guestOf(entry, req) === null) {
      const secret = this.admitGuest(entry);
      headers['set-cookie'] = `${SHARE_COOKIE}=${secret}; HttpOnly; SameSite=Lax; Path=/${entry.secure ? '; Secure' : ''}`;
    }
    res.writeHead(302, headers).end();
  }

  /** At most 10 joins a minute per address, counted before the token is looked at. */
  private admit(entry: Entry, address: string): boolean {
    const now = this.now();
    const recent = (entry.joins.get(address) ?? []).filter((at) => now - at < JOIN_WINDOW_MS);
    if (recent.length >= JOINS_PER_MINUTE) return false;
    if (!entry.joins.has(address) && entry.joins.size >= MAX_JOIN_ADDRESSES) {
      for (const [known, times] of entry.joins) {
        if (times.every((at) => now - at >= JOIN_WINDOW_MS)) entry.joins.delete(known);
      }
      if (entry.joins.size >= MAX_JOIN_ADDRESSES) return false;
    }
    recent.push(now);
    entry.joins.set(address, recent);
    return true;
  }

  /** A new browser's cookie value. Only its hash is kept. */
  private admitGuest(entry: Entry): string {
    for (;;) {
      const secret = randomBytes(32).toString('hex');
      const key = sha256(secret).toString('hex');
      const id = key.slice(0, 16);
      if (this.find(entry, id) !== undefined) continue;
      entry.guests.set(key, { key, id, state: 'new', since: this.now(), live: new Set() });
      this.trim(entry, ['new', 'expired'], MAX_IDLE_GUESTS);
      return secret;
    }
  }

  private guestOf(entry: Entry, req: IncomingMessage): Guest | null {
    const header = req.headers.cookie;
    if (header === undefined) return null;
    let tried = 0;
    for (const pair of header.split(';')) {
      const at = pair.indexOf('=');
      if (at === -1 || pair.slice(0, at).trim() !== SHARE_COOKIE) continue;
      const value = pair.slice(at + 1).trim();
      if (!/^[a-f0-9]{64}$/.test(value)) continue;
      if ((tried += 1) > 4) break;
      const guest = entry.guests.get(sha256(value).toString('hex'));
      if (guest !== undefined) return guest;
    }
    return null;
  }

  private context(entry: Entry, guest: Guest, path: string): GuestRequest {
    return {
      runId: entry.runId,
      projectId: entry.projectId,
      path,
      tunnelOrigin: entry.origin,
      upstreamOrigin: entry.upstream.origin,
      guest: {
        id: guest.id,
        state: guest.state,
        ...(guest.name !== undefined ? { name: guest.name } : {}),
        ...(guest.code !== undefined ? { code: guest.code } : {}),
      },
      ask: (name) => this.ask(entry, guest, name),
    };
  }

  private ask(entry: Entry, guest: Guest, raw: string): { code: string } | { error: string } {
    if (!this.settle(entry) || entry.guests.get(guest.key) !== guest) return { error: GONE };
    if (guest.state === 'denied') return { error: 'The owner declined this request.' };
    // Asking twice changes nothing: the owner allows the name and the code they first saw.
    if ((guest.state === 'waiting' || guest.state === 'allowed') && guest.code !== undefined) return { code: guest.code };
    const name = cleanName(raw);
    if (name === '') return { error: 'Enter your name.' };
    const waiting = [...entry.guests.values()].filter((other) => other.state === 'waiting').length;
    if (waiting >= this.maxWaiting) return { error: 'Too many people are waiting to be let in. Try again in a few minutes.' };
    const code = String(randomInt(10_000)).padStart(4, '0');
    guest.name = name;
    guest.code = code;
    guest.requestedAt = this.now();
    this.move(entry, guest, 'waiting');
    guest.timer = setTimeout(() => {
      if (guest.state !== 'waiting' || entry.guests.get(guest.key) !== guest) return;
      this.move(entry, guest, 'expired');
      this.notify(entry);
    }, this.waitingMs);
    guest.timer.unref();
    this.notify(entry);
    return { code };
  }

  private find(entry: Entry, guestId: string): Guest | undefined {
    for (const guest of entry.guests.values()) {
      if (guest.id === guestId) return guest;
    }
    return undefined;
  }

  private move(entry: Entry, guest: Guest, state: GuestState): void {
    if (guest.timer !== undefined) clearTimeout(guest.timer);
    delete guest.timer;
    guest.state = state;
    guest.since = this.now();
    if (state === 'expired') this.trim(entry, ['new', 'expired'], MAX_IDLE_GUESTS);
    if (state === 'denied') this.trim(entry, ['denied'], MAX_DENIED_GUESTS);
  }

  /** Forgets the oldest guests in `states` past `max`; a forgotten cookie is no cookie. */
  private trim(entry: Entry, states: readonly GuestState[], max: number): void {
    const pool = [...entry.guests.values()].filter((guest) => states.includes(guest.state)).sort((a, b) => a.since - b.since);
    for (const guest of pool.slice(0, Math.max(0, pool.length - max))) entry.guests.delete(guest.key);
  }

  /**
   * Brings `entry` up to the wall clock; `false` when the share is over. The timers only make an
   * expiry prompt: one that fires late must not leave a link live past the time the cockpit shows.
   */
  private settle(entry: Entry): boolean {
    if (this.entries.get(entry.runId) !== entry) return false;
    const now = this.now();
    if (now >= entry.expiresAt) {
      this.end(entry, 'expired');
      return false;
    }
    let changed = false;
    for (const guest of [...entry.guests.values()]) {
      if (guest.state === 'waiting' && now - (guest.requestedAt ?? 0) >= this.waitingMs) {
        this.move(entry, guest, 'expired');
        changed = true;
      }
    }
    if (changed) this.notify(entry);
    return true;
  }

  private end(entry: Entry, ended?: string): void {
    if (this.entries.get(entry.runId) !== entry) return;
    this.entries.delete(entry.runId);
    clearTimeout(entry.timer);
    for (const guest of entry.guests.values()) {
      if (guest.timer !== undefined) clearTimeout(guest.timer);
    }
    entry.guests.clear();
    entry.joins.clear();
    try {
      entry.tunnel.stop();
    } catch {
      // The listener below closes whatever the adapter did.
    }
    for (const socket of [...entry.sockets]) socket.destroy();
    entry.server.close();
    entry.server.closeAllConnections();
    this.emit(entry.projectId, entry.runId, null, ended);
  }

  private snapshot(entry: Entry): PreviewShare {
    const guests: PreviewShareGuest[] = [];
    for (const guest of entry.guests.values()) {
      if ((guest.state !== 'waiting' && guest.state !== 'allowed') || guest.name === undefined || guest.code === undefined) continue;
      guests.push({
        id: guest.id,
        name: guest.name,
        code: guest.code,
        state: guest.state,
        requestedAt: new Date(guest.requestedAt ?? entry.startedAt).toISOString(),
      });
    }
    guests.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    return {
      runId: entry.runId,
      target: entry.upstream.origin,
      url: entry.url,
      startedAt: new Date(entry.startedAt).toISOString(),
      expiresAt: new Date(entry.expiresAt).toISOString(),
      guests,
    };
  }

  private notify(entry: Entry): void {
    this.emit(entry.projectId, entry.runId, this.snapshot(entry));
  }

  /** A listener that throws must not take a request, or the gate, down with it. */
  private emit(projectId: string, runId: string, share: PreviewShare | null, ended?: string): void {
    try {
      this.onChange(projectId, runId, share, ended);
    } catch {
      // Reported nowhere on purpose: the share's own state is already settled.
    }
  }
}
