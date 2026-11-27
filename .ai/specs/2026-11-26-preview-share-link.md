# Preview share link — a teammate comments on the task's app from a browser

> Slug: `preview-share-link` · Status: proposed (design only, 2026-11-26)
> Gate: **pending owner ratification** — a new, click-started network exposure (§ Exposure).
> Extends: `2026-10-09-design-mode.md` (the mirror and the picker), #2446 (comments on elements of
> HTML assets, which ride the review comments).
> Related, not required: `2026-10-31-task-preview-apps.md` (the hosted port gateway, unbuilt).

## TLDR

The Preview's toolbar gets **Share**. One click gives a public `https://` link to the task's
running app. A teammate opens it in any browser, the owner lets them in from the cockpit, and
they click an element and write a comment. The
comment arrives in the owner's task as a review comment with the teammate's name on it, beside line
comments and asset comments, and the owner sends the review to the agent as today. The guest never
sees the cockpit and never prompts the agent.

## Intent

Marta wants someone from her team to leave comments about the changes a task proposes in the app.
That person has a browser only — no cezar, no checkout — and may be anywhere, so the link must work
from outside her network. The comments should work "just like in assets": pinned to elements,
collected, sent with the review.

## Goals, non-goals, anti-goals

**Goals**

- One click to start sharing and copy the link; one click to stop.
- The guest needs nothing installed: open the link, type a name, wait to be let in, click
  elements, write comments.
- A guest comment shows up in the owner's task while the cockpit is open, without a reload.
- Nothing listens and no process runs until the owner clicks Share. Stop removes all of it.

**Non-goals (first cut)**

- A guest sending anything to the agent, or seeing chat, diff, terminal or any cockpit screen.
- Sharing from a hosted cockpit. That needs the port gateway of `task-preview-apps` Phase 3.
- Sharing HTML assets. The same listener could serve them later.
- Apps that span several local origins (§ Limits).
- Screenshots, and guests seeing each other's comments.
- The owner's Preview drawing the guest's marks on the page. Chips are enough to start.
- Reviewing while the owner's machine is asleep or the app is stopped.

**Anti-goals** — it has failed if any of these is true, even when everything else works:

- A guest can reach the cockpit API, or any local port other than the one shared.
- A browser the owner has not let in receives any byte of the app.
- A link stays live without the cockpit saying so.
- It needs a setting, an account or a config file before it works.
- The Design Mode mirror loses any loopback-only guarantee of design-mode § 4.

## Decisions

Decided with Marta (2026-11-26):

| # | Decision |
| --- | --- |
| D1 | The reviewer has a **browser only**. Rules out "open the branch in your own cezar". |
| D2 | The link must **work from anywhere**. Rules out Tailscale-only and same-network links as the first reach. |

Proposed by the author and not objected to; the owner may change any of them:

| # | Call | Why |
| --- | --- | --- |
| C1 | Guest comments go to the **owner's review comments**, never straight to the agent. | An outside person must not prompt an agent that has a shell. It is also how asset comments already behave. |
| C2 | The reach is a **Cloudflare quick tunnel** (`cloudflared`), found on `PATH`. | Public HTTPS with no account, WebSockets work, one child process. Nothing else in cezar relays to a browser. |
| C3 | The comment box is drawn **inside the shared page**, not by a guest shell on a second origin. | One origin means one listener and one tunnel. § Approaches has the trade-off. |
| C4 | The click, behind a first-time confirm, is the opt-in. `CEZ_PREVIEW_SHARE=0` turns it off. | Same shape as Design Mode (2026-10-17) and the relay (2026-11-01). The opt-in version is requiring `CEZ_PREVIEW_SHARE=1`; it is one line in the capability. |
| C5 | A share ends **8 hours** after it starts or after its last **Extend**. No idle rule, and nothing extends on its own. | One clock the owner can read off the toolbar. An idle timeout would kill a link the teammate has not opened yet. Extend (added 2026-11-27 at the owner's request) keeps a long review on one link; each extension is a click. |
| C6 | A guest sees and edits **their own** comments only; the owner can delete a guest comment but not edit it. | They are someone else's words. |
| C7 | A live share is shown **outside the Preview too**: a badge on the task's row and one workspace-wide "N live links" indicator in the app shell, each with Stop. | The second anti-goal. The Preview toolbar disappears the moment the owner opens another task. |
| C8 | The exposure text is shown **every time** a share starts, in the popover that holds **Create link**. Nothing is remembered. | Each project exposes different source, and a stored "seen it" would let a second repository go public with no warning. Sharing is rare enough for one extra click. |
| C9 | One share per run. A second target on the same run is **refused** (409) until the first is stopped; it never replaces a link teammates already hold. | A replaced link fails silently for the people using it. |
| C10 | A target that **answers as a cezar** is refused, on top of the mirror's origin checks. | A task in cezar's own repository previews another cezar on another port. Sharing that would put an API with an unrestricted shell behind the link. |
| C11 | Off for a paired phone (`narrowForRelay`), like Design Mode. | A relay request is a hosted request; a phone cannot start a public listener on the desktop. |

Added after the safety review with Marta (2026-11-26):

| # | Decision | Why |
| --- | --- | --- |
| D3 | **The owner lets each visitor in.** A new browser that opens the link gets a waiting page and nothing of the app until the owner clicks **Allow** in the cockpit. | The link alone was the only lock. A forwarded message, a shared channel or a chat app's link-preview bot would otherwise reach a dev server that was never built for the internet. The cost: the owner must be at the cockpit when a teammate first opens the link. |
| C12 | The waiting page and the cockpit show the same **4-digit code** beside the name the visitor typed. | The name is whatever the visitor types. The code lets the owner check "is 4821 you?" over chat before allowing. Same idea as the relay's desktop match. |

## Approaches

**How the link reaches the teammate**

| Approach | What it gives | What it costs | |
| --- | --- | --- | --- |
| Cloudflare quick tunnel | A random public `https://…trycloudflare.com` address, no account | A new binary to discover. Cloudflare terminates TLS and carries the traffic. No Server-Sent Events, 200 in-flight requests, no uptime promise | **Picked** (D2) |
| `tailscale serve` | HTTPS for tailnet members only; nothing public; identity for free | Works only inside one tailnet | Rejected by D2. Good second adapter |
| Bind the LAN address | No dependency | Office or VPN only, plain `http` | Rejected by D2 |
| cezar's phone relay | Zero install | The relay is private, end-to-end encrypted for a native app, and "relaying to a browser" is a stated non-goal of its spec | Owner's decision, not this spec's |
| Hosted cockpit + port gateway | A normal cockpit URL | Unbuilt, unratified, and only for teams that run a hosted cockpit | Out of scope |
| Teammate's own cezar, notes back through the PR | No exposure at all | Needs a dev setup | Rejected by D1 |
| A static snapshot of the page | Works with the laptop off | Not the app: no navigation, no state | Rejected: the changes under review are in a running app |

**Where the guest's comment box lives**

| Approach | Trade-off | |
| --- | --- | --- |
| In the shared page, in a shadow root, posting to the share listener | One origin. The guest's text sits in the app's document, so the app's own script could read or forge comments. | **Picked** (C3) |
| A guest shell on a second origin that frames the app, as the cockpit does | Text never touches the app's document. Needs two listeners and two tunnels, and the shell must be allowed to frame the app. | Rejected |

C3 is acceptable because of C1: a guest comment is data shown to the owner, capped and labelled,
and the app is the owner's own task. The cockpit keeps drawing its own popup for the owner
(design-mode § 7a), where the text does go to the agent on one click.

## What each person sees

Owner, Preview toolbar:

```
[←][→][⟳]  localhost:5173/settings          [Design Mode ⌥D]  [Share]
                                                     │ click
[←][→][⟳]  localhost:5173/settings   [Design Mode ⌥D]  [● Sharing · 3 comments · until 18:40 ▾]
                                                          Copy link · Stop sharing
                                                          ─────────────────────────
                                                          Ana · 4821 wants to join
                                                                      [Deny] [Allow]
                                                          Piotr                [Remove]
```

A waiting visitor also shows in the workspace-wide indicator (C7), so the owner sees the request
from any screen of the cockpit.

Visitor, before being let in:

```
┌───────────────────────────────────────────────┐
│   Marta is sharing an app preview with you.    │
│   Your name  [ Ana            ]  [Ask to join] │
│                                                │
│   Waiting to be let in…    Your code: 4821     │
└───────────────────────────────────────────────┘
```

Owner, composer: guest comments are chips beside the diff and asset chips —
`Ana · button.btn-primary “Save”`. Clicking one opens the Preview on that comment's page.

Guest, the app with a small bar in a corner:

```
┌───────────────────────────────────────────────┐
│  (the app, full window)                        │
│        ┌─[Save]─┐  ← lime frame, numbered ①    │
│        ┌──────────────────────────────┐        │
│        │ button.btn-primary           │        │
│        │ [ make this the brand green ]│        │
│        │            [Delete] [Save]   │        │
│        └──────────────────────────────┘        │
│                    [💬 Comment  ·  3 · Ana ▾]  │
└───────────────────────────────────────────────┘
```

Comment mode off, the app behaves normally. The name is the one given on the waiting page.

## Mechanism

1. **Start.** The owner clicks Share on a Preview tab showing a loopback `http://` address. A
   popover states § Exposure in two sentences, every time (C8), above **Create link**. The cockpit
   asks `POST /runs/:id/preview-share { target, parentOrigin }`. `parentOrigin` is the cockpit's
   own origin, as in the Design Mode request: under the Vite dev proxy the request's `Host` is the
   API's, so the body is the only way the server learns the cockpit's. Both are refused as
   targets, and so is any target whose `/api/v1/health` answers as a cezar (C10).
2. **Listener.** The server opens a *share listener* on `127.0.0.1:<ephemeral>` that mirrors that
   one dev server: pass-through, WebSocket splice, one script tag in HTML documents. It is a new
   class beside `DesignProxies`, sharing its forwarding code; the Design Mode mirror is not
   reused, reconfigured or widened.
3. **Tunnel.** The server starts the reach adapter. For `cloudflared`:
   `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>` as a fixed argument array,
   and it reads the `https://<name>.trycloudflare.com` address from the child's output (30 s
   limit). The adapter is one interface (`start(port) → { origin, stop }`), so `tailscale` can
   follow; only `cloudflared` is built. No `cloudflared` on `PATH`: the route answers 409 with the
   platform's install command, the toolbar shows it with **Retry**, and nothing else changes.
4. **Link.** The server mints a 256-bit token and answers
   `{ url: https://<name>.trycloudflare.com/__cezar_share__/join/<token>?next=<path>, expiresAt }`.
5. **Join.** `join` compares the token in constant time and sets an `HttpOnly; Secure;
   SameSite=Lax` cookie holding a random per-browser guest id, with `Referrer-Policy:
   no-referrer`. The token is reusable until the share ends, so several teammates can use one
   link — but the token only buys a place in the queue. The visitor gets the waiting page, served
   by the listener itself: a name field, then a 4-digit code and "Waiting to be let in".
6. **Letting in (D3).** The request appears live in the cockpit with the name and the code. On
   **Allow** the guest id becomes allowed and the waiting page moves on to `next` (a same-origin
   relative path only). On **Deny** that guest id is refused for the rest of the share. A request
   nobody answers expires after 10 minutes; at most 5 wait at once.
7. **Gate.** Every request and every WebSocket upgrade is forwarded to the app only with an
   **allowed** guest id and a `Host` equal to the tunnel's. A waiting or denied browser can reach
   the waiting page and its status check, nothing else. No cookie at all gets a plain "This link
   is no longer active" page. The share cookie is removed before a request is forwarded.
8. **Commenting.** The injected script is the Design Mode picker's selection and description code
   with an in-page host: the corner bar, the comment popup, numbered marks found again by
   selector on the same path (as asset comments are). Saving posts to
   `/__cezar_share__/comments` on the same origin. The author is the name the owner allowed, read
   from the server's record of the guest id, never from the request body.
9. **Arrival.** The server validates the comment (zod, the caps of `parseDesignPick`), stores it
   on the run, and tells open cockpits. The cockpit shows it as a review comment chip.
10. **Sending.** The owner sends the review as today: the message is composed in the browser and
   posted as text, so the server never sees which comments it carried. After a successful send the
   cockpit calls `POST /runs/:id/guest-comments/sent` with each carried comment's id and revision.
   The server removes only those still at that revision, in one write. A comment a guest edited
   while the send was in flight stays, unsent, which is what `submit` already does for the owner's
   own comments.

### What the agent receives

Guest comments add a third kind to the review block (`formatDiffComments`):

```
- `http://localhost:5173/settings` (app preview) element `main > form.settings > button.btn-primary` — "Save" — from Ana:

  component: SettingsPage › SettingsForm › Button (src/ui/button.tsx:14)

  ```html
  <button class="btn-primary" type="submit">Save</button>
  ```

  Make this the brand green, it reads as a link right now.
```

The address is the app's real one, never the tunnel's. `component` is best-effort, as in
design-mode § 3. `parseReviewMessage` must read the new item back into a card, and every review
already sent must still render.

## Storage

Guest comments are a **server-owned list per run**. The server appends (a guest saves), replaces
one (a guest edits their own) and deletes (a guest, the owner's chip ✕, or a sent review). The
cockpit never writes the list as a whole. That is deliberate: the `diff-comments` draft surface is
replaced whole by the cockpit after a client-side merge, and a guest append landing between its
read and its write would be lost.

- The cockpit's review list (`useDiffComments`) is the union of the `diff-comments` surface and
  this list.
- Removed with the run, and covered by `ensureDataGitignore`.
- Comments outlive the share: a link that has ended leaves its comments where they are.
- Caps: 2,000 characters per comment, 600 of markup (`ASSET_EXCERPT_MAX`), 60 per author name,
  50 unsent comments per run, and 60,000 characters for the run's whole unsent list. A review
  message holds 100,000 characters and `messageWithReview` throws past that; the owner cannot
  edit a guest's words, so the list must always fit with room for the owner's own comments. A
  guest who hits the budget is told the reviewer's inbox is full.
- Each comment carries a revision that changes on every guest edit (step 10 of § Mechanism).

## Exposure

Recorded in AGENTS.md § Zero config as **pending owner ratification** in the implementing PR.

What a share opens: one loopback listener and one `cloudflared` child, after a click and a
confirm, for one dev server, for 8 hours, longer only when the owner clicks **Extend**. What the confirm must say:

> Anyone with this link can use this app and read whatever your dev server serves, including
> source files. Traffic passes through Cloudflare.

A dev server is not a production app: Vite serves source and `/@fs/` paths, source maps are on,
debug routes exist, and a request through the mirror arrives from loopback with `Host` rewritten,
so whatever the dev server trusts a local visitor with, it trusts a guest with. Two locks stand
between that and the internet: the token, and the owner's Allow (D3).

| Risk | Answer |
| --- | --- |
| The dev server on the public internet | Click and confirm; a 256-bit token; then the owner's Allow per browser; every request and upgrade gated on an allowed guest id; ends 8 hours after the start or the last Extend, on Stop, and with the server. |
| The link leaking (forwarded, posted in a channel, fetched by a link-preview bot) | The holder gets the waiting page and no byte of the app until the owner allows that browser (D3). The token is in the path, never forwarded to the app, dropped from `Referer`, and useless once the share ends. |
| A stranger with the link typing a teammate's name | The 4-digit code on both sides (C12). The owner can also **Remove** an allowed guest at any time, which cuts their session at once. |
| Join requests as a nuisance | 5 waiting at once, 10 minutes each, a rate limit per address on `join`; **Stop sharing** ends all of it. |
| Open proxy | Forwards only to the one loopback origin it was opened for (`parseDesignTarget`). |
| Reaching cezar | The cockpit origin (from the body) and the API origin (the request's `Host`) are refused as targets under every loopback spelling, as in the mirror. Those two checks miss a second cezar on another port, so a target that answers as a cezar is refused as well (C10). The listener serves the mirror and `/__cezar_share__/*` only. |
| A paired phone starting a share | The capability is narrowed off in `narrowForRelay` (C11). |
| Forged comment requests | The comment endpoints need the cookie, an `Origin` equal to the tunnel's, and a JSON body. |
| The app's script forging or reading comments (C3) | Accepted. Comments are labelled as a guest's, capped twice, fenced in the review, and never delivered without the owner's click. |
| Hostile comment text in a prompt | Same trust level as the diff the agent already reads; the owner reads it first. |
| Flooding | The caps in § Storage, plus a per-guest rate limit. |
| The app's session | The guest starts logged out: cookies are per browser. `Set-Cookie` from the app passes through with any `Domain` attribute removed. |
| A stray child process | `cloudflared` is killed on Stop, on expiry and on server shutdown (`onDispose`). |
| Hosted cockpits | Off. The capability is `localHandoff` and not `CEZ_PREVIEW_SHARE=0`. |

Each row gets a test, as design-mode § 4 does in `design-proxy.test.ts`.

## States and their exits

- **A share** (listener + tunnel child + token; one per run, four at once). Started by the route.
  Ended by: **Stop sharing**; 8 hours after it started or was last extended; the tunnel child exiting; the task being archived or
  deleted, or its worktree reclaimed; server shutdown. Nothing is persisted, so a restart ends
  every share — the quick tunnel's address would have changed anyway. Asking again for the same
  target while one is live answers the same link; a different target is refused (C9), and a
  Preview tab on another origin shows the same "Sharing localhost:5173" control with Stop.
- **Share state in the cockpit.** Read from `GET /runs/:id/preview-share` and, for the task-row
  badge and the app-shell indicator (C7), `GET /workspace/preview-shares`; both updated live. A
  share that ended on its own says why in the toolbar ("Sharing stopped: cloudflared exited").
- **A tunnel that will not start.** `cloudflared` is installed but exits before printing an
  address. The toolbar shows its last line of output and **Retry**; no listener is left open.
- **A join request.** Created when a visitor with a valid token gives a name. Ends by: Allow,
  Deny, 10 minutes with no answer (the waiting page says so and offers to ask again), or the share
  ending.
- **An allowed guest.** Created by Allow. Ends by: **Remove** in the Sharing menu, or the share
  ending. Memory-only, like the share. Comments they already left stay.
- **A denied guest.** That browser is refused until the share ends. A different browser can ask
  again, within the limits in § Exposure.
- **A guest comment.** Created by a guest. Gone when the guest deletes it, the owner deletes its
  chip, a review carries it, or the run is deleted.
- **The app is down.** The listener answers a plain "The app is not running right now" page. The
  share stays up, so starting the app again brings the link back.

## API and contract

All shapes in `packages/contract/src/preview.ts`; routes chained into the runs family and mounted
under both `/api/v1/…` and `/api/v1/p/:projectId/…`.

- `POST /runs/:id/preview-share` `{ target, parentOrigin }` → `{ share }`. 409 `{ error }` when
  off, hosted, the target is refused, the run already shares another target, four shares are
  live, or no tunnel binary is found (the error carries the install command).
- `GET /runs/:id/preview-share` → `{ share: Share | null }`. A share lists its guests: id, name,
  code, `waiting` or `allowed`, and when they asked.
- `DELETE /runs/:id/preview-share`.
- `POST /runs/:id/preview-share/extend` → `{ share }`: ends 8 hours from now, never earlier. 404 `{ error }`
  without a live share, 409 `{ error }` when off (C5).
- `POST /runs/:id/preview-share/guests/:guestId` `{ decision: 'allow' | 'deny' }`;
  `DELETE /runs/:id/preview-share/guests/:guestId` (Remove).
- `GET /runs/:id/guest-comments` → `{ comments }`; `DELETE /runs/:id/guest-comments/:commentId`
  (the owner's chip ✕); `POST /runs/:id/guest-comments/sent` `{ comments: [{ id, revision }] }`.
- `GET /workspace/preview-shares` → every live share, workspace-level and single-mount (C7).
- `capabilities.previewShare: boolean` in health, narrowed off in `narrowForRelay`.
- `CEZ_PREVIEW_SHARE` in `.env.example` and the `docs/reference.md` env table.
- The guest comment's shape and caps are zod in `packages/contract`. `parseDesignPick` is
  hand-rolled in the web package and the server cannot import it, so the caps move to the
  contract and both sides read them there.
- `/__cezar_share__/*` on the share listener is not part of the versioned API and is not
  inventoried in BACKWARD_COMPATIBILITY.md; the routes above are.

`CEZ_DRY_RUN=1` uses a fake adapter whose "tunnel" is the listener's own loopback address, so the
whole guest flow runs offline and in the e2e suite.

## Limits

- **Single-origin apps.** A page that calls a second local port from the browser (an API on
  `localhost:4000`) makes that call on the guest's own machine, and fails. An app that proxies its
  API through the dev server works.
- **No Server-Sent Events** through a quick tunnel (Cloudflare's documented limit). WebSocket hot
  reload works; `webpack-hot-middleware` and any `EventSource` feature do not stream.
- **The owner's machine must be awake** with the app running.
- **The owner must be at the cockpit** when a teammate first opens the link, to let them in (D3).
  After that the teammate can come and go until the share ends.
- **Dev servers that pin their origin** (absolute `localhost` URLs in markup, a strict CSP naming
  hosts) may render partly broken. The picker still needs the app's CSP to allow a same-origin
  script.
- **A new address every time.** Stopping and sharing again gives a different link.
- **An existing `cloudflared` setup.** Cloudflare's Quick Tunnels page
  (https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/,
  read 2026-11-27) does not mention `~/.cloudflared/config.yaml` at all, so whether it blocks a
  quick tunnel is still unconfirmed. The adapter needs no special case: if cloudflared refuses,
  its own last output line lands in "a tunnel that will not start". The page does list a limit
  of 200 in-flight requests per quick tunnel (more get a `429`).

## Left to the builder

- How the picker source is split so selection and description exist once, with two hosts (the
  framed `postMessage` one and the in-page guest one). The picker exits when it is not framed
  (`picker-script.ts`), so the guest host is a second entry point, not a flag.
- How `DesignProxies` forwarding is shared with the share listener without changing the mirror's
  behaviour or its tests.
- Where the guest-comment list lives on disk, and the live signal's shape. The signal must travel
  on the existing global SSE stream, not a poll and not a WebSocket topic (those must be safe for
  any local page, and comment text is not).
- The review block's heading once three kinds can mix, keeping the three current headings readable.
- Redirect (`Location`) rewriting and the picker's behaviour under the app's CSP — check what the
  mirror does today and match it.
- The guest bar's exact look, within the picker's existing colours (blue hover, lime selected).
- Phasing. A workable order: listener + gate + fake adapter + guest picker + comment store; then
  the cockpit toolbar, chips and review format; then the `cloudflared` adapter and its
  missing-binary state; then docs (`docs/site` feature page, `.env.example`, AGENTS.md entry).
