# Plan 016: Stop destroying the native browser view on switch/overlay; fix focus handoff

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1fa5160..HEAD -- src/desktop/main.mjs src/desktop/preload.cjs src/lib/host-capabilities.ts src/components/KiriBoard.tsx src/components/kiri-board/corner-peek-shell.tsx src/components/kiri-board/corner-peek.tsx src/components/kiri-board/selected-agent-pane.tsx src/components/kiri-board/browser-panel.tsx src/components/kiri-board/resource-tabs.ts src/styles/app/board-chat-diff-terminal.css`
> `main.mjs` and `preload.cjs` are plain JS (no type errors will surface for
> them at `pnpm typecheck` — verify those two by `pnpm build` + manual smoke
> only). If any in-scope file changed since this plan was written, compare
> the "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none hard; **soft-sequence with plan 009** (see
  "Interaction with plan 009" below) — land 009 and this plan close together,
  ideally 009 first or in the same review window. **Soft on plan 018 Step 3
  (H5)** for the project-*hide* case of E1.1 (see the known-limit note in
  "Approach").
- **Category**: bugfix (browser resource lifecycle)
- **Planned at**: commit `1fa5160`, 2026-07-01

## Why this matters

The board's browser resource is a native Electron `WebContentsView`
(`src/desktop/main.mjs:275-281`, `mainWindow.contentView.addChildView(view)`),
positioned over a DOM anchor via `bridge.setBounds()`
(`browser-panel.tsx:58-76`). Two architectural facts drive every bug in this
area:

1. **A `WebContentsView` composites above the entire renderer window
   regardless of DOM/CSS z-index.** It is a separate native layer, not a DOM
   node — hiding it means either moving it out of the visible bounds
   (`setBounds(id, null)` → `entry.view.setVisible(false)`,
   `main.mjs:234-248`) or destroying it. There is no CSS trick that puts a
   DOM overlay "in front" of it.
2. **`bridge.destroy(id)` on unmount is real state loss**, not cleanup.
   `browser-panel.tsx:37-44`'s effect cleanup calls `bridge.setBounds(id,
   null)` + `bridge.destroy(id)` → `main.mjs:267-269` →
   `destroyBrowserView` (`main.mjs:306-322`) → `entry.view.webContents.close()`.
   The next mount calls `bridge.create(id, initialUrlRef.current)`
   (`browser-panel.tsx:39`) with the resource's **original, create-time**
   URL — never the live, navigated-to URL — so every unmount discards
   in-page navigation, scroll position, form state, and any login that
   wasn't persisted to disk (see E4.3 below; today it usually *is*
   persisted, because there's no partition at all — see Step 7).

Given fact 1, "hide" and "destroy" are the only two primitives available, and
today the app reaches for "destroy" far too often: on every project switch
(E1.1 — the headline bug), on opening the Project Manager or Settings dialog
(E1.2), and implicitly whenever a DOM overlay needs to appear on top of it
(E2.1, currently *not even attempted* — the overlay just renders invisibly
behind the view). This plan converts every one of those paths to "hide" (or,
for E1.1, "never unmount at all"), and separately fixes the two other real
defects in the native-view integration: no OS focus handoff back to the host
window (E3.1), and a CSS rule that neutralizes `hidden` for both the browser
and terminal panels (E2.2).

## Interaction with plan 009

Plan 009 (`plans/009-browser-keymap-forwarding.md`, still TODO) forwards
reserved board chords (cmd+arrows, cmd+1-9, cmd/ctrl+K) from the focused
native view into the renderer via `before-input-event` in
`createBrowserView` (`main.mjs:272-304`) + a new `onShortcut` bridge channel,
dispatched into the same `handleBoardChord` the DOM keydown listener uses.

Two concrete couplings with this plan:

- **009 Step 5 (`cornerPeekHeld` stuck-on) is a correctness prerequisite for
  this plan's Step 3.** Step 3 below folds the corner-peek panel's expanded
  state into an `overlayOpen` boolean that forces the browser view's bounds
  to `null`. `cornerPeekHeld` is one of the inputs to that expanded state
  (`corner-peek.tsx:38`, `expanded = open || held`). Today, if the user holds
  Cmd, presses an arrow while the *native browser view* has OS focus, and
  releases Cmd there, the host window never sees the keyup/blur that clears
  `cornerPeekHeld` (`board-keyboard-shortcuts.ts` `onKeyUp`/`onBlur`) —today
  that's just a cosmetic "peek stays open" bug. **After this plan's Step 3
  lands, the same stuck state would permanently null the browser's bounds**
  (the view would go blank and stay blank until something else resets
  `cornerPeekHeld`). Do not ship Step 3 without 009 Step 5's release-forwarding
  fix, or add an independent workaround (e.g. a timeout) in Step 3.
- **E3.1's focus handoff only fires today when the DOM keydown listener
  fires** (`board-keyboard-shortcuts.ts:233`, `window.addEventListener
  ('keydown', ...)`), which never happens while the native view holds OS
  focus. Without 009, a user cannot navigate off a focused browser resource
  via keyboard at all, so E3.1's fix is reachable only via mouse-driven
  resource switches. **Once 009 lands**, its forwarded chords call the same
  `onSelectAdjacentResource` / `selectResource` callbacks
  (`KiriBoard.tsx:297-306`, `185-206`) that this plan's Step 4 effect
  observes — so Step 4's focus-handoff effect transparently starts covering
  the keyboard-driven case too, with no additional change required in 009 or
  here. This is the reason the two plans should land close together: 009
  without 016 leaves the keyboard-driven navigation silently un-focused;
  016 without 009 leaves E3.1 with no reachable trigger from a
  keyboard-focused browser.

Recommendation: sequence 009 immediately before or alongside this plan.

## Approach (decided)

1. **E1.1 — never unmount a browser resource's `BrowserPanel` while it still
   exists anywhere in the workspace.** `corner-peek-shell.tsx` already
   receives `resourcesByProject` (used today only for the `CornerPeek`
   sidebar) — reuse it to compute an all-projects browser list instead of
   filtering the active-project-only `resources` prop. Visibility (which one
   is actually painted) stays scoped to the active project/tab; only the
   *mount* lifetime widens. **Known limit**: `resourcesByProject` is built
   from `workspace.projects` only (`use-project-resources.ts:57-66` iterates
   the server's visible-project list), so this fix covers project
   *switching* but NOT project *hide* — hiding a project still unmounts and
   destroys its browser view until plan 018's Step 3 (H5) feeds
   `hiddenProjects` into the same reconciliation. Land 018 H5 first (or
   accept hide-as-destroy in the interim and note it in the PR).
2. **E1.2 — stop early-returning the whole tree for Project Manager /
   Settings.** Render them as overlay siblings of the persistently-mounted
   board (matching how `CommandPalette` / `ConfirmDialog` etc. already
   render today), so `CornerPeekShell` → `SelectedAgentPane` →
   `BrowserPanel` never unmounts for these.
3. **E2.1 — derive one `overlayOpen` boolean** (command palette, agent
   switcher, session launcher, both confirm dialogs, scratchpad float,
   Project Manager, Settings, and the corner-peek panel's expanded state)
   and fold it into the `visible` prop already threaded to each
   `BrowserPanel`. `BrowserPanel`'s existing `syncBounds` already nulls
   bounds on `!visible` (`browser-panel.tsx:61-64`) — no `BrowserPanel`
   change needed, only the boolean computation and threading.
4. **E3.1 — one focus-handoff effect** in `KiriBoard.tsx`, keyed on
   `(activeResource?.kind, tab)`, that calls a new `bridge.focusHost()` →
   `mainWindow.webContents.focus()` whenever the active resource stops being
   an on-screen browser.
5. **E2.2 — one CSS rule** restoring `[hidden]` precedence for
   `.browser-panel`/`.terminal-panel`/`.chat-panel`; no JSX changes (both
   already use `hidden={!visible}`).
6. **E4.2 — let Electron manage real popup windows** (`action: 'allow'` with
   `overrideBrowserWindowOptions`, scoped to genuine popup dispositions)
   instead of denying + loading the popup URL into the same view, so
   `window.opener`/`postMessage` keep working for OAuth/SSO popups.
7. **E4.3 — per-browser session partition** (`persist:kiri-browser-
   ${browserId}`), since today every browser view (and the host app window
   itself) shares Electron's default session.
8. **E2.3 — nits**: consistent edge-rounding for bounds, and ignore
   non-main-frame `did-fail-load`.

## Current state

All refs re-verified against the live tree at commit `1fa5160`.

- `src/desktop/main.mjs`
  - `browserViews` map (line 15).
  - `createWindow`'s own `setWindowOpenHandler` (70-74) is the **outer app
    window's** popup handler (opens external browser) — unrelated to E4.2,
    which is the embedded browser view's handler.
  - IPC handlers (208-270): `kiri:browser:create` (231-233), `kiri:browser:
    set-bounds` (234-248, the independent-rounding site for E2.3), `kiri:
    browser:navigate/go-back/go-forward/reload/stop/destroy` (249-269).
  - `createBrowserView` (272-304): `new WebContentsView({ webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true } })`
    (275-277, no `partition` — E4.3); `mainWindow.contentView.addChildView
    (view)` (281); event wiring (286-295); `did-fail-load` wired straight to
    `emit` with no `isMainFrame` check (290, E2.3); `wc.setWindowOpenHandler`
    (297-301, deny + `wc.loadURL(target)` into the same view — E4.2).
  - `destroyBrowserView` (306-322): deletes from `browserViews`, removes the
    child view, calls `entry.view.webContents.close()`.
  - No `webContents.focus()` / `blur()` anywhere in the file (confirmed via
    grep) — E3.1's gap.
  - `installApplicationMenu` (365-403): `Cmd+O` → `add-project`, `Cmd+,` →
    `settings` (374-377) — these are the two menu actions that trigger
    `projectManagerOpen`/`settingsOpen` in the renderer (E1.2).
- `src/desktop/preload.cjs`
  - `browser` bridge object (26-40): `create/setBounds/navigate/goBack/
    goForward/reload/stop/destroy/onState`. No `focusHost` (E3.1) yet.
- `src/lib/host-capabilities.ts`
  - `KiriBrowserBridge` type (25-35) — add `focusHost` here (E3.1).
  - `getKiriBrowserBridge()` (57-59).
- `src/components/KiriBoard.tsx`
  - `projectResources = useProjectResources(...)` (123-126).
  - `activeResourceId`/`activeResource` computed (175-183) from
    `projectResources.activeProjectResources` — active-project-only.
  - `selectResource` (185-206), `useBoardKeyboardShortcuts` call with
    `onSelectAdjacentResource`/`onMoveActiveResource` (285-338) — the
    choke points where the active resource changes; the E3.1 effect goes
    near 175-183, observing the result of these.
  - `if (projectManagerOpen) return <ProjectManagerDialog .../>` (397-412)
    and `if (settingsOpen) return <SettingsScreen .../>` (414-429) — full
    early returns, the E1.2 bug. Both occur **before** the `if
    (!selectedProject) return <EmptyProjectState/>` check (431-452) and
    before the main `<main className="kiri-shell">` return (454-593).
  - Inside `<main>`: `CommandPalette` (469-474), `AgentSwitcherSheet`
    (476-485), `InlineSessionLauncher` (487-500), delete-session
    `ConfirmDialog` (502-519), delete-project `ConfirmDialog` (521-539) all
    already render as overlay siblings next to `CornerPeekShell` — the
    pattern E1.2's fix should match.
  - `<CornerPeekShell resources={projectResources.activeProjectResources
    ?.resources ?? []} ... resourcesByProject={projectResources
    .resourcesByProject} cornerPeekHeld={cornerPeekHeld} .../>` (541-590,
    the `resources` prop at line 546 is the active-project-only list that
    feeds E1.1's bug; `resourcesByProject` at line 551 is the workspace-wide
    record already available for the E1.1 fix).
- `src/components/kiri-board/corner-peek-shell.tsx`
  - `CornerPeekShellProps.resourcesByProject` type (35-38) — keyed by
    projectId, each entry `{ resources, activeResourceId }`. Covers
    **visible projects only**: its source (`use-project-resources.ts:57-66`)
    iterates `workspace.projects`, which the server has already filtered to
    `!hiddenAt` (`workspace-snapshot.ts:167`). See the E1.1 known-limit note
    in "Approach".
  - `browserResources` memo (90-93): **filters the active-project-only
    `resources` prop** — this is the exact site of the E1.1 fix (switch the
    source to `resourcesByProject`).
  - `stageBrowser = resolveStageBrowser(activeResource)` (88, fn at
    210-212) — stays active-project-scoped; this is what should continue to
    govern *visibility*, not mount lifetime.
  - `<ResourceStage {...stageProps} browserResources={browserResources}
    .../>` (143-153) — `ResourceStage` is a re-export of
    `SelectedAgentPane` (`resource-stage.tsx:3`).
- `src/components/kiri-board/corner-peek.tsx`
  - `open` state (36), `expanded = open || held` (38) — `open` already
    covers click-to-pin and Escape-to-close; **CSS-only `:hover` reveal**
    (`board-navigation.css:330-337`, `.corner-peek-wrap:hover
    .corner-peek-panel`) is a third path with **no JS-observable state** —
    the gap Step 3 needs to close (add hover tracking, see Step 3).
  - No `onExpandedChange`/hover handlers today.
- `src/components/kiri-board/selected-agent-pane.tsx`
  - `mountedBrowserResourceIds` state (150-152); mount-on-visit effect
    (165-171); **prune effect** (172-178) — prunes to whatever is in the
    `browserResources` prop today (active-project-only, per corner-peek-
    shell.tsx:90-93) — this prune is what deletes a browser resource's
    mounted `BrowserPanel` on project switch. Fixing corner-peek-shell's
    `browserResources` source (E1.1) fixes this prune for free — no change
    needed in this file for E1.1 itself.
  - Render site (301-309): `<BrowserPanel key={...} resource={resource}
    visible={tab === 'browser' && selectedBrowserResource?.id === resource
    .id} />` (307) — the `visible` expression Step 3 extends with
    `!overlayOpen`.
- `src/components/kiri-board/browser-panel.tsx`
  - Create/destroy effect (37-44): `bridge.create(resource.browserId,
    initialUrlRef.current)` on mount, `bridge.setBounds(id, null); bridge
    .destroy(id)` on unmount — this is the effect that must stop firing on
    project switch (E1.1) and Project Manager/Settings open (E1.2).
  - `syncBounds` (58-76): already nulls bounds on `!visible || !anchor`
    (61-64) — Step 3 relies on this without modification.
  - `hidden={!visible}` (117) — same pattern as `terminal-panel.tsx:457`;
    E2.2's shared bug.
- `src/components/kiri-board/resource-tabs.ts`
  - `BrowserResource` type (36-42), `ensureBrowserResource` (248-292, the
    reuse-if-exists check at 257-269 confirms E4.1: one browser per project
    by design — a non-issue, do not "fix").
  - Good spot to add a small exported pure helper for E1.1 (see Step 1) so
    the workspace-wide flatten is unit-testable without rendering React.
- `src/styles/app/board-chat-diff-terminal.css`
  - `.chat-panel, .browser-panel, .terminal-panel { display: flex; ... }`
    (858-866) — the combined rule that beats `[hidden]` for **both**
    `browser-panel.tsx:117` and `terminal-panel.tsx:457`. E2.2's fix site.
- `src/components/kiri-board/terminal-panel.tsx:457` — `hidden={!visible}`,
  same CSS bug as browser-panel; read-only for this plan (only the shared
  CSS rule changes; do not touch this file).
- `src/styles/app/board-navigation.css`
  - Corner-peek positioning/reveal cluster (281-337): `.corner-peek-wrap`
    (281-287, `position: absolute; z-index: 22`), `.corner-peek-panel`
    (306-328, `position: absolute`, hidden via `opacity`/`pointer-events`
    not `display`), reveal triggers (330-337: `:hover`, `:focus-within`,
    `.held`, `.open`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 (does not cover `main.mjs`/`preload.cjs` — plain JS) |
| Targeted tests | `pnpm exec vitest run tests/kiri-board/` | all pass |
| Unit tests | `pnpm test:unit` | all pass |
| Build | `pnpm build` | exit 0 |
| E2E (chromium) | `pnpm verify:e2e` | all pass (cannot drive the native `WebContentsView` — see manual smoke) |
| Manual desktop smoke | `pnpm dev` (in one shell) + `pnpm desktop:dev` (in another) | see per-step manual checklists |

## Scope

**In scope**:
- `src/desktop/main.mjs` — bounds rounding, `did-fail-load` guard, popup
  handler rework, session partition, `focusHost` IPC handler.
- `src/desktop/preload.cjs` — `browser.focusHost`.
- `src/lib/host-capabilities.ts` — `KiriBrowserBridge.focusHost` type.
- `src/components/KiriBoard.tsx` — Project Manager/Settings overlay
  restructure, `overlayOpen` derivation, focus-handoff effect.
- `src/components/kiri-board/corner-peek-shell.tsx` — workspace-wide
  `browserResources`, thread `overlayOpen` down.
- `src/components/kiri-board/corner-peek.tsx` — hover state, `onExpandedChange`.
- `src/components/kiri-board/selected-agent-pane.tsx` — thread `overlayOpen`
  into the `visible` prop passed to `BrowserPanel` (only if it cannot be
  folded in one level up — see Step 3).
- `src/components/kiri-board/resource-tabs.ts` — new exported pure helper
  for workspace-wide browser resource collection.
- `src/styles/app/board-chat-diff-terminal.css` — one `[hidden]` override
  rule.
- `tests/kiri-board/resource-tabs.test.ts` (or a new test file) —
  regression tests for the new pure helper.

**Out of scope** (do NOT touch):
- `src/components/kiri-board/terminal-panel.tsx` — read-only; benefits from
  the shared CSS fix (E2.2) with zero changes of its own.
- The keymap-chord forwarding itself (`before-input-event`, `onShortcut`,
  `handleBoardChord`) — that is plan 009's scope; this plan only adds the
  focus-handoff effect that 009's forwarded chords will end up triggering.
- Terminal/PTY lifecycle (plans 010/011/012) — unrelated subsystem.
- `resource-tabs.ts`'s existing reconciliation/order logic, `ensureBrowserResource`'s
  reuse-if-exists behavior (E4.1, confirmed correct by design) — do not
  change to "one browser per project."
- Any change to how many browser resources a project may have.

## Git workflow

- Branch: `advisor/016-browser-resource-lifecycle`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: E1.1 — keep every browser resource's `BrowserPanel` mounted workspace-wide

In `resource-tabs.ts`, add a small pure helper next to the existing type
exports:

```ts
export function collectBrowserResources(
  resourcesByProject: Record<string, { readonly resources: readonly ProjectResource[] }>,
): BrowserResource[] {
  const seen = new Set<string>()
  const result: BrowserResource[] = []
  for (const entry of Object.values(resourcesByProject)) {
    for (const resource of entry.resources) {
      if (resource.kind !== 'browser' || seen.has(resource.id)) continue
      seen.add(resource.id)
      result.push(resource)
    }
  }
  return result
}
```

In `corner-peek-shell.tsx`, replace the `browserResources` memo (90-93):

```ts
const browserResources = React.useMemo(
  () => collectBrowserResources(resourcesByProject),
  [resourcesByProject],
)
```

Do not change `stageBrowser`/`resolveStageBrowser` (88, 210-212) — visibility
stays scoped to the active project's active resource; only the *mount* set
widens to every project in `resourcesByProject` (all *visible* projects
today; hidden projects join automatically once plan 018's H5 feeds
`hiddenProjects` into `use-project-resources.ts`'s reconciliation — write
`collectBrowserResources` so it needs no change when that happens).

No change is needed in `selected-agent-pane.tsx`: its prune effect (172-178)
already recomputes `available` from the `browserResources` prop, so once
that prop spans all projects, resources belonging to inactive projects simply
stop being pruned. Its render site (301-309) already computes `visible`
per-resource from `selectedBrowserResource?.id === resource.id`, which
remains `false` for every non-active-project browser — they stay mounted
(subject to Step 3's `overlayOpen`) but invisible/bounds-null.

**Verify**: `pnpm typecheck` → 0. Add a unit test in
`tests/kiri-board/resource-tabs.test.ts` for `collectBrowserResources`:
multiple projects each with a browser resource → returns all of them,
de-duplicated by id, order stable. `pnpm exec vitest run
tests/kiri-board/resource-tabs.test.ts` → pass.

### Step 2: E1.2 — stop unmounting the tree for Project Manager / Settings

In `KiriBoard.tsx`, the early returns at 397-412 (`projectManagerOpen`) and
414-429 (`settingsOpen`) replace the entire render output, unmounting
`CornerPeekShell` → ... → `BrowserPanel`. Restructure so these render as
overlay siblings of `<main className="kiri-shell">`'s content instead of
replacing it:

- Keep the `if (!selectedProject) return <EmptyProjectState .../>` check
  (431-452) as-is — with no project selected there is nothing to preserve.
- Move the `projectManagerOpen`/`settingsOpen` conditionals **inside** the
  `<main>` return (454-593), alongside the existing overlay list
  (`CommandPalette` 469-474, `AgentSwitcherSheet` 476-485, etc.), rendering
  `<ProjectManagerDialog .../>` / `<React.Suspense><SettingsScreen
  .../></React.Suspense>` as siblings of `<CornerPeekShell .../>` rather
  than instead of it.
- `ProjectManagerDialog`/`SettingsScreen` render as full-screen overlays
  today (confirm their own CSS covers the whole viewport — they do not need
  `CornerPeekShell` to be visually present underneath, only mounted).

**Verify**: `pnpm typecheck` → 0; `pnpm build` → 0. Manual: open a project
with a browser resource loaded to some non-default URL/scroll position,
press Cmd+O (Project Manager) then close it, then Cmd+, (Settings) then
close it — the browser view must still show the same page/scroll position
it had before (no reload, no create-time-URL reset). Record in PR
description (native view cannot be asserted via `pnpm verify:e2e`).

### Step 3: E2.1 — force native bounds to null behind every overlay

3a. **Promote corner-peek hover-reveal to JS state.** In `corner-peek.tsx`,
add a `hovered` state set via `onMouseEnter`/`onMouseLeave` on the
`.corner-peek-wrap` div (40-46), and widen `expanded`:

```ts
const [hovered, setHovered] = React.useState(false)
const expanded = open || held || hovered
```

Add an `onExpandedChange?: (expanded: boolean) => void` prop; call it from
a `React.useEffect(() => { onExpandedChange?.(expanded) }, [expanded])`.

3b. **Thread the callback up.** `CornerPeekShellProps` gains
`onPeekExpandedChange: (expanded: boolean) => void`; pass it to
`<CornerPeek onExpandedChange={onPeekExpandedChange} .../>` (130-141).

3c. **Compute `overlayOpen` in `KiriBoard.tsx`.** Add `const
[peekExpanded, setPeekExpanded] = React.useState(false)`, pass
`onPeekExpandedChange={setPeekExpanded}` to `<CornerPeekShell .../>`, and
derive:

```ts
const overlayOpen =
  commandPaletteOpen || agentSwitcherOpen || sessionLauncherOpen ||
  Boolean(pendingDelete) || Boolean(pendingProjectDelete) || scratchpadOpen ||
  projectManagerOpen || settingsOpen || peekExpanded
```

3d. **Fold it into visibility.** Thread `overlayOpen` as a new prop through
`CornerPeekShellProps` → `ResourceStage`/`SelectedAgentPane`, and change the
`visible` expression at `selected-agent-pane.tsx:307`:

```ts
visible={!overlayOpen && tab === 'browser' && selectedBrowserResource?.id === resource.id}
```

No change to `BrowserPanel`/`syncBounds` — `visible=false` already forces
`bridge.setBounds(id, null)` (browser-panel.tsx:61-64).

**Verify**: `pnpm typecheck` → 0; `pnpm exec vitest run tests/kiri-board/`
→ pass. Manual (native view, cannot be scripted): with a browser resource
visible, open the command palette (Cmd+K) — the palette must be visible
*and interactive*, not painted behind the page; repeat for the agent
switcher, session launcher, both confirm dialogs, scratchpad float, and
hovering (not clicking) the corner-peek anchor. Confirm the browser view
reappears immediately on close/dismiss with no reload (bounds restored, not
resource destroyed).

### Step 4: E3.1 — hand OS focus back to the host window

In `main.mjs`, add an IPC handler near the other `kiri:browser:*` handlers
(208-270):

```js
ipcMain.on('kiri:browser:focus-host', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.focus()
})
```

In `preload.cjs`, add to the `browser` object (26-40):

```js
focusHost: () => ipcRenderer.send('kiri:browser:focus-host'),
```

In `host-capabilities.ts`, add to `KiriBrowserBridge` (25-35):

```ts
readonly focusHost: () => void
```

In `KiriBoard.tsx`, near the `activeResource` computation (175-183), add an
effect that fires the handoff whenever the active resource stops being an
on-screen browser:

```ts
const previousBrowserActiveRef = React.useRef(false)
React.useEffect(() => {
  const isBrowserActive = tab === 'browser' && activeResource?.kind === 'browser'
  if (previousBrowserActiveRef.current && !isBrowserActive) {
    getKiriBrowserBridge()?.focusHost()
  }
  previousBrowserActiveRef.current = isBrowserActive
}, [tab, activeResource])
```

`focusHost()` is a no-op when the bridge is absent (web mode) and harmless
when the window already has focus.

**Verify**: `pnpm typecheck` → 0. Manual (requires 009's chord forwarding to
reach this via keyboard, or drive it with mouse in the interim): click a
browser resource so the native view has OS focus, then switch the active
resource away (click another tab, or — once 009 lands — Cmd+Right), then
immediately type a character. It must land in the renderer (chat input,
etc.), not be swallowed by the now-invisible browser view. Record result in
PR description; also re-run 009's Step 7 checklist item 6 if 009 has
already landed.

### Step 5: E2.2 — fix `hidden` being neutralized by CSS

In `board-chat-diff-terminal.css`, immediately after the combined rule at
858-866 (`.chat-panel, .browser-panel, .terminal-panel { display: flex;
... }`), add an override so the `hidden` attribute wins:

```css
.chat-panel[hidden],
.browser-panel[hidden],
.terminal-panel[hidden] {
  display: none;
}
```

This is a same-origin, later-in-source rule at equal-or-higher specificity,
so it beats the earlier `display: flex` for any element carrying `hidden`.
No JSX changes — both `browser-panel.tsx:117` and `terminal-panel.tsx:457`
already set `hidden={!visible}`.

**Verify**: `pnpm build` → 0. Manual: with a browser resource mounted-but-
hidden (e.g. switch away from it via Step 1's fix, or switch `tab` away from
`'browser'`), inspect the DOM — the hidden `.browser-panel`/`.terminal-panel`
element must be `display: none` (not laid out, not tab-reachable), confirmed
via devtools computed style or an e2e assertion if a harness element is
reachable.

### Step 6: E4.2 — let real popups work (OAuth/SSO)

In `main.mjs`'s `createBrowserView` (272-304), replace the
`wc.setWindowOpenHandler` at 297-301:

```js
wc.setWindowOpenHandler(({ url: popupUrl, disposition }) => {
  const target = safeBrowserUrl(popupUrl)
  if (!target) return { action: 'deny' }
  if (disposition !== 'new-window' && disposition !== 'foreground-tab') {
    // Ordinary same-view navigation request; keep existing behavior.
    wc.loadURL(target).catch(() => {})
    return { action: 'deny' }
  }
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      parent: mainWindow ?? undefined,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    },
  }
})
```

Confirm against the live Electron version's `setWindowOpenHandler`
disposition values (`default`, `foreground-tab`, `background-tab`,
`new-window`, `save-to-disk`, `other`) before picking the exact set to
`allow` — the goal is: genuine popup-style opens (OAuth/SSO `window.open`
calls) get a real child `BrowserWindow` so `window.opener`/`postMessage`
keep working; ordinary same-tab navigation requests keep today's
same-view-load behavior. If the installed Electron version's dispositions
don't cleanly separate these, treat it as a STOP condition and report the
version + observed dispositions rather than guessing.

**Verify**: `pnpm build` → 0. Manual: navigate the embedded browser to a
real OAuth-popup-based login flow (e.g. any site using Google/GitHub OAuth
via a popup, not a redirect) and confirm the popup opens as a separate
window and the flow completes (the opener page reflects logged-in state
without a manual reload). This cannot be scripted in `verify:e2e`; record
manually in the PR description.

### Step 7: E4.3 — per-browser session partition

In `main.mjs:275-277`, add a partition to the `WebContentsView`'s
`webPreferences`:

```js
const view = new WebContentsView({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    partition: `persist:kiri-browser-${browserId}`,
  },
})
```

`browserId` is stable for the life of a browser resource (created once via
`crypto.randomUUID()` in `resource-tabs.ts`'s `createBrowserId`, reused by
`ensureBrowserResource`'s existing-resource path — E4.1 confirms one
resource is reused per project rather than recreated), so this does not
regress "stay logged in across reopen" for the common case; it only stops
every project's browser (and the host app's own window, which also uses the
default session today) from sharing cookies/localStorage/login state with
each other.

**Verify**: `pnpm build` → 0. Manual: log in to a site in one project's
browser resource, open a different project's browser resource to the same
site — it must NOT be logged in. Confirm the same project's browser stays
logged in across a hide/show cycle (Step 1's mount lifetime) and across a
full app restart (persistent partition, not in-memory).

### Step 8: E2.3 — rounding seam + non-main-frame `did-fail-load` noise

In `main.mjs`'s `kiri:browser:set-bounds` handler (234-248), round from
edges instead of independently rounding width/height, to avoid a sub-pixel
seam against the DOM anchor:

```js
ipcMain.on('kiri:browser:set-bounds', (_event, browserId, bounds) => {
  const entry = browserViews.get(String(browserId))
  if (!entry) return
  if (!bounds || typeof bounds !== 'object') {
    entry.view.setVisible(false)
    return
  }
  const x = Math.round(bounds.x)
  const y = Math.round(bounds.y)
  const right = Math.round(bounds.x + bounds.width)
  const bottom = Math.round(bounds.y + bounds.height)
  entry.view.setBounds({
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  })
  entry.view.setVisible(true)
})
```

In the `did-fail-load` wiring (290), ignore subframe failures:

```js
wc.on('did-fail-load', (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
  if (isMainFrame) emit()
})
```

**Verify**: `pnpm build` → 0. Manual: resize the window with a browser
resource visible and check for a visible seam at the anchor's edge (before/
after comparison); navigate to a page with a failing embedded iframe/ad and
confirm `kiri:browser:state` IPC traffic doesn't spike (devtools/console
instrumentation or a temporary log statement, removed before commit).

## Test plan

- Step 1's `collectBrowserResources` unit test is the only new automated
  net for the E1.1 headline fix — the mount-lifetime behavior itself
  (BrowserPanel staying mounted across a project switch) has no component
  test harness for `corner-peek-shell.tsx`/`selected-agent-pane.tsx` today;
  do not build new React Testing Library infra for this plan — cover it via
  the manual checklists in Steps 1-4 instead, and record results in the PR
  description.
- Steps 2-8 are all manual/native-view checks (`pnpm verify:e2e` cannot
  drive a `WebContentsView`, same limitation plan 009 documented).
- Existing `tests/kiri-board/resource-tabs.test.ts` regressions are the
  cheapest fast-feedback loop while iterating on Step 1.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test:unit` exits 0
- [ ] `pnpm build` exits 0
- [ ] `pnpm verify:e2e` exits 0
- [ ] `collectBrowserResources` unit test passes and covers de-dup + multi-project
- [ ] Manual: browser view survives a project switch with live nav state intact (Step 1)
- [ ] Manual: browser view survives Project Manager/Settings open+close (Step 2)
- [ ] Manual: every DOM overlay (palette, switcher, launcher, both confirm dialogs, scratchpad, peek-hover) is visible and interactive over a mounted browser resource (Step 3)
- [ ] Manual: typing after navigating off a focused browser lands in the renderer, not the browser (Step 4)
- [ ] Manual: hidden `.browser-panel`/`.terminal-panel` is `display: none`, not laid out (Step 5)
- [ ] Manual: a popup-based OAuth/SSO flow completes in a real popup window (Step 6)
- [ ] Manual: two projects' browser resources do not share login state; same-project login survives hide/show and restart (Step 7)
- [ ] Manual: no visible bounds seam; no IPC spam from subframe load failures (Step 8)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match live code (drift), especially `corner-peek-
  shell.tsx`'s `browserResources` memo (90-93), `KiriBoard.tsx`'s early
  returns (397-429), or `main.mjs`'s `setWindowOpenHandler` (297-301).
- The installed Electron version's `setWindowOpenHandler` `disposition`
  values don't cleanly separate "genuine popup" from "same-view navigation"
  (Step 6) — report the version and observed dispositions.
- Folding `overlayOpen` into `visible` (Step 3) is insufficient because some
  overlay renders through a portal outside the normal React tree (verify no
  such portal exists before assuming the simple boolean fold works).
- 009's `cornerPeekHeld` release-forwarding fix (Step 5 of 009) has not
  landed before Step 3 of this plan ships — do not ship Step 3 without it or
  without an independent timeout/workaround; a stuck `cornerPeekHeld` would
  permanently blank the browser view.
- Restructuring the Project Manager/Settings overlays (Step 2) turns out to
  require changes to `ProjectManagerDialog`/`SettingsScreen` internals
  (e.g. they assume being the sole rendered tree) — escalate rather than
  reworking those components' internals as a side effect of this plan.

## Maintenance notes

- If a future plan adds another full-screen dialog (beyond Project
  Manager/Settings), add it to both the `KiriBoard.tsx` overlay-siblings
  list (Step 2's pattern) and the `overlayOpen` boolean (Step 3), or it will
  silently reintroduce E1.2/E2.1 for that dialog.
- Plan 011 (event-based terminal sync) and plan 012 (terminal/daemon PTY
  lifecycle) are the terminal-side analogues of this plan's E1.1 — both are
  "don't destroy on switch" problems in different subsystems; no code is
  shared, but keep the same review bar (hide-don't-destroy, verify state
  survives a switch) when those land.
- `collectBrowserResources` (Step 1) is a reasonable place to also solve a
  latent variant of E1.1 if a future feature allows more than one browser
  resource per project (currently prevented by design, E4.1) — it already
  de-dupes by resource id across all projects.
