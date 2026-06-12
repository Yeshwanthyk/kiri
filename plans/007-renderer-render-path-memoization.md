# Plan 007: Memoize the chat timeline render path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat eadc8a0..HEAD -- src/components/kiri-board/rich-message-body.tsx src/components/kiri-board/message-timeline.tsx src/components/kiri-board/chat-panel.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-gate-action-poll-and-slim-revision.md (optional —
  001 reduces how often this path re-renders; this plan reduces what each
  re-render costs. Either order works; 001 first gives bigger wins sooner.)
- **Category**: perf
- **Planned at**: commit `eadc8a0`, 2026-06-12

## Why this matters

While an agent streams, the chat timeline re-renders on every applied
snapshot/detail refresh. Four cheap-to-fix hotspots make each re-render more
expensive than it needs to be: (1) `RichMessageBody` is unmemoized and
constructs a fresh `remarkPlugins` array per render, so **every message's
markdown re-parses on every timeline render** even when its text is
unchanged; (2) `computeHiddenTimestamps(rows)` runs unmemoized in the
timeline body; (3) `WorkEntryRow` calls `diffLineStats(entry.diff.patch)`
(a patch-text scan) on every row render; (4) `ChatPanel` passes an inline
async closure as `onLoadOlderHistory`, defeating memoization below it. With
500 mounted timeline rows (the perf-gate cap), the markdown re-parse alone
dominates renderer CPU during streaming.

## Current state

Relevant files and excerpts:

- `src/components/kiri-board/rich-message-body.tsx:8-22` — unmemoized
  component, inline plugin array:

  ```tsx
  export function RichMessageBody({
    text,
    compact = false,
  }: { text: string; compact?: boolean }) {
    return (
      <div className={compact ? 'rich-message-body compact' : 'rich-message-body'}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {text}
        </ReactMarkdown>
      </div>
    )
  }
  ```

  (`markdownComponents` is already a module-level constant at line 78;
  `HighlightedPre` at line 35 is already `React.memo` — only the outer
  component and the plugins array are the gap.)

- `src/components/kiri-board/message-timeline.tsx:52` —
  `const hideTimestampByRowId = computeHiddenTimestamps(rows)` executed
  directly in the component body (the helper is defined in the same file at
  line 107). Usage sites: `RichMessageBody` is rendered at lines 148, 164,
  185.

- `src/components/kiri-board/message-timeline.tsx:246-262` — `WorkEntryRow`
  (already `React.memo`) recomputes per render:

  ```tsx
  const WorkEntryRow = React.memo(function WorkEntryRow({ entry, themeMode }) {
    const preview = formatWorkPreview(entry)
    const previewText = preview?.text ?? null
    const stats = entry.diff ? diffLineStats(entry.diff.patch) : null
    ...
  ```

  The memo wrapper helps only when `entry` is referentially stable; rows are
  re-derived per refresh (`deriveAgentTimelineRows` in `chat-panel.tsx:107-112`
  builds new objects), so the body runs often and `diffLineStats` rescans the
  patch each time.

- `src/components/kiri-board/chat-panel.tsx:366-374` — inline handler:

  ```tsx
  onLoadOlderHistory={async () => {
    if (!onLoadOlderHistory) return
    setError(null)
    try {
      await onLoadOlderHistory()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }}
  ```

### Repo conventions

- TypeScript: no `any`, no `!`, no `as Type`.
- Components in this folder use named function declarations wrapped in
  `React.memo(function Name(...) {...})` — see `WorkEntryRow`
  (`message-timeline.tsx:246`) and `HighlightedPre`
  (`rich-message-body.tsx:35`). Match that style.
- Perf regression nets exist: `pnpm test:perf` includes a client render gate
  (`tests/server/perf-gates.test.ts`, mountedTimelineRows=500), and
  `tests/perf/run-client-render-perf.tsx` is a runnable harness.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Targeted tests | `pnpm exec vitest run tests/kiri-board/timeline.test.ts tests/kiri-board/detail-merge.test.ts` | all pass |
| Unit tests | `pnpm test:unit` | all pass |
| Perf gates | `pnpm test:perf` | all pass |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/components/kiri-board/rich-message-body.tsx`
- `src/components/kiri-board/message-timeline.tsx`
- `src/components/kiri-board/chat-panel.tsx`

**Out of scope** (do NOT touch):
- `deriveAgentTimelineRows` / `src/components/kiri-board/timeline.ts` —
  restructuring row derivation (e.g. splitting the working-indicator out of
  the derivation) is a larger change, deferred.
- `src/lib/code-highlighter.ts` and `HighlightedPre` — already cached/memoized.
- `selected-agent-pane.tsx` query keys (`revision` including `status` is
  intentional: a status flip changes the timeline's working indicator).
- Any visual/behavioral change — this plan is render-cost only.

## Git workflow

- Branch: `advisor/007-render-path-memoization`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Memoize RichMessageBody

In `rich-message-body.tsx`:

1. Hoist the plugin array: `const remarkPlugins = [remarkGfm]` at module
   scope (near `markdownComponents`).
2. Wrap the component:
   `export const RichMessageBody = React.memo(function RichMessageBody({ text, compact = false }: { ... }) { ... })`
   using `remarkPlugins` in the JSX.

Both props are primitives (`text: string`, `compact?: boolean`), so default
shallow comparison suffices — do not write a custom comparator.

**Verify**: `pnpm typecheck` → exit 0 (this also proves all usage sites
tolerate the const-export form).

### Step 2: Memoize computeHiddenTimestamps

In `message-timeline.tsx`, replace line 52 with:

```ts
const hideTimestampByRowId = React.useMemo(() => computeHiddenTimestamps(rows), [rows])
```

Note line 52 sits AFTER an early return for the empty-rows case (lines
40-50). Hooks may not be conditional: move the `useMemo` ABOVE the early
return (it is safe to compute for empty rows), or restructure so the early
return comes after all hooks. Keep the early-return JSX identical.

**Verify**: `pnpm exec vitest run tests/kiri-board/timeline.test.ts` → pass.

### Step 3: Memoize diffLineStats in WorkEntryRow

In `WorkEntryRow` (`message-timeline.tsx:246`), replace

```ts
const stats = entry.diff ? diffLineStats(entry.diff.patch) : null
```

with a `useMemo` keyed on the patch text:

```ts
const patch = entry.diff?.patch
const stats = React.useMemo(() => (patch ? diffLineStats(patch) : null), [patch])
```

The patch string is stable across re-derived row objects (same underlying
diff), so this caches across the row-object churn that defeats the
`React.memo` wrapper.

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Stabilize onLoadOlderHistory

In `chat-panel.tsx`, hoist the inline handler (lines 366-374) into a
`React.useCallback` named `handleLoadOlderHistory` with deps
`[onLoadOlderHistory]` (`setError` from `useState` is stable and may be
omitted per React rules; include it if the repo's lint config demands
exhaustive deps), and pass it to `<MessageTimeline onLoadOlderHistory={handleLoadOlderHistory} ...>`.

Then check whether `MessageTimeline` itself is exported wrapped in
`React.memo` (`grep -n "MessageTimeline" src/components/kiri-board/message-timeline.tsx`).
If it is not, wrap it (same `React.memo(function MessageTimeline(...))`
style) — with `rows`, `themeMode`, `listRef`, `selectedMessageId`,
`hasOlderHistory`, `olderHistoryPending`, and the now-stable callback as
props, shallow comparison is correct. If any prop is a fresh object per
render of ChatPanel, stabilize it or skip the wrap and note why.

**Verify**: `pnpm exec vitest run tests/kiri-board/timeline.test.ts` → pass;
`pnpm typecheck` → exit 0.

### Step 5: Full gates + perf sanity

**Verify**: `pnpm test:unit && pnpm test:perf && pnpm build` → all exit 0.
Optionally run `pnpm exec tsx tests/perf/run-client-render-perf.tsx` (check
the file header for how it's invoked — it may be wired into perf-gates
already) and record before/after numbers in the PR description.

## Test plan

- No new unit tests required — behavior is unchanged; the protection is the
  existing component tests (`tests/kiri-board/timeline.test.ts` et al.) plus
  the client render perf gate in `pnpm test:perf`.
- If `tests/server/perf-gates.test.ts` exposes a client-render timing metric
  with a budget, confirm it still passes; improvement is expected, regression
  is a failure.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test:unit` exits 0
- [ ] `pnpm test:perf` exits 0
- [ ] `pnpm build` exits 0
- [ ] `grep -n "React.memo" src/components/kiri-board/rich-message-body.tsx` shows RichMessageBody wrapped
- [ ] `grep -n "remarkPlugins={\[" src/components/kiri-board/rich-message-body.tsx` returns no matches (array hoisted)
- [ ] `grep -n "useMemo" src/components/kiri-board/message-timeline.tsx` shows the two new memos
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift).
- Wrapping `RichMessageBody` in `React.memo` breaks a test that mutates
  message text without changing the `text` prop identity (would indicate a
  caller relying on parent-driven re-render; investigate, don't force-render).
- Step 2's hook reordering around the early return requires restructuring
  more than the order of declarations.
- Lint (`pnpm lint`) flags the useCallback deps and satisfying it requires
  behavior changes.

## Maintenance notes

- The remaining known cost on this path is `deriveAgentTimelineRows`
  recomputing all rows whenever the `agent` object identity changes
  (`chat-panel.tsx:89-112` — `timelineAgent` depends on `agent`). After
  plan 001 lands, that only happens on real snapshot changes, which is
  acceptable. If profiling later shows it hot, the fix is content-keyed
  memoization inside the derivation, not more React.memo.
- Reviewers should reject future PRs that pass inline object/array literals
  into `RichMessageBody` or `MessageTimeline` — that silently re-defeats the
  memoization this plan adds.
