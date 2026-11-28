import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { GUEST_NAME_MAX, guestCommentInputSchema, withoutBidiControls, type GuestCommentInput } from '@open-mercato/cezar-contract';
import { z } from 'zod';

import { artifactsCdnEnabled, findArtifact } from '../../runs/artifacts.ts';
import { addGuestComment, deleteGuestComment, readGuestComments, toGuestComment, updateGuestComment } from '../../runs/guest-comments.ts';
import { artifactsDir } from '../../runs/store.ts';
import { SHARED_ARTIFACT_SANDBOX, appendToStream, artifactHeaders, artifactPickerTag, openArtifact } from '../artifacts.ts';
import { guestShellCsp } from './share-guest-shell.ts';
import { SHARE_PREFIX, type GuestRequest, type GuestRoutes } from './share-listener.ts';

/**
 * What the share listener answers with (spec 2026-11-28-asset-share-link § Mechanism 3–9): the
 * waiting page, the guest shell, the asset in its frame, and what an allowed guest saves.
 */

export interface GuestRoutesDeps {
  /** `null` answers 404. */
  dataDirOf(projectId: string): string | null;
  /** After every write that landed: the server publishes the listing. */
  onComments(projectId: string, runId: string): void;
  /** The whole HTML document of an allowed guest's `/`. */
  guestShell(config: { name: string; frameSrc: string; nonce: string; title: string }): string;
  /** `CEZ_ARTIFACTS_CDN`, read per answer as the cockpit's own asset route does. */
  cdnEnabled?(): boolean;
  now?(): number;
  /** How long a body may take to arrive. Tests shorten it. */
  bodyTimeoutMs?: number;
}

const BODY_MAX = 64 * 1024;
/** A 60-character name needs no more. */
const ASK_BODY_MAX = 1024;
const BODY_TIMEOUT_MS = 15_000;
const WRITES_PER_MINUTE = 30;
const WRITE_WINDOW_MS = 60_000;
// Bounds what allowed guests can make this process remember (spec § Exposure, Flooding).
const MAX_WRITERS = 1000;
/** `ctx.path` is raw, so an encoded or longer path is another path, not this one. */
const COMMENT_PATH = /^comments\/([A-Za-z0-9_-]{1,64})$/;

const GONE = 'This link is no longer active.';
/** The shared file is missing for now: the agent may be rewriting it, so the share stays up (spec § States). */
const ASSET_AWAY = 'This page is not available right now.';
const INBOX_FULL = "The reviewer's inbox is full.";
const INVALID = 'That comment cannot be saved as it is.';
const NOT_SAVED = 'The comment could not be saved.';
/** One answer for a comment that is missing and for another guest's: which it was is not told. */
const NO_COMMENT = 'That comment is no longer there.';

const askSchema = z.object({ name: z.string() });
const editSchema = guestCommentInputSchema.pick({ body: true });

type Guest = NonNullable<GuestRequest['guest']>;
type Read = { ok: true; value: unknown } | { ok: false; status: 400 | 408 | 413 };

/** On every answer another page could try to load: no other origin may embed or read it. */
const OWN = { 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' } as const;

// No cache header here or below: the listener's own no-store default must be the one that stands.
function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...OWN, ...headers }).end(JSON.stringify(body));
}

function gone(res: ServerResponse): void {
  json(res, 404, { error: GONE });
}

function fail(res: ServerResponse): void {
  if (res.headersSent) res.destroy();
  else json(res, 500, { error: 'Something went wrong.' });
}

/** Spec § Exposure, forged comment requests: a cross-site page can send neither of these. */
function ownJson(ctx: GuestRequest, req: IncomingMessage): boolean {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  return req.headers.origin === ctx.tunnelOrigin && type === 'application/json';
}

/** Every text field of a comment without bidi controls (spec 2026-11-28-asset-share-link § Exposure):
 *  the owner must read the order the agent will receive. */
function readable(input: GuestCommentInput): GuestCommentInput {
  return {
    selector: withoutBidiControls(input.selector),
    label: withoutBidiControls(input.label),
    excerpt: withoutBidiControls(input.excerpt),
    body: withoutBidiControls(input.body),
    ...(input.component !== undefined ? { component: withoutBidiControls(input.component) } : {}),
  };
}

interface BodyLimits {
  max: number;
  timeoutMs: number;
}

/** `null` when the connection went away first: nobody is left to answer, so nothing is saved. */
function readJson(req: IncomingMessage, limits: BodyLimits): Promise<Read | null> {
  return new Promise((resolve) => {
    if (Number(req.headers['content-length']) > limits.max) {
      resolve({ ok: false, status: 413 });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (read: Read | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(read);
    };
    const timer = setTimeout(() => settle({ ok: false, status: 408 }), limits.timeoutMs);
    // Never the reason a process stays alive.
    timer.unref();
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limits.max) settle({ ok: false, status: 413 });
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        settle({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
      } catch {
        settle({ ok: false, status: 400 });
      }
    });
    req.on('error', () => settle(null));
    req.on('close', () => settle(null));
  });
}

function withBody(req: IncomingMessage, res: ServerResponse, limits: BodyLimits, use: (value: unknown) => void): void {
  readJson(req, limits)
    .then((read) => {
      if (read === null || res.destroyed) return;
      if (read.ok) use(read.value);
      else if (read.status === 400) json(res, 400, { error: INVALID });
      // `connection: close` ends the socket once this is sent, so the rest of the body is not waited for.
      else json(res, read.status, { error: read.status === 413 ? 'That is too large.' : 'That took too long.' }, { connection: 'close' });
    })
    .catch(() => fail(res));
}

export function createGuestRoutes(deps: GuestRoutesDeps): GuestRoutes {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.bodyTimeoutMs ?? BODY_TIMEOUT_MS;
  const writers = new Map<string, number[]>();
  let sweptAt = 0;

  /** 30 writes a minute per guest. At most `MAX_WRITERS` are remembered; an idle one goes at the next minute's sweep. */
  function admit(guestId: string): boolean {
    const at = now();
    if (at - sweptAt >= WRITE_WINDOW_MS) {
      for (const [id, times] of writers) {
        if (times.every((time) => at - time >= WRITE_WINDOW_MS)) writers.delete(id);
      }
      sweptAt = at;
    }
    const recent = (writers.get(guestId) ?? []).filter((time) => at - time < WRITE_WINDOW_MS);
    if (recent.length >= WRITES_PER_MINUTE) return false;
    if (!writers.has(guestId) && writers.size >= MAX_WRITERS) return false;
    recent.push(at);
    writers.set(guestId, recent);
    return true;
  }

  function announce(ctx: GuestRequest): void {
    try {
      deps.onComments(ctx.projectId, ctx.runId);
    } catch {
      // The comment is saved; a listener that throws must not turn that into an error.
    }
  }

  function waiting(res: ServerResponse): void {
    const nonce = randomBytes(16).toString('base64');
    res
      .writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      .end(waitingPage(nonce));
  }

  /** The guest's page (spec § Mechanism 4): cezar's own document, which frames the asset. */
  function shell(ctx: GuestRequest, res: ServerResponse): void {
    const guest = ctx.guest;
    if (guest === null || guest.state !== 'allowed' || guest.name === undefined || ctx.viewBase === undefined) {
      gone(res);
      return;
    }
    const nonce = randomBytes(16).toString('base64');
    // Built before any header goes out: a shell that cannot be built is a 500, not half a page.
    const page = deps.guestShell({ name: guest.name, frameSrc: `${ctx.viewBase}${ctx.asset}`, nonce, title: ctx.assetTitle });
    res
      .writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // `frame-src 'self'` is half of C15: the asset cannot take its frame to another site.
        'content-security-policy': guestShellCsp(nonce),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      .end(page);
  }

  /**
   * One file of the share (spec § Mechanism 5–6): the shared HTML asset, sandboxed with the picker
   * appended, or an image artifact of the run. `findArtifact` is the traversal guard, as on the
   * cockpit's own route.
   */
  async function asset(ctx: GuestRequest, name: string, res: ServerResponse): Promise<void> {
    const dataDir = ctx.viewBase === undefined ? null : deps.dataDirOf(ctx.projectId);
    if (dataDir === null || ctx.viewBase === undefined) {
      gone(res);
      return;
    }
    const dir = artifactsDir(dataDir, ctx.runId);
    const shared = name === ctx.asset;
    const artifact = await findArtifact(dir, name);
    // Another HTML asset, Markdown, JSON: not part of this link.
    const served = artifact !== null && (shared ? artifact.kind === 'html' : artifact.kind === 'image');
    const stream = served ? await openArtifact(dir, name) : null;
    // Remove, or the share ending, cut the answer while the file was being opened.
    if (res.destroyed) {
      void stream?.cancel().catch(() => {});
      return;
    }
    if (artifact === null || stream === null) {
      if (shared) res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }).end(ASSET_AWAY);
      else gone(res);
      return;
    }
    const cdn = (deps.cdnEnabled ?? artifactsCdnEnabled)();
    const headers = shared
      ? artifactHeaders(artifact, cdn, `${ctx.tunnelOrigin}${ctx.viewBase}`, SHARED_ARTIFACT_SANDBOX)
      : artifactHeaders(artifact, cdn);
    // The shell is the picker's only parent; both schemes, as a TLS edge sees one and this server the other.
    const host = new URL(ctx.tunnelOrigin).host;
    const body = shared ? appendToStream(stream, artifactPickerTag([`http://${host}`, `https://${host}`])) : stream;
    // The listener's own `private, no-store` must stand over the artifact's `no-store`.
    res.writeHead(200, { ...headers, 'cache-control': 'private, no-store' });
    const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
    source.on('error', () => res.destroy());
    res.on('close', () => source.destroy());
    source.pipe(res);
  }

  function ask(ctx: GuestRequest, req: IncomingMessage, res: ServerResponse): void {
    withBody(req, res, { max: ASK_BODY_MAX, timeoutMs }, (value) => {
      const parsed = askSchema.safeParse(value);
      if (!parsed.success) {
        json(res, 400, { error: 'Enter your name.' });
        return;
      }
      const asked = ctx.ask(parsed.data.name);
      if ('code' in asked) json(res, 200, { code: asked.code });
      else json(res, 409, { error: asked.error });
    });
  }

  function add(ctx: GuestRequest, guest: Guest, author: string, dir: string, req: IncomingMessage, res: ServerResponse): void {
    withBody(req, res, { max: BODY_MAX, timeoutMs }, (value) => {
      // Unknown keys are dropped: author, guest, id and revision are the server's to set.
      const parsed = guestCommentInputSchema.safeParse(value);
      // Stripped once, here, so every reader gets the stored order; what is left must still be a comment.
      const text = parsed.success ? guestCommentInputSchema.safeParse(readable(parsed.data)) : parsed;
      if (!text.success) {
        json(res, 400, { error: INVALID });
        return;
      }
      // The asset is the share's, never the request's (spec § Mechanism 8).
      const saved = addGuestComment(dir, ctx.runId, { ...text.data, asset: ctx.asset, author, guestId: guest.id }, () => new Date(now()));
      if (saved.ok) {
        announce(ctx);
        json(res, 201, { comment: toGuestComment(saved.comment) });
      } else if (saved.reason === 'full' || saved.reason === 'budget') {
        json(res, 409, { error: INBOX_FULL });
      } else {
        // An add has nothing to find, so `not-found` is the write itself failing. So is anything new.
        json(res, 500, { error: NOT_SAVED });
      }
    });
  }

  function edit(ctx: GuestRequest, guest: Guest, id: string, dir: string, req: IncomingMessage, res: ServerResponse): void {
    withBody(req, res, { max: BODY_MAX, timeoutMs }, (value) => {
      const sent = editSchema.safeParse(value);
      const parsed = sent.success ? editSchema.safeParse({ body: withoutBidiControls(sent.data.body) }) : sent;
      if (!parsed.success) {
        json(res, 400, { error: INVALID });
        return;
      }
      const saved = updateGuestComment(dir, ctx.runId, id, guest.id, parsed.data.body);
      if (saved.ok) {
        announce(ctx);
        json(res, 200, { comment: toGuestComment(saved.comment) });
      } else if (saved.reason === 'not-found') {
        json(res, 404, { error: NO_COMMENT });
      } else if (saved.reason === 'full' || saved.reason === 'budget') {
        json(res, 409, { error: INBOX_FULL });
      } else {
        json(res, 500, { error: NOT_SAVED });
      }
    });
  }

  function answer(ctx: GuestRequest, req: IncomingMessage, res: ServerResponse): void {
    const guest = ctx.guest;
    if (guest === null || !ctx.path.startsWith(`${SHARE_PREFIX}/`)) {
      gone(res);
      return;
    }
    const method = req.method ?? '';
    const name = ctx.path.slice(SHARE_PREFIX.length + 1);
    if (method !== 'GET' && !ownJson(ctx, req)) {
      json(res, 403, { error: 'Forbidden.' });
      return;
    }
    if (method === 'GET' && name === 'wait') {
      waiting(res);
      return;
    }
    if (method === 'GET' && name === 'status') {
      json(res, 200, {
        state: guest.state,
        ...(guest.code !== undefined ? { code: guest.code } : {}),
        ...(guest.name !== undefined ? { name: guest.name } : {}),
      });
      return;
    }
    if (method === 'POST' && name === 'ask') {
      ask(ctx, req, res);
      return;
    }

    // Past this line is the far side of the gate (spec § Mechanism 7): an allowed guest, or 404.
    const author = guest.name;
    if (guest.state !== 'allowed' || author === undefined) {
      gone(res);
      return;
    }
    const id = COMMENT_PATH.exec(name)?.[1];
    const lists = method === 'GET' && name === 'comments';
    const adds = method === 'POST' && name === 'comments';
    const changes = (method === 'PUT' || method === 'DELETE') && id !== undefined;
    const dir = lists || adds || changes ? deps.dataDirOf(ctx.projectId) : null;
    if (dir === null) {
      gone(res);
      return;
    }
    if (lists) {
      // Only this guest's own: another guest's words are the owner's to read, not a visitor's.
      const own = readGuestComments(dir, ctx.runId).filter((comment) => comment.guestId === guest.id);
      json(res, 200, { comments: own.map(toGuestComment) });
      return;
    }
    if (!admit(guest.id)) {
      json(res, 429, { error: 'Too many changes at once. Try again in a minute.' }, { 'retry-after': '60' });
      return;
    }
    if (adds) {
      add(ctx, guest, author, dir, req, res);
    } else if (method === 'PUT' && id !== undefined) {
      edit(ctx, guest, id, dir, req, res);
    } else if (method === 'DELETE' && id !== undefined && deleteGuestComment(dir, ctx.runId, id, guest.id)) {
      // `guest.id` is always passed: without it the store deletes as the owner.
      announce(ctx);
      res.writeHead(204, { 'x-content-type-options': 'nosniff' }).end();
    } else {
      json(res, 404, { error: NO_COMMENT });
    }
  }

  return {
    // Always `true`: a path under the prefix is answered here.
    handle(ctx, req, res) {
      try {
        answer(ctx, req, res);
      } catch {
        fail(res);
      }
      return true;
    },
    shell(ctx, _req, res) {
      try {
        shell(ctx, res);
      } catch {
        fail(res);
      }
    },
    asset(ctx, name, _req, res) {
      asset(ctx, name, res).catch(() => fail(res));
    },
  };
}

function waitingPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>Shared design</title>
<style nonce="${nonce}">${WAITING_STYLE}</style>
</head>
<body>
<main>
<h1>Someone is sharing a design with you.</h1>
<form id="ask">
<label for="name">Your name</label>
<input id="name" name="name" type="text" maxlength="${GUEST_NAME_MAX}" autocomplete="name" required autofocus>
<button id="submit" type="submit">Ask to join</button>
</form>
<div role="status">
<p id="waiting" hidden><span>Waiting to be let in…</span> <span id="code"></span></p>
<p id="message" hidden></p>
</div>
<button id="again" type="button" hidden>Ask again</button>
</main>
<script nonce="${nonce}">${WAITING_SCRIPT}</script>
</body>
</html>
`;
}

const WAITING_STYLE = String.raw`
:root { color-scheme: light dark; --page: #f5f6f8; --card: #ffffff; --text: #16181d; --muted: #5b6270; --line: #cfd4dc; --accent: #1d4ed8; --on-accent: #ffffff; }
@media (prefers-color-scheme: dark) {
  :root { --page: #0f1115; --card: #181b21; --text: #eceef2; --muted: #a3abb8; --line: #333945; --accent: #8ab4ff; --on-accent: #0b1220; }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 1.5rem; background: var(--page); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { width: 100%; max-width: 30rem; padding: 1.75rem; background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
h1 { margin: 0 0 1.25rem; font-size: 1.125rem; font-weight: 600; line-height: 1.35; }
form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.375rem 0.75rem; }
label { grid-column: 1 / -1; font-size: 0.875rem; color: var(--muted); }
input { min-width: 0; padding: 0.5rem 0.625rem; font: inherit; color: var(--text); background: transparent; border: 1px solid var(--line); border-radius: 8px; }
button { padding: 0.5rem 0.875rem; font: inherit; font-weight: 600; color: var(--on-accent); background: var(--accent); border: 1px solid transparent; border-radius: 8px; cursor: pointer; }
button:disabled, input:disabled { opacity: 0.6; cursor: default; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
p { margin: 1.25rem 0 0; }
#waiting { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.25rem 1.5rem; color: var(--muted); }
#code { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
#again { margin-top: 1rem; }
`;

// Everything a server answer or the address bar supplies is written as text or a field value, never as markup.
const WAITING_SCRIPT = String.raw`
(function () {
  'use strict';
  var base = '/__cezar_share__/';
  var failed = 'Something went wrong. Try again.';
  var over = 'This link is no longer active.';
  function el(id) { return document.getElementById(id); }
  var form = el('ask');
  var input = el('name');
  var submit = el('submit');
  var waiting = el('waiting');
  var code = el('code');
  var message = el('message');
  var again = el('again');
  var name = '';
  var timer = null;
  var turn = 0;
  var misses = 0;

  function render(view, text) {
    form.hidden = view !== 'new' && view !== 'waiting';
    input.disabled = view !== 'new';
    submit.disabled = view !== 'new';
    waiting.hidden = view !== 'waiting';
    again.hidden = view !== 'expired';
    again.disabled = false;
    message.textContent = text || '';
    message.hidden = !text;
    if (name && (view === 'waiting' || !input.value)) input.value = name;
  }

  function apply(body) {
    var state = body && body.state;
    if (body && typeof body.name === 'string') name = body.name;
    // One page to land on: the shell (spec 2026-11-28-asset-share-link § Mechanism 3).
    if (state === 'allowed') { location.replace('/'); return; }
    if (state === 'waiting') {
      code.textContent = 'Your code: ' + (typeof body.code === 'string' ? body.code : '');
      render('waiting');
      poll();
      return;
    }
    if (state === 'denied') { render('denied', 'You were not let in.'); return; }
    if (state === 'expired') { render('expired', 'Nobody answered in time.'); return; }
    render('new');
  }

  function stop() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function poll() {
    if (timer === null) timer = setTimeout(check, 2000);
  }

  // The default fetch mode keeps the Origin header real under this page's no-referrer policy.
  function check() {
    stop();
    var mine = ++turn;
    fetch(base + 'status', { cache: 'no-store', headers: { accept: 'application/json' } }).then(function (res) {
      if (res.status === 404) return { state: 'over' };
      if (!res.ok) throw new Error('status');
      return res.json();
    }).then(function (body) {
      if (mine !== turn) return;
      misses = 0;
      if (body && body.state === 'over') render('over', over);
      else apply(body);
    }).catch(function () {
      if (mine !== turn) return;
      misses += 1;
      // A link that stays dead for a minute is over; a single lost request is not.
      if (misses >= 30) render('over', over);
      else poll();
    });
  }

  function ask(value) {
    stop();
    var mine = ++turn;
    submit.disabled = true;
    again.disabled = true;
    fetch(base + 'ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name: value })
    }).then(function (res) {
      return res.json().then(function (body) { return { status: res.status, body: body }; }, function () { return { status: res.status, body: null }; });
    }).then(function (answer) {
      if (mine !== turn) return;
      if (answer.status === 200) { check(); return; }
      if (answer.status === 404) { render('over', over); return; }
      render('new', answer.body && typeof answer.body.error === 'string' && answer.body.error ? answer.body.error : failed);
    }).catch(function () {
      if (mine === turn) render('new', failed);
    });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!submit.disabled) ask(input.value);
  });
  again.addEventListener('click', function () {
    if (name) ask(name);
    else render('new');
  });
  check();
})();
`;
