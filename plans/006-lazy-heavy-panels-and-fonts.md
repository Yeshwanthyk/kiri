# Plan 006: Code-split the diff and settings panels; trim font subsets

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat eadc8a0..HEAD -- src/components/kiri-board/selected-agent-pane.tsx src/components/KiriBoard.tsx src/styles/app.css`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `eadc8a0`, 2026-06-12

## Why this matters

The initial client bundle eagerly includes the diff viewer and the settings
screen. The diff viewer (`@pierre/diffs`) imports the **full `shiki` package**
(not `shiki/core`), which drags ~9.4MB of grammar/theme chunks into
`dist/client` and puts `@pierre/diffs` + its shiki core into the main routes
chunk (~1.03MB at planning time). Every byte of that is parsed at window
open, before the user has looked at a diff or opened settings. Code-splitting
the two panels moves that cost to first use. Separately, `src/styles/app.css`
imports four font families with **all unicode subsets** (Cyrillic, Greek,
Vietnamese, …), inflating `dist/client` asset count and the packaged app for
glyphs the UI never renders by default.

For calibration, the app's own highlighter already does this right:
`src/lib/code-highlighter.ts` uses `shiki/core` with the JS regex engine and
18 explicit languages — the 9.4MB comes only from `@pierre/diffs`'s full-shiki
import, which lazy-loading the panel defers.

## Current state

Relevant files and excerpts:

- `src/components/kiri-board/selected-agent-pane.tsx:22-25` — static imports:

  ```ts
  import { ChatPanel } from './chat-panel'
  import { DiffPanel } from './diff-panel'
  import { TerminalPanel } from './terminal-panel'
  import { TerminalWorkspace } from './terminal-workspace'
  ```

- `src/components/kiri-board/diff-panel.tsx:3-5` — the heavy dependency:

  ```ts
  import { PatchDiff } from '@pierre/diffs/react'
  import type { GitStatus } from '@pierre/trees'
  import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react'
  ```

- `src/components/KiriBoard.tsx:25` — `import { SettingsScreen } from './kiri-board/settings-screen'`,
  rendered at line ~267.

- `src/styles/app.css:1-9`:

  ```css
  @import 'tailwindcss' source('../');
  @import '@fontsource-variable/geist/index.css';
  @import '@fontsource/jetbrains-mono/400.css';
  @import '@fontsource/jetbrains-mono/500.css';
  @import '@fontsource/jetbrains-mono/700.css';
  @import '@fontsource/fira-code/400.css';
  @import '@fontsource/fira-code/500.css';
  @import '@fontsource/ibm-plex-mono/400.css';
  @import '@fontsource/ibm-plex-mono/500.css';
  ```

- The terminal panel already lazy-loads xterm
  (`await import('@xterm/xterm')` in `terminal-panel.tsx:262-266`) — do not
  add another layer there.

### Repo conventions

- TypeScript: no `any`, no `!`, no `as Type`. Named exports everywhere —
  `React.lazy` needs the `.then((m) => ({ default: m.X }))` adapter.
- The app is TanStack Start with SSR for the initial route; `React.lazy` +
  `<React.Suspense>` is supported in React 19 SSR, and the default sidebar
  tab is chat, so the lazy panels do not render during initial SSR in
  practice.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test:unit` | all pass |
| Build | `pnpm build` | exit 0 |
| Bundle inventory | `du -sh dist/client && ls dist/client/assets \| wc -l` | for before/after comparison |
| E2E | `pnpm verify:e2e` | all pass |

## Scope

**In scope** (the only files you should modify):
- `src/components/kiri-board/selected-agent-pane.tsx`
- `src/components/KiriBoard.tsx`
- `src/styles/app.css`

**Out of scope** (do NOT touch):
- `src/components/kiri-board/diff-panel.tsx`, `settings-screen.tsx` — the
  panels themselves don't change; only how they're imported.
- `src/lib/code-highlighter.ts` — already optimized (shiki/core + 18 langs).
- `src/components/kiri-board/terminal-panel.tsx` — xterm already lazy.
- `package.json` dependency changes (that's plan 008).
- Vite config / manualChunks tuning.

## Git workflow

- Branch: `advisor/006-lazy-panels-fonts`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 0: Record the baseline

Run `pnpm build`, then record: `du -sh dist/client`, `ls dist/client/assets | wc -l`,
and the size of the largest JS chunk (`ls -lS dist/client/assets/*.js | head -5`
— note `/bin/ls` if `ls` is aliased). Keep these numbers for the PR
description.

### Step 1: Lazy-load DiffPanel

In `selected-agent-pane.tsx`, replace the static import (line 23) with:

```ts
const DiffPanel = React.lazy(() =>
  import('./diff-panel').then((module) => ({ default: module.DiffPanel })))
```

(placed after the other imports, module scope). Wrap the existing
`<DiffPanel ...>` usage site in a Suspense boundary:

```tsx
<React.Suspense fallback={<div className="empty-panel">Loading diff view…</div>}>
  <DiffPanel ... />
</React.Suspense>
```

Match the surrounding JSX structure — if the panel is rendered conditionally
per tab, the Suspense wraps only the DiffPanel branch. Check whether
`diff-panel.tsx` exports anything else this file imports (as of planning it
does not; `formatTerminalKey` comes from `terminal-panel`, not `diff-panel`).

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Lazy-load SettingsScreen

In `KiriBoard.tsx`, same pattern for `SettingsScreen` (line 25; usage near
line 267). Fallback: `<div className="empty-panel">Loading settings…</div>`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Latin-only font subsets

The static `@fontsource/<family>/<weight>.css` files include every unicode
subset; each package also ships `latin-<weight>.css`. First confirm the files
exist:

```
ls node_modules/@fontsource/jetbrains-mono/ | grep latin-400
ls node_modules/@fontsource/fira-code/ | grep latin-400
ls node_modules/@fontsource/ibm-plex-mono/ | grep latin-400
ls node_modules/@fontsource-variable/geist/ | grep -i latin
```

Then in `app.css` swap each import for its latin variant, e.g.
`@import '@fontsource/jetbrains-mono/latin-400.css';` (and 500/700), same for
fira-code 400/500 and ibm-plex-mono 400/500. For the variable Geist package,
use the latin-subset css file found by the `ls` above (commonly
`latin.css` or `index.css` already latin-only — if `ls` shows no latin
variant and `index.css` imports all subsets, use the per-subset file it
ships; if none exists, leave the Geist import unchanged and note it).

Keep `latin-ext` OUT unless the `ls` output shows project docs demanding it —
plain latin covers the UI.

**Verify**: `pnpm build` → exit 0, then
`ls dist/client/assets | grep -ci "cyrillic\|greek\|vietnamese"` → `0`.

### Step 4: Measure and sanity-check

1. `pnpm build`, re-run the Step 0 measurements. Expected: largest routes
   chunk shrinks (the `@pierre/diffs` + shiki-core code moves to a new
   lazy chunk), `dist/client` asset count drops (fonts), total `du` drops.
   If the largest chunk did NOT shrink, inspect with
   `grep -l "pierre" dist/client/assets/*.js | head` — the lazy boundary may
   have been hoisted away by another static import of `diff-panel` (search:
   `grep -rn "from './diff-panel'\|from \"./diff-panel\"" src/`).
2. Run the app and click through: chat → diff tab (shows fallback briefly,
   then renders), settings (same), code blocks in chat still highlight
   (app highlighter unaffected).

**Verify**: `pnpm test:unit && pnpm verify:e2e` → all pass.

## Test plan

- No new unit tests — this is import topology. The regression net is:
  `pnpm test:unit` (component tests under `tests/kiri-board/` exercise the
  pane modules), `pnpm verify:e2e` (clicks through tabs), and Step 4's
  measured bundle deltas recorded in the PR description.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test:unit` exits 0
- [ ] `pnpm build` exits 0
- [ ] `pnpm verify:e2e` exits 0
- [ ] `grep -n "^import { DiffPanel }" src/components/kiri-board/selected-agent-pane.tsx` returns no matches
- [ ] `grep -n "^import { SettingsScreen }" src/components/KiriBoard.tsx` returns no matches
- [ ] `ls dist/client/assets | grep -ci "cyrillic"` returns 0
- [ ] Before/after bundle numbers recorded in the PR description
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift).
- SSR build fails with a lazy/Suspense hydration error after Step 1 or 2 —
  the TanStack Start version may need its own code-splitting primitive
  instead of bare `React.lazy`; report rather than swapping frameworks
  mid-plan.
- Another module statically imports `diff-panel` or `settings-screen`,
  defeating the split (Step 4.1 grep) and removing it isn't a one-line
  import change.
- The fontsource packages ship no latin-only css (Step 3 `ls` finds nothing).

## Maintenance notes

- Anyone adding a new import of `diff-panel.tsx` or `settings-screen.tsx`
  from an eagerly-loaded module silently undoes the split — reviewers should
  watch import paths on those two files.
- The deeper fix for the shiki payload is upstream: `@pierre/diffs` importing
  full `shiki` instead of `shiki/core`. If a future version offers an
  injectable highlighter, pass the one from `src/lib/code-highlighter.ts` and
  the 9.4MB of grammar chunks disappears from the package entirely (also
  shrinks plan 008's asar).
- Deferred (recorded here so it isn't lost): the Electron main process
  serializes window creation behind backend startup
  (`src/desktop/main.mjs:16-27` — `await resolveAppUrl()` before
  `createWindow`). Since the window is shown only after `loadURL` completes,
  fixing perceived startup means adding a splash/loading state — a product
  decision, not attempted here.
