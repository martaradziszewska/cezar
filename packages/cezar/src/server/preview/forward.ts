import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * Forwarding to ONE loopback dev server, shared by the Design Mode mirror and the share listener
 * (spec 2026-11-26-preview-share-link § Mechanism step 2). Each listener does its own gating first.
 */

/** HTML is buffered whole to place the script tag. Past this it is passed through untouched —
 *  a page that large is not a dev server's document, and holding it would be the wrong trade. */
export const HTML_BUFFER_MAX = 4 * 1024 * 1024;

/** Hop-by-hop headers: they describe one connection and must not be copied onto the next. */
export const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

export interface ForwardOptions {
  /** The one loopback origin requests go to. */
  upstream: URL;
  /** This listener's own origin as its pages see it: only requests from it are made same-origin. */
  own: string;
  /** Request cookies removed before forwarding. Given, `Set-Cookie` also loses its `Domain`. */
  dropCookies?: readonly string[];
  rewriteAnswer?(headers: Record<string, string | string[]>): void;
  injectHtml(html: string): string;
  /** The 502 body when the upstream cannot be reached. */
  unreachable: string;
}

/** `[::1]` → `::1`: `URL.hostname` keeps the brackets, a socket address does not take them. */
export function socketHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

export function portOf(url: URL): number {
  return url.port === '' ? 80 : Number(url.port);
}

/** The `Cookie` header without `names`; `undefined` when nothing is left. */
export function stripCookies(header: string | undefined, names: readonly string[]): string | undefined {
  if (header === undefined) return undefined;
  const pairs = header.split(';');
  const kept = pairs.filter((pair) => !names.includes(pair.split('=')[0]!.trim()));
  if (kept.length === pairs.length) return header;
  const joined = kept.map((pair) => pair.trim()).join('; ');
  return joined === '' ? undefined : joined;
}

/** A host-only cookie stays host-only on the tunnel's name: `Domain=localhost` would be refused
 *  there (spec 2026-11-26-preview-share-link § Exposure, "The app's session"). */
export function stripSetCookieDomain(value: string | string[]): string | string[] {
  const strip = (cookie: string): string => {
    const [pair, ...attributes] = cookie.split(';');
    const kept = attributes.filter((attribute) => attribute.split('=')[0]!.trim().toLowerCase() !== 'domain');
    return [pair, ...kept].join(';');
  };
  return Array.isArray(value) ? value.map(strip) : strip(value);
}

/** The request's headers as the app should see them. */
export function forwardHeaders(req: IncomingMessage, options: ForwardOptions): Record<string, string | string[]> {
  const { upstream, own } = options;
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers[name] = value;
  }
  headers.host = upstream.host;
  // Only a request from the proxy's OWN pages is presented as same-origin. A foreign origin is
  // passed through untouched so the app's CORS and CSRF checks judge it as they always would.
  if (typeof headers.origin === 'string' && headers.origin === own) headers.origin = upstream.origin;
  if (typeof headers.referer === 'string' && headers.referer.startsWith(`${own}/`)) {
    headers.referer = upstream.origin + headers.referer.slice(own.length);
  }
  if (options.dropCookies !== undefined) {
    const cookie = stripCookies(typeof headers.cookie === 'string' ? headers.cookie : undefined, options.dropCookies);
    if (cookie === undefined) delete headers.cookie;
    else headers.cookie = cookie;
  }
  return headers;
}

export function forwardRequest(req: IncomingMessage, res: ServerResponse, options: ForwardOptions): void {
  const { upstream, own } = options;
  const headers = forwardHeaders(req, options);
  // Uncompressed, so an HTML answer can be read and given its script tag. Loopback: the bytes
  // saved by compression were never crossing a network.
  headers['accept-encoding'] = 'identity';

  const outgoing = httpRequest(
    { host: socketHost(upstream), port: portOf(upstream), method: req.method, path: req.url, headers },
    (incoming) => {
      const answer: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        answer[name] = value;
      }
      options.rewriteAnswer?.(answer);
      if (options.dropCookies !== undefined && answer['set-cookie'] !== undefined) {
        answer['set-cookie'] = stripSetCookieDomain(answer['set-cookie']);
      }
      // A redirect to the app's own origin stays inside the proxy; one that leaves it, leaves.
      if (typeof answer.location === 'string' && answer.location.startsWith(upstream.origin)) {
        answer.location = own + answer.location.slice(upstream.origin.length);
      }
      const status = incoming.statusCode ?? 502;
      const type = String(incoming.headers['content-type'] ?? '');
      const encoded = incoming.headers['content-encoding'];
      const html = /^text\/html\b/i.test(type) && (encoded === undefined || encoded === 'identity') && req.method !== 'HEAD';
      if (!html) {
        res.writeHead(status, answer);
        incoming.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let passthrough = false;
      incoming.on('data', (chunk: Buffer) => {
        if (passthrough) {
          res.write(chunk);
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
        if (size > HTML_BUFFER_MAX) {
          passthrough = true;
          res.writeHead(status, answer);
          res.write(Buffer.concat(chunks));
          chunks.length = 0;
        }
      });
      incoming.on('end', () => {
        if (passthrough) {
          res.end();
          return;
        }
        const body = Buffer.from(options.injectHtml(Buffer.concat(chunks).toString('utf8')), 'utf8');
        delete answer['content-length'];
        res.writeHead(status, { ...answer, 'content-length': String(body.length) });
        res.end(body);
      });
      incoming.on('error', () => res.destroy());
    },
  );
  outgoing.on('error', () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(options.unreachable);
  });
  res.on('close', () => outgoing.destroy());
  req.pipe(outgoing);
}

/** WebSocket upgrades (a dev server's hot reload) are spliced through byte for byte. `onClose`
 *  runs on every close or error of either side, so it must be idempotent. */
export function spliceUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, options: ForwardOptions, onClose?: () => void): void {
  const headers = forwardHeaders(req, options);
  // `forwardHeaders` drops hop-by-hop headers, and an upgrade is made of exactly two of them.
  headers.connection = 'Upgrade';
  headers.upgrade = req.headers.upgrade ?? 'websocket';

  const upstream: Socket = connect(portOf(options.upstream), socketHost(options.upstream));
  const release = () => {
    onClose?.();
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      for (const single of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${single}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', release);
  upstream.on('close', release);
  socket.on('error', release);
  socket.on('close', release);
}
