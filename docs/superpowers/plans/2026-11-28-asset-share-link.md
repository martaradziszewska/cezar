# Asset Share Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Share from the task's Preview to its Assets tab: a public link to ONE HTML asset, where a teammate the owner lets in explores the mockup and pins comments to elements.

**Architecture:** The branch already holds a share listener, a tunnel adapter, a waiting room, a guest-comment store and the cockpit's Share control, all built for a dev server. This plan keeps those, deletes everything that mirrored an app, and makes the listener serve two things from disk: a cezar-written guest shell at `/`, and the asset inside a sandboxed frame at a per-guest path. The shell hosts the comment bar and speaks the framed picker's `postMessage` protocol, as the cockpit's `AssetCommentsLayer` does.

**Tech Stack:** TypeScript (ESM, Node 20+), Hono, zod, `node:http`, React 19, TanStack Query, vitest.

**Spec:** `.ai/specs/2026-11-28-asset-share-link.md` — read it first; ids (D1–D5, C1–C16) refer to it.

## Global Constraints

- `AGENTS.md` § Zero config, § The HTTP API, § Changing a mechanism that already works apply.
- Names: capability `assetShare`; env `CEZ_ASSET_SHARE` (`=0` off); routes `/runs/:id/asset-share[/extend|/guests/:guestId]`, `/workspace/asset-shares`; SSE frame and event `asset-share`; contract file `packages/contract/src/asset-share.ts` (already written — it is the interface between server and cockpit; change it only with a note in the hand-back). No `preview-share`, `previewShare`, `PreviewShare` or `CEZ_PREVIEW_SHARE` may remain anywhere but the deleted spec's git history.
- Exact values kept: 8 hours; 4 shares at once; 1 per run; 5 waiting; 10 minutes per join request; 30 s tunnel start; 4-digit code; 256-bit token, cookie secret and view key; comment caps as in the contract.
- Listener paths: `/__cezar_share__/join/<token>` → cookie + 302 to `/__cezar_share__/wait`; `wait`, `status`, `ask`, `comments`, `comments/<id>` under the prefix (cookie); `/` = the guest shell (allowed cookie); `/__cezar_share__/a/<viewKey>/<artifact name>` = asset files (allowed guest's view key, no cookie). Everything else 404 `This link is no longer active.`; every upgrade destroyed.
- The framed asset: `artifactHeaders` output with the CSP's sandbox directive replaced by `sandbox allow-scripts` (C15), `ownBase` = `<tunnel origin>/__cezar_share__/a/<viewKey>/`, picker appended with `artifactPickerTag([http://<host>, https://<host>])`. Served names: the shared HTML asset, and any `kind: 'image'` artifact of the run. The cockpit's own asset route sends byte-identical headers to `main`.
- The shell's CSP: `default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
- Exposure copy, verbatim: `People you let in with this link can open this page, and the images among this task's assets, and comment. Traffic passes through Cloudflare.`
- Waiting page heading: `Someone is sharing a design with you.`; its `<title>`: `Shared design`.
- Review item, verbatim shape: `` - `<asset>` (shared asset) element `<selector>` — "<label>" — from <author>: `` then the optional `component:` line, the fenced excerpt and the body, as the asset comment item is laid out.
- `packages/cezar/src/server/preview/design-proxy.ts` and `picker-script.ts` end up equal to `main` except the redirect prefix fix of `b788102ad`; `forward.ts` and its test are deleted.
- Comments cite `spec 2026-11-28-asset-share-link`. Tests through `npm test -- <path>`, never `npx vitest`. No commits, no `git stash`: three workers share this checkout.

## Review Focus

1. **A view key from a removed guest.** Asset files answer 404 at once, and what that guest had open is cut. → Task 1.
2. **A name that is not the shared asset.** Another HTML asset, a dot file, a `..` path, a Markdown or JSON asset under a valid view key: 404, nothing read. → Task 1.
3. **The asset is rewritten or deleted mid-share.** The next load serves the new file; a missing file answers a plain page and the share stays up. → Task 1.
4. **The share ends while a guest is writing.** Save answers 404; the shell keeps the typed text and says the link has ended. → Task 2.
5. **A message to the shell from anything but its own frame** (the top window, another frame, a forged `picked` from a popup): ignored. → Task 2.

---

### Task 1: Server — the listener serves an asset, not an app

**Files:** `packages/cezar/src/server/preview/share-listener.ts` (+test), `share-guest-routes.ts` (+test), `packages/cezar/src/server/artifacts.ts`, `packages/cezar/src/server/preview-share-routes.ts` → `asset-share-routes.ts`, `preview-share-api.test.ts` → `asset-share-api.test.ts`, `contract-parity.preview-share.test.ts` → `contract-parity.asset-share.test.ts`, `server.ts`, `capabilities.ts` (+test), `relay/scope.ts`, `runs/guest-comments.ts` (+test), `worktree-lifecycle.ts`, and every other `packages/cezar` file that names the share (not the three mirror files of Task 3).

**Interfaces — produces:**
- `class AssetShares` (was `PreviewShares`): `start({ runId, projectId, asset, assetTitle }): Promise<ShareStart>`; `get`, `list`, `projectOf`, `stop`, `extend`, `decide`, `removeGuest`, `closeAll` unchanged.
- `GuestRequest` loses `upstreamOrigin`, gains `asset: string` and, for an allowed guest, `viewBase: string` (`/__cezar_share__/a/<viewKey>/`).
- `GuestRoutes` gains `shell(ctx, req, res): void` and `asset(ctx, name, req, res): void`.
- `artifactCsp(cdnEnabled, ownBase?, sandbox?)` and `artifactHeaders(artifact, cdnEnabled, ownBase?, sandbox?)`; the default is today's string.

- [x] Strip `upstream`, `forward`, `verified`/`probe`/`doubt`, `answersAsCezar`, `isCezar`, `safeNext` and `next`; `upgrade` destroys the socket. Delete their tests.
- [x] Tests first, then code: a view key is minted when a guest becomes `allowed`, dies on Remove and on end; `/` serves the shell to an allowed cookie only; asset files follow Global Constraints; Review Focus 1–3.
- [x] `POST /runs/:id/asset-share { asset }`: 400 unless `findArtifact` lists it as `html`; title from the scan (`extractTitle`), else the name; same asset again answers the same link; another asset 409 `Already sharing “<title>” — stop it first`.
- [x] A guest comment stores `asset` from the share, never from the body; `guestCommentCost` charges it.
- [x] A reclaimed worktree no longer ends a share; archive and delete still do (spec § States).
- [x] `npm test -- packages/cezar/src/server/preview packages/cezar/src/server/asset-share-api.test.ts packages/cezar/src/runs/guest-comments.test.ts` passes.

### Task 2: The guest shell

**Files:** `packages/cezar/src/server/preview/share-guest-script.ts` → `share-guest-shell.ts`; `packages/web/src/routes/task-preview/share-guest-script.test.ts` → `packages/web/src/routes/task-assets/share-guest-shell.test.ts`.

**Interfaces — produces:** `guestShell(config: { name: string; frameSrc: string; nonce: string; title: string }): string` — the whole HTML document. Consumed by `GuestRoutes.shell`.

- [x] The bar and popup become ordinary DOM in the shell (no shadow root). `tell` posts to the frame's `contentWindow` with `'*'`; `receive` runs for `message` events whose `source` is that window and whose `data.source` is `cezar-design`.
- [x] Marks and `set-active` are sent only while Comment is on (C16); every own comment is on this one page, so the path filter goes.
- [x] Tests: Review Focus 4 and 5; a saved comment's number; Comment off sends `set-marks` with an empty list.

### Task 3: Put the mirror back, and the docs

**Files:** `packages/cezar/src/server/preview/design-proxy.ts`, `forward.ts`, `forward.test.ts`, `picker-script.ts` and their tests; `AGENTS.md`, `.env.example`, `docs/reference.md`, `docs/site/content/docs/03-features/tasks-and-sessions/*`, `BACKWARD_COMPATIBILITY.md`; delete `.ai/specs/2026-11-26-preview-share-link.md` and `docs/superpowers/plans/2026-11-26-preview-share-link.md`.

- [x] `git restore --source=main --worktree` the mirror files, then re-apply only the redirect fix and its test. `git diff main -- packages/cezar/src/server/preview/design-proxy.ts` shows that fix alone.
- [x] Rewrite the AGENTS.md ratification entry, the env docs, the route inventory and the feature page for assets; `npm run docs:check` passes.

### Task 4: Cockpit — Share on the Assets toolbar

**Files:** `packages/web/src/routes/task-preview/share-control.tsx` and `share-guests.tsx` (+tests) → `packages/web/src/routes/task-assets/`; `assets-view.tsx`; `browser-view.tsx`; `packages/web/src/api/*`; `components/live-shares-indicator.tsx`, `current-tasks.tsx`; `routes/task-thread/diff-comments.ts`, `diff-comment-chips.tsx`, `review-comments-block.tsx`; every web test that names the share.

- [x] `ShareControl({ runId, asset, assetTitle })` renders in the Assets toolbar after **Comment**, under the same `commentable` condition. On another asset of a sharing task it reads `Sharing “<assetTitle>”` with Stop and no Create link.
- [x] The Preview toolbar has no Share; `browser-view.tsx` equals `main`.
- [x] A guest chip opens the Assets tab on `comment.asset`; the review item follows Global Constraints and `parseReviewMessage` reads it back.
- [x] `npm test -- packages/web/src/routes/task-assets packages/web/src/routes/task-thread packages/web/src/api packages/web/src/components` passes.

### Task 5: End to end, and the gate

**Files:** `packages/web/e2e/preview-share.e2e.ts` → `asset-share.e2e.ts`.

- [x] Owner shares an HTML asset from the Assets toolbar; guest waits, is allowed, switches Comment on, clicks an element in the frame, saves through the real bar; the chip appears under the guest's name; Stop ends the link.
- [x] `npm run typecheck`, then the targeted suites of Tasks 1–4. The full gate runs at commit.
