# Plan 001: Gate the action-window poll behind the revision check and slim the revision hash

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat eadc8a0..HEAD -- src/components/kiri-board/board-workspace.ts src/components/kiri-board/workspace-polling.ts src/components/kiri-board/workspace-fingerprint.ts src/server/db/workspace-snapshot.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `eadc8a0`, 2026-06-12

## Why this matters

Kiri desktop polls the workspace two ways. The background poll (every 2s) is
revision-gated: it fetches a cheap SHA-256 revision first and only fetches the
full workspace snapshot when the revision changed. But every user action
(send, steer, interrupt, etc.) opens a polling window that fetches the **full
snapshot every 750ms for up to 120 seconds with no revision gate** — that is
up to ~160 full snapshot fetches per action, each of which re-hydrates Pi
JSONL session files, runs every snapshot SQL query, serializes the result,
and then gets `JSON.stringify`-fingerprinted on the client, even when nothing
changed. This is the single largest source of steady-state CPU on both the
backend process and the renderer while an agent is running.

Separately, the "cheap" revision check is not as cheap as it should be: its
SQL feeds entire `runtime_state_json` blobs and entire scratchpad `body`
texts through `GROUP_CONCAT` into the hash, so the revision query's cost
scales with the size of runtime state and scratchpad content rather than
with row counts.

## Current state

Relevant files:

- `src/components/kiri-board/board-workspace.ts` — `useBoardWorkspace` hook;
  owns the dedupe + revision-gate refs and wires both polling modes.
- `src/components/kiri-board/workspace-polling.ts` — `pollWorkspaceDuringAction`
  (action window) and `pollWorkspaceInBackground` (2s loop). **Read-only for
  this plan** — its generics already support what we need.
- `src/components/kiri-board/workspace-fingerprint.ts` — `createWorkspaceDedupe`
  (JSON.stringify fingerprint) and `createWorkspaceRevisionGate`.
- `src/server/db/workspace-snapshot.ts` — `readWorkspaceRevision` (line 193),
  the SQL whose hash inputs get slimmed.

### The ungated action poll — `board-workspace.ts:72-94`

```ts
const withWorkspacePolling = React.useCallback(async (
  action: () => Promise<WorkspaceSnapshot>,
  onResult: (result: WorkspaceSnapshot) => void,
  onPoll?: RefreshAgentDetail,
) => {
  const endWorkspaceMutation = beginWorkspaceMutation()
  const gatedOnPoll = onPoll
    ? async () => {
        if (workspaceDedupeRef.current.didChange()) await onPoll()
      }
    : undefined
  try {
    await pollWorkspaceDuringAction({
      action,
      refreshWorkspace: () => refreshWorkspaceRef.current(),   // <-- full snapshot, no gate
      onResult,
      onWorkspace: applyWorkspace,
      onPoll: gatedOnPoll,
    })
  } finally {
    endWorkspaceMutation()
  }
}, [applyWorkspace, beginWorkspaceMutation])
```

The background poll (same file, lines 108-121) shows the gated pattern this
plan extends to the action poll:

```ts
React.useEffect(() =>
  pollWorkspaceInBackground({
    refreshWorkspace: () =>
      workspaceRevisionGateRef.current.refreshIfChanged({
        refreshRevision: () => refreshWorkspaceRevisionRef.current(),
        refreshWorkspace: () => refreshWorkspaceRef.current(),
      }),
    onWorkspace: (next) => {
      if (next) applyWorkspace(next)
    },
    ...
```

`pollWorkspaceDuringAction` is generic (`<T, Snapshot>`) and calls
`onWorkspace(next)` then `await onPoll?.()` each tick
(`workspace-polling.ts:23-64`), so it accepts a nullable snapshot type
without modification.

The gate (`workspace-fingerprint.ts:45-56`) keeps one `lastRevision` string
and returns `null` when unchanged. The dedupe's `apply` returns `true` when
the snapshot changed and `false` otherwise (`workspace-fingerprint.ts:19-29`);
`didChange()` returns the result of the **last** `apply` call — note this is
stale on ticks where `apply` was never called, which is why Step 2 tracks
per-tick change explicitly instead of using `didChange()`.

### The heavyweight revision hash — `src/server/db/workspace-snapshot.ts:211-241` and `266-278`

Agents query (inside `readWorkspaceRevision`): the per-row marker concatenates
`COALESCE(runtime_state_json, '')` — multi-KB JSON blobs — even though both
write sites for that column also set `runtime_state_updated_at`
(`src/server/db/runtime-state.ts:93` and `:153`, both
`UPDATE agent_slots SET runtime_state_json = ?, runtime_state_updated_at = ? ...`),
so the timestamp is a faithful proxy for the blob.

```sql
COALESCE(GROUP_CONCAT(
  id || ':' || project_id || ':' || slot || ':' || title || ':' || runtime || ':' ||
  interface_mode || ':' || model || ':' || status || ':' || session_dir || ':' ||
  COALESCE(session_file, '') || ':' || COALESCE(runtime_state_json, '') || ':' ||
  position || ':' || COALESCE(archived_at, ''),
  char(31)
), '') AS marker
```

Scratchpad query: the marker concatenates the full `body` of every block:

```sql
COALESCE(SUM(LENGTH(body)), 0) AS bodyBytes,
...
COALESCE(GROUP_CONCAT(
  id || ':' || COALESCE(project_id, '') || ':' || body || ':' ||
  COALESCE(triggered_agent_id, ''),
  char(31)
), '') AS marker
```

Scratchpad block bodies are immutable after insert — `src/server/db/scratchpad.ts`
has only INSERT (line 48-55), DELETE (line 62), and an UPDATE that touches only
`triggered_at`/`triggered_agent_id` (lines 72-80). So dropping `body` from the
marker loses nothing: deletions change the id list and `bodyBytes`, triggers
change `triggered_agent_id` in the marker and `triggeredAt` MAX.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Unit tests | `pnpm test:unit` | all pass |
| Targeted tests | `pnpm exec vitest run tests/kiri-board/workspace-polling.test.ts tests/kiri-board/workspace-fingerprint.test.ts tests/server/db-workspace-snapshot.test.ts` | all pass |
| Perf gates | `pnpm test:perf` | all pass |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/components/kiri-board/board-workspace.ts`
- `src/server/db/workspace-snapshot.ts` (only `readWorkspaceRevision`)
- `tests/kiri-board/workspace-polling.test.ts` (add cases)
- `tests/server/db-workspace-snapshot.test.ts` (add cases)

**Out of scope** (do NOT touch, even though they look related):
- `src/components/kiri-board/workspace-polling.ts` — its generics already
  support a nullable snapshot; no change needed.
- `src/components/kiri-board/workspace-fingerprint.ts` — keep the
  JSON.stringify fingerprint. Once this plan lands, `apply` runs only when a
  revision actually changed, so the stringify cost leaves the hot path.
  Do not rewrite it.
- `readWorkspaceSnapshot` and every other function in `workspace-snapshot.ts`.
- The server endpoints / TanStack server functions in `src/server/workspace.ts`.

## Git workflow

- Branch: `advisor/001-gate-action-poll`
- Commit style: short imperative subject, no prefix (matches repo history,
  e.g. "Batch near-simultaneous wakes to the same receiver into one turn").
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Slim the revision hash SQL

In `src/server/db/workspace-snapshot.ts`, inside `readWorkspaceRevision`:

1. In the **agents** query marker, replace
   `COALESCE(runtime_state_json, '')` with
   `COALESCE(runtime_state_updated_at, '')`. Keep everything else in the
   marker, and keep the existing
   `COALESCE(MAX(COALESCE(runtime_state_updated_at, '')), '') AS runtimeStateUpdatedAt`
   line as-is. Add `runtime_state_updated_at` stays in the inner SELECT
   (it is already selected).
2. In the **scratchpadBlocks** query marker, remove `body || ':'` from the
   GROUP_CONCAT (keep `id`, `project_id`, `triggered_agent_id`). Keep the
   `SUM(LENGTH(body)) AS bodyBytes` aggregate — it is part of the hashed JSON
   and preserves sensitivity to any hypothetical body change.

**Verify**: `pnpm exec vitest run tests/server/db-workspace-snapshot.test.ts` → all pass.

### Step 2: Route the action poll through the revision gate

In `src/components/kiri-board/board-workspace.ts`, rewrite
`withWorkspacePolling` so each tick fetches the revision first and only
fetches the full snapshot on change. Target shape:

```ts
const withWorkspacePolling = React.useCallback(async (
  action: () => Promise<WorkspaceSnapshot>,
  onResult: (result: WorkspaceSnapshot) => void,
  onPoll?: RefreshAgentDetail,
) => {
  const endWorkspaceMutation = beginWorkspaceMutation()
  let tickChanged = false
  const gatedOnPoll = onPoll
    ? async () => {
        if (tickChanged) await onPoll()
      }
    : undefined
  try {
    await pollWorkspaceDuringAction<WorkspaceSnapshot, WorkspaceSnapshot | null>({
      action,
      refreshWorkspace: () =>
        workspaceRevisionGateRef.current.refreshIfChanged({
          refreshRevision: () => refreshWorkspaceRevisionRef.current(),
          refreshWorkspace: () => refreshWorkspaceRef.current(),
        }),
      onResult,
      onWorkspace: (next) => {
        tickChanged = next !== null &&
          workspaceDedupeRef.current.apply(next, setWorkspace)
      },
      onPoll: gatedOnPoll,
    })
  } finally {
    endWorkspaceMutation()
  }
}, [beginWorkspaceMutation])
```

Notes:
- `tickChanged` replaces the old `workspaceDedupeRef.current.didChange()`
  check because `didChange()` reports the last `apply` call, which is stale
  on ticks where the gate returned `null` and `apply` never ran.
- The `applyWorkspace` dependency drops out of the `useCallback` deps array
  (the body now calls `workspaceDedupeRef.current.apply` + `setWorkspace`
  directly). Update the deps array accordingly; do not leave a stale dep.
- TypeScript: if explicit generics on `pollWorkspaceDuringAction` are not
  required for inference, you may omit them — but do not use `any` or `as`
  casts (repo rule: no `any`, no `as Type`, no non-null `!`).

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Add tests

1. `tests/server/db-workspace-snapshot.test.ts` (model new cases after the
   existing tests in that file, which build an in-memory `DatabaseSync` and
   call the exported reader functions):
   - updating an agent's runtime state (use the existing runtime-state write
     helper from `src/server/db/runtime-state.ts` or a direct
     `UPDATE agent_slots SET runtime_state_json = ?, runtime_state_updated_at = ?`)
     changes the value returned by `readWorkspaceRevision`.
   - marking a scratchpad block triggered changes the revision.
   - deleting a scratchpad block changes the revision.
2. `tests/kiri-board/workspace-polling.test.ts` already covers
   `pollWorkspaceDuringAction` with fake timers. Add a case in
   that style asserting that when `refreshWorkspace` resolves `null`,
   `onWorkspace` receives `null` and (if you test via the board-workspace
   integration) `onPoll` is not invoked. If the existing file only tests the
   polling primitives (not the hook), keep the new test at the primitive
   level: nullable snapshot flows through `onWorkspace` unchanged.

**Verify**: `pnpm exec vitest run tests/kiri-board/workspace-polling.test.ts tests/server/db-workspace-snapshot.test.ts` → all pass, including the new cases.

### Step 4: Full gates

**Verify**: `pnpm typecheck && pnpm test:unit && pnpm test:perf && pnpm build` → all exit 0.

## Test plan

- New server tests (Step 3.1): revision sensitivity to runtime-state writes,
  scratchpad trigger, scratchpad delete — these guard the exact fields the
  slimmed SQL stopped hashing directly.
- New client test (Step 3.2): null snapshot pass-through on the action poll.
- Pattern files: `tests/server/db-workspace-snapshot.test.ts`,
  `tests/kiri-board/workspace-polling.test.ts`.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test:unit` exits 0, including the new revision-sensitivity tests
- [ ] `pnpm test:perf` exits 0
- [ ] `pnpm build` exits 0
- [ ] `grep -n "runtime_state_json" src/server/db/workspace-snapshot.ts` returns **no matches**
- [ ] `grep -c "refreshIfChanged" src/components/kiri-board/board-workspace.ts` returns `2` (background poll + action poll)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts above don't match the live code (drift).
- You find a write site that updates `runtime_state_json` **without** also
  updating `runtime_state_updated_at` (search:
  `grep -rn "runtime_state_json" src/server`). The proxy assumption would be
  false and Step 1.1 must not land.
- You find any code path that UPDATEs `scratchpad_blocks.body` after insert.
- A revision-sensitivity test fails after Step 1 and the cause isn't a test
  bug — that means the slimmed hash lost a real signal.
- Existing `workspace-polling.test.ts` tests fail after Step 2 in a way that
  suggests action-result delivery (`onResult`) regressed.

## Maintenance notes

- After a mutation applies its returned snapshot directly, the gate's
  `lastRevision` is stale, so the next changed-revision tick refetches one
  full snapshot that the dedupe then drops. This is pre-existing behavior
  (the background poll works the same way) and is acceptable; fixing it would
  require mutations to return revisions.
- If a new column is added to `agent_slots` or `scratchpad_blocks` that can
  change user-visible snapshot output, it must be added to the corresponding
  revision marker — reviewers should watch for this in future schema PRs.
- Deferred (not in this plan): replacing the JSON.stringify dedupe
  fingerprint. Post-gating it runs only on real changes; revisit only if
  profiling shows it hot.
