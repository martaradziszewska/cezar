import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { isLoopbackHostHeader } from '../capabilities.ts';
import { forwardRequest, spliceUpgrade, type ForwardOptions } from './forward.ts';
import { PICKER_PATH, pickerScript } from './picker-script.ts';

/**
 * The Design Mode proxy (spec `.ai/specs/2026-10-09-design-mode.md`).
 *
 * A task's Preview tab frames the task's dev server, which is cross-origin to the cockpit —
 * so the cockpit cannot see what the user points at. This re-serves ONE loopback dev server on a
 * second loopback port with a picker script injected into its HTML, and the picker reports the
 * clicked element to the cockpit over `postMessage`.
 *
 * What makes it safe to exist, each of which is load-bearing:
 *
 *  - It is on its OWN origin (its own port), never the cockpit's: serving worktree content from
 *    the cockpit's origin would put it beside the API; a different port is a different origin, and the API's
 *    request-origin guard refuses mutating requests from it like from any other foreign origin.
 *  - It forwards ONLY to the loopback origin it was opened for. It is not an open proxy and can
 *    reach nothing a local page could not already reach directly.
 *  - It checks `Host` itself (`isLoopbackHostHeader`). Dev servers defend against DNS rebinding by
 *    checking `Host`; a proxy that rewrote `Host` without checking it first would be the bypass.
 *  - It rewrites `Origin` only when the request really came from its own pages. Any other origin
 *    reaches the app exactly as the browser sent it, so the app's own CORS/CSRF rules still hold.
 *  - It listens on 127.0.0.1 only, and only after a user switched Design Mode on.
 *
 * Lifetime — every way a listener stops: it has served nothing and holds no live socket for
 * `idleMs`; it is the least recently used when a new one would exceed `max`; or the server shuts
 * down (`closeAll`). Nothing is written to disk, so a restart simply forgets them and the cockpit
 * asks again.
 */

const SCRIPT_TAG = `<script src="${PICKER_PATH}" data-cezar-design></script>`;

export type DesignProxyResult = { ok: true; origin: string } | { ok: false; reason: string };

export interface DesignProxiesOptions {
  /** How long an untouched listener with no live socket survives. */
  idleMs?: number;
  /** How many dev servers can be mirrored at once. */
  max?: number;
}

interface Entry {
  key: string;
  upstream: URL;
  parentOrigin: string;
  server: Server;
  port: number;
  lastUsed: number;
  sockets: Set<Duplex>;
}

/** `http://localhost:5173` from anything a user could have typed, or a reason it will not do. */
export function parseDesignTarget(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not an address' };
  }
  // http only: a loopback https dev server has a certificate this process has no reason to trust,
  // and silently skipping verification is not a decision to make on the user's behalf.
  if (url.protocol !== 'http:') return { ok: false, reason: 'Design Mode works on local http:// addresses' };
  if (!isLoopbackHostHeader(url.host)) return { ok: false, reason: 'Design Mode works on local addresses only' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'not an address' };
  return { ok: true, url: new URL(url.origin) };
}

function parseParentOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!isLoopbackHostHeader(url.host)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Where a script tag goes: as early as a parser allows, so it is in place before the app's
 *  own scripts can throw. The share listener places its own tag here too. */
export function injectTag(html: string, tag: string): string {
  for (const pattern of [/<head[^>]*>/i, /<html[^>]*>/i, /<!doctype[^>]*>/i]) {
    const match = pattern.exec(html);
    if (match) {
      const at = match.index + match[0].length;
      return html.slice(0, at) + tag + html.slice(at);
    }
  }
  return tag + html;
}

export function injectPicker(html: string): string {
  return injectTag(html, SCRIPT_TAG);
}

/**
 * Lets the cockpit frame the mirror when the app forbids embedding (`X-Frame-Options: SAMEORIGIN`,
 * `frame-ancestors 'self'` — Next.js apps commonly send both). Only the cockpit origin is added;
 * the rest of the app's CSP is left exactly as sent.
 */
export function allowFramingBy(headers: Record<string, string | string[]>, parentOrigin: string): void {
  const xfo = headers['x-frame-options'];
  delete headers['x-frame-options'];
  const csp = headers['content-security-policy'];
  const policies = csp === undefined ? [] : Array.isArray(csp) ? csp : [csp];
  if (!policies.some((policy) => /(^|;)\s*frame-ancestors(\s|;|$)/i.test(policy))) {
    // `X-Frame-Options` was the only framing policy: dropping it bare would let ANY page frame the mirror.
    if (xfo === undefined) return;
    const self = String(xfo).trim().toUpperCase() === 'SAMEORIGIN' ? "'self' " : '';
    headers['content-security-policy'] = [...policies, `frame-ancestors ${self}${parentOrigin}`];
    return;
  }
  const rewrite = (policy: string): string =>
    policy
      .split(';')
      .map((directive) => {
        const [name, ...sources] = directive.trim().split(/\s+/);
        if (name?.toLowerCase() !== 'frame-ancestors') return directive;
        // `'none'` cannot be combined with a source, so it is replaced rather than extended.
        const kept = sources.filter((source) => source.toLowerCase() !== "'none'");
        const indent = /^\s*/.exec(directive)![0];
        return `${indent}frame-ancestors ${[...kept, parentOrigin].join(' ')}`;
      })
      .join(';');
  const rewritten = policies.map(rewrite);
  headers['content-security-policy'] = Array.isArray(csp) ? rewritten : rewritten[0]!;
}

export class DesignProxies {
  private readonly entries = new Map<string, Entry>();
  private readonly idleMs: number;
  private readonly max: number;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(options: DesignProxiesOptions = {}) {
    this.idleMs = options.idleMs ?? 30 * 60_000;
    this.max = options.max ?? 8;
  }

  /** How many listeners are open — for tests and for nothing else. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * The proxy origin for `target`, opening a listener the first time it is asked for.
   *
   * `forbidden` are origins that must never be mirrored: the cockpit and the API themselves. A
   * mirrored cockpit would be this server's API re-served with `Origin` rewritten to look
   * same-origin — the request-origin guard, defeated by the very thing meant to stay outside it.
   */
  async open(input: { target: string; parentOrigin: string; forbidden?: readonly string[] }): Promise<DesignProxyResult> {
    const target = parseDesignTarget(input.target);
    if (!target.ok) return target;
    const parentOrigin = parseParentOrigin(input.parentOrigin);
    if (parentOrigin === null) return { ok: false, reason: 'Design Mode needs a local cockpit' };
    const upstream = target.url;
    const refused = new Set([parentOrigin, ...(input.forbidden ?? [])].flatMap(loopbackAliases));
    if (loopbackAliases(upstream.origin).some((alias) => refused.has(alias))) {
      return { ok: false, reason: 'Design Mode cannot be pointed at cezar itself' };
    }

    const key = `${upstream.origin}|${parentOrigin}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return { ok: true, origin: this.originOf(existing) };
    }

    while (this.entries.size >= this.max) {
      const oldest = [...this.entries.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0]!;
      this.close(oldest);
    }

    let entry: Entry;
    try {
      entry = await this.listen(key, upstream, parentOrigin);
    } catch (error) {
      return { ok: false, reason: `could not open a local port for Design Mode: ${(error as Error).message}` };
    }
    // Two requests for the same target can race the `listen`; the first one in wins and the
    // other's listener is closed rather than leaked.
    const raced = this.entries.get(key);
    if (raced) {
      entry.server.close();
      return { ok: true, origin: this.originOf(raced) };
    }
    this.entries.set(key, entry);
    this.startSweeper();
    return { ok: true, origin: this.originOf(entry) };
  }

  closeAll(): void {
    for (const entry of [...this.entries.values()]) this.close(entry);
  }

  /** The hostname the user typed, with the proxy's port: cookies are scoped by host and not by
   *  port, so keeping `localhost` as `localhost` keeps the app's session. `[::1]` is the one
   *  exception — the listener is IPv4-only. */
  private originOf(entry: Entry): string {
    const host = entry.upstream.hostname.startsWith('[') ? '127.0.0.1' : entry.upstream.hostname;
    return `http://${host}:${entry.port}`;
  }

  private close(entry: Entry): void {
    this.entries.delete(entry.key);
    for (const socket of entry.sockets) socket.destroy();
    entry.server.close();
    entry.server.closeAllConnections?.();
    if (this.entries.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - this.idleMs;
      for (const entry of [...this.entries.values()]) {
        if (entry.sockets.size === 0 && entry.lastUsed < cutoff) this.close(entry);
      }
    }, Math.max(1_000, Math.min(60_000, this.idleMs)));
    // Never the reason a process stays alive.
    this.sweeper.unref();
  }

  private listen(key: string, upstream: URL, parentOrigin: string): Promise<Entry> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      const entry: Entry = { key, upstream, parentOrigin, server, port: 0, lastUsed: Date.now(), sockets: new Set() };
      server.on('request', (req, res) => this.handle(entry, req, res));
      server.on('upgrade', (req, socket, head) => this.upgrade(entry, req, socket, head));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          server.close();
          reject(new Error('no port'));
          return;
        }
        entry.port = address.port;
        server.off('error', reject);
        // A listener error after boot must not take the process down with an unhandled event.
        server.on('error', () => {});
        resolve(entry);
      });
    });
  }

  /** What the shared forwarding needs to mirror `entry` for this request. */
  private forwardOptions(entry: Entry, req: IncomingMessage): ForwardOptions {
    return {
      upstream: entry.upstream,
      own: `http://${req.headers.host}`,
      rewriteAnswer: (headers) => allowFramingBy(headers, entry.parentOrigin),
      injectHtml: injectPicker,
      unreachable: `Design Mode could not reach ${entry.upstream.origin} — is the app still running?`,
    };
  }

  private handle(entry: Entry, req: IncomingMessage, res: ServerResponse): void {
    if (!isLoopbackHostHeader(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
      return;
    }
    entry.lastUsed = Date.now();

    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === PICKER_PATH) {
      res
        .writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
        .end(pickerScript({ parentOrigin: entry.parentOrigin, upstreamOrigin: entry.upstream.origin }));
      return;
    }

    forwardRequest(req, res, this.forwardOptions(entry, req));
  }

  private upgrade(entry: Entry, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!isLoopbackHostHeader(req.headers.host)) {
      socket.destroy();
      return;
    }
    entry.lastUsed = Date.now();
    entry.sockets.add(socket);
    spliceUpgrade(req, socket, head, this.forwardOptions(entry, req), () => {
      entry.sockets.delete(socket);
      entry.lastUsed = Date.now();
    });
  }
}

/** Every loopback spelling of an origin's host, so `localhost:4321` and `127.0.0.1:4321` are
 *  recognised as the same listener when deciding what must not be mirrored. */
export function loopbackAliases(origin: string): string[] {
  try {
    const url = new URL(origin);
    const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
    return isLoopbackHostHeader(url.host) ? [`loopback:${port}`] : [`${url.hostname}:${port}`];
  } catch {
    return [];
  }
}
