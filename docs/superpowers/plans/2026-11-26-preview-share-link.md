# Preview Share Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Share** control in a task's Preview that gives a public link to the task's running app, where a teammate the owner lets in can pin comments to elements, and those comments arrive in the owner's review comments.

**Architecture:** A new loopback *share listener* mirrors one dev server (sharing the Design Mode mirror's forwarding code, not its listener), gated by a link token plus a per-browser Allow from the owner. A tunnel adapter (`cloudflared` quick tunnel; a loopback fake under `CEZ_DRY_RUN=1`) makes it reachable. Guest comments are a server-owned per-run list; the cockpit unions it into the review comments and learns of changes over the existing global SSE stream.

**Tech Stack:** TypeScript (ESM, Node 20+), Hono, zod, `node:http`/`node:net`, React 19, TanStack Query, vitest.

**Spec:** `.ai/specs/2026-11-26-preview-share-link.md` — read it first; decision ids (D1–D3, C1–C12) below refer to it.

## Global Constraints

- Read `AGENTS.md` § Zero config, § The HTTP API and § Changing a mechanism that already works before Task 1.
- Every request/response shape is a zod schema in `packages/contract`, type inferred. Routes are CHAINED into a family builder; bodies, params and query validated as middleware (`jsonZodValidator` / `paramZodValidator` / `queryZodValidator`).
- Run-scoped routes mount under both `/api/v1/…` and `/api/v1/p/:projectId/…` (`route-parity.test.ts` enforces it). Workspace routes are single-mount.
- The Design Mode mirror's behaviour must not change: `packages/cezar/src/server/preview/design-proxy.test.ts` passes unmodified at every task.
- Local cockpit only: the capability is `localHandoff && CEZ_PREVIEW_SHARE !== '0'`, and off in `narrowForRelay`.
- Nothing listens and no child runs before `POST /runs/:id/preview-share`.
- Exact values: share lifetime **8 hours**; **4** shares at once; **1** per run; **5** waiting guests per share; a join request lives **10 minutes**; tunnel start limit **30 s**; code is **4 digits**; token and guest id are **256-bit** random, hex.
- Guest comment caps: body **2,000** chars, excerpt **600**, name **60**, **50** unsent per run, **60,000** chars for a run's whole unsent list.
- Exposure copy, verbatim: `Anyone with this link can use this app and read whatever your dev server serves, including source files. Traffic passes through Cloudflare.`
- Listener paths all live under `/__cezar_share__/`. Cookie name: `__cezar_share`.
- Comments: one or two lines on WHY, citing `spec 2026-11-26-preview-share-link`.
- Tests run through npm: `npm test -- <path>`; never `npx vitest`. Run `npm run typecheck` before every commit. The full gate (AGENTS.md § Validation) runs once, in Task 12.
- Work on a branch off `origin/main` (not on `main`); the PR targets `open-mercato/cezar` `main`.

## Review Focus

1. **The app stops while a share is live.** A guest gets a plain "The app is not running right now" page (502), the share stays up, and the page works again once the app is back. → Task 4.
2. **A WebSocket upgrade from a browser that was never allowed.** Hot reload is a second way into the dev server; the socket must be destroyed, not spliced. → Task 4.
3. **The share ends while a guest is writing.** Saving answers 404; the guest script keeps the typed text in the box and says the link has ended, instead of losing it. → Task 6.
4. **The server restarts under an open cockpit.** `GET …/preview-share` answers `{ share: null }` and the toolbar returns to **Share**, never a dead "Sharing"; chips of comments that are gone disappear. → Tasks 10 and 11.
5. **One guest touching another guest's comment.** `PUT`/`DELETE` on a comment with a different guest id answers 404 and changes nothing. → Task 5.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/contract/src/preview-share.ts` (new) | Every share and guest-comment shape, the caps, the two SSE frames |
| `packages/contract/src/health.ts` (modify) | `capabilities.previewShare` |
| `packages/cezar/src/runs/guest-comments.ts` (new) | The server-owned per-run comment list on disk |
| `packages/cezar/src/server/preview/forward.ts` (new) | Request forwarding + WebSocket splice, extracted from `design-proxy.ts` |
| `packages/cezar/src/server/preview/design-proxy.ts` (modify) | Calls `forward.ts`; behaviour unchanged |
| `packages/cezar/src/server/preview/share-listener.ts` (new) | `PreviewShares`: lifecycle, token, guests, gate |
| `packages/cezar/src/server/preview/share-guest-routes.ts` (new) | The listener's own `/__cezar_share__/*` answers: waiting page, status, comments |
| `packages/cezar/src/server/preview/share-guest-script.ts` (new) | The in-page guest host (bar, popup, marks) |
| `packages/cezar/src/server/preview/picker-script.ts` (modify) | A transport seam so the picker core serves both hosts |
| `packages/cezar/src/server/preview/share-tunnel.ts` (new) | `TunnelAdapter`, `cloudflaredTunnel`, `loopbackTunnel`, `installHint` |
| `packages/cezar/src/server/server.ts` (modify) | The API routes, SSE frames, cleanup wiring |
| `packages/web/src/api/client.ts`, `queries.ts`, `global-events.tsx` (modify) | Client calls, hooks, live frames |
| `packages/web/src/routes/task-thread/diff-comments.ts` + chips + review block (modify) | Guest comments as a third review kind |
| `packages/web/src/routes/task-preview/share-control.tsx` (new) | The toolbar control |
| `packages/web/src/components/live-shares-indicator.tsx` (new) | The workspace-wide indicator and the task-row badge |

---

### Task 1: Contract and capability

**Files:**
- Create: `packages/contract/src/preview-share.ts`
- Modify: `packages/contract/src/index.ts` (add `export * from './preview-share.ts';` beside the `preview.ts` line), `packages/contract/src/health.ts` (`capabilitiesSchema`), `packages/cezar/src/server/capabilities.ts` (`resolveCapabilities`), `packages/cezar/src/relay/scope.ts` (`narrowForRelay`), `.env.example`, `docs/reference.md` (env table)
- Test: `packages/cezar/src/server/capabilities.test.ts`, `packages/cezar/src/relay/authorization.test.ts`

**Interfaces — Produces** (all exported from `@open-mercato/cezar-contract`):

```ts
export const GUEST_COMMENT_BODY_MAX = 2000;
export const GUEST_EXCERPT_MAX = 600;
export const GUEST_NAME_MAX = 60;
export const GUEST_LABEL_MAX = 80;
export const GUEST_SELECTOR_MAX = 1000;
export const GUEST_URL_MAX = 2000;
export const GUEST_COMPONENT_MAX = 300;
export const GUEST_COMMENTS_MAX = 50;
export const GUEST_COMMENTS_TEXT_BUDGET = 60_000;

// What a guest posts. Every string is `.max()`-capped with the constants above; body is trimmed, min 1.
export const guestCommentInputSchema: z.ZodObject<{ url; selector; label; excerpt; component /* optional */; body }>;
// What the cockpit reads. `url` is the app's real address, never the tunnel's.
export const guestCommentSchema = guestCommentInputSchema.extend({
  id: z.string(), revision: z.number().int().positive(), author: z.string(), createdAt: z.string(),
});
export const guestCommentsResponseSchema = z.object({ comments: z.array(guestCommentSchema) });
export const guestCommentsSentRequestSchema = z.object({
  comments: z.array(z.object({ id: z.string(), revision: z.number().int().positive() })).max(GUEST_COMMENTS_MAX),
});
export const guestCommentsSentResponseSchema = z.object({ removed: z.array(z.string()) });

export const previewShareGuestSchema = z.object({
  id: z.string(), name: z.string(), code: z.string().regex(/^\d{4}$/),
  state: z.enum(['waiting', 'allowed']), requestedAt: z.string(),
});
export const previewShareSchema = z.object({
  runId: z.string(), target: z.string(), url: z.string(),
  startedAt: z.string(), expiresAt: z.string(), guests: z.array(previewShareGuestSchema),
});
export const previewShareRequestSchema = z.object({ target: z.string().min(1).max(2048), parentOrigin: z.string().min(1).max(512) });
export const previewShareResponseSchema = z.object({ share: previewShareSchema });
export const previewShareStateResponseSchema = z.object({ share: previewShareSchema.nullable() });
export const previewShareErrorSchema = z.object({
  error: z.string(), code: z.enum(['no-tunnel', 'tunnel-failed']).optional(), install: z.string().optional(),
});
export const previewShareDecisionSchema = z.object({ decision: z.enum(['allow', 'deny']) });
export const previewShareGuestParamSchema = z.object({ id: z.string(), guestId: z.string().regex(/^[a-f0-9]{16}$/) });
export const guestCommentParamSchema = z.object({ id: z.string(), commentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
export const liveSharesResponseSchema = z.object({
  shares: z.array(z.object({ projectId: z.string(), runId: z.string(), target: z.string(), expiresAt: z.string(), waiting: z.number().int() })),
});

// SSE frames on the global stream. Each carries the WHOLE current value, like `runArtifactsEventSchema`.
export const previewShareEventSchema = z.object({
  type: z.literal('preview-share'), runId: z.string(), project: z.string().optional(),
  share: previewShareSchema.nullable(), ended: z.string().optional(), // why it ended on its own
});
export const guestCommentsEventSchema = z.object({
  type: z.literal('guest-comments'), runId: z.string(), project: z.string().optional(), comments: z.array(guestCommentSchema),
});
```

`previewShareGuestSchema.id` is the PUBLIC guest id (16 hex), never the cookie's secret. Export a `z.infer` type beside every schema (`GuestComment`, `PreviewShare`, …).

- [ ] **Step 1: Write the failing tests**

In `capabilities.test.ts`:

```ts
it('offers previewShare on a local cockpit, and CEZ_PREVIEW_SHARE=0 turns it off', () => {
  expect(resolveCapabilities({}, '127.0.0.1').previewShare).toBe(true);
  expect(resolveCapabilities({ CEZ_PREVIEW_SHARE: '0' }, '127.0.0.1').previewShare).toBe(false);
});
it('never offers previewShare on a hosted cockpit', () => {
  expect(resolveCapabilities({ CEZ_REMOTE: '1' }, '127.0.0.1').previewShare).toBe(false);
  expect(resolveCapabilities({}, '0.0.0.0').previewShare).toBe(false);
});
```

In `authorization.test.ts`, beside the existing `designMode` narrowing assertion: `previewShare` is `false` inside a relay scope.

- [ ] **Step 2: Run them, confirm red**

Run: `npm test -- packages/cezar/src/server/capabilities.test.ts packages/cezar/src/relay/authorization.test.ts`
Expected: FAIL — `previewShare` is `undefined`.

- [ ] **Step 3: Implement**

Add the schemas above. Add `previewShare: z.boolean()` to `capabilitiesSchema` with a doc comment citing the spec. In `capabilities.ts` add `previewShareEnabled(env, bindHost)` = `env.CEZ_PREVIEW_SHARE !== '0' && localHandoffEnabled(env, bindHost)` and return it from `resolveCapabilities`. Add `previewShare: false` to `narrowForRelay`. Add `CEZ_PREVIEW_SHARE` to `.env.example` and the `docs/reference.md` env table: "`0` removes the Preview's Share control (a public link to the task's app). Default: available on a local cockpit, started only by a click."

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- packages/cezar/src/server/capabilities.test.ts packages/cezar/src/relay/authorization.test.ts packages/cezar/src/server/contract-parity.workspace.test.ts && npm run typecheck`
Expected: PASS. Fix any fixture that builds a `Capabilities` literal by hand (typecheck names them).

- [ ] **Step 5: Commit**

```bash
git add packages/contract packages/cezar/src/server/capabilities.ts packages/cezar/src/server/capabilities.test.ts packages/cezar/src/relay .env.example docs/reference.md
git commit -m "feat(contract): preview share shapes and the previewShare capability"
```

---

### Task 2: The guest-comment list on disk

**Files:**
- Create: `packages/cezar/src/runs/guest-comments.ts`, `packages/cezar/src/runs/guest-comments.test.ts`
- Modify: `packages/cezar/src/data-gitignore.ts` (add `'guest-comments/'` with a comment citing the spec), `packages/cezar/src/runs/store.ts` (`publishGuestComments`, and the orphan sweep beside `deleteRunDrafts` near line 2624), `packages/cezar/src/server/server.ts` (the run-delete handler near line 6744, beside `deleteRunLayouts`), `packages/cezar/src/workflows/run.ts` (`onTaskDeleted`, near line 1900)

**Interfaces — Produces:**

```ts
// One file per run: <dataDir>/guest-comments/<runId>.json. Synchronous read-modify-write with an
// atomic tmp+rename, so two requests in one process can never interleave.
export interface StoredGuestComment extends GuestComment { guestId: string } // guestId = the PUBLIC id
export function guestCommentsRoot(dataDir: string): string;
export function readGuestComments(dataDir: string, runId: string): StoredGuestComment[]; // never throws; corrupt → []
export type GuestCommentWrite = { ok: true; comment: StoredGuestComment } | { ok: false; reason: 'full' | 'budget' | 'not-found' };
export function addGuestComment(dataDir: string, runId: string, input: GuestCommentInput & { author: string; guestId: string }, now?: () => Date): GuestCommentWrite;
export function updateGuestComment(dataDir: string, runId: string, id: string, guestId: string, body: string): GuestCommentWrite; // bumps revision
export function deleteGuestComment(dataDir: string, runId: string, id: string, guestId?: string): boolean; // guestId omitted = the owner
export function removeSentGuestComments(dataDir: string, runId: string, sent: readonly { id: string; revision: number }[]): string[]; // ids removed
export function deleteRunGuestComments(dataDir: string, runId: string): void;
export function toGuestComment(stored: StoredGuestComment): GuestComment; // drops guestId
// on RunStore:
publishGuestComments(runId: string, comments: GuestComment[]): void; // emits ('guest-comments', { runId, comments })
```

`runId` is validated with the same `^[A-Za-z0-9_-]{1,64}$` rule `runs/layouts.ts` uses before it becomes a path segment. `'full'` = 50 comments already; `'budget'` = the list's `body + excerpt + label + selector + url + component` characters would pass 60,000.

- [ ] **Step 1: Write the failing tests** (`guest-comments.test.ts`, a temp `dataDir` per test)

```ts
it('adds, lists and bumps the revision on an edit', () => {
  const a = addGuestComment(dir, 'r1', { ...pick, body: 'first', author: 'Ana', guestId: 'g1' });
  expect(a.ok && a.comment.revision).toBe(1);
  const b = updateGuestComment(dir, 'r1', a.comment.id, 'g1', 'second');
  expect(b.ok && b.comment.revision).toBe(2);
  expect(readGuestComments(dir, 'r1').map((c) => c.body)).toEqual(['second']);
});
it("refuses another guest's edit and delete", () => {
  expect(updateGuestComment(dir, 'r1', id, 'g2', 'x')).toEqual({ ok: false, reason: 'not-found' });
  expect(deleteGuestComment(dir, 'r1', id, 'g2')).toBe(false);
  expect(deleteGuestComment(dir, 'r1', id)).toBe(true); // the owner
});
it('removes a sent comment only at the revision that was sent', () => {
  // c1 sent at revision 1 and unchanged → removed; c2 sent at 1 but edited to 2 → kept
  expect(removeSentGuestComments(dir, 'r1', [{ id: c1, revision: 1 }, { id: c2, revision: 1 }])).toEqual([c1]);
});
it('stops at 50 comments', () => { /* 51st → { ok: false, reason: 'full' } */ });
it('stops at the 60,000-character budget', () => { /* 30 × 2,000-char bodies fit; the 31st → 'budget' */ });
it('reads a corrupt file as empty and refuses a runId that is not a path segment', () => {
  expect(readGuestComments(dir, '../x')).toEqual([]);
});
```

- [ ] **Step 2: Run, confirm red** — `npm test -- packages/cezar/src/runs/guest-comments.test.ts` → FAIL, module not found.
- [ ] **Step 3: Implement** `guest-comments.ts`; ids from `randomUUID()`. Add `publishGuestComments` to `RunStore` beside `publishArtifacts`. Call `deleteRunGuestComments` at the three run-removal sites listed under Files.
- [ ] **Step 4: Run** `npm test -- packages/cezar/src/runs/guest-comments.test.ts packages/cezar/src/data-gitignore.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(runs): a server-owned guest comment list per run"`

---

### Task 3: Extract the mirror's forwarding

A refactor with a guard: the Design Mode mirror must behave exactly as before.

**Files:**
- Create: `packages/cezar/src/server/preview/forward.ts`, `packages/cezar/src/server/preview/forward.test.ts`
- Modify: `packages/cezar/src/server/preview/design-proxy.ts` (`forwardHeaders`, `handle`, `upgrade` call the new functions)

**Interfaces — Produces:**

```ts
export interface ForwardOptions {
  upstream: URL;                 // the one loopback origin
  own: string;                   // this listener's public origin, e.g. `http://localhost:51234` or the tunnel's
  dropCookies?: readonly string[];            // request cookie names removed before forwarding
  rewriteAnswer?(headers: Record<string, string | string[]>): void; // e.g. allowFramingBy
  injectHtml(html: string): string;
  unreachable: string;           // the 502 body
}
export function forwardHeaders(req: IncomingMessage, options: ForwardOptions): Record<string, string | string[]>;
export function forwardRequest(req: IncomingMessage, res: ServerResponse, options: ForwardOptions): void;
export function spliceUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, options: ForwardOptions, onClose?: () => void): void;
export function stripCookies(header: string | undefined, names: readonly string[]): string | undefined; // undefined when nothing is left
export function stripSetCookieDomain(value: string | string[]): string | string[];
```

`HOP_BY_HOP`, `HTML_BUFFER_MAX`, `socketHost` and `portOf` move with them. `forwardRequest` always applies `stripSetCookieDomain` to `set-cookie` **only when `dropCookies` is given** (the share listener's case), so the mirror's bytes do not change.

- [ ] **Step 1: Write the failing tests** (`forward.test.ts`)

```ts
it('removes only the named cookies', () => {
  expect(stripCookies('a=1; __cezar_share=secret; b=2', ['__cezar_share'])).toBe('a=1; b=2');
  expect(stripCookies('__cezar_share=secret', ['__cezar_share'])).toBeUndefined();
});
it('drops Domain from Set-Cookie and keeps every other attribute', () => {
  expect(stripSetCookieDomain('sid=1; Domain=localhost; Path=/; HttpOnly')).toBe('sid=1; Path=/; HttpOnly');
});
it('forwards without the share cookie, and rewrites Origin only when it is its own', async () => {
  // real upstream on an ephemeral port echoes its request headers as JSON
});
```

- [ ] **Step 2: Run, confirm red** — `npm test -- packages/cezar/src/server/preview/forward.test.ts`
- [ ] **Step 3: Implement** `forward.ts` by moving the bodies out of `DesignProxies` unchanged, then point `DesignProxies` at them (`own` = `http://${req.headers.host}`, `rewriteAnswer` = `allowFramingBy`, `injectHtml` = `injectPicker`, `unreachable` = today's sentence, `onClose` updates `lastUsed` and the `sockets` set).
- [ ] **Step 4: Run the guard and the new tests**

Run: `npm test -- packages/cezar/src/server/preview packages/cezar/src/server/design-proxy-api.test.ts`
Expected: PASS, with `design-proxy.test.ts` **unmodified** (`git diff --stat` shows no change to it).

- [ ] **Step 5: Commit** — `git commit -m "refactor(preview): share the mirror's forwarding with a second listener"`

---

### Task 4: The share listener — lifecycle and gate

**Files:**
- Create: `packages/cezar/src/server/preview/share-listener.ts`, `packages/cezar/src/server/preview/share-listener.test.ts`

**Interfaces — Consumes:** `forwardRequest`, `spliceUpgrade` (Task 3); `parseDesignTarget` and the `loopbackAliases` rule from `design-proxy.ts` (export `loopbackAliases`).

**Interfaces — Produces:**

```ts
export interface Tunnel { origin: string; stop(): void; onExit(listener: (reason: string) => void): void }
export interface TunnelAdapter { start(port: number): Promise<Tunnel> } // rejects with TunnelError
export class TunnelError extends Error { constructor(message: string, readonly code: 'no-tunnel' | 'tunnel-failed', readonly install?: string) }

export type ShareStart =
  | { ok: true; share: PreviewShare }
  | { ok: false; status: 400 | 409; error: string; code?: 'no-tunnel' | 'tunnel-failed'; install?: string };

export interface GuestRoutes { // Task 5 supplies it; Task 4's tests pass a stub
  handle(ctx: GuestRequest, req: IncomingMessage, res: ServerResponse): boolean; // true = answered
}
export interface GuestRequest {
  runId: string; projectId: string; path: string; tunnelOrigin: string; upstreamOrigin: string;
  guest: { id: string; state: 'new' | 'waiting' | 'allowed' | 'denied' | 'expired'; name?: string; code?: string } | null;
  ask(name: string): { code: string } | { error: string };           // creates the join request
}
export interface PreviewSharesOptions {
  tunnel: TunnelAdapter; guestRoutes: GuestRoutes;
  isCezar?(origin: string): Promise<boolean>;                         // C10; default probes `${origin}/api/v1/health`
  onChange(runId: string, share: PreviewShare | null, ended?: string): void;
  now?(): number; lifetimeMs?: number; max?: number; maxWaiting?: number; waitingMs?: number;
}
export class PreviewShares {
  constructor(options: PreviewSharesOptions);
  start(input: { runId: string; projectId: string; target: string; parentOrigin: string; forbidden: readonly string[] }): Promise<ShareStart>;
  get(runId: string): PreviewShare | null;
  list(): Array<{ projectId: string; share: PreviewShare }>;
  stop(runId: string, ended?: string): boolean;
  decide(runId: string, guestId: string, decision: 'allow' | 'deny'): boolean;
  removeGuest(runId: string, guestId: string): boolean;
  closeAll(): void;
}
```

Rules the tests pin (spec § Mechanism 2–7, § States):

- `start`: refuses a non-loopback or non-`http:` target (400, `parseDesignTarget`'s reason with "Design Mode" replaced by "Sharing"); refuses the cockpit origin, every `forbidden` origin and any origin `isCezar` says yes to (400, `Sharing cannot be pointed at cezar itself`); the same run + same target answers the live share; the same run + another target → 409 `Already sharing <origin> — stop it first`; a fifth share → 409. The listener binds `127.0.0.1:0`. If the tunnel rejects, the listener is closed and the `TunnelError`'s `code`/`install` are returned with status 409.
- The link is `${tunnel.origin}/__cezar_share__/join/${token}?next=${encodeURIComponent(path)}`, where `path` is the target's path + search, default `/`.
- Every request: `Host` must equal the tunnel origin's host, else 403. Then, in order: the join path; `guestRoutes.handle(...)`; forward if the cookie's guest is `allowed`; else 302 to `/__cezar_share__/wait` for a cookie-holder; else 404 with the body `This link is no longer active.`
- Join: constant-time token compare (`timingSafeEqual` over equal-length buffers); a wrong token → the same 404. A right one sets `__cezar_share=<256-bit hex>; HttpOnly; SameSite=Lax; Path=/` plus `Secure` when the tunnel origin is `https:`, sends `Referrer-Policy: no-referrer`, and 302s to `/__cezar_share__/wait?next=<next>`. `next` is kept only when it starts with a single `/`. At most 10 joins per minute per client address (`cf-connecting-ip` when present, else the socket's), then 429.
- The cookie value is the secret; the guest's PUBLIC id is the first 16 hex chars of its SHA-256. Only the public id leaves the class.
- `ask(name)`: trims, caps at 60; needs 1+ chars; a 6th waiting guest → `{ error }`; the code is 4 random digits. A waiting guest expires 10 minutes after asking.
- `decide('deny')` keeps the guest id refused until the share ends. `removeGuest` destroys that guest's live sockets.
- WebSocket upgrade: same `Host` and allowed-guest checks; otherwise `socket.destroy()`.
- Forwarding uses `dropCookies: ['__cezar_share']`, `own: tunnel.origin`, `injectHtml` adding `<script src="/__cezar_share__/guest.js" data-cezar-design></script>` at the place `injectPicker` picks, and `unreachable: 'The app is not running right now.'`
- Ends: `stop`; the lifetime timer (`ended: 'expired'`); `tunnel.onExit` (`ended: 'cloudflared exited'` + the reason); `closeAll`. Every end stops the tunnel, closes the listener and its sockets, and calls `onChange(runId, null, ended)`. Timers are `unref()`'d.
- `onChange(runId, share)` fires on start and on every guest change.

- [ ] **Step 1: Write the failing tests** (`share-listener.test.ts`: a real upstream `http` server on an ephemeral port, a fake `TunnelAdapter` whose origin is `http://127.0.0.1:<port>`, a stub `guestRoutes`). One `it` per rule above, plus these from Review Focus:

```ts
it('answers 502 while the app is down and forwards again once it is back', async () => {
  upstream.close();
  expect((await guest.get('/')).status).toBe(502);
  expect(await (await guest.get('/')).text()).toBe('The app is not running right now.');
  await listenAgain(upstream, port);
  expect((await guest.get('/')).status).toBe(200);
  expect(shares.get('r1')).not.toBeNull();
});
it('destroys a WebSocket upgrade from a browser that was never allowed', async () => {
  const closed = await upgradeAndWaitForClose(shareOrigin, { cookie: waitingGuestCookie });
  expect(closed).toBe(true);
  expect(upstreamUpgrades).toBe(0);
});
it('never forwards the share cookie or the token to the app', async () => {
  await allowed.get('/echo');
  expect(lastUpstreamHeaders.cookie ?? '').not.toContain('__cezar_share');
  expect(JSON.stringify(upstreamRequests)).not.toContain(token);
});
it('gives a waiting browser nothing of the app', async () => {
  const res = await waiting.get('/', { redirect: 'manual' });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/__cezar_share__/wait');
  expect(upstreamRequests).toHaveLength(0);
});
```

- [ ] **Step 2: Run, confirm red** — `npm test -- packages/cezar/src/server/preview/share-listener.test.ts`
- [ ] **Step 3: Implement** `PreviewShares`.
- [ ] **Step 4: Run** the same command plus `packages/cezar/src/server/preview/design-proxy.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(preview): a share listener gated by a link token and the owner's allow"`

---

### Task 5: The listener's own pages — waiting, status, comments

**Files:**
- Create: `packages/cezar/src/server/preview/share-guest-routes.ts`, `packages/cezar/src/server/preview/share-guest-routes.test.ts`

**Interfaces — Consumes:** `GuestRoutes`, `GuestRequest` (Task 4); the store functions and `toGuestComment` (Task 2); `guestCommentInputSchema` (Task 1); `guestScript` (Task 6 — until it lands, serve an empty script and let Task 6 replace the import).

**Interfaces — Produces:**

```ts
export function createGuestRoutes(deps: {
  dataDirOf(projectId: string): string | null;       // null → 404
  onComments(projectId: string, runId: string): void; // the server publishes the listing
  guestScript(config: { upstreamOrigin: string; name: string }): string; // Task 6's signature
  now?(): number;
}): GuestRoutes;
```

Answers, all under `/__cezar_share__/`:

| Request | Who | Answer |
| --- | --- | --- |
| `GET wait` | any cookie-holder | The waiting page: one self-contained HTML document, inline script and style, no external request. Shows the name field and **Ask to join**, then `Waiting to be let in…` and `Your code: NNNN`; polls `status` every 2 s; on `allowed` goes to `next`; on `denied` shows `You were not let in.`; on `expired` offers **Ask again**. |
| `POST ask` `{ name }` | `new` or `expired` | `{ code }`, or 409 `{ error }` |
| `GET status` | any cookie-holder | `{ state, code?, name? }` |
| `GET guest.js` | `allowed` | `guestScript({ upstreamOrigin: ctx.upstreamOrigin, name: ctx.guest.name })`, `cache-control: no-store` |
| `GET comments` | `allowed` | `{ comments }` — this guest's own, through `toGuestComment` |
| `POST comments` | `allowed` | 201 `{ comment }`; 400 on a bad body; 409 `{ error: "The reviewer's inbox is full." }` for `'full'`/`'budget'` |
| `PUT comments/:id` `{ body }` | `allowed` | `{ comment }`, or 404 |
| `DELETE comments/:id` | `allowed` | 204, or 404 |

Every write needs `content-type: application/json` and an `Origin` header equal to `ctx.tunnelOrigin`, else 403. Bodies are read with a 64 KiB limit. The comment's `author` is `ctx.guest.name` and its `guestId` is `ctx.guest.id`; neither is read from the body. `url` must start with the share's upstream origin — the guest script sends the app's real address — else 400. More than 30 writes per minute from one guest → 429. Every successful write calls `onComments`. A path under `/__cezar_share__/` that matches nothing answers 404 (it is never forwarded to the app).

- [ ] **Step 1: Write the failing tests** — one per row, and:

```ts
it("answers 404 when a guest edits or deletes another guest's comment, and changes nothing", async () => {
  const id = (await ana.post('comments', comment)).json.comment.id;
  expect((await piotr.put(`comments/${id}`, { body: 'x' })).status).toBe(404);
  expect((await piotr.delete(`comments/${id}`)).status).toBe(404);
  expect(readGuestComments(dir, 'r1')[0]!.body).toBe(comment.body);
});
it('takes the author from the allowed guest, never from the body', async () => {
  await ana.post('comments', { ...comment, author: 'Marta' });
  expect(readGuestComments(dir, 'r1')[0]!.author).toBe('Ana');
});
it('refuses a write without the tunnel Origin', async () => { /* 403 */ });
it('serves the waiting page with no external request in it', () => {
  expect(waitingPage).not.toMatch(/(src|href)="https?:/);
});
```

- [ ] **Step 2: Run, confirm red** — `npm test -- packages/cezar/src/server/preview/share-guest-routes.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(preview): the share link's waiting page and guest comment endpoints"`

---

### Task 6: The guest script

**Files:**
- Modify: `packages/cezar/src/server/preview/picker-script.ts`
- Create: `packages/cezar/src/server/preview/share-guest-script.ts`
- Test: `packages/web/src/routes/task-preview/design-picker.test.ts` (existing — the guard), `packages/web/src/routes/task-preview/share-guest-script.test.ts` (new; import the script by the same relative path the existing test uses)

**Interfaces — Produces:**

```ts
// picker-script.ts
export interface PickerConfig { /* existing fields */ inPage?: boolean }
// With `inPage`, the core does NOT return when unframed, posts through
// `window.__cezarShareHost.receive(message)` instead of `window.parent.postMessage`, and exposes
// `window.__cezarSharePicker = { send(message) }` for the host's `set-active` / `set-marks`.
export function guestPickerCore(upstreamOrigin: string): string;

// share-guest-script.ts
export function guestScript(config: { upstreamOrigin: string; name: string }): string; // host + guestPickerCore
```

The transport is the ONLY change to the picker core: selection, `describe`, marks and key handling stay one copy. The guest host speaks the existing protocol (`ready`, `picked`, `rects`, `mark-clicked`, `cancel`, `toggle` in; `set-active`, `set-marks` out) — `packages/web/src/routes/task-assets/asset-comments.tsx` is the reference for what a host does with each message.

The host, in one closed shadow root appended to `document.documentElement`:

- A corner bar: `Comment` toggle, the count of this guest's comments, the guest's name.
- On `picked`: a popup under the element (above when there is no room) with the element's name, a textarea (max 2,000) and **Save**; `Ctrl/Cmd+Enter` saves; `Esc` closes. For a saved comment, **Delete** and editing in place.
- Saving posts `{ url, selector, label, excerpt, component, body }` to `/__cezar_share__/comments` — `url` from the pick (the app's real address), `excerpt` cut to 600, `component` as `A › B (file:line)` when the pick has components.
- On load: `GET /__cezar_share__/comments`, then `set-marks` for those whose `url` path equals this page's path, numbered in list order.
- A failed save keeps the popup open with the text in it. A 404 shows `This link has ended — your comment was not saved.`; a 409 shows the server's `error`.

- [ ] **Step 1: Write the failing tests** (`share-guest-script.test.ts`, jsdom, `fetch` stubbed)

```ts
it('runs unframed and saves a picked element with the app address, not the page address', async () => {
  run(guestScript({ upstreamOrigin: 'http://localhost:5173', name: 'Ana' }));
  toggleCommentMode(); click(button); type('make it green'); save();
  expect(lastPost.url).toBe('/__cezar_share__/comments');
  expect(lastPost.body).toMatchObject({ url: 'http://localhost:5173/settings', selector: expect.stringContaining('button'), body: 'make it green' });
});
it('keeps the typed text when the share has ended', async () => {
  fetchAnswers(404);
  toggleCommentMode(); click(button); type('still here'); save();
  expect(popupText()).toBe('still here');
  expect(popupMessage()).toBe('This link has ended — your comment was not saved.');
});
it('marks only the comments of this page', async () => { /* two stored comments, one on another path → one mark */ });
it('leaves the page alone while comment mode is off', () => { /* a click reaches the app's own handler */ });
```

- [ ] **Step 2: Run, confirm red** — `npm test -- packages/web/src/routes/task-preview/share-guest-script.test.ts`
- [ ] **Step 3: Implement** the transport seam and the host. Wire `guestScript` into `createGuestRoutes`' `guestScript` dep (Task 5's placeholder).
- [ ] **Step 4: Run the guard and the new tests**

Run: `npm test -- packages/web/src/routes/task-preview packages/web/src/routes/task-assets packages/cezar/src/server/preview`
Expected: PASS, `design-picker.test.ts` unmodified.

- [ ] **Step 5: Commit** — `git commit -m "feat(preview): an in-page guest host for the Design Mode picker"`

---

### Task 7: Tunnel adapters

**Files:**
- Create: `packages/cezar/src/server/preview/share-tunnel.ts`, `packages/cezar/src/server/preview/share-tunnel.test.ts`

**Interfaces — Consumes:** `TunnelAdapter`, `Tunnel`, `TunnelError` (Task 4); `resolveOnPath` from `packages/cezar/src/server/open-in-app.ts`.

**Interfaces — Produces:**

```ts
export interface TunnelChild { onLine(l: (line: string) => void): void; onExit(l: (error?: Error) => void): void; kill(): void }
export function cloudflaredTunnel(options?: {
  resolve?(bin: string): string | null;                       // default resolveOnPath
  spawn?(bin: string, args: readonly string[]): TunnelChild;  // default node:child_process, stdout+stderr by line
  platform?: NodeJS.Platform; timeoutMs?: number;             // 30_000
}): TunnelAdapter;
export function loopbackTunnel(): TunnelAdapter;               // origin = `http://127.0.0.1:${port}`; stop() is a no-op
export function installHint(platform: NodeJS.Platform): string;
export function shareTunnel(env: NodeJS.ProcessEnv): TunnelAdapter; // CEZ_DRY_RUN=1 → loopbackTunnel, else cloudflaredTunnel
```

- Arguments, exactly: `['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`]`.
- The address is the first match of `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/` in any output line.
- No binary → `TunnelError('Sharing needs cloudflared', 'no-tunnel', installHint(platform))`.
- Exit before an address, or 30 s without one (the child is killed) → `TunnelError(<last non-empty output line, or 'cloudflared did not start'>, 'tunnel-failed')`.
- After the address, an exit calls the `onExit` listeners once. `stop()` kills the child and does NOT call them.
- `installHint`: `darwin` → `brew install cloudflared`; `win32` → `winget install --id Cloudflare.cloudflared`; otherwise `https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`.
- **Verify before coding (spec § Limits, last bullet):** read Cloudflare's Quick Tunnels page and confirm whether a quick tunnel refuses to start when `~/.cloudflared/config.yaml` exists. If it does, no code changes — the `tunnel-failed` path already shows cloudflared's own last line — but update the spec's bullet from "Unverified" to what the page says.

- [ ] **Step 1: Write the failing tests** (a fake `spawn` that feeds lines)

```ts
it('resolves with the trycloudflare address from the output', async () => {
  const t = cloudflaredTunnel({ resolve: () => 'cloudflared', spawn }).start(4321);
  child.line('2026-11-26 INF |  https://calm-river-12.trycloudflare.com  |');
  expect((await t).origin).toBe('https://calm-river-12.trycloudflare.com');
  expect(spawned.args).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:4321']);
});
it('rejects with the install command when cloudflared is not on PATH', async () => {
  await expect(cloudflaredTunnel({ resolve: () => null, platform: 'darwin' }).start(1)).rejects.toMatchObject({ code: 'no-tunnel', install: 'brew install cloudflared' });
});
it('rejects with the last output line when the child exits first', async () => { /* code: 'tunnel-failed' */ });
it('kills the child and rejects after 30 seconds without an address', async () => { /* fake timers */ });
it('reports an exit after start, but not a stop()', async () => {});
```

- [ ] **Step 2: Run, confirm red** — `npm test -- packages/cezar/src/server/preview/share-tunnel.test.ts`
- [ ] **Step 3: Implement.** The default `spawn` returns `null`-safe behaviour under `process.env.VITEST` the way `relay/keep-awake.ts` does: a test never starts a real `cloudflared`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(preview): cloudflared quick tunnel adapter for share links"`

---

### Task 8: API routes, live frames and cleanup

**Files:**
- Modify: `packages/cezar/src/server/server.ts`, `BACKWARD_COMPATIBILITY.md` (§2 route inventory)
- Create: `packages/cezar/src/server/preview-share-api.test.ts` (model it on `design-proxy-api.test.ts`)

**Interfaces — Consumes:** everything from Tasks 1, 2, 4, 5, 7.

**Interfaces — Produces** (project-scoped family `previewShareRoutes = new Hono<ProjectApiEnv>()`, mounted beside `draftRoutes` near line 8978; the workspace route chained beside `/workspace/phones`):

| Route | Answer |
| --- | --- |
| `POST /runs/:id/preview-share` (`previewShareRequestSchema`) | 200 `previewShareResponseSchema`; 404 unknown run; 409 `previewShareErrorSchema` when the capability is off (`Sharing is not available on this cockpit`), the run is archived, or `start` answers 409; 400 `{ error }` when `start` answers 400 |
| `GET /runs/:id/preview-share` | `previewShareStateResponseSchema` |
| `DELETE /runs/:id/preview-share` | `previewShareStateResponseSchema` with `share: null` (idempotent) |
| `POST /runs/:id/preview-share/guests/:guestId` (`previewShareDecisionSchema`) | `previewShareStateResponseSchema`; 404 unknown guest |
| `DELETE /runs/:id/preview-share/guests/:guestId` | `previewShareStateResponseSchema`; 404 unknown guest |
| `GET /runs/:id/guest-comments` | `guestCommentsResponseSchema` |
| `DELETE /runs/:id/guest-comments/:commentId` | `guestCommentsResponseSchema` (the list after) |
| `POST /runs/:id/guest-comments/sent` (`guestCommentsSentRequestSchema`) | `guestCommentsSentResponseSchema` |
| `GET /workspace/preview-shares` | `liveSharesResponseSchema` |

Wiring:

- `AppDeps` gains `previewShares?: PreviewShares` (tests inject one with a fake tunnel). The default is ONE instance per app: `new PreviewShares({ tunnel: shareTunnel(process.env), guestRoutes: createGuestRoutes(...), onChange })`, with `deps.onDispose?.(() => previewShares.closeAll())` — the same shape as `designProxies` at line 3999.
- `forbidden` for `start` is `host ? [`http://${host}`] : []`, as the design-proxy route passes it.
- `onChange` emits on the run's project store: `('preview-share', { runId, share, ended })`. The comment routes and `onComments` call `store.publishGuestComments(runId, comments)`.
- **Both** SSE endpoints (the run stream near line 7389 and the workspace stream near line 7446) forward the two frames, exactly where each forwards `artifacts` — subscribe and unsubscribe in the same places. Grep `store.on('artifacts'` to find both; a frame added to one only ships half the feature.
- A share ends when its run is deleted, archived, or its worktree is reclaimed: call `previewShares.stop(id, 'the task was removed')` beside `stopTaskProcesses(id)` in the delete handler, and at the archive and worktree-reclaim sites (grep `stopTaskProcesses(` for all of them).
- Add the nine routes to `BACKWARD_COMPATIBILITY.md` §2.

- [ ] **Step 1: Write the failing tests** (`preview-share-api.test.ts`)

```ts
it('409s with the reason when sharing is off, and on a hosted cockpit', async () => {
  process.env.CEZ_PREVIEW_SHARE = '0';
  expect((await post(run.id, body)).status).toBe(409);
});
it('starts a share, reports it, and stops it', async () => {
  const started = previewShareResponseSchema.parse(await (await post(run.id, body)).json());
  expect(started.share.url).toContain('/__cezar_share__/join/');
  expect((await get(run.id)).share?.target).toBe(upstreamOrigin);
  expect((await del(run.id)).share).toBeNull();
  expect(shares.get(run.id)).toBeNull();
});
it('refuses to share this server and any other cezar', async () => { /* own Host → 400; isCezar → 400 */ });
it('carries the install command when no tunnel binary is found', async () => {
  // tunnel.start rejects with TunnelError('…', 'no-tunnel', 'brew install cloudflared')
  expect(await res.json()).toMatchObject({ code: 'no-tunnel', install: 'brew install cloudflared' });
});
it('removes only sent comments still at the sent revision', async () => {});
it('ends the share when its run is deleted', async () => {});
it('answers every route under /api/v1/p/<boot>/ as well', async () => {});
it('sends a preview-share frame and a guest-comments frame on the workspace stream', async () => {});
```

- [ ] **Step 2: Run, confirm red** — `npm test -- packages/cezar/src/server/preview-share-api.test.ts`
- [ ] **Step 3: Implement** the routes and wiring.
- [ ] **Step 4: Run the route gates**

Run: `npm test -- packages/cezar/src/server/preview-share-api.test.ts packages/cezar/src/server/route-parity.test.ts packages/cezar/src/server/versioned-surface.test.ts packages/cezar/src/server/bc-route-inventory.test.ts packages/cezar/src/server/typed-bodies.test.ts && npm test -- packages/cezar/src/server -t "contract-parity" && npm run typecheck`
Expected: PASS. A contract-parity failure means the route and its schema disagree — fix the route, never widen the schema.

- [ ] **Step 5: Commit** — `git commit -m "feat(server): preview share routes, live frames and cleanup"`

---

### Task 9: Cockpit data layer

**Files:**
- Modify: `packages/web/src/api/client.ts`, `packages/web/src/api/queries.ts`, `packages/web/src/api/global-events.tsx`
- Test: `packages/web/src/api/global-events.test.tsx`, `packages/web/src/api/contract-pipeline.test.ts` (extend if it enumerates client calls)

**Interfaces — Produces:**

```ts
// client.ts — each mirrors `openDesignProxy` / `getRunArtifacts`
export function startPreviewShare(runId: string, input: PreviewShareRequest): Promise<PreviewShareResponse>; // throws ShareError
export class ShareError extends Error { code?: 'no-tunnel' | 'tunnel-failed'; install?: string }
export function getPreviewShare(runId: string, opts?: ReadOptions): Promise<PreviewShareStateResponse>;
export function stopPreviewShare(runId: string): Promise<PreviewShareStateResponse>;
export function decidePreviewShareGuest(runId: string, guestId: string, decision: 'allow' | 'deny'): Promise<PreviewShareStateResponse>;
export function removePreviewShareGuest(runId: string, guestId: string): Promise<PreviewShareStateResponse>;
export function getGuestComments(runId: string, opts?: ReadOptions): Promise<GuestCommentsResponse>;
export function deleteGuestComment(runId: string, commentId: string): Promise<GuestCommentsResponse>;
export function markGuestCommentsSent(runId: string, comments: { id: string; revision: number }[]): Promise<GuestCommentsSentResponse>;
export function getLiveShares(opts?: ReadOptions): Promise<LiveSharesResponse>;

// queries.ts
queryKeys.runs.previewShare(id), queryKeys.runs.guestComments(id), queryKeys.workspace.liveShares
export function usePreviewShare(runId: string | undefined);   // staleTime: Infinity; refetchOnReconnect + on visibility
export function useGuestComments(runId: string | undefined);  // same
export function useLiveShares();
```

`global-events.tsx`: two listeners beside `artifacts` (line ~879). `preview-share` sets `queryKeys.runs.previewShare(runId)` to `{ share }` and invalidates `queryKeys.workspace.liveShares`; a frame with `ended` raises one toast, `Sharing stopped: ${ended}`. `guest-comments` sets `queryKeys.runs.guestComments(runId)` to `{ comments }`. Both follow the `artifacts` handler's rules: parse with the contract schema, drop a frame for another project through `inactiveProjectRefresher`, ignore malformed JSON.

- [ ] **Step 1: Write the failing tests** in `global-events.test.tsx`, modelled on the `artifacts` cases near line 1870: a `preview-share` frame patches the cache; a `guest-comments` frame patches the cache; a frame for another project patches nothing; `{not json` is ignored; a frame with `ended` toasts once.
- [ ] **Step 2: Run, confirm red** — `npm test -- packages/web/src/api/global-events.test.tsx`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -- packages/web/src/api && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): preview share client, hooks and live frames"`

---

### Task 10: Guest comments in the review

**Files:**
- Modify: `packages/web/src/routes/task-thread/diff-comments.ts`, `diff-comment-chips.tsx`, `review-comments-block.tsx`
- Test: `diff-comments.test.ts`, `diff-comments-store.test.tsx`, `diff-comment-chips.test.tsx`, `review-comments-block.test.tsx` (all existing, beside the sources)

**Interfaces — Consumes:** `useGuestComments`, `deleteGuestComment`, `markGuestCommentsSent` (Task 9); `GuestComment` (Task 1).

**Interfaces — Produces:**

```ts
export interface GuestReviewComment extends GuestComment { kind: 'guest' }
export type ReviewComment = DiffComment | AssetComment | GuestReviewComment;
export function isGuestComment(comment: ReviewComment): comment is GuestReviewComment;
export const REVIEW_GENERAL_HEADING = 'Review comments:';
// DiffComments gains:
guestComments: GuestReviewComment[];
```

- `useDiffComments(runId).all` = the stored list followed by the guest comments (oldest first). `guestComments` is never written to the `diff-comments` draft surface — `serialize` filters it out.
- `update(id, …)` on a guest comment is a no-op returning `false` (C6). `remove(id)` on one calls `deleteGuestComment`. `clear()` leaves guest comments alone.
- `submit`: after the action resolves, the carried guest comments go to `markGuestCommentsSent` with the `revision` each had when captured; the local draft comments are dropped as today.
- `formatDiffComments`: a guest item is

  ```
  - `<url>` (app preview) element `<selector>` — "<label>" — from <author>:

    component: <component>          ← only when present

    <fenced excerpt>

    <body>
  ```

  with the ` — "<label>"` part omitted for an empty label, and `"` in a label replaced by `'` as `assetWhere` does. The heading is `REVIEW_GENERAL_HEADING` whenever at least one guest comment rides; otherwise the three existing headings, unchanged.
- `parseReviewMessage` accepts `REVIEW_GENERAL_HEADING` and reads a guest item back into a `ReviewItem` with a new optional `guest?: { selector: string; author: string }` and `path` = the url.
- Chip: `<author> · <selectorTail(selector)>` + ` “<label>”` when there is one; ✕ removes; a click opens the task's Preview on `url` (the route `/tasks/:id/preview` plus the existing way a tab address is opened — follow what `AssetCommentChip` does for the Assets tab).
- The review card renders a guest item with the author as its header line.

- [ ] **Step 1: Write the failing tests**

```ts
it('formats a guest comment with its page, element, author and component', () => {
  expect(formatDiffComments([guest])).toBe(
    'Review comments:\n\n' +
    '- `http://localhost:5173/settings` (app preview) element `main > button.btn-primary` — "Save" — from Ana:\n\n' +
    '  component: SettingsForm › Button (src/ui/button.tsx:14)\n\n' +
    '  ```html\n  <button class="btn-primary">Save</button>\n  ```\n\n' +
    '  Make this the brand green.',
  );
});
it('reads the guest item back, and still reads all three older headings', () => {
  expect(parseReviewMessage(formatDiffComments([guest]))?.items[0]).toMatchObject({ path: 'http://localhost:5173/settings', guest: { author: 'Ana' }, body: 'Make this the brand green.' });
  for (const sent of [OLD_DIFF_REVIEW, OLD_ASSET_REVIEW, OLD_MIXED_REVIEW]) expect(parseReviewMessage(sent)).toBeDefined();
});
it('never writes a guest comment into the diff-comments draft', async () => {});
it('marks carried guest comments sent at the captured revision', async () => {
  // guest comment at revision 2 → after submit, markGuestCommentsSent('r1', [{ id, revision: 2 }])
});
it('does not edit a guest comment', () => { expect(store.update(guest.id, 'mine now')).toBe(false); });
it('shows no chip once the server restarts and the list is empty', async () => {
  // Review Focus 4: a `{ comments: [] }` listing after a populated one removes the chips
});
```

- [ ] **Step 2: Run, confirm red** — `npm test -- packages/web/src/routes/task-thread`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -- packages/web/src/routes/task-thread packages/web/src/routes/task-assets && npm run typecheck` → PASS (the asset-comment tests are the guard: their behaviour must not change).
- [ ] **Step 5: Commit** — `git commit -m "feat(web): guest comments ride the review as a third kind"`

---

### Task 11: The Share control

**Files:**
- Create: `packages/web/src/routes/task-preview/share-control.tsx`, `packages/web/src/routes/task-preview/share-control.test.tsx`
- Modify: `packages/web/src/routes/task-preview/browser-view.tsx` (render it in the toolbar after the Design Mode toggle, `data-slot="browser-design-toggle"`, line ~710)

**Interfaces — Consumes:** Task 9's hooks and client calls; `targetOrigin` and `health.data?.capabilities` already in `browser-view.tsx`.

**Interfaces — Produces:**

```tsx
export function ShareControl(props: {
  runId: string;
  /** The loopback origin of the tab on screen, or null when it has none (same value Design Mode uses). */
  targetOrigin: string | null;
  /** Path + search of the tab on screen, for the link's `next`. */
  path: string;
}): JSX.Element | null;
```

States (each a `data-slot`), all from `usePreviewShare(runId)`:

| State | What shows |
| --- | --- |
| capability off | nothing (`null`) |
| idle | `Share` button; disabled with `Sharing works on local http:// addresses` when `targetOrigin` is null |
| popover (`share-confirm`) | the exposure copy from Global Constraints, verbatim, and **Create link**. Shown on every click — nothing is stored (C8) |
| starting | `Creating link…`, the button disabled |
| no tunnel (`share-no-tunnel`) | `Sharing needs cloudflared`, the install command in a copyable code line, **Retry** |
| tunnel failed | cloudflared's line from the error, **Retry** |
| live (`share-live`) | `● Sharing · <n> comments · until <HH:MM>`; the menu has **Copy link**, **Stop sharing**, then one row per guest: waiting → `<name> · <code> wants to join` with **Deny** / **Allow**; allowed → `<name>` with **Remove** |
| live, tab on another origin | the same control reading `Sharing <share.target host>`; **Create link** is not offered (C9) |

`<n> comments` is `useGuestComments(runId)`'s length. `until` is `expiresAt` in the browser's locale, hours and minutes. **Create link** posts `{ target: targetOrigin + path, parentOrigin: window.location.origin }`. After a successful start the link is copied to the clipboard and a toast says `Link copied`. A waiting guest raises the control's attention dot.

- [ ] **Step 1: Write the failing tests** (`share-control.test.tsx`, the query client seeded per case)

```tsx
it('shows the exposure text every time before creating a link', async () => {
  render(<ShareControl runId="r1" targetOrigin="http://localhost:5173" path="/settings" />);
  await user.click(screen.getByRole('button', { name: 'Share' }));
  expect(screen.getByText(/Anyone with this link can use this app and read whatever your dev server serves, including source files\. Traffic passes through Cloudflare\./)).toBeVisible();
  expect(startPreviewShare).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Create link' }));
  expect(startPreviewShare).toHaveBeenCalledWith('r1', { target: 'http://localhost:5173/settings', parentOrigin: window.location.origin });
});
it('offers the install command and Retry when cloudflared is missing', async () => {});
it('lets a waiting guest in, with the name and code on the row', async () => {
  // share.guests = [{ id, name: 'Ana', code: '4821', state: 'waiting' }]
  expect(screen.getByText('Ana · 4821 wants to join')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Allow' }));
  expect(decidePreviewShareGuest).toHaveBeenCalledWith('r1', guestId, 'allow');
});
it('returns to Share when the server no longer knows the share', async () => {
  // Review Focus 4: the query answers { share: null } after having answered a live one
  expect(screen.getByRole('button', { name: 'Share' })).toBeVisible();
});
it('does not offer a second link on a tab with another origin', async () => {});
it('renders nothing when the capability is off', () => {});
```

- [ ] **Step 2: Run, confirm red** — `npm test -- packages/web/src/routes/task-preview/share-control.test.tsx`
- [ ] **Step 3: Implement**, using the shadcn/ui primitives `browser-view.tsx` already imports; light and dark themes, keyboard reachable.
- [ ] **Step 4: Run** `npm test -- packages/web/src/routes/task-preview && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): Share control in the task Preview"`

---

### Task 12: Indicators, docs, ratification entry, and the full gate

**Files:**
- Create: `packages/web/src/components/live-shares-indicator.tsx`, `packages/web/src/components/live-shares-indicator.test.tsx`, `packages/web/e2e/preview-share.e2e.ts`, `docs/site/content/docs/03-features/tasks-and-sessions/share-preview.mdx`
- Modify: `packages/web/src/components/app-shell-container.tsx` (mount the indicator), `packages/web/src/components/current-tasks.tsx` (the task-row badge — beside the row's PR chip; if the row lives in `task-quick-list.tsx` instead, put it there and in every list that renders that chip), `AGENTS.md` (§ Zero config), `docs/site/content/docs/03-features/tasks-and-sessions/index.mdx`, `design-mode.mdx` (one cross-link), `.ai/specs/2026-11-26-preview-share-link.md` (status line → implemented)

**Interfaces — Produces:**

```tsx
export function LiveSharesIndicator(): JSX.Element | null; // null when there are no live shares
export function TaskShareBadge(props: { runId: string }): JSX.Element | null;
```

- `LiveSharesIndicator` reads `useLiveShares()`: `1 live link` / `N live links`, plus `· M waiting` when any guest waits. Its menu lists each share as the task's title and target with **Open** (the task's Preview) and **Stop sharing**.
- `TaskShareBadge` shows a small `Sharing` badge on the row of a task with a live share.
- AGENTS.md entry, inserted with the other pending items:

  > - **Pending owner ratification (2026-11-26)**: the Preview share link (spec `.ai/specs/2026-11-26-preview-share-link.md`) is available by default on a local cockpit; `CEZ_PREVIEW_SHARE=0` turns it off, and it is always off on a hosted one and for a paired phone. Nothing starts before a click on **Share** and a second on **Create link**, under a text that says what is exposed. That click opens a `127.0.0.1` listener mirroring the previewed dev server and one `cloudflared` child that publishes it at a random `trycloudflare.com` address, for at most 8 hours. A visitor needs the link's token and then the owner's Allow per browser, and can only comment: comments wait in the owner's review. Listed here because it puts a dev server on the public internet through a third party. The opt-in version is requiring `CEZ_PREVIEW_SHARE=1` in `previewShareEnabled`.

- The docs page follows `.ai/skills/cezar-docs/SKILL.md`: `title`/`description` frontmatter, what it is, how to share, what the teammate sees, letting people in, the limits from the spec (single origin, no SSE, machine awake, new address each time), and `> **Good to know**:` for the `cloudflared` requirement.
- e2e (`CEZ_DRY_RUN=1`, so the loopback tunnel): start a task, open Preview on the dry-run app address, Share → Create link, open the link in a second page, ask to join as `Ana`, Allow in the cockpit, comment on an element, and see the `Ana · …` chip in the task's composer.

- [ ] **Step 1: Write the failing component tests** — no shares → renders nothing; two shares, one waiting guest → `2 live links · 1 waiting`; **Stop sharing** calls `stopPreviewShare` with that run; `TaskShareBadge` shows only for a run in the listing.
- [ ] **Step 2: Run, confirm red** — `npm test -- packages/web/src/components/live-shares-indicator.test.tsx`
- [ ] **Step 3: Implement** the two components and mount them.
- [ ] **Step 4: Write the docs, the AGENTS.md entry and the e2e spec.**
- [ ] **Step 5: Run the full gate, in order**

```bash
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
npm run docs:check
npm run test:e2e
```

Expected: every command exits 0; `test:e2e` prints `TEST_E2E_STATUS=passed` (a `skipped` is not a pass — say so in the PR).

- [ ] **Step 6: Manual check with a real tunnel** (needs `cloudflared` installed): `npm run dev`, share a real dev server, open the link on a phone off the local network, get let in, leave a comment, send the review. Record what happened in the PR body.
- [ ] **Step 7: Commit** — `git commit -m "feat(web): live share indicators, docs and the zero-config entry"`

### Task 13: Extend a live share

Added by the owner on 2026-11-27.

The owner asked for it mid-run: "let's also add extend option". It changes spec decision C5
("A share ends 8 hours after it starts, whatever happens") to: a share ends 8 hours after it
starts **or after its last Extend**. Every extension is an explicit click by the owner; nothing
extends on its own.

**Files:**
- Modify: `.ai/specs/2026-11-26-preview-share-link.md` (C5, § States "A share", § API and contract,
  § Exposure's "for at most 8 hours" sentence and its risk-table row)
- Modify: `packages/cezar/src/server/preview/share-listener.ts`, `share-listener.test.ts`
- Modify: `packages/cezar/src/server/preview-share-routes.ts`, `packages/cezar/src/server/preview-share-api.test.ts`,
  `BACKWARD_COMPATIBILITY.md` (§2 route inventory)
- Modify: `packages/web/src/api/client.ts`, `client.test.ts`
- Modify: `packages/web/src/routes/task-preview/share-control.tsx`, `share-control.test.tsx`

**Interfaces — Produces:**

```ts
// share-listener.ts
class PreviewShares {
  /** Sets the share to end `lifetimeMs` from now. Null when the run has no live share. */
  extend(runId: string): PreviewShare | null;
}

// route (chained into the existing preview-share family, both mounts)
// POST /runs/:id/preview-share/extend  → previewShareStateResponseSchema ({ share })
//   404 `{ error }` when the run is unknown or has no live share
//   409 `{ error: 'Sharing is not available on this cockpit' }` when the capability is off
//   (it steers a share, so it is capability-gated like the guest decision routes)

// client.ts
export function extendPreviewShare(runId: string): Promise<PreviewShareStateResponse>;
```

No new contract schema: the answer is `previewShareStateResponseSchema`; the path param is the
existing run id param schema the neighbouring routes use.

**Rules:**

- `extend` sets `expiresAt = now + lifetimeMs` (8 hours by default), re-arms the lifetime timer
  (the old timer is cleared; the new one is `unref()`'d), and fires `onChange(projectId, runId, share)`
  so every open cockpit sees the new `expiresAt`. It never shortens a share: if the new expiry would
  be earlier than the current one, keep the current one.
- Nothing else about the share changes: same token, same link, same listener, same tunnel, same
  guests (allowed stay allowed, waiting stay waiting with their own 10-minute clocks, denied stay
  denied).
- A share that has already expired or ended cannot be extended (`null` → 404). A pending start
  (tunnel not up yet) cannot be extended (`null`).
- `startedAt` does not change.
- The wall-clock expiry check that `get()`/`list()` and the request gate already do must use the
  extended `expiresAt`.
- UI: in the live control's menu, between **Copy link** and **Stop sharing**, an item
  **Extend 8 hours**. On success: set the returned state into `queryKeys.runs.previewShare(runId)`
  and toast `Sharing until <HH:MM>` (same time format the control already uses). On failure: the
  server's message as a toast; nothing else changes. Disabled while the request is in flight. Not
  shown when the capability reads false (the server would refuse it).
- Spec edits, exact:
  - C5 call becomes: `A share ends **8 hours** after it starts or after its last **Extend**. No idle rule, and nothing extends on its own.` Its "Why" gains: `Extend (added 2026-11-27 at the owner's request) keeps a long review on one link; each extension is a click.`
  - § States "A share": add `Extend` to the list — "Ended by: **Stop sharing**; 8 hours after it started or was last extended; …".
  - § API and contract: add `POST /runs/:id/preview-share/extend` → `{ share }`.
  - § Exposure: "for at most 8 hours" → "for 8 hours, longer only when the owner clicks **Extend**"; the first risk row's "ends at 8 hours" → "ends 8 hours after the start or the last Extend".

- [x] **Step 1: Write the failing tests**

```ts
// share-listener.test.ts (fake clock via options.now and a short lifetimeMs)
it('extends a live share to a full lifetime from now and keeps the link and guests', async () => {
  // start at t=0 with lifetimeMs L; allow one guest; at t=L-1 extend →
  // share.expiresAt === iso(t + L); url unchanged; the guest still gets the app at t=L+1;
  // onChange fired with the new expiresAt; the share ends ('expired') at the new time.
});
it('never shortens a share and cannot revive an ended one', async () => {
  // extend twice in a row → expiresAt does not move backwards; stop → extend returns null
});
it('does not extend a start that is still waiting for its tunnel', async () => {});

// preview-share-api.test.ts
it('extends a live share, 404s without one, and 409s when sharing is off', async () => {});
it('answers the extend route under /api/v1/p/<boot>/ as well', async () => {});

// share-control.test.tsx
it('extends the share from the menu and says until when', async () => {
  // click Extend 8 hours → extendPreviewShare('r1') called once; toast `Sharing until HH:MM`;
  // the control's "until" shows the new time
});
it('offers no Extend when the capability is off', async () => {});
```

- [x] **Step 2: Run, confirm red**

Run: `npm test -- packages/cezar/src/server/preview/share-listener.test.ts packages/cezar/src/server/preview-share-api.test.ts packages/web/src/routes/task-preview/share-control.test.tsx packages/web/src/api/client.test.ts`

- [x] **Step 3: Implement** the method, the route, the client call, the menu item and the spec edits.
- [x] **Step 4: Run the gates**

Run the Step 2 command, then
`npm test -- packages/cezar/src/server/route-parity.test.ts packages/cezar/src/server/bc-route-inventory.test.ts packages/cezar/src/server/typed-bodies.test.ts packages/cezar/src/server/versioned-surface.test.ts packages/cezar/src/server/preview/design-proxy.test.ts`,
the contract-parity test files by path (`ls packages/cezar/src/server/contract-parity*.test.ts`), then `npm run typecheck`.
Expected: PASS.

- [x] **Step 5: Commit** — `git commit -m "feat(preview): extend a live share by another 8 hours"`

---

## After the last task

Open the PR against `open-mercato/cezar` `main` with the spec, the plan and screenshots of the toolbar states and the guest page. It is a feature, not a fix, so no backport label. The PR body must call out the pending owner ratification.
