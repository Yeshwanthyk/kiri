# Effect Migration Tracker

This tracker is the source of truth for the Kiri Effect migration. Keep it current before and after each file or tightly-coupled file group changes.

## Status Values

- `not-started` - classified, not migrated yet.
- `migrating` - active work in progress.
- `legacy-compat` - old public exports intentionally remain while callers move.
- `migrated` - final target seam is in place and review gate passed.
- `explicit-non-migration` - intentionally left outside Effect because it is pure, UI, script, fixture, or generated transport.

## Review Gate Values

- `required` - a review subagent must run before this row can be marked migrated.
- `passed` - review subagent ran and all blockers were fixed. Non-blocking residual risks may be logged in the migration record.
- `not-required` - only valid for explicit non-migration rows.

## Allowed State Pairs

- `not-started|required`
- `migrating|required`
- `legacy-compat|required`
- `migrated|passed`
- `explicit-non-migration|not-required`

## File Tracker

| File | Classification | Target Seam | Status | Review Gate | Notes |
|---|---|---|---|---|---|
| `src/server/backend-server.ts` | transport | `app/readiness` entrypoint over app layer | not-started | required | Readiness should probe layer dependencies, not direct DB state. |
| `src/server/codex-app-server.ts` | runtime-adapter | `runtime/codex/app-server-adapter.ts` scoped protocol adapter | not-started | required | Already uses Effect well; needs scoped lifecycle and smaller protocol/process modules. |
| `src/server/codex-runtime.ts` | runtime-adapter | `runtime/codex/{runtime-service,retained-state,projection,attachments}.ts` | not-started | required | Main Codex retained-state and stale-turn risk. |
| `src/server/db.ts` | legacy-compat | `db/{connection,migrations,schema,transaction,repositories,projections}` | not-started | required | Highest priority split; preserve compatibility exports until callers move. |
| `src/server/db/agent-detail.ts` | repository | Paged agent detail reader for timeline, diffs, tasks, and context usage | migrating | required | Extracted from `db.ts`; review/verification pending. |
| `src/server/db/connection.ts` | repository | DB open/configure/migrate boundary | migrating | required | Owns SQLite handle creation; review/verification pending. |
| `src/server/db/migrations.ts` | repository | DB schema creation and migration helpers | migrating | required | Extracted and reviewed; final status waits for DB connection/transaction service boundary. |
| `src/server/db/projects.ts` | repository | Project repository over DB connection/transaction helpers | migrating | required | Extracted from `db.ts`; review/verification pending. |
| `src/server/db/runtime-state.ts` | repository | Agent launch/runtime state/status/context usage repository | migrating | required | Extracted from `db.ts`; review/verification pending. |
| `src/server/db/scratchpad.ts` | repository | Scratchpad block repository over DB connection | migrating | required | Extracted from `db.ts`; review/verification pending. |
| `src/server/db/sessions.ts` | repository | Session summary and lifecycle repository over DB connection | migrating | required | Extracted from `db.ts`; review/verification pending. |
| `src/server/db/schema.ts` | pure | DB row schemas/parsers used by repositories and projections | explicit-non-migration | not-required | Pure parser module; no Effect needed unless schemas migrate later. |
| `src/server/db/timeline-format.ts` | pure | Timeline event id/tone/display derivation helpers | explicit-non-migration | not-required | Pure formatting/normalization module shared by readers and writers. |
| `src/server/db/timeline-writes.ts` | repository | Timeline/message/task/diff write repository over DB connection | migrating | required | Extracted from `db.ts`; direct live/projection/diff persistence tests added and review passed; final status waits for DB service boundary. |
| `src/server/db/transaction.ts` | repository | DB transaction helper boundary | migrating | required | Introduced for staged replacement of direct BEGIN/COMMIT/ROLLBACK blocks. |
| `src/server/diff-refresh.ts` | use-case | runtime/workspace service command | not-started | required | Should use runtime projection/repository services. |
| `src/server/git-diff.ts` | process-adapter | `integrations/git-diff.ts` service with process adapter and budgets | not-started | required | Direct `git` subprocess boundary. |
| `src/server/kiri-config.ts` | config | `config/kiri-config.ts` Effect config layer | not-started | required | Thin service exists; move env parsing into typed config service. |
| `src/server/kiri-control.ts` | use-case | `control/kiri-control.ts` over shared services | not-started | required | Good Effect facade; needs injected DB/runtime/terminal/config dependencies. |
| `src/server/kiri-mcp.ts` | transport | `transport/mcp.ts` over `KiriControl` app layer | not-started | required | Keep MCP output parity. |
| `src/server/pi-jsonl.ts` | projection | `db/projections/pi-jsonl.ts` plus file reader service | not-started | required | Split pure JSONL projection from file IO. |
| `src/server/pi-rpc.ts` | runtime-adapter | `runtime/pi/rpc-adapter.ts` scoped process adapter | not-started | required | Already Effect-aware; needs scoped process/listener lifetime. |
| `src/server/pi-runtime.ts` | runtime-adapter | `runtime/pi/{runtime-service,retained-state,attachments}.ts` | not-started | required | Main Pi retained-state and cleanup risk. |
| `src/server/preferences.ts` | config | `config/preferences-service.ts` with atomic file and in-memory adapters | not-started | required | Direct JSON file persistence. |
| `src/server/provider-runtime.ts` | use-case | `runtime/registry.ts` with injected runtime services | not-started | required | Registry exists; adapters are still imported singletons. |
| `src/server/runtime-binaries.ts` | process-adapter | `integrations/runtime-binaries.ts` resolver service | not-started | required | Direct PATH/executable resolution. |
| `src/server/runtime-file-operations.ts` | pure | pure runtime file-operation classifier | explicit-non-migration | not-required | Keep pure unless telemetry/resource dependencies are added. |
| `src/server/runtime-lifecycle.ts` | use-case | `runtime/lifecycle.ts` and `runtime/projection.ts` | not-started | required | Best current Effect shape; live projector should depend on repositories. |
| `src/server/runtime.ts` | use-case | runtime registry-backed command surface | not-started | required | Replace direct adapter dispatch with service calls. |
| `src/server/scratchpad-trigger.ts` | use-case | scratchpad/workspace service method | not-started | required | Shared semantics are good; move behind shared service. |
| `src/server/settings.ts` | config | `config/settings-service.ts` with typed config errors | not-started | required | Thin service exists; direct file read remains. |
| `src/server/terminal-launch.ts` | process-adapter | `terminal/launch-resolver.ts` | not-started | required | Command construction and resume detection seam. |
| `src/server/terminal-server.ts` | runtime-adapter | `terminal/registry.ts` scoped websocket/PTY registry | not-started | required | Singleton terminal sessions and idle timers need scoped cleanup. |
| `src/server/workspace.ts` | transport | `transport/workspace-functions.ts` over `WorkspaceService` | not-started | required | Server functions should become parse/run/respond only. |

## Per-File Record Template

Copy this section under `## Migration Records` for each file or inseparable file group as it changes.

```md
### <file-or-group>

- Status:
- Target seam:
- Behavior preserved:
- Dependencies moved:
- Baseline tests before migration:
- Tests added/updated:
- Post-migration parity tests:
- Perf/memory impact:
- Verification commands and results:
- Review subagent summary:
- Findings fixed:
- Residual risk:
```

## Migration Records

### Phase 1 guardrails

- Status: extracted; final migration status remains `migrating|required` until repositories sit behind the DB service boundary.
- Target seam: tracker and audit guardrails before migrations
- Behavior preserved: no runtime behavior changed
- Dependencies moved: none
- Baseline tests before migration: existing server/unit/e2e tests from prior branch state
- Tests added/updated: `tests/server/effect-migration-audit.test.ts`
- Post-migration parity tests: not applicable; guardrail-only phase
- Perf/memory impact: none
- Verification commands and results:
  - `pnpm effect:audit` - passed, 23 tracked files and 23 server files
  - `pnpm test -- --runInBand tests/server/effect-migration-audit.test.ts` - passed, 30 files and 125 tests
  - `pnpm typecheck` - passed
- Review subagent summary:
  - LOG.md second pass: no blockers; migration scope, exact verification, and review artifact requirements confirmed.
  - tracker second pass: no blockers; state pairs, baseline/parity fields, and audit command confirmed.
  - test/package second pass: no blockers; count brittleness fixed.
  - script final pass: no blockers; Map/Set guardrail fixed for exported and typed top-level declarations.
- Findings fixed: tightened migration scope, exact verification requirements, review artifact requirements, tracker review semantics, `db.ts` initial status, audit row duplicate checks, migrated-row record checks, missing-file handling, file extension coverage, and non-brittle test assertions.
- Residual risk: Markdown table parsing remains intentionally simple; avoid `|` in tracker cells.

### src/server/db/schema.ts

- Status: completed
- Target seam: pure DB row schema/parser module for later repositories and projections
- Behavior preserved: moved existing row schema definitions out of `src/server/db.ts` without changing parser shapes or callers.
- Dependencies moved: `zod` row schemas now live in `src/server/db/schema.ts`; `src/server/db.ts` imports them.
- Baseline tests before migration: existing DB, detail, perf, scratchpad, CLI, and MCP harness tests.
- Tests added/updated: tracker row added; no new behavior test needed for pure extraction.
- Post-migration parity tests: focused DB/perf/scratchpad/CLI/MCP tests remained green.
- Perf/memory impact: none expected; pure module split only.
- Verification commands and results:
  - `pnpm effect:audit` - passed, 24 tracked files and 24 server files.
  - `pnpm typecheck` - passed.
  - `pnpm test -- --runInBand tests/server/agent-detail-history.test.ts tests/server/perf-gates.test.ts tests/server/task-progress-db.test.ts tests/server/scratchpad-trigger.test.ts tests/server/effect-migration-audit.test.ts` - passed, 30 files and 125 tests.
- Review subagent summary: no blockers; confirmed safe pure extraction, no circular dependency, valid tracker row. Non-blocking unused import nit fixed.
- Findings fixed: restored required contract-schema imports in `db.ts` after focused tests caught the missing imports; removed unused imports from `schema.ts`.
- Residual risk: none known for this pure extraction.

### src/server/db/migrations.ts

- Status: extracted; final migration status remains `migrating|required` until the DB connection/transaction service boundary owns migration execution.
- Target seam: DB schema creation and legacy migration helpers isolated from the compatibility facade.
- Behavior preserved: copied existing migration SQL, migration order, indexes, constraints, and cleanup calls from `src/server/db.ts` without changing public DB exports.
- Dependencies moved: schema/migration SQL and legacy repair helpers moved from `src/server/db.ts` to `src/server/db/migrations.ts`.
- Baseline tests before migration: existing DB, detail, perf, scratchpad, CLI, MCP, and runtime harness tests.
- Tests added/updated: `tests/server/db-migrations.test.ts` covers the legacy `CHECK (runtime = 'pi')` migration and renamed foreign-key repair path.
- Post-migration parity tests: focused DB/perf/scratchpad/CLI/MCP tests remained green after extraction.
- Perf/memory impact: none expected; module split only.
- Verification commands and results:
  - `pnpm effect:audit` - passed, 25 tracked files and 25 server files.
  - `pnpm typecheck` - passed.
  - `pnpm test -- --runInBand tests/server/agent-detail-history.test.ts tests/server/perf-gates.test.ts tests/server/task-progress-db.test.ts tests/server/scratchpad-trigger.test.ts tests/server/effect-migration-audit.test.ts` - passed, 30 files and 125 tests.
  - `pnpm test -- --runInBand tests/server/db-migrations.test.ts` - passed, 31 files and 126 tests.
  - `pnpm exec vitest run tests/server/db-migrations.test.ts` - passed, 1 file and 1 test.
  - `pnpm lint` - passed.
  - `pnpm build` - passed; existing Vite chunk-size warning remains.
- Review subagent summary: initial review found one process blocker that the new migrations file was untracked for the slice commit; no schema/order regressions were found. The reviewer recommended adding a legacy-schema fixture; that test was added.
- Findings fixed: added `tests/server/db-migrations.test.ts` for legacy runtime-check widening, row preservation, foreign-key repair, and `PRAGMA foreign_key_check`.
- Residual risk: migrations still receive a raw SQLite handle until the next DB connection/transaction service slice moves execution behind the service boundary.

### src/server/db/connection.ts and src/server/db/transaction.ts

- Status: extracted; final migration status remains `migrating|required` until repositories use the connection and transaction seams consistently.
- Target seam: DB open/configure/migrate boundary plus synchronous transaction bracketing helper.
- Behavior preserved: `getDb()` still returns a memoized `DatabaseSync`, applies the same PRAGMAs, runs migrations before seeded-data cleanup, and preserves current public DB exports.
- Dependencies moved: SQLite handle creation, DB directory creation, PRAGMA setup, migration invocation, and one transaction bracketing path moved out of the compatibility facade.
- Baseline tests before migration: existing DB, detail, perf, scratchpad, CLI, MCP, and runtime harness tests.
- Tests added/updated: `tests/server/db-connection.test.ts` covers DB path creation, migrated schema, PRAGMA configuration, commit, and rollback; `tests/types/db-transaction-types.ts` pins async transaction callbacks as a type error.
- Post-migration parity tests: focused DB/perf/scratchpad/CLI/MCP tests remained green after the connection split.
- Perf/memory impact: none expected; module split and helper extraction only.
- Verification commands and results:
  - `pnpm effect:audit` - passed, 27 tracked files and 27 server files.
  - `pnpm exec vitest run tests/server/db-connection.test.ts tests/server/db-migrations.test.ts` - passed, 2 files and 3 tests.
  - `pnpm typecheck` - passed.
  - `pnpm test -- --runInBand tests/server/agent-detail-history.test.ts tests/server/perf-gates.test.ts tests/server/task-progress-db.test.ts tests/server/scratchpad-trigger.test.ts tests/server/effect-migration-audit.test.ts tests/server/db-connection.test.ts tests/server/db-migrations.test.ts` - passed, 32 files and 128 tests.
  - `pnpm lint` - passed.
- Review subagent summary: no blockers; reviewer confirmed `getDb()` ordering, connection extraction, and first `withTransaction` use. Notes about async use and PRAGMA coverage were fixed.
- Findings fixed: made `withTransaction` a synchronous-only typed helper and added a typecheck fixture for async callbacks; expanded connection tests to assert `busy_timeout` and `journal_mode`.
- Residual risk: most `src/server/db.ts` transaction blocks still use direct `BEGIN`/`COMMIT`/`ROLLBACK` until the repository extraction replaces them; `withTransaction` is an internal typed helper, so untyped/cast async misuse can still escape at runtime.

### src/server/db/projects.ts

- Status: extracted; final migration status remains `migrating|required` until all repositories sit behind the DB service boundary.
- Target seam: project repository over `DatabaseSync` plus shared transaction helper.
- Behavior preserved: project summaries, create validation, delete position compaction, visible reorder, hide/unhide, hidden filtering, and active-session counts retain the previous SQL semantics.
- Dependencies moved: project summary parsing, project CRUD SQL, visible-order SQL, project slug validation, and project transaction bracketing moved out of `src/server/db.ts`.
- Baseline tests before migration: existing CLI/MCP project management tests and full DB/perf/scratchpad harnesses.
- Tests added/updated: `tests/server/db-projects.test.ts` covers project create/list/summary, active vs archived session counts, hide/unhide filtering, visible reorder with hidden tail preservation, delete compaction, invalid slug/cwd, duplicate and stale reorder ids, missing ids, and last-project/last-visible guards.
- Post-migration parity tests: CLI and MCP project flows remained green after extraction.
- Perf/memory impact: none expected; SQL was moved without changing query shape.
- Verification commands and results:
  - `pnpm effect:audit` - passed, 28 tracked files and 28 server files.
  - `pnpm exec vitest run tests/server/db-projects.test.ts tests/server/kiri-control-cli.test.ts tests/server/kiri-mcp.test.ts` - passed, 3 files and 5 tests.
  - `pnpm typecheck` - passed.
  - `pnpm lint` - passed.
- Review subagent summary: no blockers in initial or second-pass review; reviewer confirmed project behavior parity and the expanded test coverage. Residual wrapper/rollback injection coverage gaps were non-blocking.
- Findings fixed: expanded direct project repository tests for session counts, duplicate/stale reorder ids, missing-id behavior, and old hide-last-visible-before-existence ordering.
- Residual risk: public `db.ts` project wrapper functions are covered through CLI/MCP flows rather than direct wrapper assertions; delete/reorder rollback failure injection is not yet modeled.

### src/server/db/scratchpad.ts

- Status: extracted; final migration status remains `migrating|required` until repositories sit behind the DB service boundary.
- Target seam: scratchpad block repository over `DatabaseSync`.
- Behavior preserved: scratchpad list filtering/order, add body trimming, project validation, delete, get, and trigger marker persistence retain previous SQL semantics.
- Dependencies moved: scratchpad block SQL and row parsing moved out of `src/server/db.ts`.
- Baseline tests before migration: existing scratchpad trigger harness, CLI scratchpad tests, MCP scratchpad tests, and workspace mutation smoke through the broad server suite.
- Tests added/updated: `tests/server/db-scratchpad.test.ts` covers list/add/get/delete, project filtering, trigger marker updates, missing project/body/id validation, missing triggered-agent FK failure, and `ON DELETE SET NULL` for project/session references.
- Post-migration parity tests: scratchpad trigger, CLI, and MCP flows remained green after extraction.
- Perf/memory impact: none expected; SQL was moved without changing query shape.
- Verification commands and results:
  - `pnpm effect:audit` - passed, 29 tracked files and 29 server files.
  - `pnpm exec vitest run tests/server/db-scratchpad.test.ts tests/server/scratchpad-trigger.test.ts tests/server/kiri-control-cli.test.ts tests/server/kiri-mcp.test.ts` - passed, 4 files and 6 tests.
  - `pnpm typecheck` - passed.
  - `pnpm lint` - passed.
- Review subagent summary: no blockers in initial or second-pass review; reviewer confirmed SQL, trim behavior, error strings, ordering, FK semantics, and no import cycle.
- Findings fixed: added direct FK semantics coverage for missing triggered agent and `ON DELETE SET NULL` on agent/project deletion.
- Residual risk: marking a nonexistent block remains a no-op, matching previous behavior and left unchanged.

### src/server/db/runtime-state.ts

- Status: extracted; final migration status remains `migrating|required` until repositories sit behind the DB/runtime service boundary.
- Target seam: agent runtime-state repository over `DatabaseSync`.
- Behavior preserved: active launch config lookup, runtime JSON parse/fallback, status validation, context usage upsert/clear/math, pending question parsing, and thinking-level lookup retain previous semantics.
- Dependencies moved: launch config SQL, runtime state/status mutations, context usage persistence/math, pending question read, and thinking-level read moved out of `src/server/db.ts`.
- Baseline tests before migration: runtime lifecycle, provider runtime, terminal launch, CLI/MCP flows, and broad server suite.
- Tests added/updated: `tests/server/db-runtime-state.test.ts` covers launch config, archived lookup hiding, runtime JSON valid/invalid/clear, status validation, context usage no-op/upsert/preserve/fallback/cap/null-window math, pending question parsing, and thinking-level reads.
- Post-migration parity tests: runtime lifecycle, provider runtime, and terminal launch tests remained green after extraction.
- Perf/memory impact: none expected; SQL and context math were moved without changing query shape.
- Verification commands and results:
  - `pnpm effect:audit` - passed, 31 tracked files and 31 server files.
  - `pnpm exec vitest run tests/server/db-runtime-state.test.ts tests/server/runtime-lifecycle.test.ts tests/server/provider-runtime.test.ts tests/server/terminal-launch.test.ts` - passed, 4 files and 27 tests.
  - `pnpm typecheck` - passed.
  - `pnpm lint` - passed.
- Review subagent summary: no blockers in initial or second-pass review; reviewer confirmed SQL/error parity and public wrapper preservation.
- Findings fixed: added direct context usage fallback, over-window cap, and missing-window coverage.
- Residual risk: runtime-state repository is still synchronous over `DatabaseSync`; Effect service wrapping lands in a later phase.

### src/server/db/agent-detail.ts + src/server/db/timeline-format.ts

- Status: extracted; `agent-detail.ts` final migration status remains `migrating|required`; `timeline-format.ts` is `explicit-non-migration|not-required` because it is pure formatting/normalization.
- Target seam: paged agent detail reader plus pure timeline event display/id/tone helpers.
- Behavior preserved: agent detail lookup, context usage read, active-thread selection, paged message/event union ordering, timeline item parsing, diff limit, task ordering, event label/detail derivation, event id derivation, tone inference, and timestamp normalization retain previous semantics.
- Dependencies moved: paged detail SQL, diff reader, task reader, timeline row parser, and pure event formatting helpers moved out of `src/server/db.ts`.
- Baseline tests before migration: agent detail history harness, perf gates, runtime lifecycle tests, and broad server suite.
- Tests added/updated: no new test files; existing history and perf harnesses directly cover the moved hot path.
- Post-migration parity tests: history harness still returned 500 timeline rows, 125 messages, 375 events, and 50 diff cap; perf harness remained within payload, latency, and memory budgets.
- Perf/memory impact: no query-shape change; extraction keeps bounded detail hydration and detail JSON under budget. One combined run missed RSS by 0.02 MB, then focused and review harness reruns passed with RSS delta down to 44.44 MB.
- Verification commands and results:
  - `pnpm effect:audit` - passed, 33 tracked files and 33 server files.
  - `pnpm exec vitest run tests/server/agent-detail-history.test.ts tests/server/perf-gates.test.ts tests/server/runtime-lifecycle.test.ts tests/server/db-runtime-state.test.ts` - passed after rerunning the perf gate for RSS noise.
  - `pnpm exec vitest run tests/server/agent-detail-history.test.ts tests/server/perf-gates.test.ts` - passed.
  - `pnpm typecheck` - passed.
  - `pnpm lint` - passed.
  - `pnpm build` - passed with existing Vite chunk-size warning.
- Review subagent summary: no blockers; reviewer confirmed SQL parity, timeline display parity, paging caps, and direct perf harness output at 500 timeline rows, 50 diffs, 89.79ms detail time, 44.44 MB RSS delta.
- Findings fixed: restored `agentDetailDbRowSchema` import used by workspace snapshots after first verification caught the over-removal.
- Residual risk: message/event/task writers still live in `src/server/db.ts`; they are the next repository extraction boundary.

### src/server/db/timeline-writes.ts

- Status: completed
- Target seam: repository module for message, timeline event, task, Pi projection, context usage, and diff write persistence over an injected DB connection.
- Behavior preserved: `src/server/db.ts` compatibility exports still expose the same public write functions while delegating to the repository. Pi projection hydration still replaces transient prompt rows, preserves JSONL message ids, updates tasks/context usage, and falls back to live RPC messages when no JSONL projection is available.
- Dependencies moved: message id hashing, Pi live-turn filtering, projection hydration, task replacement, diff artifact replacement, thread summary updates, and info/runtime/Pi timeline event inserts moved from `src/server/db.ts`.
- Baseline tests before migration: runtime lifecycle, agent detail history, perf gates, Pi JSONL projection, runtime state, task-progress DB tests.
- Tests added/updated: `tests/server/db-timeline-writes.test.ts` covers Pi live-turn persistence, JSONL projection replacement with task/context usage writes, and diff replacement semantics.
- Post-migration parity tests: focused repository tests and existing runtime/detail/perf tests passed.
- Perf/memory impact: no payload growth. Standalone perf harness after extraction returned 500 timeline rows and 50 diffs with 54.67MB RSS delta under the 64MB budget.
- Verification commands and results:
  - `pnpm exec vitest run tests/server/db-timeline-writes.test.ts` - passed, 3 tests
  - `pnpm typecheck` - passed
  - `pnpm effect:audit` - passed, 34 tracked/server files
  - `pnpm exec vitest run tests/server/db-timeline-writes.test.ts tests/server/runtime-lifecycle.test.ts tests/server/agent-detail-history.test.ts tests/server/perf-gates.test.ts tests/server/pi-jsonl.test.ts tests/server/db-runtime-state.test.ts tests/server/task-progress-db.test.ts` - parallel perf RSS exceeded by 3.59MB, rerun isolated below passed; other 24 tests passed
  - `pnpm exec vitest run tests/server/perf-gates.test.ts` - passed
  - `pnpm exec tsx tests/perf/run-perf.ts` - passed, RSS delta 54.67MB
  - `pnpm lint` - passed
  - `git diff --check` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
- Review subagent summary: first reviewer reported no blockers and identified missing direct persistence coverage; tests were added. Ramanujan reported no blocking findings and no edits; verified focused timeline-write test, typecheck, lint, and diff check.
- Findings fixed: added direct persistence regression tests after the first reviewer identified missing coverage for Pi live/projection writes and diff replacement.
- Residual risk: no direct test yet for low-level timeline event id collisions; covered through existing runtime lifecycle flow tests and unchanged event id helper.

### src/server/db/sessions.ts

- Status: extracted; final migration status remains `migrating|required` until repositories sit behind the DB service boundary.
- Target seam: session lifecycle repository over `DatabaseSync`.
- Behavior preserved: session summary list/order/defaults, start row creation, initial thread, thinking-level info event, archive/restore, rename, and started-session guards retain prior semantics.
- Dependencies moved: session summary SQL and start/archive/restore/rename persistence moved out of `src/server/db.ts`.
- Baseline tests before migration: CLI/MCP session flows, runtime lifecycle tests, broad server suite.
- Tests added/updated: `tests/server/db-sessions.test.ts` covers start/list/require/archive/restore/rename, validation errors, deterministic slot/session-dir generation, thinking-level event persistence, and rollback on partial start failure.
- Post-migration parity tests: CLI, MCP, and runtime lifecycle tests remained green after extraction.
- Perf/memory impact: none expected; SQL was moved without changing query shape.
- Verification commands and results:
  - `pnpm effect:audit` - passed, 30 tracked files and 30 server files.
  - `pnpm exec vitest run tests/server/db-sessions.test.ts tests/server/kiri-control-cli.test.ts tests/server/kiri-mcp.test.ts tests/server/runtime-lifecycle.test.ts` - passed, 4 files and 20 tests.
  - `pnpm typecheck` - passed.
  - `pnpm lint` - passed.
  - `pnpm build` - passed with existing Vite chunk-size warning.
- Review subagent summary: no blockers after second pass; reviewer confirmed SQL/order parity, transaction bracketing, duplicate project check for error precedence, and rollback coverage.
- Findings fixed: restored legacy project-not-found error precedence before runtime/model validation; added forced thread-insert failure rollback test.
- Residual risk: start-session facade still performs settings/model validation outside the repository until the settings service layer lands.

## Audit Command

Run this after tracker edits and before each migrated row is marked complete:

```sh
pnpm effect:audit
```
