# Plan 005: Unmount hidden terminal tabs in the renderer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat eadc8a0..HEAD -- src/components/kiri-board/terminal-workspace.tsx src/components/kiri-board/terminal-panel.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `eadc8a0`, 2026-06-12

## Why this matters

In the shell terminal workspace, **every tab stays mounted** — hidden tabs
are wrapped in `<div hidden>` but their `TerminalPanel` components remain
live. Each mounted panel holds a full `@xterm/xterm` Terminal instance (its
own scrollback buffer), a WebGL canvas context (loaded via the enhancements
addon), an open WebSocket to the daemon, a `ResizeObserver`, and a
`MutationObserver`. A user with 5 terminal tabs pays 5× renderer RAM and
keeps 5 live sockets streaming output into hidden DOM. Browsers also cap
WebGL contexts (~8-16 per page); enough hidden tabs can evict the visible
terminal's context.

This is safe to fix by unmounting because the system was designed for it:
the daemon keeps the PTY and full scrollback server-side, and the file's own
header comment says "every pane reattaches to its session (full scrollback)
on remount, so the UI is disposable"
(`terminal-workspace.tsx:30-32`).

## Current state

Relevant files:

- `src/components/kiri-board/terminal-workspace.tsx` — tab rendering; the
  change site.
- `src/components/kiri-board/terminal-panel.tsx` — the per-pane terminal;
  its connect effect (lines 243-400) opens the WebSocket and constructs the
  xterm instance regardless of the `visible` prop (line 375 `void connect()`),
  and its cleanup (lines 377-399) already disposes everything correctly.
  **Read-only except the disposal audit in Step 3.**

### All tabs mounted — `terminal-workspace.tsx:178-202`

```tsx
{layout.tabs.map((tab) => (
  <div
    key={tab.id}
    className="terminal-workspace-surface"
    hidden={tab.id !== layout.activeTabId}
  >
    <WorkspaceNode
      node={tab.root}
      layout={layout}
      setLayout={setLayout}
      tabVisible={visible && tab.id === layout.activeTabId}
      ...
    />
  </div>
))}
```

`TerminalPanel` is keyed per pane
(`key={`terminal-${project.id}-shell-${node.termId}`}`,
`terminal-workspace.tsx:245`), and the panel's connect effect re-runs on
mount, attaching to the daemon session which replays the snapshot — so
unmount/remount loses nothing but local scroll position.

Note the same all-mounted pattern exists at the *sidebar tab* level
(`selected-agent-pane.tsx` renders `TerminalPanel`/`TerminalWorkspace` with a
`visible` prop and `hidden` attribute) — that level is **out of scope** here
(see Scope) because the runtime terminal intentionally stays connected to
stream agent output; this plan only changes the shell workspace's inactive
tabs, which have no consumer while hidden.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Targeted tests | `pnpm exec vitest run tests/kiri-board/terminal-layout.test.ts tests/kiri-board/terminal-panel.test.ts` | all pass |
| Unit tests | `pnpm test:unit` | all pass |
| Build | `pnpm build` | exit 0 |
| E2E (chromium) | `pnpm verify:e2e` | all pass |

## Scope

**In scope** (the only files you should modify):
- `src/components/kiri-board/terminal-workspace.tsx`
- `src/components/kiri-board/terminal-panel.tsx` (only if the Step 3 audit
  finds an undisposed addon — see step)
- `tests/kiri-board/terminal-layout.test.ts` (only if layout helpers change —
  they should not)

**Out of scope** (do NOT touch):
- The `hidden`-but-mounted pattern in `selected-agent-pane.tsx` for the
  runtime terminal / chat / diff sidebar tabs. The runtime terminal must stay
  mounted while hidden so agent output keeps streaming into the local buffer.
- `src/components/kiri-board/terminal-layout.ts` (pure layout logic).
- The daemon / server terminal code.
- localStorage layout persistence keys.

## Git workflow

- Branch: `advisor/005-unmount-hidden-terminal-tabs`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Render only the active tab's subtree

In `terminal-workspace.tsx`, replace the `layout.tabs.map(...)` block
(lines 178-202) so only the active tab mounts:

```tsx
{layout.tabs.map((tab) =>
  tab.id === layout.activeTabId ? (
    <div key={tab.id} className="terminal-workspace-surface">
      <WorkspaceNode
        node={tab.root}
        ...same props...
        tabVisible={visible}
        ...
      />
    </div>
  ) : null)}
```

Keep the `key={tab.id}` on the surface div so React remounts panes on tab
switch rather than reusing state across tabs. `tabVisible` simplifies to
`visible` since the inactive branches no longer render.

Do NOT change the tab *strip* (`layout.tabs.map` over buttons in the header,
lines 116-127) — all tab buttons must stay.

**Verify**: `pnpm typecheck` → exit 0; `pnpm exec vitest run tests/kiri-board/terminal-layout.test.ts` → pass.

### Step 2: Keep pane status sane across switches

`paneStatus` (line 55) accumulates `{paneId: status}` entries; after Step 1,
status updates only arrive from mounted panes, but stale entries for panes in
other tabs linger harmlessly (the header reads only
`paneStatus[layout.activePaneId]`, line 174). No change required — but
confirm the active pane's status shows "Connecting"/"Connected" after
switching tabs back and forth in Step 4's manual check. If the header shows a
stale status for a remounted pane id, clear that pane's entry when its
`TerminalPanel` reports a new status (the existing `onPaneStatus` callback
already overwrites per pane — so this should already hold).

**Verify**: no code change expected; `pnpm typecheck` still exits 0.

### Step 3: Audit panel disposal for the remount path

`terminal-panel.tsx`'s cleanup (lines 377-399) disposes the socket handlers,
animation frames, observers, `terminalDisposables`, fit addon, and the
terminal itself. Audit one gap: addons loaded inside
`loadTerminalEnhancements(term, terminalDisposables, () => disposed)`
(line 283) — open the helper (search
`grep -rn "loadTerminalEnhancements" src/components/kiri-board/`) and confirm
every addon it loads (WebGL, ligatures, unicode11 if present) is pushed into
`terminalDisposables` or disposed via `term.dispose()`. xterm disposes loaded
addons when the Terminal is disposed, so a gap is only real if an addon
allocates resources OUTSIDE the terminal (the WebGL addon's context is freed
on dispose; verify the helper doesn't hold module-level references to addon
instances). If a leak is found, fix it by registering the addon in
`terminalDisposables`; otherwise change nothing.

**Verify**: `pnpm exec vitest run tests/kiri-board/terminal-panel.test.ts` → pass.

### Step 4: Behavior check (manual, headed or via e2e)

Run the app (`pnpm dev` + `pnpm desktop:dev`, or the e2e suite) and:

1. Open the shell terminal, create 2-3 tabs (Cmd+T), run `echo tab-N` in each.
2. Switch between tabs: each remount shows the daemon snapshot including the
   earlier `echo` output (scrollback restored).
3. Split a pane (Cmd+D), switch away and back: split layout intact (layout
   state lives in `layout`/localStorage, not in the DOM).
4. In devtools, confirm only the active tab's `.terminal-workspace-surface`
   exists in the DOM.

**Verify**: `pnpm verify:e2e` → all pass (the suite covers terminal basics;
the manual checks cover what it does not).

## Test plan

- Existing `tests/kiri-board/terminal-layout.test.ts` and
  `tests/kiri-board/terminal-panel.test.ts` must keep passing unchanged —
  this plan's change is structural JSX, which those files don't snapshot.
- The real regression net is Step 4's manual checklist + `pnpm verify:e2e`.
  If the e2e suite has a terminal-tabs spec (check `tests/e2e/`), extend it
  with "output survives tab switch"; if not, do not build new e2e
  infrastructure — record the manual results in the PR description.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test:unit` exits 0
- [ ] `pnpm build` exits 0
- [ ] `pnpm verify:e2e` exits 0
- [ ] `grep -n "hidden={tab.id" src/components/kiri-board/terminal-workspace.tsx` returns no matches (inactive tabs are unmounted, not hidden)
- [ ] Manual checklist in Step 4 completed and recorded
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift).
- Switching tabs loses scrollback content in Step 4.2 — that means the daemon
  snapshot replay does not behave as the file comment claims, and hidden
  mounting was load-bearing after all.
- The e2e suite has a test that asserts hidden tabs remain in the DOM.
- Fixing a disposal gap in Step 3 requires changes beyond registering an
  addon in `terminalDisposables`.

## Maintenance notes

- After this lands, each tab switch costs one snapshot replay over the
  WebSocket (typically tens of KB). If users report sluggish tab switching
  with huge scrollbacks, the daemon-side `snapshot(session, scrollbackLines)`
  parameter (`terminal-registry.ts:280`) supports partial replay — wire it
  before reaching for re-mounting.
- The runtime terminal in `selected-agent-pane.tsx` deliberately keeps the
  hidden-but-mounted pattern; do not "clean it up" to match this change.
