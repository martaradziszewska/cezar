# Asset share link — a teammate explores an HTML mockup and comments on it from a browser

> Slug: `asset-share-link` · Status: implemented (2026-11-28), pending owner ratification
> Gate: **pending owner ratification** — a click-started network exposure (§ Exposure).
> Replaces: `2026-11-26-preview-share-link.md`, which shared the task's running app. That version
> was built on `feat/preview-share-link` and never merged; this spec says what ships instead and
> what of that branch is kept (§ What happens to the branch).
> Extends: `2026-10-22-html-artifacts-and-impact.md` (how assets are served), #2446 (comments on
> elements of HTML assets).

## TLDR

The Assets tab's toolbar gets **Share**, beside **Comment**. One click gives a public `https://`
link to the HTML asset on screen. A teammate opens it in any browser, the owner lets them in from
the cockpit, and they use the mockup as it is — click through it, switch its states — and, with
Comment switched on, click an element and write a comment. The comment arrives in the owner's task
as a review comment with the teammate's name on it, and the owner sends the review to the agent as
today. The Preview tab has no Share.

## Intent

Marta has a task whose agent wrote a clickable design mockup (an HTML asset). She wants someone
from her team to explore that mockup and leave comments on it. That person has a browser only — no
cezar, no checkout — and may be anywhere.

The first build misread this as "share the running app". Sharing a dev server is a different
feature with a much larger exposure, and it is not wanted: Share belongs to assets only.

## Goals, non-goals, anti-goals

**Goals**

- One click on the Assets toolbar to start sharing the asset on screen and copy the link; one
  click to stop.
- The guest needs nothing installed: open the link, type a name, wait to be let in.
- The guest can **explore**: with Comment off the mockup behaves exactly as it does for the owner.
- With Comment on, the guest clicks an element and writes a comment, as the owner does in the
  Assets tab's Comment mode.
- A guest comment shows up in the owner's task while the cockpit is open, without a reload.
- Nothing listens and no process runs until the owner clicks Share. Stop removes all of it.

**Non-goals (first cut)**

- Sharing the task's running app (the Preview). Removed, not hidden.
- Sharing several assets behind one link, or a list of the task's assets. One link, one page.
- Non-HTML assets (Markdown, JSON, images on their own). Comment mode is HTML-only today.
- Older versions of an asset. The guest sees the current file.
- The guest's page reloading itself when the agent rewrites the asset. They reload.
- A guest sending anything to the agent, or seeing chat, diff, terminal or any cockpit screen.
- Sharing from a hosted cockpit or a paired phone.
- Guests seeing each other's comments; screenshots.
- The owner's Assets tab drawing the guest's marks on the page. The chip carries the element and
  its markup; marks are the first follow-up.

**Anti-goals** — it has failed if any of these is true, even when everything else works:

- A guest can reach the cockpit API, a dev server, or any file other than the shared asset and the
  task's image assets.
- A browser the owner has not let in receives any byte of the asset.
- The asset's own script can read a guest's comments, or write a comment's text or its author.
  (The asset is sandboxed in the cockpit today; a share must not be weaker. Which element a
  comment points at comes from the page in the cockpit too, § Exposure.)
- The asset's own script can hand the page to a browser the owner never allowed.
- A link stays live without the cockpit saying so.
- It needs a setting, an account or a config file before it works.
- The Design Mode mirror or the cockpit's own asset serving changes behaviour.

## Decisions

Decided with Marta:

| # | Decision |
| --- | --- |
| D1 | The reviewer has a **browser only** (2026-11-26). |
| D2 | The link must **work from anywhere** (2026-11-26). |
| D3 | **The owner lets each visitor in.** A new browser gets a waiting page and nothing of the asset until the owner clicks **Allow** (2026-11-26). |
| D4 | **Assets only.** Share moves to the Assets tab and leaves the Preview (2026-11-28). |
| D5 | **One link shares the one asset on screen**, so the teammate can explore that mockup and comment on it (2026-11-28). |

Proposed by the author; the owner may change any of them:

| # | Call | Why |
| --- | --- | --- |
| C1 | Guest comments go to the **owner's review comments**, never straight to the agent. | An outside person must not prompt an agent that has a shell. Unchanged. |
| C2 | The reach is a **Cloudflare quick tunnel** (`cloudflared` on `PATH`). | Unchanged: public HTTPS with no account, one child process. |
| C3 | The guest gets a **cezar-written page that frames the asset in its sandbox**; the comment bar and popup live in that page, not in the asset. | § Approaches. Reverses the first build's C3. |
| C4 | The click, behind a confirm, is the opt-in. `CEZ_ASSET_SHARE=0` turns it off. | Same shape as Design Mode and the relay. |
| C5 | A share ends **8 hours** after it starts or after its last **Extend**. | Unchanged. |
| C6 | A guest sees and edits **their own** comments only; the owner can delete a guest comment but not edit it. | Unchanged. |
| C7 | A live share is shown **outside the Assets tab too**: the badge on the task's row and the workspace-wide "N live links" indicator, each with Stop. | Unchanged. |
| C8 | The exposure text is shown **every time** a share starts, in the popover that holds **Create link**. | Unchanged; the text is new (§ Exposure). |
| C9 | **One share per task.** Sharing a second asset of the same task is refused (409) until the first is stopped. | A replaced link fails silently for the people using it. |
| C11 | Off for a paired phone and a hosted cockpit. | Unchanged. |
| C12 | The waiting page and the cockpit show the same **4-digit code** beside the visitor's name. | Unchanged. |
| C13 | **Everything is renamed** from "preview share" to "asset share": the env var, the capability, the routes, the SSE frame, the files. | Nothing has shipped, so there is no compatibility cost, and `CEZ_PREVIEW_SHARE` for a button on Assets would mislead for good. |
| C14 | The asset's files are addressed by a **per-guest key in the path**, not by the cookie. | § Mechanism 6: a sandboxed frame does not send the share cookie. |
| C15 | The shared frame's sandbox is **`allow-scripts` only**: no popups, and the shell pins the frame to its own origin. | The asset's script can read its own address, key included. Without a popup or a navigation it has nowhere to send it. The cost is in § Limits. |
| C16 | The guest's marks show **only while Comment is on**. | Exploring should show the mockup, not lime frames. The bar's count says comments exist. The owner's Assets tab keeps showing marks always. |

The first build's C10 (refuse a target that answers as a cezar) is gone with its reason: the
listener no longer forwards to anything.

## Approaches

**What the guest's page is**

| Approach | Trade-off | |
| --- | --- | --- |
| A cezar-written shell that frames the asset in its sandbox, as the cockpit's Assets tab does | The asset keeps its opaque origin and its CSP, so its script can touch neither the cookie nor the comment endpoints. One origin, one tunnel. The bar and popup need a `postMessage` host instead of the in-page one. | **Picked** (C3) |
| Serve the asset at the tunnel's origin and inject the guest script into it, as the first build did for the app | Least new code. But the asset's script and its CDN libraries then share an origin with the comment endpoints: they could read or forge comments, and `connect-src 'none'` would have to open. Weaker than the cockpit is today. | Rejected: third anti-goal |
| Keep the dev-server mirror and point it at cezar's own asset URL | Puts the cockpit's origin behind a public link. The first build refused exactly this (C10). | Rejected |
| Upload a copy of the asset to a host | Needs an account or a third party that keeps the file; comments would have no way back. | Rejected: fourth anti-goal |

**How the link reaches the teammate** — unchanged from the first build: a Cloudflare quick tunnel,
picked over `tailscale serve` (tailnet only), the LAN address (office only) and the phone relay
(private by its own spec).

## What each person sees

Owner, Assets toolbar (Share appears wherever Comment does: an HTML asset, current version):

```
Surfer · Settings · clickable mockup  HTML ▾  [sandboxed]      [Comment] [Share] [⊟] [Open in new tab] [Download] [Reload]
                                                                            │ click → popover: what is exposed · [Create link]
Surfer · Settings · clickable mockup  HTML ▾  [sandboxed]      [Comment] [● Sharing · 3 comments · until 18:40 ▾] …
                                                                            Copy link · Extend 8 hours · Stop sharing
                                                                            ─────────────────────────
                                                                            Ana · 4821 wants to join
                                                                                        [Deny] [Allow]
                                                                            Piotr                [Remove]
```

On another asset of the same task the control reads **Sharing “Settings mockup”** with Stop, and
offers no second link (C9).

Visitor, before being let in — the waiting page, unchanged apart from its first line:

```
┌───────────────────────────────────────────────┐
│   Marta is sharing a design with you.          │
│   Your name  [ Ana            ]  [Ask to join] │
│   Waiting to be let in…    Your code: 4821     │
└───────────────────────────────────────────────┘
```

Guest, after Allow — the mockup fills the window, with a small bar in a corner:

```
┌───────────────────────────────────────────────┐
│  (the mockup, full window, fully clickable)    │
│        ┌─[Save changes]─┐  ← lime frame, ①     │
│        ┌──────────────────────────────┐        │
│        │ button.btn-primary           │        │
│        │ [ too grey, reads disabled  ]│        │
│        │            [Delete] [Save]   │        │
│        └──────────────────────────────┘        │
│                    [💬 Comment  ·  3 · Ana ▾]  │
└───────────────────────────────────────────────┘
```

Owner, composer: a guest comment is a chip beside the diff and asset chips —
`Ana · button.btn-primary “Save changes”`. Clicking it opens the Assets tab on that asset.

## Mechanism

1. **Start.** The owner clicks Share on an HTML asset. A popover states § Exposure, every time
   (C8), above **Create link**. The cockpit asks `POST /runs/:id/asset-share { asset }`, where
   `asset` is a listed artifact name. The server refuses anything `findArtifact` does not list as
   `kind: 'html'` in the run's current artifacts directory.
2. **Listener.** The server opens a share listener on `127.0.0.1:<ephemeral>`. It serves exactly:
   the join link, the waiting page, the guest shell, the shared asset, the run's image assets,
   and the comment endpoints. It forwards nothing, and it refuses every WebSocket upgrade.
3. **Tunnel, link, join, letting in.** As built: `cloudflared` as a fixed argument array, a
   256-bit token, `join` in constant time setting an `HttpOnly; Secure; SameSite=Lax` cookie with
   a random per-browser guest id, the waiting page, Allow / Deny / Remove, 5 waiting at once for
   10 minutes each. The link no longer carries `next`: there is one page to land on.
4. **The shell.** An allowed guest's `/` is a page cezar writes: one `<iframe>` that fills the
   window, plus the corner bar and the comment popup as ordinary DOM. It is the guest's
   counterpart of the cockpit's `AssetCommentsLayer`, and speaks the same protocol to the frame
   (`set-active`, `set-marks`; `ready`, `rects`, `picked`, `mark-clicked`, `cancel`, `toggle`). It
   posts with `'*'` and accepts messages from its own frame's window only, as the cockpit does:
   an opaque origin cannot be named. Its CSP allows its own inline script and style, `frame-src
   'self'` and `connect-src 'self'`; nothing else.
5. **The asset in the frame.** Served with the headers the cockpit sends (`artifactHeaders` →
   `artifactCsp`, with `ownBase` set to this guest's asset base so relative images load), with
   one difference: the `sandbox` directive is `allow-scripts` alone (C15). The framed picker is
   appended (`artifactPickerTag`, told the tunnel's origin). So the asset runs in an opaque
   origin as it does in the cockpit: it cannot read the cookie, call the comment endpoints, or
   reach the shell's DOM. With no popup, `connect-src 'none'`, `form-action 'none'` and the
   shell's `frame-src 'self'`, it also cannot send its address anywhere but a CDN it is already
   allowed to load from. The cockpit's own asset route is not touched.
6. **How the frame is authorised (C14).** A document in an opaque origin does not send a
   `SameSite=Lax` cookie with the requests it makes, so the mockup's own `<img src="shots/a.png">`
   would arrive without one. Asset files are therefore addressed as
   `/__cezar_share__/a/<viewKey>/<name>`: `viewKey` is random, per guest, minted on Allow, checked
   in constant time, and dead the moment the guest is removed or the share ends. It opens the
   shared HTML file and the run's `image` artifacts, nothing else. The asset's script can read it
   (it is in its own address), which is why C15 leaves that script no way to pass it on. The
   shell gets the frame's address from an endpoint that does need the cookie. The builder
   confirms the cookie behaviour in a real browser. Do not add a cookie check to the HTML file:
   the first load carries the cookie, but a reload from inside the frame does not, and a mockup
   that reloads itself would break.
7. **The gate.** Every answer but the join link needs a `Host` equal to the tunnel's. The shell
   and the comment endpoints need an **allowed** guest's cookie; asset files need an allowed
   guest's `viewKey`. A waiting or denied browser reaches the waiting page and its status check
   only. No cookie at all gets "This link is no longer active".
8. **Commenting.** Comment off: the picker is inactive, no marks are set, and the mockup is the
   mockup (C16). Comment on: the guest's saved comments are framed and numbered in the page,
   found again by selector after a reload; a click picks an element, the popup opens beside it,
   and Save posts to `/__cezar_share__/comments`. The author is the name the owner allowed, from the server's record of
   the guest id, never from the request body. The server sets the comment's asset from the share
   itself, never from the request.
9. **Arrival, sending.** As built: validated with zod, stored on the run, pushed to open cockpits,
   shown as a chip, held 5 seconds before a review may carry it, marked sent by id and revision.

### What the agent receives

A guest comment is the asset comment's review item with its author:

```
- `settings-mockup.html` (shared asset) element `main > form > button.btn-primary` — "Save changes" — from Ana:

  ```html
  <button class="btn-primary" disabled>Save changes</button>
  ```

  Too grey — it reads as disabled even when there is something to save.
```

`parseReviewMessage` reads it back into a card. The first build's `(app preview)` item never
shipped and is not kept.

## Storage

Unchanged from the first build, with one field: a guest comment carries `asset` (the artifact's
listed name) where it carried `url`. The list is server-owned per run, appended and edited by
guests, deleted by the guest, the owner's chip ✕ or a sent review; the caps and the review budget
(`guestCommentCost`) stay, with `asset` charged in place of `url`.

## Exposure

Recorded in AGENTS.md § Zero config as **pending owner ratification**, replacing the first
build's entry.

What a share opens: one loopback listener and one `cloudflared` child, after a click and a
confirm, for one HTML asset, for 8 hours, longer only when the owner clicks **Extend**. What the
confirm says:

> People you let in with this link can open this page, and the images among this task's assets,
> and comment. Traffic passes through Cloudflare.

| Risk | Answer |
| --- | --- |
| The link leaking | The holder gets the waiting page and no byte of the asset until the owner allows that browser (D3). The token is in the path, dropped from `Referer`, and useless once the share ends. |
| A stranger typing a teammate's name | The 4-digit code on both sides (C12); **Remove** cuts an allowed guest at once, their `viewKey` included. |
| Join requests as a nuisance | 5 waiting at once, 10 minutes each, a rate limit per address on `join`. |
| A join request timed to slide under the owner's click | Allow / Deny / Remove are off for 600 ms whenever a row moves. As built. |
| Reaching cezar or a dev server | The listener reads files from one run's artifacts directory and forwards nothing. No target, no upstream, no upgrade. |
| Reading other files of the task | `findArtifact` is the traversal guard, as on the cockpit's own route. Only the shared HTML asset and `image` artifacts of that run are served; another HTML asset is a 404. Accepted: an allowed guest who guesses the file name of another image among the task's assets can open it, because the listener cannot know which images a page will ask for. |
| The asset's script reading comments, or writing their text | It runs in an opaque origin with `connect-src 'none'` (C3) and cannot reach the shell's DOM or the endpoints. The body is typed into the shell, the author comes from the server, and Save is a click in the shell. |
| The asset's script choosing what a comment points at | Accepted, and the same in the cockpit: the selector, label and markup excerpt come from the frame's `picked` message, which the asset's script could post itself. They are capped and fenced, and the guest sees the element named in the popup before saving. |
| The asset's script passing the `viewKey` to someone else | It can read the key from its own address. C15 leaves it no popup, no navigation, no request and no form to send it with. What remains is the query string of a script it loads from an allowed CDN: the CDN's operator could see the key, and with it the page and the task's images until that guest is removed or the share ends. `referrer-policy: no-referrer` keeps it out of `Referer`. |
| Forged comment requests | The cookie, an `Origin` equal to the tunnel's, and a JSON body. |
| Hostile comment text in a prompt | Labelled as a guest's, capped twice, fenced in the review, read by the owner first, held 5 seconds. |
| A tunnel edge caching the asset | Every answer is `private, no-store`. As built. |
| A stray `cloudflared` | Killed on Stop, expiry and shutdown; `~/.cache/cez/share-tunnels.json` and the boot-time reap. As built. |
| A paired phone or a hosted cockpit starting a share | The capability is off for both. A phone can still read the link and stop it. |

Each row gets a test.

## States and their exits

- **A share** (listener + tunnel child + token; one per task, four at once). Started by the route.
  Ended by: **Stop sharing**; 8 hours after it started or was last extended; the tunnel child
  exiting; the task being archived or deleted; server shutdown. A reclaimed worktree no longer
  ends it, on purpose: assets live under `.ai/cezar/artifacts/`, not in the worktree. Nothing is
  persisted. Asking again
  for the same asset answers the same link; another asset of that task is refused (C9).
- **The asset is gone or renamed.** The share stays up — the agent may be rewriting the file —
  and the frame shows a plain "This page is not available right now". It comes back when the file
  does.
- **A tunnel that will not start; a join request; an allowed guest; a denied guest; a guest
  comment.** As in the first build. A removed guest's `viewKey` dies with them.

The first build's "the app is down" state is gone with the app.

## API and contract

Shapes in `packages/contract/src/asset-share.ts`; routes chained into their family and mounted
under both `/api/v1/…` and `/api/v1/p/:projectId/…`.

- `POST /runs/:id/asset-share` `{ asset }` → `{ share }`. 400 when `asset` is not a listed HTML
  asset of the run. 409 when off, hosted, the task is archived, the task already shares another
  asset, four shares are live, or no tunnel binary is found (with the install command).
- `GET` / `DELETE /runs/:id/asset-share`, `POST …/extend`, `POST` / `DELETE …/guests/:guestId`:
  as built, renamed. A share carries `asset` and the asset's title (`extractTitle`, as the scan
  does) where it carried `target`.
- `GET /runs/:id/guest-comments`, `DELETE …/:commentId`, `POST …/sent`: as built.
- `GET /workspace/asset-shares` → every live share, with `asset` and its title.
- `capabilities.assetShare`; `CEZ_ASSET_SHARE` in `.env.example` and `docs/reference.md`.
- SSE frames `asset-share` and `guest-comments` on the global stream, never on the WebSocket bus.
- `/__cezar_share__/*` on the listener is not part of the versioned API.

`CEZ_DRY_RUN=1` keeps the fake adapter whose "tunnel" is the listener's own loopback address.

## What happens to the branch

Kept, renamed where it says "preview": the tunnel adapter and its record, the token, cookie and
join, the waiting page and guest states, Allow / Deny / Remove, the clock and Extend, the
guest-comment store, routes and SSE frames, the Share control and its guest list, the live-links
indicator and the task-row badge, guest chips, the 5-second hold and the sent marks.

Removed:

- The Preview toolbar's Share and everything that mirrored an app: forwarding, WebSocket splice,
  redirect and cookie rewriting, the "answers as a cezar" probe, the app-down state.
- The in-page guest host and the picker's in-page variant. The picker goes back to framed-only.
- `forward.ts` as a shared module: the Design Mode mirror goes back to what `main` has, unless a
  commit on the branch fixed a bug that `main` also has (the redirect prefix fix, `b788102ad`) —
  that one is kept and ships as its own change.
- The first build's spec, plan and feature page, replaced by this spec and a new page.

## Limits

- **One page.** A link in the mockup that leads to another HTML asset does not open it.
- **No new tabs for a guest.** A link in the mockup that opens another site, or a new tab, does
  nothing for a guest (C15). It still works for the owner in the cockpit.
- **A comment is pinned to an element, not to a state.** A mockup with several states shows a
  comment's mark only while that element is on screen. Same as the owner's asset comments.
- **The owner's machine must be awake**, and the owner must be at the cockpit when a teammate
  first opens the link.
- **A new address every time.** Stopping and sharing again gives a different link.
- **Whatever a CDN refuses to a sandboxed page**, it refuses here too: the asset is served exactly
  as in the cockpit.

## Left to the builder

- Whether the shell reuses the first build's bar and popup source with a `postMessage` transport,
  or is written fresh against the framed picker's protocol. Either way the protocol exists once.
- Where the Share control's component lives now that the Preview does not use it, and how the
  Assets toolbar fits it at phone width.
- The exact CSP of the shell, and how the frame's address is handed to it.
- Whether the cookie check can also be applied to asset files (§ Mechanism 6).
- The order of work. A workable one: rename and strip the mirror; the listener serving the shell
  and the asset; the shell's comment host; the cockpit's Assets toolbar and chip target; e2e
  (share an asset, comment through the real bar — the shell is ordinary DOM); then docs
  (`docs/site` feature page, `.env.example`, `docs/reference.md`, AGENTS.md,
  BACKWARD_COMPATIBILITY.md).
