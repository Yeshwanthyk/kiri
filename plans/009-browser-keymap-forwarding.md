# Plan 009: Forward board keymap chords from the focused browser view

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 297e31e..HEAD -- src/desktop/main.mjs src/desktop/preload.cjs src/lib/host-capabilities.ts src/components/kiri-board/board-keyboard-shortcuts.ts src/components/kiri-board/browser-panel.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bugfix (input routing)
- **Planned at**: commit `297e31e`, 2026-06-15

## Why this matters

The board added a browser resource. The browser is a **native Electron
`WebContentsView`** painted over the renderer via `bridge.setBounds(...)`
(`src/desktop/main.mjs:275-281`, anchored in `browser-panel.tsx`), not a DOM
node. Board navigation (cmd+←/→ between resource tabs, cmd+↑/↓ between project
rows, cmd+1–9, cmd+K, cmd+shift+←/→ reorder) is implemented as a **renderer
`window` keydown listener** (`board-keyboard-shortcuts.ts:233`).

When the native browser view holds keyboard focus, Electron delivers keystrokes
to the embedded web contents, so they **never reach the host window listener**.
`createBrowserView` registers loading/navigation handlers but **no
`before-input-event` handler** (`main.mjs:272-304`), so navigation is dead while
the browser is focused — you can reach the browser tab but cannot move out of
it with the keymap. The tell: cmd+shift+B (Open Browser) still works from inside
the browser because it is a **Menu accelerator** (`main.mjs:384`, dispatched
globally), while the renderer-JS-bound chords do not.

The data/nav layer is already correct — `selectAdjacentResource`
(`resource-tabs.ts:171-180`) and `useProjectResources.selectAdjacent`
(`use-project-resources.ts:174-187`) include the browser in the ordered
resource list. This is purely an input-routing gap.

## Approach (decided)

Forward only the reserved navigation chords from the browser view's
`webContents` at the **main-process** level, over a new IPC channel, into a
**single shared renderer dispatcher** that both the existing DOM keydown
listener and the forwarded input feed. This keeps the user keymap as the single
source of truth, leaves ordinary keys flowing to the page, and avoids global
Menu accelerators (which would hijack arrows/scroll inside every page) and
keymap-sync-to-main (extra plumbing for chords that aren't in the keymap
anyway).

## Current state

Relevant files:

- `src/lib/host-capabilities.ts:25-35` — `KiriBrowserBridge`; `onState` is the
  pattern to mirror for `onShortcut`.
- `src/desktop/preload.cjs:26-39` — `browser` bridge; `onState` (line 35) shows
  the `ipcRenderer.on(...)` / `removeListener` listener pattern.
- `src/desktop/main.mjs:272-304` — `createBrowserView`; the `before-input-event`
  attach site. No keyboard handling today.
- `src/components/kiri-board/board-keyboard-shortcuts.ts` — the change site:
  - `onKeyDown` (lines 94-223) handles, in order: corner-peek-held set
    (line 96), cmd+K (97), cmd+shift+B (105), direct project index (111),
    resource-move (120), project delta (127), resource delta (136), Escape
    (143), then remappable shift-actions via `actionForKey` (154+).
  - Pure chord predicates read only `key`/`metaKey`/`ctrlKey`/`altKey`/
    `shiftKey`: `directProjectIndexForEvent` (281-285), `projectDeltaForEvent`
    (287-294), `resourceDeltaForEvent` (296-303), `resourceMoveDeltaForEvent`
    (305-312), `isArrowKey` (272-274).
- `src/components/kiri-board/browser-panel.tsx` — read-only here; confirms the
  view is native and focus lives outside the DOM.

### The reserved chords (what to forward)

These are the focus-independent, hardcoded chords — exactly the ones lost when
the browser is focused:

- cmd+ArrowLeft / cmd+ArrowRight → adjacent resource
- cmd+ArrowUp / cmd+ArrowDown → adjacent project
- cmd+Shift+ArrowLeft / Right → reorder active resource
- cmd+1 … cmd+9 → direct project select
- cmd/ctrl+K → command palette

The remappable shift-actions (`focusChat`, `openTerminal`, `openBrowser`,
`openScratchpad`, `toggleTerminalFocus`) require a DOM target + editable-target
checks (`board-keyboard-shortcuts.ts:156-170`) and stay **DOM-only** — they are
not forwarded.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Targeted tests | `pnpm exec vitest run tests/kiri-board/` | all pass |
| Unit tests | `pnpm test:unit` | all pass |
| Build | `pnpm build` | exit 0 |
| E2E (chromium) | `pnpm verify:e2e` | all pass |

## Scope

**In scope** (the only files you should modify):
- `src/lib/host-capabilities.ts` — add `BrowserShortcutInput` type + `onShortcut`.
- `src/desktop/preload.cjs` — add `browser.onShortcut`.
- `src/desktop/main.mjs` — add `before-input-event` handler + chord predicate in `createBrowserView`.
- `src/components/kiri-board/board-keyboard-shortcuts.ts` — extract shared chord handler; subscribe to `onShortcut`.
- A new/extended test under `tests/kiri-board/` for the chord predicate.

**Out of scope** (do NOT touch):
- The nav data layer (`resource-tabs.ts`, `use-project-resources.ts`) — already correct.
- `navigation.ts` clamp/wrap behavior — separate, intentional design.
- The Menu accelerator path / `kiri:menu-action`.
- Any terminal/PTY code (that is plans 010/011).

## Git workflow

- Branch: `advisor/009-browser-keymap-forwarding`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Define the bridge contract

In `src/lib/host-capabilities.ts`, add the forwarded-input shape and the
subscription, mirroring `BrowserNavState` / `onState`:

```ts
export type BrowserShortcutInput = {
  readonly browserId: string
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly repeat: boolean
}
```

Add to `KiriBrowserBridge`:

```ts
readonly onShortcut: (handler: (input: BrowserShortcutInput) => void) => () => void
```

**Verify**: `pnpm typecheck` → exit 0 (preload/main are JS, so the type is
renderer-side only; the runtime wiring is added in Steps 2–3).

### Step 2: Expose the channel in preload

In `src/desktop/preload.cjs`, add to the `browser` object (mirror `onState` at
line 35):

```js
onShortcut: (handler) => {
  const listener = (_event, input) => handler(input)
  ipcRenderer.on('kiri:browser:shortcut', listener)
  return () => ipcRenderer.removeListener('kiri:browser:shortcut', listener)
},
```

**Verify**: `pnpm build` → exit 0.

### Step 3: Detect + forward reserved chords in main

In `src/desktop/main.mjs` `createBrowserView` (after the `wc` event handlers,
near line 295), attach:

```js
wc.on('before-input-event', (event, input) => {
  if (input.type !== 'keyDown') return
  if (input.isComposing) return
  if (!isReservedBrowserChord(input)) return
  event.preventDefault()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('kiri:browser:shortcut', browserShortcutPayload(browserId, input))
  }
})
```

Add small local helpers near `createBrowserView`:

- `isReservedBrowserChord(input)` — returns true only for the chord set listed
  in "The reserved chords" above. Match the renderer's modifier semantics
  EXACTLY: arrows / direct-project use `meta && !control && !alt`; reorder uses
  `meta && shift && !control && !alt`; cmd/ctrl+K allows either meta or control.
  Normalize with `input.key.toLowerCase()`. Use `input.meta` / `input.control` /
  `input.shift` / `input.alt` (the Electron `Input` fields), **not**
  `input.modifiers`.
- `browserShortcutPayload(browserId, input)` — map Electron `Input` →
  `BrowserShortcutInput` (`metaKey: input.meta`, etc.; include `browserId` and
  `repeat: input.isAutoRepeat`).

Decide auto-repeat per chord in the predicate: arrows may pass through repeats;
cmd+K, cmd+1–9, and reorder should return false when `input.isAutoRepeat` is
true (no key-repeat for palette toggles / project jumps / reorders).

**Verify**: `pnpm build` → exit 0. `grep -n "before-input-event" src/desktop/main.mjs` returns one match.

### Step 4: Extract the shared chord handler in the renderer

In `src/components/kiri-board/board-keyboard-shortcuts.ts`, extract the
hardcoded-chord portion of `onKeyDown` (the blocks for cmd+K, cmd+shift+B,
direct project index, resource-move, project delta, resource delta — lines
~97–141) into one function:

```ts
type ChordInput = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>
function handleBoardChord(input: ChordInput): boolean { /* returns true if handled */ }
```

- `KeyboardEvent` satisfies `ChordInput`, so `onKeyDown` calls
  `handleBoardChord(event)` and, when it returns true, calls
  `event.preventDefault()` and returns (preserving today's behavior).
- The existing predicate helpers (`directProjectIndexForEvent` etc.) take a
  `KeyboardEvent` today; widen their parameter type to `ChordInput` (they only
  read the five fields) so they work for forwarded input too.
- The corner-peek-held set (line 96) stays in the DOM `onKeyDown` (it is a
  visual cue tied to real key-hold). See Step 5 for the cleanup fix.

Then subscribe to the bridge in the same effect (or a sibling effect):

```ts
const bridge = getKiriBrowserBridge()
if (bridge?.onShortcut) {
  const off = bridge.onShortcut((input) => { handleBoardChord(input) })
  // include off() in the effect cleanup
}
```

Forwarded input already had `preventDefault()` applied in main, so the renderer
just dispatches.

**Verify**: `pnpm typecheck` → exit 0; `pnpm exec vitest run tests/kiri-board/` → pass.

### Step 5: Fix the `cornerPeekHeld` stuck-state

`cornerPeekHeld` is set on cmd+arrow (line 96) and cleared on Meta keyup / blur
(`onKeyUp` line 226, `onBlur` line 229). When the browser view holds focus, the
host window receives neither, so the corner-peek can stick on after the user
releases Cmd over the browser.

Minimal fix: forward modifier-release from the view too. In `main.mjs`'s
`before-input-event`, when `input.type === 'keyUp'` and the key is `Meta`/
`Control`, send a lightweight release signal (either a dedicated
`kiri:browser:shortcut` payload with a `release: true` flag, or reuse the
channel with `key: 'meta'` + a `type` field). In the renderer's `onShortcut`
handler, on a release signal call `setCornerPeekHeld(false)`. Keep this change
tiny — do not redesign the peek state.

**Verify**: manual check in Step 7 (peek does not stick after browser-focused
cmd+arrow).

### Step 6: Test the predicate

Add a unit test (e.g. `tests/kiri-board/browser-shortcut.test.ts`, or extend an
existing board test) that exercises `isReservedBrowserChord` /
`handleBoardChord` for: cmd+arrows (handled), cmd+shift+arrows (handled),
cmd+1–9 (handled), cmd/ctrl+K (handled), plain arrows (NOT handled), a letter
key (NOT handled), and auto-repeat of cmd+K (NOT handled). If
`isReservedBrowserChord` lives in `main.mjs` (CJS/ESM), mirror its logic in the
renderer predicate and test the renderer side; do not contort the build to
import from main.

**Verify**: `pnpm exec vitest run tests/kiri-board/` → pass.

### Step 7: Behavior check (manual, desktop)

Run the desktop app (`pnpm dev` + `pnpm desktop:dev`):

1. Open a project with ≥1 agent and add a browser resource.
2. Click into the browser page so the native view has focus.
3. cmd+ArrowLeft/Right → selection moves off the browser to adjacent resources.
4. cmd+ArrowUp/Down → project row changes.
5. cmd+1…9 and cmd+K work from inside the browser.
6. Type in a page text field: arrows/letters still work normally in the page
   (only the reserved chords are intercepted).
7. Hold Cmd, press an arrow over the browser, release Cmd → corner-peek does
   not stay stuck (Step 5).

**Verify**: `pnpm verify:e2e` → all pass (plus the manual checklist, recorded in
the PR description).

## Test plan

- New/extended predicate test (Step 6) is the unit net.
- Manual checklist (Step 7) is the real regression net — the e2e harness cannot
  focus a native `WebContentsView`, so browser-focused forwarding is verified
  manually. Record results in the PR description.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test:unit` exits 0
- [ ] `pnpm build` exits 0
- [ ] `pnpm verify:e2e` exits 0
- [ ] `grep -n "before-input-event" src/desktop/main.mjs` → exactly one match
- [ ] `grep -n "onShortcut" src/desktop/preload.cjs src/lib/host-capabilities.ts` → matches in both
- [ ] DOM keydown and forwarded input go through ONE `handleBoardChord` (no duplicated chord logic in the renderer)
- [ ] Manual checklist in Step 7 completed and recorded (incl. peek-not-stuck)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift).
- `before-input-event` does not fire for the `WebContentsView` (Electron
  version/config difference) — report the Electron version and how the view is
  created; the fix premise changes.
- Intercepting + `preventDefault()` on a matched chord still lets the page also
  act on it (double handling), or non-reserved keys stop reaching the page.
- The shared-dispatcher extraction would require changing the remappable
  shift-action path or the editable-target checks (`board-keyboard-shortcuts.ts:156-170`).

## Maintenance notes

- If more global chords are added to `onKeyDown` later, add them to
  `isReservedBrowserChord` too, or they will silently stop working while the
  browser is focused. Keep the reserved-chord set in main and the renderer
  predicate in sync (single list, mirrored).
- This forwards only hardcoded chords. If the project later wants the full
  remappable keymap to work over a focused browser, that is the
  keymap-sync-to-main approach (rejected here for scope) — revisit then.
- Related: plans 010/011 fix terminal PTY respawn; unrelated subsystem.
