import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GUEST_NAME_MAX, GUEST_URL_MAX, guestCommentInputSchema } from '@open-mercato/cezar-contract';
import { z } from 'zod';

import { addGuestComment, deleteGuestComment, readGuestComments, toGuestComment, updateGuestComment } from '../../runs/guest-comments.ts';
import { safeNext, SHARE_PREFIX, type GuestRequest, type GuestRoutes } from './share-listener.ts';

/**
 * The share listener's own pages (spec 2026-11-26-preview-share-link § Mechanism 5–9): the waiting
 * page, and what an allowed guest's script saves. Anyone holding the link reaches these.
 */

export interface GuestRoutesDeps {
  /** `null` answers 404. */
  dataDirOf(projectId: string): string | null;
  /** After every write that landed: the server publishes the listing. */
  onComments(projectId: string, runId: string): void;
  guestScript(config: { upstreamOrigin: string; name: string }): string;
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

/**
 * The app's own page in the one spelling that is stored, or `null`. The text a guest sent is never
 * kept: it can read as another host to a parser that is not this one (spec § Mechanism 9).
 */
function pageAddress(sent: string, upstreamOrigin: string): string | null {
  if (!URL.canParse(sent)) return null;
  const url = new URL(sent);
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '' || url.origin !== upstreamOrigin) return null;
  // Spelled out it can be longer than what was sent, and one entry over the cap unreads the whole list.
  return url.href.length <= GUEST_URL_MAX ? url.href : null;
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

  function waiting(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '';
    const mark = url.indexOf('?');
    // Directly addressable, so `next` is judged again here and never trusted from the join redirect.
    const next = safeNext(mark === -1 ? null : new URLSearchParams(url.slice(mark + 1)).get('next')) ?? '/';
    const nonce = randomBytes(16).toString('base64');
    res
      .writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      .end(waitingPage(next, nonce));
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
      const url = parsed.success ? pageAddress(parsed.data.url, ctx.upstreamOrigin) : null;
      if (!parsed.success || url === null) {
        json(res, 400, { error: INVALID });
        return;
      }
      const saved = addGuestComment(dir, ctx.runId, { ...parsed.data, url, author, guestId: guest.id }, () => new Date(now()));
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
      const parsed = editSchema.safeParse(value);
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
      waiting(req, res);
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

    // Past this line is the app's side of the gate (spec § Mechanism 7): an allowed guest, or 404.
    const author = guest.name;
    if (guest.state !== 'allowed' || author === undefined) {
      gone(res);
      return;
    }
    if (method === 'GET' && name === 'guest.js') {
      const script = deps.guestScript({ upstreamOrigin: ctx.upstreamOrigin, name: author });
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...OWN }).end(script);
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
    // Always `true`: a path under the prefix is answered here and never reaches the app.
    handle(ctx, req, res) {
      try {
        answer(ctx, req, res);
      } catch {
        fail(res);
      }
      return true;
    },
  };
}

/** `next` travels as data, with `<` escaped, so no value of it can close the block or open a tag. */
function waitingPage(next: string, nonce: string): string {
  const config = JSON.stringify({ next }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>App preview</title>
<style nonce="${nonce}">${WAITING_STYLE}</style>
</head>
<body>
<main>
<h1>Someone is sharing an app preview with you.</h1>
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
<script type="application/json" id="cezar-share-config">${config}</script>
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
  var next = '/';
  try { next = JSON.parse(el('cezar-share-config').textContent).next; } catch (e) { next = '/'; }
  if (typeof next !== 'string') next = '/';
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
    if (state === 'allowed') { location.replace(next); return; }
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
