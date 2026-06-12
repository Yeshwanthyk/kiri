# Plan 003: Remove read-model refresh from the snapshot/detail read paths

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat eadc8a0..HEAD -- src/server/workspace-service.ts src/server/read-model-indexer.ts src/server/db.ts`
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

Every workspace snapshot read and every agent-detail read first runs
`refreshReadModels`, which collects **all** read-model candidates (workspace
summary, every agent timeline, every diff summary) from SQLite, serializes
them, runs the indexer (optionally spawning the Rust binary
`kiri-read-model-indexer` via `execFileSync` with a 10MB buffer), reads all
existing `read_model_entries` back, and diffs the two sets — on **every poll
tick**. Crucially, as of the planned-at commit, **nothing consumes
`read_model_entries`**: the only references to the table in `src/` are the
indexer itself, the schema, and migrations (verified via
`grep -rn "read_model" src/ --include='*.ts' --include='*.tsx'`). The GUI
renders from `readWorkspaceSnapshot`, which queries the source tables
directly. Refreshing on the read path is therefore pure overhead — CPU,
allocations, and (when the Rust path is enabled) a child-process spawn per
snapshot. Keeping the refresh on mutation paths preserves the entries for a
future consumer at near-zero steady-state cost.

## Current state

Relevant files:

- `src/server/workspace-service.ts` — wires `refreshReadModels` into service
  methods. The two **read** paths to change:

  ```ts
  // line 254-257
  const snapshot = Effect.fn('WorkspaceService.snapshot')(function* () {
    yield* syncCall('WorkspaceService.refreshReadModels', dependencies.refreshReadModels)
    return yield* syncCall('WorkspaceService.snapshot', dependencies.getWorkspaceSnapshot)
  })

  // line 307-310
  agentDetail: Effect.fn('WorkspaceService.agentDetail')(function* (input: AgentDetailInput) {
    yield* syncCall('WorkspaceService.refreshReadModels', dependencies.refreshReadModels)
    return yield* syncCall('WorkspaceService.agentDetail', () => dependencies.getAgentDetail(input))
  }),
  ```

  The **mutation** paths that must KEEP their refresh calls: `snapshotAfter`
  (line 262-270), `syncSnapshotMethod` (line 271-279), `forkSession`
  (line 337-348), and the one at line 388 (check its enclosing method when
  editing — it is a mutation-flavored path and stays).

- `src/server/read-model-indexer.ts` — `refreshReadModelEntriesIfChanged`
  (line 41-55): note it computes the full new entry set **before** comparing,
  so "if changed" only saves the write, not the compute. **Read-only for this
  plan** (see out of scope).

- `src/server/db.ts` — `refreshReadModels()` (line 199-211) wraps the indexer
  with a kill switch (`KIRI_READ_MODEL_REFRESH=0`). **Read-only.**

### Repo conventions

- Effect service style: methods are `Effect.fn('Label')(function* () { ... })`
  with `syncCall`/`promiseCall` wrappers. Match the surrounding code exactly;
  do not introduce new Effect patterns.
- TypeScript: no `any`, no `!`, no `as Type`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Targeted tests | `pnpm exec vitest run tests/server/workspace-service.test.ts tests/server/read-model-indexer.test.ts` | all pass |
| Effect audit | `pnpm effect:audit` | exit 0 |
| Unit tests | `pnpm test:unit` | all pass |
| Perf gates | `pnpm test:perf` | all pass |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/server/workspace-service.ts` (the `snapshot` and `agentDetail` methods only)
- `tests/server/workspace-service.test.ts` (update/add assertions)

**Out of scope** (do NOT touch):
- `src/server/read-model-indexer.ts` — making the indexer itself incremental
  is a separate, larger change; with the read path fixed it runs only on
  mutations, which is cheap enough.
- `src/server/db.ts` — `refreshReadModels` and its kill switch stay.
- All mutation methods in `workspace-service.ts` (`snapshotAfter`,
  `syncSnapshotMethod`, `forkSession`, etc.) — they keep their refresh.
- The `read_model_entries` schema/migrations.
- Do NOT delete the read-model subsystem even though it has no consumer —
  that is a product decision, not a perf fix.

## Git workflow

- Branch: `advisor/003-read-models-off-read-path`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Drop the refresh from the two read methods

In `src/server/workspace-service.ts`:

1. In `snapshot` (line 254-257), delete the
   `yield* syncCall('WorkspaceService.refreshReadModels', ...)` line.
2. In `agentDetail` (line 307-310), delete the same line.
3. Confirm with `grep -n "refreshReadModels" src/server/workspace-service.ts`
   that the remaining occurrences are: the import (line 41), the dependencies
   type (line 169), the live wiring (line 215), `snapshotAfter` (was 268),
   `syncSnapshotMethod` (was 277), `forkSession` (was 342), and the one near
   line 388. Exactly the two read-path occurrences are gone.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Update tests

`tests/server/workspace-service.test.ts` builds the service with stub
dependencies. Find any assertions that `refreshReadModels` is called during
`snapshot`/`agentDetail` and invert or remove them; add explicit assertions:

- `snapshot` does NOT invoke the `refreshReadModels` dependency.
- `agentDetail` does NOT invoke it.
- A mutation method (pick `deleteSession` or `addProject`, whichever the
  existing tests already construct) DOES invoke it.

Model the new cases on the existing tests in that file (they pass a
dependencies object with recording stubs).

**Verify**: `pnpm exec vitest run tests/server/workspace-service.test.ts` → all pass.

### Step 3: Full gates

**Verify**: `pnpm typecheck && pnpm effect:audit && pnpm test:unit && pnpm test:perf && pnpm build` → all exit 0.

## Test plan

Covered in Step 2: presence-on-mutation + absence-on-read assertions in
`tests/server/workspace-service.test.ts`, modeled on that file's existing
stub-dependency style.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test:unit` exits 0, including the new call-pattern assertions
- [ ] `pnpm test:perf` exits 0
- [ ] `pnpm effect:audit` exits 0
- [ ] `pnpm build` exits 0
- [ ] `grep -c "refreshReadModels" src/server/workspace-service.ts` returns a count exactly 2 lower than before the change
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift).
- You find an actual consumer of `read_model_entries` that reads on the
  snapshot/detail path (re-run
  `grep -rn "read_model" src --include='*.ts' --include='*.tsx'` and also
  check `crates/` for the Rust side reading the table directly from
  `kiri.sqlite`). If a consumer exists, the freshness contract changes and
  this plan needs re-scoping (e.g. throttled refresh instead of removal).
- `tests/server/kiri-mcp.test.ts` or `tests/server/kiri-mcp-runtime.test.ts`
  fail after the change — the MCP surface may depend on read-side refresh
  indirectly; that is a re-scope, not a quick fix.

## Maintenance notes

- If a future feature starts consuming `read_model_entries` (the MCP server
  is the likely candidate), it must either tolerate mutation-time freshness
  (entries can lag live runtime output between mutations) or trigger its own
  refresh — do not reintroduce refresh on the GUI poll path.
- Follow-up worth considering later: make
  `refreshReadModelEntriesIfChanged` revision-gated on its inputs so even
  mutation-time refreshes skip the candidate collection when source tables
  are unchanged.
