# Unified settings — one full-screen surface, two URL families

**Status:** plan (nothing implemented). Supersedes the "Settings split" subsection of
`2026-07-20-multi-project-workspace.md` for the *presentation*; the URL scheme and the store
split that spec introduced are kept on purpose (see "Why the URLs stay").

**Owner decision (2026-10-13):** the app sidebar is HIDDEN while in settings. Settings is the
cockpit's first full-screen surface, with its own nav and its own way back.

**Owner revision (2026-10-13):** the frame is now literally shared — `components/sidebar-frame.tsx`
(`SidebarFrame` with the #788 resize handle, `SidebarDrawer`, `useSidebarWidth`) wraps both the
app's content and settings'; one stored width serves both columns.

**Owner revision (2026-10-13):** the settings nav REUSES the app sidebar's frame (264px
`bg-sidebar` column, same header row, row heights and footer): Back and the cezar brand
lockup at the top, a labelled **General settings** group above a labelled **Project
settings** tree, and the footer with the ⌘K launcher and the theme toggle; below `md` the same sidebar is a drawer
behind a hamburger in a top bar shaped like the app's (menu + title only). No breadcrumb —
the page header (desktop only; the mobile bar titles the page below `md`) reads
`project / view` on project section pages (the project name leads, the view is the heading),
then the one-liner; the project index reads `project  Project settings`. No corner badge. The
diagram and "Header" text below predate this revision; the code is the reference.

## Goal (the brief)

1. Global settings lists every registered project; a project entry expands into that
   project's own settings sub-nav (Agents, Agent config, Worktrees, Bookmarklets, Prompt
   templates).
2. The **Settings** row under a project in the sidebar still opens that project's settings.
3. The footer gear still opens global settings.
4. The app sidebar is not shown inside settings.

## Today (what the split looks like in code)

- Registry: `packages/web/src/routes/settings/registry.tsx` — each section has
  `scope: 'project' | 'global'`; `visibleSettingsSections(scope)` is "the only thing keeping
  them apart". 5 project sections, 6 global (+ hidden `keyboard`).
- Shell: `settings-shell.tsx` renders ONE shell twice, with `scope` as the only difference —
  the left nav (`data-slot="settings-nav"`, `data-scope`), the mobile pill row, the index
  cards, and a cross-link paragraph telling each half where the other one is.
- Routes: `/p/:projectId/settings[/<id>]` inside the `ProjectScopeRoute` layout;
  `/settings/global[/<id>]` top-level, with no `ProjectScopeProvider` above it.
- App shell: `AppShell` always renders the sidebar column (`md:`) and the drawer + top bar
  (`<md`). No route is chromeless today; `/new` merely has no active nav item.
- Entry points: sidebar nav item `/settings` (per project group: `scopeTo(project.id, '/settings')`);
  footer `GlobalSettingsLink` → `/settings/global`; ⌘K "Settings" view (`/settings` only);
  ~12 deep links to `/settings/agents#providers`, `/settings/global/projects`,
  `/settings/global/resources`.

Three facts constrain the merge:

- **Project sections need the `/p/<id>` URL.** `ProjectScopeProvider` is mounted only by
  `ProjectScopeRoute`; outside it every scoped hook (`useConfig`, `useRepo`, `useAgentConfig`,
  `useWorktrees`, `useUiState`, `useSkills`, `useLaunchKey`) hits the unprefixed `/api/v1/*`,
  i.e. the **boot project, silently**. A project section rendered at a non-`/p/` URL would
  read and write the wrong repo without erroring.
- **`lastLocation` refuses non-`/p/` paths** — client (`lib/last-location.ts`) and contract
  (`workspaceLastLocationSchema.pathname.startsWith('/p/')`). Anything that lives outside `/p/`
  is never restored on the bare root. That is fine for global preferences; it would be a
  regression for a project's Agents page.
- **Moving a section's URL is a BC break** (`BACKWARD_COMPATIBILITY.md` §"Cockpit page URLs":
  "moving a settings section without leaving its old URL redirecting to the new one").

## Decision 1: unify the SHELL, keep the URLs

One settings surface = one left nav + one index, rendered identically at both roots.
The URL families stay exactly as they are:

| What | URL | Scope provider | Store |
| --- | --- | --- | --- |
| Global index (the unified home) | `/settings/global` | none | — |
| Global section | `/settings/global/<id>` | none | `/api/v1/workspace/*` |
| Project index | `/p/<id>/settings` | `ProjectScopeRoute` | — |
| Project section | `/p/<id>/settings/<id>` | `ProjectScopeRoute` | `/api/v1[/p/<id>]/config`, `/ui-state` |

### Why the URLs stay

- Every project section keeps its provider, its cache keys, its `lastLocation` restore and its
  deep links (`/settings/agents#providers` from the thread, the review panel, the inbox, the
  provider banner, the Tools menu, the prompt-template menu) — zero call-site churn.
- No new redirects, no BC entry, no change to `workspaceLastLocationSchema`.
- The legacy flat redirect (`/settings/*` → `/p/<boot>/settings/*`, protected) is untouched.
- The alternative — `/settings/global/projects/<id>/<section>` — would require mounting a
  second `ProjectScopeProvider` by hand outside the layout gate, teaching `last-location` and
  the contract a second path grammar, redirecting every `/p/<id>/settings/<section>` URL, and
  re-pointing a dozen scoped links. All cost, no user-visible gain: the user sees one nav either
  way.

Optional, later: make `/settings` (exact) an alias of the unified home instead of the boot
project's index. Not in this plan — it is a protected legacy URL and the boot project's index
now *is* the unified surface with the boot project selected, so a saved `/settings` bookmark
already lands somewhere sensible.

## Decision 2: settings is full-screen (no app sidebar)

### What "in settings" means

One predicate, exported from `routes/settings/settings-shell.ts(x)` and used by both the app
shell and the settings shell so they can never disagree:

```ts
/** True for every settings URL, both families: `/p/<id>/settings[/…]` and `/settings/global[/…]`. */
export function isSettingsPathname(pathname: string): boolean
// stripProjectPrefix(pathname) matches '/settings' or '/settings/*'
```

`/settings/skills` (the redirect to the top-level Skills page) matches too; it is a one-frame
redirect, so a flash of the chromeless frame is harmless.

### App shell changes (`app-shell.tsx`)

`AppShell` derives `chromeless = isSettingsPathname(pathname)` and, when true:

- does not render `<Sidebar>` (desktop column) nor `<MobileNavDrawer>`;
- does not render `<MobileTopBar>` — the settings shell brings its own header on every
  viewport (today the mobile top bar is what titles the page "Settings");
- keeps the `banner` row (provider auth failures link INTO settings; hiding the banner there
  would hide the fix from the person about to apply it) and the `composer` row (it is the
  bottom safe-area gutter, not a composer);
- keeps the `<Sheet>` root — it renders no DOM and the drawer state is simply never opened.

The grid stays `auto auto 1fr auto`; the first row is empty in chromeless mode, exactly the
case the explicit `row-start-*` placement was written for (see the shell's layout comment).
`data-slot="app-shell"` gains `data-chromeless=""` so tests and e2e can assert the mode.

Nothing in `app-shell-container.tsx` changes: the queries it runs feed badges that are simply
not rendered in settings, and TanStack keeps them warm for the return trip.

### The settings frame (`settings-shell.tsx`)

The shell becomes a full-window frame: header + (nav | content), on every viewport.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ← Back   Settings › cezar › Agents        [Global | cezar]   ☼ theme     │  header, 52px
├────────────────┬─────────────────────────────────────────────────────────┤
│ Appearance     │                                                         │
│ Notifications  │   (section body, unchanged)                             │
│ Resources      │                                                         │
│ Skills         │                                                         │
│ Agent accounts │                                                         │
│ Projects       │                                                         │
│ Stored in      │                                                         │
│  ~/.cezar      │                                                         │
│ ───────────    │                                                         │
│ PROJECT        │                                                         │
│ SETTINGS       │                                                         │
│ ▾ cezar   main │                                                         │
│    Agents      │                                                         │
│    Agent config│                                                         │
│    Worktrees   │                                                         │
│    Bookmarklets│                                                         │
│    Prompt tmpl.│                                                         │
│ ▸ storefront   │                                                         │
│ ▸ old-repo  ✗  │                                                         │
│                │                                                         │
│ ───────────    │                                                         │
│ 🔍 Search…  ⌘K │  ← the sidebar footer's launcher, kept at the bottom    │
└────────────────┴─────────────────────────────────────────────────────────┘
```

**Header** (`data-slot="settings-header"`, `h-[52px]`, `pt-[env(safe-area-inset-top)]` because
the shell's mobile top bar no longer carries the notch inset):

- `← Back` (`data-slot="settings-back"`): see "Leaving settings".
- Breadcrumb: `Settings` (link → `/settings/global`) › for project pages the project name
  (link → `/p/<id>/settings`) › the section title as the `h1`. On the global index the `h1` is
  `Settings`; on the project index the `h1` is the project name.
- Scope chip (`data-slot="settings-scope-chip"`): `Global` or the project name — the scope of
  what is being edited. Kept as today's slot, new text.
- `ThemeToggle` — it lived in the sidebar footer, which is gone here. The version chip and the
  Tools menu are NOT duplicated: version is one click away on every non-settings page, and the
  Tools menu's own "Settings → Agents" link points here.
- Below `md`: same header, one line, breadcrumb truncated from the left (title always visible),
  plus the search icon button that stands in for the nav-column launcher (see the nav's
  "Search launcher" bullet).

**Nav** (`data-slot="settings-nav"`, `data-scope` = scope of the CURRENT page, kept for the
e2e selectors), a 232px column from `md` up; the sole navigation on the page, so it is a
touch wider than today's 208px:

- Six global rows, plain react-router `NavLink` (must not be prefixed — the existing header
  comment in `settings-shell.tsx` says why). The "Stored in ~/.cezar" footer label moves
  directly under this group.
- `PROJECT SETTINGS` group label, then one row per registered project, ordered `lastOpenedAt`
  desc (same as the sidebar): chevron, name, `folder not found` pill for `missing`. No branch —
  settings describe the repo, not what is checked out (owner's call, 2026-10-13).
  Rows and their sections link with an EXPLICIT `scopeTo(project.id, '/settings/<id>')`, the
  same rule `project-groups.tsx` follows: the point is linking into a project that is not the
  active one.
- Expansion is derived, not stored: the project named by the URL (`pathnameProjectId`) is
  expanded; the chevron toggles others for the life of the mount. No persistence (nothing to
  configure; the two roots mount different route elements so a toggle is honestly transient).
- Row click → `/p/<id>/settings`; chevron click only toggles.
- Project list from `useProjects()` (already cached) — no per-project fetch, a 40-project
  workspace costs nothing extra.
- Single project (`capabilities.singleProject`, or a registry with one entry): no group
  label, no chevron — the five sections render flat under `This project`; the registry pane
  stays hidden as today. Mirrors the sidebar's "groups only from the second project on".
- `missing` project: greyed, no links, tooltip "…remove it in Projects" (the sidebar's wording,
  minus "Global settings →").
- **Search launcher, pinned to the bottom** (`data-slot="command-palette-hint"`): the sidebar
  footer's `CommandPaletteHint` — magnifier, `Search…`, the `⌘K`/`Ctrl+K` chord — moves into
  the nav column's footer (`mt-auto`, above a top border), so the palette stays discoverable
  and clickable on a page that has no sidebar. It is the SAME component, extracted from
  `app-shell.tsx` into `components/command-palette-hint.tsx` and rendered by both the sidebar
  footer and the settings nav; it already opens the palette through `openCommandPalette()`,
  which needs no shell context. The keyboard chord works either way (the palette is mounted
  at the app root); the hint is what makes it findable. Below `md` the nav column is hidden,
  and with it the hint — the mobile header carries a search icon button
  (`data-slot="settings-search"`, `size-11` touch target) that calls the same
  `openCommandPalette()`.

**Index pages**

- `/settings/global` — cards for the six global sections, then a `Project settings` card list,
  one per project → `/p/<id>/settings` (name, status).
- `/p/<id>/settings` — cards for that project's five sections. The cross-link paragraph and
  `data-slot="settings-global-link"` go away: the breadcrumb's `Settings` crumb and the nav
  are the way up.

**Mobile (`<md`)**: the nav column is hidden; the index pages ARE the nav (stacked cards,
two-level drill-in). Section pages keep the pill row: global pages list the six global
sections; project pages list that project's five sections with a leading `‹ All settings`
pill (→ `/settings/global`). The header's `← Back` leaves settings; the breadcrumb goes up.

### Leaving settings — where `← Back` goes

Settings is entered from many places (sidebar row, footer gear, ⌘K, ten deep links, a cold
load of a pasted URL) and navigation INSIDE settings pushes history, so `navigate(-1)` is
wrong: it would walk back through settings pages. Instead:

- `lib/settings-return.ts`: a tiny module-level store `{ get(): Location | null, record(loc) }`.
  `LastLocationController` (already the one router listener in `app.tsx`) calls `record` for
  every location that is NOT a settings pathname. So the store always holds the last
  non-settings page the user was on, across any number of settings pages.
- `← Back` navigates to `get()` when set. Fallback (cold load straight into settings): the
  tasks pane of the project in scope — `/p/<id>/` for project pages, `/p/<boot>/` for global
  ones (`useProjects().data?.bootProject`, else the `/` legacy redirect resolves it).
- `Escape` triggers the same, when focus is not inside an input, textarea, select,
  `contenteditable` or an open Radix layer (dialogs own Escape). Registered by the settings
  frame while mounted; unregistered on unmount.
- The store is memory-only. A reload lands on the fallback, which is honest: there is nothing
  to come back to.

### What the hidden sidebar means for existing behaviour

- **⌘K still works, and stays visible** — the palette is mounted at the app root, not in the
  sidebar, so the chord never depended on the footer. The launcher hint is preserved at the
  bottom of the settings nav (desktop) and as a search button in the settings header (mobile),
  so opening the palette by click is still one gesture away on every settings page.
- **`New task` CTA and `Add project` are gone in settings.** Both are one `← Back` away; the
  Projects registry pane keeps its own affordances.
- **Live badges (needs-you, inbox, skills update) are not shown in settings.** Accepted by the
  owner as the cost of the full-screen decision. `run-notifications` (browser notifications)
  keep firing — they are not sidebar-bound.
- **The provider banner still shows** (kept row, see above).
- **Document title** is unchanged (`Settings · cezar` for global, `Agents · <project> · cezar`
  for project pages).
- **The boot project's Settings row lighting up on `/settings/global*`** (today's
  `activeNavPath` quirk) becomes unobservable — the sidebar is not rendered there. No fix
  needed; a unit test pins that the sidebar is absent instead.

## Entry points after the merge

| Entry | Target | Change |
| --- | --- | --- |
| Sidebar → project group → Settings | `/p/<id>/settings` | none (lands in the full-screen frame with that project expanded) |
| Sidebar flat nav → Settings (single project) | `/p/<boot>/settings` | none |
| Footer gear | `/settings/global` | none |
| ⌘K "Settings" view | `/settings` (scoped) | add a second view row **Global settings** → `/settings/global` (plain react-router navigate for this one row; the others stay scoped) |
| Projects registry table row | — | add a per-row **Settings** link → `/p/<id>/settings` (explicit scope), absent for `missing` |
| Every existing deep link | unchanged | — |

## Implementation plan (one PR, ordered so each step is testable alone)

1. **Predicate** `isSettingsPathname` in `settings-shell.tsx` (+ unit test: both families,
   `/settings/skills`, negatives `/p/x/settingsfoo`, `/skills`).
2. **App shell chromeless mode** (`app-shell.tsx`): `chromeless` prop derived inside `AppShell`
   from `useLocation`; skip Sidebar, MobileNavDrawer, MobileTopBar; add `data-chromeless`.
   Keep banner and composer rows.
3. **Return store** `lib/settings-return.ts` + one `record` call in
   `last-location-controller.tsx` (guarded by the predicate).
4. **Extract `CommandPaletteHint`** from `app-shell.tsx` into
   `components/command-palette-hint.tsx` (no behaviour change; the sidebar footer keeps
   rendering it). Pure move so step 5 can reuse it.
5. **Settings frame** (`settings-shell.tsx`): header (Back, breadcrumb, chip, ThemeToggle,
   mobile search button), Escape handler, the unified nav (global rows + project tree) with
   the `CommandPaletteHint` pinned at its bottom, the widened column, the
   `pt-[env(safe-area-inset-top)]`.
6. **Index pages**: global index gains the project card list; project index gets the
   project-name `h1`; drop the cross-link paragraph and `settings-global-link`.
7. **Mobile pills**: `‹ All settings` leading pill on project pages.
8. **Registry pane** (`projects-section.tsx`): per-row Settings link.
9. **Command palette**: Global settings view row; update the pinned views list in its test.
10. **Registry helper** (`registry.tsx`): `settingsSectionsByScope(capabilities)` returning
    `{ global, project }` so the nav asks once. `scope` stays on every section — it still
    decides the URL and the store.
11. **Docs**: `README.md:353-357` (already stale — lists MCP and Keyboard, omits Skills,
    Accounts, Agent config) → "one full-screen settings surface; per-project sections under
    `/p/<id>/settings`, everything else under `/settings/global`". `BACKWARD_COMPATIBILITY.md`
    §"Settings split, old URLs kept": one sentence — URLs and redirects unchanged, only the
    nav and the frame changed. `AGENTS.md` project-scoped routes row: same one-liner, plus
    "settings is chromeless" in the Web UI row. Spec `2026-07-20` §"Settings split" and
    §"Sidebar → Footer": pointer to this file.

Not touched: `routes.tsx` route table, `MovedSettingsSectionRedirect`,
`SettingsSkillsRedirect`, `last-location` parsing/contract, `nav-items.ts`, any server code,
`.env.example`.

## Tests

Unit (`npm test -- packages/web/src/routes/settings packages/web/src/components`):

- `settings-shell` predicate test (step 1).
- `app-shell.test.tsx`: at `/p/boot/settings/agents` and `/settings/global/appearance` no
  `[data-slot="sidebar"]`, no drawer trigger, no mobile top bar; `data-chromeless` present;
  banner slot still renders when a banner is passed. At `/p/boot/` everything renders as
  before (the existing footer-row assertions stay).
- `settings.test.tsx`: nav at `/settings/global/appearance` lists global sections AND one row
  per registered project; the URL's project is expanded with explicit
  `/p/<id>/settings/<section>` hrefs; a missing project renders no links; single-project mode
  renders the sections flat and no registry pane; `/settings/global` index shows project
  cards; `/p/boot/settings` index shows the project name. Header: Back present, breadcrumb
  crumbs, chip text `Global` / project name, theme toggle present. The nav column ends with
  `[data-slot="command-palette-hint"]`, and clicking it opens the palette
  (`openCommandPalette` spy); the mobile header renders `[data-slot="settings-search"]` with
  the same effect. Existing assertions to update: nav contents (was "only project
  sections"), `settings-global-link` (removed).
- `app-shell.test.tsx`: the sidebar footer still renders the hint after the extraction
  (existing `command-palette-hint` assertions unchanged).
- `settings-return` test: Back goes to the recorded non-settings page after several settings
  hops; cold load falls back to `/p/<id>/` (project) or `/p/<boot>/` (global); Escape in an
  input does nothing, Escape on the page leaves.
- `routes.test.tsx`: `h1` expectations (`Global settings` → `Settings`; project index → project
  name). Redirect cases unchanged.
- `last-location-controller.test.tsx`: settings paths are still never SAVED as lastLocation
  (existing) and now ARE recorded as the return target's *exclusion* (new).
- `command-palette.test.tsx`: 10 views. `projects-section.test.tsx`: per-row Settings href.

E2E (`npm run test:e2e`):

- `settings-appearance.e2e.ts`: nav selector unchanged; add "sidebar absent, Back returns to
  the tasks pane", and "the Search… launcher at the bottom of the settings nav opens the
  command palette".
- `ios-sweep.e2e.ts:160-180`: the mobile top bar assertions on settings pages move to the
  settings header (`settings-header` has the safe-area inset).
- `smoke.e2e.ts:131-167` (footer rows) runs on the home page — unaffected. `smoke.e2e.ts:220`
  (`/settings/skills` → Skills item active) — unaffected, Skills is not a settings page.
- `project-groups.e2e.ts:302-312` (single-project: no registry pane) — still holds.
- `settings-bookmarklets.e2e.ts`, `tools-menu.e2e.ts:101-118` (Tools → Settings → Agents lands
  on `/p/<boot>/settings/agents`) — unchanged.
- New flow: home → footer gear → `/settings/global` → click second project's Agents in the
  tree → URL `/p/<other>/settings/agents`, Agents form shows that project's runner → `← Back`
  → home.

## Review follow-ups resolved (2026-10-13)

The local `om-code-review` passes found, and this branch resolved: the sidebar width is a
shared store (`useSyncExternalStore`) so a drag in one column moves every mounted column live,
and a drag still applies for the page when storage refuses to persist it; the settings mobile
bar puts the safe-area inset on its outer box; the drawer's rows, chevrons and Back meet the
44px touch rule while the desktop column keeps the app sidebar's sizes; a project's expanded
body id is unique per instance and `aria-controls` is set only while the body exists; the
pill row is a distinct landmark ("Sections of this area") built on the scoped NavLink; a fold
made on one project's page does not follow the user to another project; flat mode renders a
`missing` project inert and names a lone project on global pages; an unknown project id is
named after the boot repo only when it IS the boot project; `?agent=` on Agent accounts
remounts the tabs when it changes.

Known, outside this change: with the registry query in its error state, the scope gate's
fall-through and any page observer of `useProjects` loop (refetch → pending → gate unmounts
the page → mount → refetch) — pre-existing on main for every project page that reads the
registry.

## Checklist of things the split hid (found while planning)

- [ ] ⌘K has no way to reach global settings (step 8).
- [ ] The global Skills section is pinned to the boot project
      (`useSkillsUpdate(projects.bootProject)`); next to a per-project tree, "Skills updates
      for this machine" reading one project's status will look wrong. Out of scope; candidate
      follow-up: move the check under each project's sub-nav or make it workspace-wide.
- [ ] Two places say "Defaults for new projects" (Agent accounts) vs the per-project default
      agent (Agents). The tree makes the pair visible together; wording should say which wins
      ("a project's own choice overrides the default"). Copy only.
- [ ] Project sections have no guard against being mounted outside `/p/`. Cheap insurance:
      `SettingsSectionRoute` for `scope === 'project'` renders the not-found screen when
      `pathnameProjectId(pathname) === null`. Optional.
- [ ] README settings paragraph is stale independently of this work (step 10).
- [ ] `settings-scope-chip` has no test today; the new chip text gets one.
- [ ] The boot project's Settings row lit up on `/settings/global*` via `activeNavPath`. Moot
      once the sidebar is hidden there, but `activeNavPath('/settings/global/x') === '/settings'`
      remains true and would bite any future non-chromeless caller; a one-line note in
      `nav-items.ts` is enough.
