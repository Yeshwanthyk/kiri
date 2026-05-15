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
| `src/server/codex-retained-state.ts` | runtime-adapter | Codex retained-state registry for adapters, listeners, threads, turns, queues, generations, and diff-turn guards | migrating | required | Extracted from `codex-runtime.ts`; review/verification pending. |
| `src/server/codex-runtime.ts` | runtime-adapter | `runtime/codex/{runtime-service,retained-state,projection,attachments}.ts` | migrating | required | Retained-state maps extracted; runtime service/projection/attachment splits remain. |
| `src/server/db.ts` | legacy-compat | `db/{connection,migrations,schema,transaction,repositories,projections}` | not-started | required | Highest priority split; preserve compatibility exports until callers move. |
| `src/server/db/agent-detail.ts` | repository | Paged agent detail reader for timeline, diffs, tasks, and context usage | migrating | required | Extracted from `db.ts`; review/verification pending. |
| `src/server/db/bootstrap.ts` | repository | Startup DB data repair and seed cleanup boundary | migrating | required | Extracted from `db.ts`; direct bootstrap tests added and review passed; final status waits for DB/settings service boundary. |
| `src/server/db/connection.ts` | repository | DB open/configure/migrate boundary | migrating | required | Owns SQLite handle creation; review/verification pending. |
| `src/server/db/migrations.ts` | repository | DB schema creation and migration helpers | migrating | required | Extracted and reviewed; final status waits for DB connection/transaction service boundary. |
| `src/server/db/projects.ts` | repository | Project repository over DB connection/transaction helpers | migrating | required | Extracted from `db.ts`; review/verification pending. |
| `src/server/db/runtime-state.ts` | repository | Agent launch/runtime state/status/context usage repository | migrating | required | Extracted from `db.ts`; review/verification pending. |
| `src/server/db/scratchpad.ts` | repository | Scratchpad block repository over DB connection | migrating | required | Extracted from `db.ts`; review/verification pending. |
| `src/server/db/session-operations.ts` | repository | Session reset/fork/persisted-Pi hydration operations over DB and session files | migrating | required | Extracted from `db.ts`; direct reset/fork/hydration tests added and review passed; final status waits for DB/config/filesystem service boundary. |
| `src/server/db/sessions.ts` | repository | Session summary and lifecycle repository over DB connection | migrating | required | Extracted from `db.ts`; review/verification pending. |
| `src/server/db/schema.ts` | pure | DB row schemas/parsers used by repositories and projections | explicit-non-migration | not-required | Pure parser module; no Effect needed unless schemas migrate later. |
| `src/server/db/timeline-format.ts` | pure | Timeline event id/tone/display derivation helpers | explicit-non-migration | not-required | Pure formatting/normalization module shared by readers and writers. |
| `src/server/db/timeline-writes.ts` | repository | Timeline/message/task/diff write repository over DB connection | migrating | required | Extracted from `db.ts`; direct live/projection/diff persistence tests added and review passed; final status waits for DB service boundary. |
| `src/server/db/transaction.ts` | repository | DB transaction helper boundary | migrating | required | Introduced for staged replacement of direct BEGIN/COMMIT/ROLLBACK blocks. |
| `src/server/db/workspace-snapshot.ts` | projection | Workspace snapshot projection over DB connection and provided settings/preferences | migrating | required | Extracted from `db.ts`; direct snapshot test added and review passed; final status waits for workspace service boundary. |
| `src/server/directory-picker.ts` | process-adapter | typed directory picker service over osascript | migrating | required | Extracted from `workspace.ts`; review/verification pending. |
| `src/server/diff-refresh.ts` | use-case | terminal diff refresh service command | migrating | required | Typed injectable diff refresh service added; review/verification pending. |
| `src/server/git-diff.ts` | process-adapter | `integrations/git-diff.ts` service with process adapter and budgets | migrating | required | Typed injectable git diff service added; review/verification pending. |
| `src/server/kiri-config.ts` | config | `config/kiri-config.ts` Effect config layer | migrating | required | Typed injectable config service added; review/verification pending. |
| `src/server/kiri-control.ts` | use-case | `control/kiri-control.ts` over shared services | migrating | required | Effect facade now has injectable dependencies and shared cleanup/trigger seams; final leaf service composition remains. |
| `src/server/kiri-mcp.ts` | transport | `transport/mcp.ts` over `KiriControl` app layer | not-started | required | Keep MCP output parity. |
| `src/server/pi-jsonl.ts` | projection | `db/projections/pi-jsonl.ts` plus file reader service | not-started | required | Split pure JSONL projection from file IO. |
| `src/server/pi-rpc.ts` | runtime-adapter | `runtime/pi/rpc-adapter.ts` scoped process adapter | migrating | required | Prompt completion waiters now cancel on stop; full scoped process/listener lifetime remains. |
| `src/server/pi-retained-state.ts` | runtime-adapter | Pi retained-state registry for adapters, launch keys, queues, and reset generations | migrating | required | Extracted from `pi-runtime.ts`; review/verification pending. |
| `src/server/pi-runtime.ts` | runtime-adapter | `runtime/pi/{runtime-service,retained-state,attachments}.ts` | migrating | required | Retained-state maps extracted; runtime service and attachment split remain. |
| `src/server/preferences.ts` | config | `config/preferences-service.ts` with atomic file and in-memory adapters | migrating | required | Typed injectable preferences service added; review/verification pending. |
| `src/server/provider-runtime.ts` | use-case | runtime registry with injected command and cleanup adapters | migrating | required | Cleanup now routes through typed registry; review/verification pending. |
| `src/server/runtime-binaries.ts` | process-adapter | `integrations/runtime-binaries.ts` resolver service | migrating | required | Typed injectable runtime binary service added; review/verification pending. |
| `src/server/runtime-cleanup.ts` | use-case | runtime cleanup use-case for session/project delete retained-state cleanup | migrating | required | Project and session delete cleanup now share tested ordering; final scoped finalizer model remains. |
| `src/server/runtime-file-operations.ts` | pure | pure runtime file-operation classifier | explicit-non-migration | not-required | Keep pure unless telemetry/resource dependencies are added. |
| `src/server/runtime-lifecycle.ts` | use-case | runtime lifecycle orchestration over injected `RuntimeProjector` | migrating | required | DB-backed live projector extracted; lifecycle now owns orchestration only. |
| `src/server/runtime-projection.ts` | projection | DB-backed runtime projector layer | migrating | required | Extracted from `runtime-lifecycle.ts`; review/verification pending. |
| `src/server/runtime.ts` | use-case | runtime registry-backed command surface | migrating | required | Runtime command service now dispatches through `RuntimeRegistry`; review/verification pending. |
| `src/server/scratchpad-trigger.ts` | use-case | scratchpad trigger service method | migrating | required | Effect service and injectable dependencies added; compatibility export preserved. |
| `src/server/settings.ts` | config | `config/settings-service.ts` with typed config errors | migrating | required | Typed injectable settings service added; review/verification pending. |
| `src/server/terminal-launch.ts` | process-adapter | terminal launch resolver service | migrating | required | Typed injectable terminal launch service added; review/verification pending. |
| `src/server/terminal-registry.ts` | runtime-adapter | terminal session registry for PTY/socket state | migrating | required | Extracted from `terminal-server.ts`; review/verification pending. |
| `src/server/terminal-server.ts` | runtime-adapter | scoped websocket/PTY service over terminal registry | migrating | required | Terminal session registry extracted; final service boundary pending. |
| `src/server/workspace-service.ts` | use-case | shared workspace service over DB/runtime/preference/terminal use-cases | migrating | required | First service slice added; workspace transport delegates to it while dependency leaf services remain compatibility exports. |
| `src/server/workspace.ts` | transport | `transport/workspace-functions.ts` over `WorkspaceService` | migrating | required | Server functions now delegate through `WorkspaceService`; final transport split/file move remains. |

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

### src/server/runtime-lifecycle.ts and src/server/runtime-projection.ts

- Status: migrating; final status waits for runtime projectors to depend on repository services instead of compatibility DB exports.
- Target seam: pure runtime lifecycle orchestration over an injectable `RuntimeProjector`, with DB-backed projection isolated in `runtime-projection.ts`.
- Behavior preserved: `RuntimeProjector`, `projectRuntimeEvent`, `runAgentTurnLifecycle`, `captureRuntimeDiffs`, `setRuntimeState`, sync/async boundary helpers, and `runtimeStateWithoutUndefined` keep their public import path through `runtime-lifecycle.ts`.
- Dependencies moved: direct DB write imports for status, user messages, runtime messages, timeline events, context usage, task replacement, diff replacement, and runtime state moved out of `runtime-lifecycle.ts` into `runtime-projection.ts`.
- Baseline tests before migration: runtime lifecycle tests covered queue behavior, lifecycle status transitions, layer replacement, stale generation suppression, runtime state filtering, file-operation projection, diff capture swallowing, and promise/sync error boundaries.
- Tests added/updated: no new tests yet; existing focused runtime lifecycle coverage was used as the parity harness for the extraction.
- Post-migration parity tests: focused runtime lifecycle/runtime cleanup tests passed.
- Perf/memory impact: no retained state added; extraction reduces lifecycle coupling and leaves projection behavior layer-replaceable for later repository-backed tests.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec vitest run tests/server/runtime-lifecycle.test.ts tests/server/runtime-cleanup.test.ts` - passed, 2 files / 17 tests
  - `pnpm exec vitest run tests/server/runtime-lifecycle.test.ts tests/server/runtime-cleanup.test.ts tests/server/runtime-commands.test.ts` - passed, 3 files / 21 tests
  - `pnpm exec eslint src/server/runtime-lifecycle.ts src/server/runtime-projection.ts tests/server/runtime-lifecycle.test.ts --max-warnings=0` - passed
  - `pnpm effect:audit` - passed, 43 tracked/server files
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `pnpm test -- --runInBand` - passed, 49 files / 203 tests including `tests/server/perf-gates.test.ts`
  - `git diff --check` - passed
- Review subagent summary: Dalton caught exported event type drift and non-Error boundary behavior drift. Pasteur second pass found no blockers after fixes.
- Findings fixed: restored public event payload parity through type-only DB writer parameter references, preserved legacy non-Error throw identity/string formatting with explicit lint suppressions, and added regression coverage for non-Error runtime failures.
- Residual risk: live projection still calls DB compatibility exports directly until DB repository services are promoted into projector dependencies.

### src/server/runtime-cleanup.ts, src/server/workspace.ts delete session, and src/server/kiri-control.ts delete session

- Status: migrating; final status waits for workspace/control to depend on a shared `WorkspaceService`/control service layer and for runtime cleanup to become a scoped finalizer boundary.
- Target seam: shared session-delete cleanup use-case that captures runtime ownership, archives the session, then clears retained runtime and terminal state.
- Behavior preserved: workspace delete keeps active-session-only lookup semantics; Kiri control keeps include-archived lookup semantics; both paths only clean retained state after the DB delete/archive call succeeds.
- Dependencies moved: duplicated `forgetProviderRuntimeAgent` and `closeAgentRuntimeTerminal` sequencing moved out of `workspace.ts` and `kiri-control.ts` into `runtime-cleanup.ts`.
- Baseline tests before migration: CLI/MCP tests covered session delete flows; runtime cleanup tests covered project delete cleanup ordering.
- Tests added/updated: `tests/server/runtime-cleanup.test.ts` now covers session cleanup success ordering, workspace-returning helper parity, delete-failure safety, missing-session safety, and cleanup failure surfacing.
- Post-migration parity tests: focused runtime cleanup, CLI, and MCP tests passed.
- Perf/memory impact: session delete now uses the same retained-state cleanup seam in UI and Kiri-control paths, reducing leak risk from divergent sequencing without changing payload/query budgets.
- Verification commands and results:
  - `pnpm exec vitest run tests/server/runtime-cleanup.test.ts` - passed, 7 tests
  - `pnpm exec eslint src/server/runtime-cleanup.ts src/server/kiri-control.ts tests/server/runtime-cleanup.test.ts --max-warnings=0` - passed
  - `pnpm typecheck` - passed
  - `pnpm exec vitest run tests/server/runtime-cleanup.test.ts tests/server/kiri-control-cli.test.ts tests/server/kiri-mcp.test.ts` - passed, 3 files / 10 tests
  - `pnpm effect:audit` - passed, 43 tracked/server files
- Review subagent summary: Sagan found no blockers. Follow-up notes led to preserving workspace active-only lookup, adding workspace helper coverage, and pinning cleanup-failure behavior; second pass found no blockers.
- Findings fixed: split active-session lookup for workspace from include-archived lookup for Kiri control; added coverage for the workspace helper and cleanup failure after DB archive success.
- Residual risk: cleanup still surfaces retained-state cleanup failures after the DB archive has succeeded, matching the existing fail-fast behavior; a later scoped finalizer phase can intentionally switch this to best-effort cleanup with explicit logging.

### src/server/workspace-service.ts and src/server/workspace.ts transport delegation

- Status: migrating; final status waits for DB/runtime/preference/terminal dependencies to be injected as Effect services instead of compatibility function dependencies, and for `workspace.ts` to move into a transport directory.
- Target seam: `WorkspaceService` owns UI-facing workspace use-cases while `workspace.ts` handles TanStack server function schemas and response wiring.
- Behavior preserved: exported server functions, query options, workspace snapshots after runtime actions, fork/trigger return shapes, preference mutation returns, terminal config merge shape, project/session/scratchpad mutation outputs, and agent detail query behavior remain unchanged.
- Dependencies moved: direct DB/runtime/preference/directory-picker/diff-refresh/terminal/scratchpad-trigger imports moved out of `workspace.ts` into `workspace-service.ts` behind an injectable dependency record and Effect service tag.
- Baseline tests before migration: CLI/MCP tests, runtime command tests, scratchpad trigger tests, terminal config flow through component typecheck, and full server suite covered existing behavior.
- Tests added/updated: `tests/server/workspace-service.test.ts` covers post-runtime snapshots, fork result shape, terminal config merge, scratchpad trigger result shape, and typed error wrapping with original cause preservation.
- Post-migration parity tests: focused workspace service/runtime cleanup tests passed; CLI/MCP/scratchpad/diff-refresh parity tests passed.
- Perf/memory impact: no payload/query changes; workspace handlers now have one orchestrator seam for future no-overlap polling, snapshot budgeting, and runtime cleanup assertions.
- Verification commands and results:
  - `effect-solutions show services-and-layers testing basics error-handling` - reviewed before writing Effect service code
  - `pnpm typecheck` - passed
  - `pnpm exec vitest run tests/server/workspace-service.test.ts tests/server/runtime-cleanup.test.ts` - passed, 2 files / 12 tests
  - `pnpm exec eslint src/server/workspace-service.ts tests/server/workspace-service.test.ts --max-warnings=0` - passed
  - `pnpm effect:audit` - passed, 44 tracked/server files
  - `pnpm exec vitest run tests/server/workspace-service.test.ts tests/server/kiri-control-cli.test.ts tests/server/kiri-mcp.test.ts tests/server/scratchpad-trigger.test.ts tests/server/diff-refresh.test.ts` - passed, 5 files / 13 tests
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `pnpm test -- --runInBand` - passed, 50 files / 213 tests including `tests/server/perf-gates.test.ts`
- Review subagent summary: Sagan found no blockers. Notes: `workspace.ts` is now transport-only enough though repetitive; only non-Error throw values are now surfaced as `WorkspaceServiceError`; representative snapshot/fork/terminal/scratchpad/error tests cover the main sequencing paths.
- Findings fixed: initial typecheck caught `chooseProjectDirectory` widening from `string` to `string | null`; restored string contract. Focused eslint caught unused schema imports and async test stubs without awaits; removed unused imports and switched stubs to `Promise.resolve`/`Promise.reject`.
- Residual risk: service dependencies are still compatibility functions rather than leaf Effect services, so this is orchestration extraction, not the final app-layer composition.

### src/server/kiri-control.ts dependency injection

- Status: migrating; final status waits for Kiri control to consume shared DB/settings/workspace/runtime services directly instead of compatibility exports.
- Target seam: injectable `KiriControlDependencies` for CLI/MCP control operations while preserving the existing `KiriControl.layer`.
- Behavior preserved: context projection, model listing, project/session/scratchpad summaries, cleanup-backed project/session delete, restore/rename/start, and scratchpad trigger return shapes are wired to the same live functions.
- Dependencies moved: direct calls inside `makeKiriControl` now go through a dependency record; live wiring still uses the existing DB/settings/runtime-cleanup/scratchpad-trigger compatibility exports.
- Baseline tests before migration: CLI and MCP tests covered live KiriControl behavior.
- Tests added/updated: `tests/server/kiri-control-service.test.ts` covers context/model construction from injected state, delete cleanup routing through injected dependencies, and scratchpad trigger routing through the shared trigger path.
- Post-migration parity tests: focused service, CLI, and MCP tests passed.
- Perf/memory impact: no query/payload changes; this makes cleanup/trigger sequencing testable without live runtime state and prepares KiriControl for leaf service replacement.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec eslint src/server/kiri-control.ts tests/server/kiri-control-service.test.ts --max-warnings=0` - passed
  - `pnpm exec vitest run tests/server/kiri-control-service.test.ts tests/server/kiri-control-cli.test.ts tests/server/kiri-mcp.test.ts` - passed, 3 files / 8 tests
  - `pnpm effect:audit` - passed, 44 tracked/server files
  - `pnpm kiricli models list --json` - passed and returned configured Pi/Codex/Claude model choices
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `pnpm test -- --runInBand` - passed, 51 files / 218 tests including `tests/server/perf-gates.test.ts`
- Review subagent summary: Sagan found no blockers. Suggested failure-shape tests were added; second pass found no blockers.
- Findings fixed: typecheck caught the test fixture using stale agent-cell fields; corrected the fixture to match the current contract. Review suggested direct sync/async error-shape coverage; added tests for injected project-list failure and scratchpad-trigger failure.
- Residual risk: error normalization remains the existing `KiriControlError` wrapper, so non-Error throws are still converted to string messages at the Effect facade boundary.

### src/server/scratchpad-trigger.ts service extraction

- Status: migrating; final status waits for DB/session/runtime command dependencies to be leaf Effect services instead of compatibility functions.
- Target seam: `ScratchpadTriggerService` owns scratchpad block lookup, session creation, trigger marking, optional GUI prompt enqueue, prompt-failure cleanup, and session summary return.
- Behavior preserved: `triggerScratchpadSession(input, prompt?)` compatibility export remains; terminal sessions do not enqueue prompts; GUI prompt enqueue failures asynchronously archive the created session and report the prompt failure; missing blocks fail before session creation.
- Dependencies moved: DB reads/writes, session start/delete/list, prompt enqueue, and prompt-failure reporting are now behind `ScratchpadTriggerDependencies`.
- Baseline tests before migration: `tests/harness/scratchpad-trigger-harness.ts` covered terminal no-prompt and GUI failed-prompt archive behavior through the public compatibility export.
- Tests added/updated: `tests/server/scratchpad-trigger-service.test.ts` covers terminal no-prompt, GUI prompt-failure cleanup/reporting, and missing-block precondition using injected dependencies.
- Post-migration parity tests: focused service, public harness, workspace-service, and KiriControl service tests passed.
- Perf/memory impact: no payload/query changes; the async prompt failure cleanup remains bounded to one retained session cleanup path and is now directly unit-testable.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec eslint src/server/scratchpad-trigger.ts tests/server/scratchpad-trigger-service.test.ts --max-warnings=0` - passed
  - `pnpm exec vitest run tests/server/scratchpad-trigger-service.test.ts tests/server/scratchpad-trigger.test.ts tests/server/workspace-service.test.ts tests/server/kiri-control-service.test.ts` - passed, 4 files / 14 tests
  - `pnpm effect:audit` - passed, 44 tracked/server files
  - `pnpm exec vitest run tests/server/scratchpad-trigger-service.test.ts tests/server/scratchpad-trigger.test.ts tests/server/workspace-service.test.ts tests/server/kiri-control-service.test.ts tests/server/kiri-control-cli.test.ts tests/server/kiri-mcp.test.ts` - passed, 6 files / 17 tests
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `pnpm test -- --runInBand` - passed, 52 files / 221 tests including `tests/server/perf-gates.test.ts`
- Review subagent summary: Sagan found no blockers. Notes: compatibility export still accepts custom `prompt`, normal `Error` failures unwrap for existing callers, GUI prompt failure cleanup and terminal no-prompt behavior are preserved.
- Findings fixed: typecheck caught that live `getScratchpadBlock` can return `undefined`; dependency type now allows `null | undefined` so the service preserves the existing missing-block behavior.
- Residual risk: the compatibility export builds a small one-off layer per call to preserve the optional prompt override; final app-layer composition should provide the service once at the transport boundary.

### src/server/pi-retained-state.ts, src/server/pi-runtime.ts, src/server/pi-rpc.ts, and project runtime cleanup

- Status: migrating; final status waits for Pi runtime use-cases, attachment handling, and process adapter lifecycle to move behind scoped services.
- Target seam: Pi retained-state registry for adapter ownership, launch identity keys, per-agent queues, reset generation guards, prompt completion cancellation, and delete cleanup use-cases.
- Behavior preserved: public Pi runtime functions, compatibility cleanup export, adapter reuse/replacement by launch identity, immediate steer/interrupt target registration, reset/fork cleanup, project/session delete cleanup, and retained-state stats remain wired through compatibility exports.
- Dependencies moved: module-global Pi retained maps moved into `pi-retained-state.ts`; `pi-runtime.ts` now delegates adapter lookup/replacement, queue ownership, stats, and cleanup through the registry. Project delete cleanup moved behind `runtime-cleanup.ts`.
- Baseline tests before migration: runtime retention tests covered idempotent Pi cleanup.
- Tests added/updated: `tests/server/pi-retained-state.test.ts` covers adapter reuse, adapter replacement with old adapter stop and generation invalidation, full forget cleanup, generation-preserving reset cleanup, delete/recreate generation invalidation, and test cleanup. `tests/server/pi-rpc.test.ts` covers prompt completion waiter cancellation on stop after prompt submission. `tests/server/runtime-cleanup.test.ts` covers project delete cleanup order and validation-failure safety.
- Post-migration parity tests: focused Pi retained-state/RPC/runtime-cleanup/runtime-retention/provider-runtime tests passed.
- Perf/memory impact: retained Pi runtime state is isolated and directly unit-tested; reset/delete/adapter replacement now invalidate queued prompts that have not started yet; active stopped Pi prompt waiters are rejected immediately instead of waiting for timeout; project delete now cleans retained runtime and terminal state for all deleted sessions.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec vitest run tests/server/runtime-cleanup.test.ts tests/server/pi-rpc.test.ts tests/server/pi-retained-state.test.ts tests/server/runtime-retention.test.ts tests/server/provider-runtime.test.ts` - passed, 5 files / 20 tests
  - `pnpm exec eslint src/server/runtime-cleanup.ts src/server/pi-rpc.ts src/server/pi-retained-state.ts src/server/pi-runtime.ts tests/server/runtime-cleanup.test.ts tests/server/pi-rpc.test.ts tests/server/pi-retained-state.test.ts --max-warnings=0` - passed
  - `pnpm effect:audit` - passed, 42 tracked/server files
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `pnpm exec vitest run tests/server/runtime-cleanup.test.ts tests/server/pi-rpc.test.ts tests/server/pi-retained-state.test.ts tests/server/runtime-retention.test.ts tests/server/provider-runtime.test.ts tests/server/kiri-control-cli.test.ts tests/server/kiri-mcp.test.ts` - passed, 7 files / 23 tests
  - `pnpm test -- --runInBand` - passed, 49 files / 202 tests including `tests/server/perf-gates.test.ts`
  - `git diff --check` - passed
- Review subagent summary: McClintock found queued prompts could survive delete because missing generation compared as current; Schrodinger found adapter replacement could also let stale queued prompts survive; Hubble found active prompt waiters could remain alive until timeout; Gauss found project delete cascaded sessions without runtime cleanup; Wegener found no remaining blockers after fixes.
- Findings fixed: generation tokens are now monotonic and missing generations are stale; reset/delete/replacement invalidate queued prompts; active Pi writes/events/diffs/status are generation-gated; `PiRpcProcessAdapter.stop()` rejects prompt completion waiters; project delete captures sessions, deletes only after DB validation succeeds, then cleans runtimes/terminals.
- Residual risk: full scoped Pi process lifecycle remains in the Pi runtime service phase; direct lint on all of `workspace.ts` still reports pre-existing server-function `require-await` noise, while the repo lint gate does not include that file.

### src/server/codex-retained-state.ts and src/server/codex-runtime.ts retained state

- Status: migrating; final status waits for Codex runtime use-cases, protocol projection, attachment handling, and adapter wiring to move behind scoped services.
- Target seam: Codex retained-state registry for adapter/listener ownership, thread-agent indexes, active turn lookup, per-agent queues, reset generations, and bounded diff-refresh guards.
- Behavior preserved: public Codex runtime functions, compatibility cleanup exports, adapter lookup/listener registration, active turn steering, reset generation checks, thread-status projection, and diff refresh guard behavior remain wired through `codex-runtime.ts`.
- Dependencies moved: module-global Codex retained maps moved into `codex-retained-state.ts`; `codex-runtime.ts` now delegates map mutation, stats, test retention, cleanup, and diff guard pruning through the registry.
- Baseline tests before migration: runtime retention tests covered Codex cleanup and 1,000-entry diff-turn guard bound.
- Tests added/updated: `tests/server/codex-retained-state.test.ts` covers adapter/listener dedupe, active-thread replacement pruning, all-agent cleanup, generation-preserving reset cleanup, oldest diff-turn eviction, and test clear semantics.
- Post-migration parity tests: focused Codex retained-state/runtime-retention/provider-runtime tests passed.
- Perf/memory impact: retained Codex runtime maps are now isolated and directly unit-tested; stale thread replacement prunes old turn guards and the diff-turn guard remains bounded.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec vitest run tests/server/codex-retained-state.test.ts tests/server/runtime-retention.test.ts tests/server/provider-runtime.test.ts` - passed, 3 files / 15 tests
  - `pnpm exec eslint src/server/codex-retained-state.ts src/server/codex-runtime.ts tests/server/codex-retained-state.test.ts tests/server/runtime-retention.test.ts --max-warnings=0` - passed
  - `pnpm effect:audit` - passed, 40 tracked/server files
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `pnpm test -- --runInBand` - passed, 47 files / 193 tests including `tests/server/perf-gates.test.ts`
  - `git diff --check` - passed
- Review subagent summary: Mill found blockers around queued turns surviving reset, stale thread cleanup deleting the current alias, and startTurn/startReview turn IDs not being retained before notifications. Kepler second pass found no remaining blockers after fixes.
- Findings fixed: focused lint caught a pre-existing async-without-await export and unsafe JSON parse assignment in the touched runtime file; fixed with `Promise.resolve(level)` and `unknown` JSON parsing annotation. Review blockers fixed by enqueue-time generation capture, ownership-checked stale thread cleanup, and immediate turn-id retention from startTurn/startReview responses.
- Residual risk: Codex adapter lifetime is still process-global and not scoped/finalized; runtime use-cases, protocol projection, and attachment writes still live in `codex-runtime.ts`.

### src/server/provider-runtime.ts

- Status: migrating; final status waits for Codex/Pi runtime services to replace imported singleton adapters.
- Target seam: runtime registry for command adapter lookup and runtime-specific retained-state cleanup.
- Behavior preserved: runtime command adapters keep the same capabilities; terminal-only Claude GUI prompts still reject with `Claude sessions run in terminal mode only`; `forgetProviderRuntimeAgent(runtime, agentId)` remains a synchronous compatibility export.
- Dependencies moved: cleanup dispatch for Pi/Codex retained state now goes through injectable `RuntimeRegistry.forget` instead of a direct switch in the public wrapper.
- Baseline tests before migration: provider runtime capability tests, runtime command tests, and runtime retention cleanup tests.
- Tests added/updated: provider runtime tests now cover injected cleanup handlers and typed `RuntimeRegistryError` wrapping when cleanup fails.
- Post-migration parity tests: focused provider-runtime/runtime-commands/runtime-retention tests passed.
- Perf/memory impact: no retained state added; cleanup behavior is now injectable and directly testable before runtime retained maps are split.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec vitest run tests/server/provider-runtime.test.ts tests/server/runtime-commands.test.ts tests/server/runtime-retention.test.ts` - passed, 3 files / 12 tests
  - `pnpm exec eslint src/server/provider-runtime.ts tests/server/provider-runtime.test.ts --max-warnings=0` - passed
  - `pnpm effect:audit` - passed, 39 tracked/server files
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `git diff --check` - passed
- Review subagent summary: Anscombe found no blockers; confirmed runtime adapter capabilities, synchronous compatibility cleanup, Pi/Codex retained-state cleanup semantics, effect-layer coverage, and wrapper cleanup smoke.
- Findings fixed: focused lint caught the terminal-only Claude rejection helper as async without await; changed it to return a rejected Promise with the same error message.
- Residual risk: registry adapters still import Codex/Pi singleton modules until runtime service extraction phases. Cleanup handlers are synchronous today; if they become async later, this boundary should move from `Effect.try` to `Effect.tryPromise`.

### src/server/terminal-registry.ts and src/server/terminal-server.ts

- Status: migrating; final status waits for websocket/PTY server startup to move behind a scoped terminal service.
- Target seam: terminal session registry for session keys, reusable session lookup, socket attach/detach, idle cleanup, replay buffer caps, broadcast, exit handling, runtime-session close, and close-all cleanup.
- Behavior preserved: `ensureTerminalServer`, terminal websocket handling, PTY spawn, shell/runtime keying, replay buffer cap, idle kill, close-on-exit, and `closeAgentRuntimeTerminal` behavior remain wired through compatibility server functions.
- Dependencies moved: mutable terminal session map and timer cleanup logic moved out of `terminal-server.ts` into `terminal-registry.ts` with injectable timers and socket open-state.
- Baseline tests before migration: terminal e2e coverage for switching tabs, shell persistence, terminal-interface runtime/shell split, plus terminal launch unit tests.
- Tests added/updated: `tests/server/terminal-registry.test.ts` covers shell/runtime keying, cwd reuse and stale-session kill, stale-exit replacement ownership, replay buffer cap, open-socket broadcast, idle kill cancellation on reattach, close-agent-runtime idle cleanup, late-exit ownership safety, and close-all cleanup.
- Post-migration parity tests: focused terminal-registry/terminal-launch tests passed.
- Perf/memory impact: retained terminal sessions remain bounded by explicit key map and idle timers; buffer cap is now directly unit-tested.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec vitest run tests/server/terminal-registry.test.ts tests/server/terminal-launch.test.ts` - passed, 2 files / 17 tests
  - `pnpm exec eslint src/server/terminal-registry.ts src/server/terminal-server.ts tests/server/terminal-registry.test.ts --max-warnings=0` - passed
  - `pnpm effect:audit` - passed, 39 tracked/server files
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `git diff --check` - passed
- Review subagent summary: Tesla found and verified one blocker: stale PTY exit could delete a live replacement with the same key. Second pass found no blockers after ownership checks and added coverage; terminal e2e persistence smoke passed in review.
- Findings fixed: typecheck caught that the registry proc contract needed `write` for websocket input; added it. Focused lint caught an unused internal test helper, so `closeTerminalServerForTests` is now an explicit export for future terminal tests. Review caught stale-exit replacement ownership; fixed by deleting only when `sessions.get(session.key) === session` and added replacement/reattach/close cleanup tests.
- Residual risk: server startup, websocket handshake, PTY spawn, stale Claude process cleanup, and actual browser terminal flows remain covered by e2e rather than fast unit tests until the terminal service phase.

### src/server/terminal-launch.ts

- Status: migrating; final status waits for `terminal-server.ts` to consume the service instead of compatibility sync exports.
- Target seam: typed injectable `TerminalLaunchService` over terminal command construction, env assembly, runtime binary lookup, MCP command resolution, and Claude resume detection.
- Behavior preserved: `buildTerminalProcessLaunch` remains a synchronous compatibility export; Claude, Codex, Pi, and shell launch arguments/env behavior are covered by existing tests.
- Dependencies moved: process env, home dir, filesystem existence, process cwd, exec path, resources path, and runtime binary resolution can now be injected.
- Baseline tests before migration: `tests/server/terminal-launch.test.ts` covered Claude/Codex/Pi/shell launch args, env metadata, Claude deterministic session ids, resume detection, and color env cleanup.
- Tests added/updated: terminal launch tests now cover injected service dependencies for Claude, Codex, Pi, and shell launches plus typed runtime-binary failure wrapping through `TerminalLaunchError`.
- Post-migration parity tests: focused terminal-launch/runtime-binaries tests passed.
- Perf/memory impact: no retained state added; launch construction remains on-demand and only performs existence checks for Claude/MCP resolution.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec vitest run tests/server/terminal-launch.test.ts tests/server/runtime-binaries.test.ts` - passed, 2 files / 17 tests
  - `pnpm exec eslint src/server/terminal-launch.ts tests/server/terminal-launch.test.ts --max-warnings=0` - passed
  - `pnpm effect:audit` - passed, 38 tracked/server files
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `git diff --check` - passed
- Review subagent summary: Boyle found no blockers; first pass noted only residual injected-service coverage shape, second pass confirmed direct Codex/Pi/shell service coverage resolves it.
- Findings fixed: added direct injected-service parity coverage for Codex, Pi, and shell launches after review feedback.
- Residual risk: `terminal-server.ts` still calls the compatibility export until the terminal registry/service phase.

### src/server/directory-picker.ts and src/server/workspace.ts directory picker

- Status: migrating; final status waits for `workspace.ts` to become transport-only over `WorkspaceService`.
- Target seam: typed injectable `DirectoryPickerService` over the `osascript` folder picker command.
- Behavior preserved: the server mutation still returns the trimmed selected path and still uses the same AppleScript prompt.
- Dependencies moved: direct `execFileSync('osascript', ...)` moved out of `workspace.ts` into an injectable process adapter.
- Baseline tests before migration: host-capability tests pin browser/desktop fallback behavior for project directory picking.
- Tests added/updated: `tests/server/directory-picker.test.ts` covers exact osascript invocation, trimmed return value, and typed failure wrapping.
- Post-migration parity tests: focused directory picker and host-capability tests passed.
- Perf/memory impact: no retained state added; process execution remains one bounded synchronous command per user request.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec vitest run tests/server/directory-picker.test.ts tests/lib/host-capabilities.test.ts` - passed, 2 files / 5 tests
  - `pnpm exec eslint src/server/directory-picker.ts tests/server/directory-picker.test.ts --max-warnings=0` - passed
  - `pnpm effect:audit` - passed, 38 tracked/server files
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `git diff --check` - passed
- Review subagent summary: Bacon found no findings; verified focused tests, typecheck, adapter lint, build, and confirmed direct `workspace.ts` lint only reports pre-existing `require-await` handlers.
- Findings fixed: none.
- Residual risk: `workspace.ts` still hosts many transport/use-case handlers until the workspace service phase.

### src/server/diff-refresh.ts

- Status: migrating; final status waits for workspace transport to consume shared workspace services instead of compatibility sync exports.
- Target seam: typed injectable `DiffRefreshService` orchestrating terminal-only validation, launch config lookup, `GitDiffService` capture, diff replacement, and workspace snapshot return.
- Behavior preserved: `refreshTerminalSessionDiffs(agentId)` remains a synchronous compatibility export, still rejects non-terminal sessions with the same message, replaces the agent diff artifacts, and returns the latest workspace snapshot.
- Dependencies moved: git diff capture is now injected through `GitDiffService`; detail/config/diff-write/snapshot operations can be injected in focused tests.
- Baseline tests before migration: workspace mutation path and git diff/runtime lifecycle focused tests.
- Tests added/updated: `tests/server/diff-refresh.test.ts` covers public sync export wiring through a real temp git repo harness, injected terminal refresh, non-terminal rejection before git work, and typed git failure wrapping with the requested agent id.
- Post-migration parity tests: focused diff-refresh/git-diff/runtime-lifecycle tests passed.
- Perf/memory impact: no retained state added; non-terminal sessions now prove they do not start git collection, and git collection remains bounded by `GitDiffService`.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec vitest run tests/server/diff-refresh.test.ts tests/server/git-diff.test.ts tests/server/runtime-lifecycle.test.ts` - passed, 3 files / 25 tests
  - `pnpm exec eslint src/server/diff-refresh.ts tests/server/diff-refresh.test.ts tests/harness/diff-refresh-public-harness.ts --max-warnings=0` - passed
  - `pnpm effect:audit` - passed, 37 tracked/server files
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `git diff --check` - passed
- Review subagent summary: Herschel found no blockers; first pass requested public sync export coverage, second pass confirmed it and suggested adding a child-process timeout to the harness test.
- Findings fixed: typecheck caught readonly diff-array mismatch with the compatibility DB writer; narrowed the service dependency to a mutable array to match the public writer contract. Added public export harness coverage from review feedback, then added a 10s child-process timeout from second-pass review feedback.
- Residual risk: DB reads/writes and workspace snapshot compatibility exports remain live dependencies until workspace and DB service phases complete.

### src/server/git-diff.ts

- Status: migrating; final status waits for runtime projection/diff refresh callers to consume the service instead of compatibility sync exports.
- Target seam: typed injectable `GitDiffService` with git command runner and clock injection.
- Behavior preserved: `collectGitDiffArtifacts` still returns an empty list outside git worktrees, captures tracked and untracked patches, skips runtime/build directories, preserves untracked total budget and per-command timeout, and keeps `diffArtifactsFromPatch` as a pure parser.
- Dependencies moved: `git` subprocess calls and clock reads can now be injected in tests.
- Baseline tests before migration: existing real-git worktree capture tests and runtime lifecycle diff projection tests.
- Tests added/updated: `tests/server/git-diff.test.ts` now covers service-layer collection, injected untracked budget timeout reduction, skipped diff paths from injected git output, service parser parity, and typed runner-failure wrapping.
- Post-migration parity tests: focused git-diff/runtime-lifecycle/runtime-binaries tests passed.
- Perf/memory impact: no retained state added; budget behavior is now directly testable and still bounds untracked diff work.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec vitest run tests/server/git-diff.test.ts tests/server/runtime-lifecycle.test.ts tests/server/runtime-binaries.test.ts` - passed, 3 files / 27 tests
  - `pnpm exec eslint src/server/git-diff.ts tests/server/git-diff.test.ts --max-warnings=0` - passed
  - `pnpm effect:audit` - passed, 37 tracked/server files
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `git diff --check` - passed
- Review subagent summary: Planck found no code blockers; first pass requested service parser parity and typed failure wrapping coverage, second pass found no blockers.
- Findings fixed: focused test initially only proved early untracked-budget stop; changed the fake clock to prove reduced remaining timeout on the second untracked diff. Added service parser parity and typed `GitDiffError` failure-path tests from review feedback.
- Residual risk: callers still use compatibility sync exports until runtime projection and diff-refresh service phases.

### src/server/runtime-binaries.ts

- Status: migrating; final status waits for terminal/process adapters to consume the service instead of the compatibility sync exports.
- Target seam: typed injectable `RuntimeBinariesService` for executable resolution and runtime process env construction.
- Behavior preserved: `resolveRuntimeExecutable` still prefers trimmed configured paths, then PATH hits, then desktop fallback paths, then bare command; `runtimeProcessEnv` still prepends desktop paths, de-duplicates PATH entries, merges extras, and preserves process env.
- Dependencies moved: process env, home directory, and executable existence checks can now be injected for tests.
- Baseline tests before migration: terminal launch tests around runtime binary env vars and commands.
- Tests added/updated: `tests/server/runtime-binaries.test.ts` covers explicit path precedence, PATH-before-desktop ordering, desktop fallback precedence, de-duplicated PATH ordering, service layer process env, and compatibility wrappers.
- Post-migration parity tests: focused runtime-binaries and terminal-launch tests passed.
- Perf/memory impact: no retained state added; service resolves from current providers on each call, matching prior global behavior.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec vitest run tests/server/runtime-binaries.test.ts tests/server/terminal-launch.test.ts` - passed, 2 files / 14 tests
  - `pnpm exec eslint src/server/runtime-binaries.ts tests/server/runtime-binaries.test.ts --max-warnings=0` - passed
  - `pnpm effect:audit` - passed, 37 tracked/server files
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `git diff --check` - passed
- Review subagent summary: Erdos found no code blockers; first pass requested stronger assertions for desktop fallback ordering and PATH de-duplication, second pass found no blockers.
- Findings fixed: tightened tests to pin desktop fallback precedence when multiple desktop candidates exist and exact de-duplicated PATH ordering.
- Residual risk: callers still use compatibility sync exports until terminal/runtime adapter service phases.

### src/server/preferences.ts

- Status: migrating; final status waits for workspace snapshot hydration and workspace mutations to depend on the service instead of compatibility sync exports.
- Target seam: typed injectable `UiPreferencesService` over `KiriConfigService` plus atomic file adapter.
- Behavior preserved: synchronous exports `getUiPreferences`, `setThemePreference`, `setKeymapPreference`, `setChatTypographyPreference`, and `setAgentByProjectPreference` keep their existing signatures, default behavior, validation behavior, and temp-file-then-rename persistence.
- Dependencies moved: direct preference file exists/read/write/mkdir/rename operations can now be supplied through `PreferencesFileSystem`; live layer still uses Node fs and process/date suffixes.
- Baseline tests before migration: existing preferences tests, workspace snapshot projection tests, and effect-layer harness.
- Tests added/updated: `tests/server/preferences.test.ts` now covers service defaults, atomic temp cleanup, persisted reads through the service, typed errors for invalid preference files, and `UiPreferencesService.layerFromConfig` wiring.
- Post-migration parity tests: focused preferences/workspace/effect-layer tests passed.
- Perf/memory impact: no retained state added; service remains on-demand and uses an in-memory file adapter only in tests.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec vitest run tests/server/preferences.test.ts tests/server/db-workspace-snapshot.test.ts tests/server/effect-layers.test.ts` - passed, 3 files / 9 tests
  - `pnpm exec eslint src/server/preferences.ts tests/server/preferences.test.ts --max-warnings=0` - passed
  - `pnpm effect:audit` - passed, 37 tracked/server files
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `git diff --check` - passed
- Review subagent summary: Euler found no code blockers; first pass noted missing layer wiring coverage, second pass only found stale tracker test count, corrected here.
- Findings fixed: focused tests caught an invalid theme fixture; changed it to an allowed theme. Typecheck lint messages caught test-side JSON helpers; replaced them with service reads and raw invalid fixture text. Added layer wiring coverage and changed chained layer provides to a single composed provide after Effect lint flagged lifecycle risk.
- Residual risk: workspace still calls compatibility sync exports until the workspace service phase.

### src/server/kiri-config.ts and src/server/settings.ts

- Status: migrating; final status waits for DB, workspace, and control callers to depend on the services instead of the compatibility sync exports.
- Target seam: typed injectable `KiriConfigService` and `KiriSettingsService` layers with constructor helpers for tests.
- Behavior preserved: synchronous exports `getKiriConfig`, `resolveKiriConfig`, `getSettings`, `getRuntimeSettings`, and `assertConfiguredModel` keep their existing call signatures and throw behavior for compatibility callers.
- Dependencies moved: config resolution and settings file reads can now be injected through Effect service constructors; settings service depends on config service through `layerFromConfig`.
- Baseline tests before migration: `kiri-config`, `effect-layers`, CLI/MCP tests that set `KIRI_SETTINGS_PATH`, and DB callers that validate configured models.
- Tests added/updated: `tests/server/kiri-config.test.ts` now covers typed config service failures; `tests/server/settings-service.test.ts` covers injected settings reads, runtime lookups, default-model validation, and model assertions.
- Post-migration parity tests: focused config/settings/effect-layer tests passed before and after review fixes.
- Perf/memory impact: no retained state added; services perform the same on-demand config/settings reads as before, with injection points for later caching or test fixtures.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec vitest run tests/server/kiri-config.test.ts tests/server/settings-service.test.ts tests/server/effect-layers.test.ts` - passed, 3 files / 11 tests
  - `pnpm exec eslint src/server/kiri-config.ts src/server/settings.ts tests/server/kiri-config.test.ts tests/server/settings-service.test.ts --max-warnings=0` - passed
  - `pnpm effect:audit` - passed, 37 tracked/server files
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `git diff --check` - passed
- Review subagent summary: Confucius found one compatibility blocker; second pass found no blockers.
- Findings fixed: restored the previous sync-export invalid default-model error text (`settings.json <runtime>.defaultModel...`) and pinned it in `tests/server/settings-service.test.ts` while keeping typed service `path` metadata.
- Residual risk: compatibility callers still read process env and settings files directly until DB/workspace/control move to injected services.

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

### src/server/db/bootstrap.ts

- Status: extracted; final migration status remains `migrating|required` until DB startup bootstraps sit behind the DB/settings service boundary.
- Target seam: startup data repair for stale seeded Pi models and legacy empty project cleanup.
- Behavior preserved: stale Pi session models are rewritten to the configured default Pi model while non-Pi agents are untouched; the empty legacy `kiri Orchestrator` project is removed only when it is the sole project and has no agent slots.
- Dependencies moved: seeded-model normalization SQL and legacy seed project cleanup SQL moved out of `src/server/db.ts`.
- Baseline tests before migration: DB connection/migration tests and full facade startup through existing harnesses.
- Tests added/updated: `tests/server/db-bootstrap.test.ts` covers stale model normalization and empty legacy project cleanup.
- Post-migration parity tests: focused bootstrap test passed; broader DB/effect gates run before commit.
- Perf/memory impact: none expected; startup SQL moved without changing query shape.
- Verification commands and results:
  - `pnpm exec vitest run tests/server/db-bootstrap.test.ts` - passed, 2 tests
  - `pnpm typecheck` - passed
- Review subagent summary: Noether reported no blockers and no edits; verified diff check, focused bootstrap test, typecheck, and effect audit.
- Findings fixed: none yet.
- Residual risk: bootstrap still receives raw settings values from the compatibility facade; service phase should inject settings through `KiriSettingsService`.

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

### src/server/db/workspace-snapshot.ts

- Status: extracted; final migration status remains `migrating|required` until projections sit behind the DB/workspace service boundary.
- Target seam: workspace snapshot projection over an injected DB connection with settings, UI preferences, and scratchpad blocks passed in by the compatibility facade.
- Behavior preserved: visible/hidden project split, active agent grouping, archived session summaries, context usage math, pending question projection, selected project/agent defaults, diff counts, and empty detail arrays remain unchanged.
- Dependencies moved: project/agent/context SQL, archived-session assembly, context usage mapping, pending-question reads, snapshot parsing, and local grouping helper moved out of `src/server/db.ts`.
- Baseline tests before migration: perf snapshot gate, CLI/MCP/workspace flows, project/session/runtime-state repository tests.
- Tests added/updated: `tests/server/db-workspace-snapshot.test.ts` covers visible and hidden projects, archived sessions, context usage, pending question, diff count, selected ids, and scratchpad passthrough.
- Post-migration parity tests: focused snapshot projection test passed; broader facade/runtime tests run before commit.
- Perf/memory impact: no query-shape or payload change; extraction only.
- Verification commands and results:
  - `pnpm exec vitest run tests/server/db-workspace-snapshot.test.ts` - passed, 1 test
- Review subagent summary: Hypatia reported no blockers and no edits; verified focused snapshot test, runtime-state plus snapshot test, effect audit, typecheck, and diff check.
- Findings fixed: none yet.
- Residual risk: final workspace-service extraction still needs to move snapshot assembly behind a higher-level Effect service and remove direct settings/preferences calls from the facade.

### src/server/db/session-operations.ts

- Status: extracted; final migration status remains `migrating|required` until session operations sit behind DB, config, and filesystem service boundaries.
- Target seam: reset, forked Pi session creation, persisted Pi session hydration, safe Pi JSONL projection, and session-file discovery/copy operations.
- Behavior preserved: reset still clears messages, events, tasks, diffs, context usage, status, session file, and thread preview; fork still validates Pi-only sources, copies cloned JSONL into the runtime session directory, hydrates messages/context, and titles the fork; persisted Pi hydration still skips deleted slots and creates missing session agents from JSONL projections.
- Dependencies moved: reset cleanup SQL, fork session SQL/file copy, persisted-session discovery, deleted-slot filtering, JSONL projection safety wrapper, and persisted agent creation moved out of `src/server/db.ts`.
- Baseline tests before migration: task progress reset harness, runtime lifecycle tests, Pi JSONL projection tests, session repository tests.
- Tests added/updated: `tests/server/db-session-operations.test.ts` covers reset cleanup, fork-copy projection hydration, and persisted Pi hydration with deleted-slot skipping.
- Post-migration parity tests: focused session operation test passed; broader runtime/session tests run before commit.
- Perf/memory impact: no query-shape change; extraction only.
- Verification commands and results:
  - `pnpm exec vitest run tests/server/db-session-operations.test.ts` - passed, 3 tests
- Review subagent summary: Hegel reported no blockers and no edits; verified diff check, typecheck, focused session-operation tests, DB repository test pack, reset harness, lint, effect audit, and build.
- Findings fixed: none yet.
- Residual risk: this module still performs direct filesystem IO; final service phase should inject a filesystem/session-file service before marking migrated.

### src/server/runtime.ts

- Status: migrating; final status waits for workspace/control callers to depend on the service surface directly instead of only the compatibility async exports.
- Target seam: `RuntimeCommands` Effect service over `RuntimeRegistry` and launch-config lookup.
- Behavior preserved: public async exports `promptAgent`, `steerAgent`, `interruptAgent`, thinking-level, reset, fork, review, and answer-question keep the same call signatures and still reject unsupported runtime capabilities with the existing user-facing messages.
- Dependencies moved: direct `runtimeAdapters` indexing moved behind `RuntimeRegistry`; adapter promise rejections are now wrapped in typed `RuntimeCommandError`.
- Baseline tests before migration: provider runtime registry tests, runtime lifecycle tests, workspace mutation coverage.
- Tests added/updated: `tests/server/runtime-commands.test.ts` covers injected registry dispatch, unsupported capability errors, adapter rejection wrapping, and public async export rejection shape through `tests/harness/runtime-command-public-harness.ts`.
- Post-migration parity tests: focused runtime command tests passed; broader runtime tests passed before commit.
- Perf/memory impact: no retained state added; runtime dispatch now uses a memoized layer constant.
- Verification commands and results:
  - `pnpm typecheck` - passed
  - `pnpm exec eslint src/server/runtime.ts tests/server/runtime-commands.test.ts tests/harness/runtime-command-public-harness.ts --max-warnings=0` - passed
  - `pnpm exec vitest run tests/server/runtime-commands.test.ts tests/server/provider-runtime.test.ts tests/server/runtime-lifecycle.test.ts tests/server/runtime-retention.test.ts` - passed, 4 files / 24 tests
  - `pnpm effect:audit` - passed, 37 tracked/server files
  - `pnpm lint` - passed
  - `pnpm build` - passed with existing Vite chunk-size warning
  - `git diff --check` - passed
- Review subagent summary: Laplace found no code blockers after fixes; only stale tracker test count, corrected here.
- Findings fixed: typecheck caught an untyped `Effect.tryPromise` catch; replaced it with `RuntimeCommandError`. Review caught public async exports throwing Effect FiberFailure instead of normal typed errors; `runRuntimeCommand` now unwraps `Effect.either`. Focused eslint caught an unnecessary assertion in capability lookup; removed it. Re-review caught stale tracker count; corrected it.
- Residual risk: `RuntimeCommands.layer` still calls the legacy `getAgentLaunchConfig` compatibility export; a later workspace/control service phase should inject a DB/session service for launch config lookup.

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
