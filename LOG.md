# Kiri Perf And Memory Log

## Goal

Improve Kiri performance, memory use, and leak resistance without removing features or regressing existing behavior.

## Constraints

- Preserve public behavior unless a contract is explicitly narrowed by tests.
- Keep UI, CLI, and MCP semantics aligned.
- Add harnesses before architecture changes where possible.
- Prefer bounded retained state over unbounded process maps.
- Verify with typecheck, lint, tests, perf harnesses, and memory assertions.

## Budget Decisions

- Agent detail page size: `limit` means latest timeline rows returned by `getAgentDetail`; default remains 500 and API max remains 500.
- Diff payload page size: cap detail diffs to the newest 50 artifacts for now; patch truncation is a later render-layer budget.
- Runtime map retention: retain active runtime state only, with reset/delete cleanup clearing agent-specific queues, threads, turns, and diff-refresh guards.
- Polling: keep current UX but add no-overlap and bounded polling before tuning intervals.

## Progress

- [x] Detail paging contract and regression harness.
- [x] Scratchpad trigger semantics shared by UI, CLI, and MCP.
- [x] Effect service layers around DB/settings/runtime registry.
- [x] Bounded runtime retained state with reset/delete cleanup tests.
- [x] Render/perf gates for timeline, diffs, snapshot hydration, runtime projection.
- [x] Knip config moved to `knip.jsonc` after current findings are triaged.
- [x] Detailed interactive HTML explainer.

## Notes

- 2026-05-15: Branch `kyendamuri/perf-improvements` created from `main`.
- 2026-05-15: Kiri session renamed to `Kiri perf and memory`.
- 2026-05-15: Committed existing perf/memory work in logical blocks before starting the Effect migration audit.
- 2026-05-15: Kiri session renamed from perf/memory implementation to `Audit Effect migration`.
- 2026-05-15: Started Effect migration/directory-structure audit and recorded findings in `docs/effect-migration-audit.md`.
- 2026-05-15: `getAgentDetail(limit)` now pages latest timeline rows instead of loading all messages/events; harness updated to prove 500 returned rows from 2,480 stored rows.
- 2026-05-15: Scratchpad triggers now go through `triggerScratchpadSession` for UI/MCP/CLI, with terminal sessions avoiding prompt enqueue and failed GUI prompt enqueue archiving the created session.
- 2026-05-15: Added Effect layers for `KiriDbService`, `KiriSettingsService`, and `RuntimeRegistry`; `tests/harness/effect-layers.ts` proves isolated wiring.
- 2026-05-15: Runtime retained state is now explicitly cleaned on session delete/reset; Codex per-turn diff guards are capped at 1,000 entries and covered by retention tests.
- 2026-05-15: Added `tests/perf/run-perf.ts` and a perf gate test. The harness seeds 6,000 timeline rows plus 80 diffs, then enforces 500 returned timeline rows, 50 returned diffs, bounded payload bytes, latency, and RSS delta.
- 2026-05-15: Workspace polling now has explicit initial/interval/max-duration budgets; chat timeline mounting is capped at the latest 500 derived rows.
- 2026-05-15: Moved Knip config to `knip.jsonc` and made `shiki` an explicit dependency for `src/lib/code-highlighter.ts`.
- 2026-05-15: Perf run result: 6,000 stored timeline rows -> 500 returned rows; 80 stored diffs -> 50 returned diffs; detail payload 1,079,099 bytes; snapshot 2.72ms; detail 90.53ms standalone / 252.13ms under parallel test load; RSS delta 44.34MB under 64MB budget.
- 2026-05-15: Added detailed interactive HTML explainer at `docs/kiri-perf-memory-explainer.html`.
- 2026-05-15: Extracted DB migrations into `src/server/db/migrations.ts` and added a legacy pi-only schema fixture to prove runtime constraint widening and foreign-key repair.
- 2026-05-15: Started DB connection/transaction split with `src/server/db/connection.ts` owning SQLite open/configure/migrate and `src/server/db/transaction.ts` owning transaction bracketing.
- 2026-05-15: Started project repository extraction with `src/server/db/projects.ts` owning project summaries, create/delete, hide/unhide, and visible reorder persistence.
- 2026-05-15: Started scratchpad repository extraction with `src/server/db/scratchpad.ts` owning block list/add/delete/get/trigger persistence.
- 2026-05-15: Started session repository extraction with `src/server/db/sessions.ts` owning session list/start/archive/restore/rename persistence.
- 2026-05-15: Started runtime-state repository extraction with `src/server/db/runtime-state.ts` owning launch config, runtime JSON, status, context usage, pending question, and thinking-level reads.
- 2026-05-15: Started paged agent-detail extraction with `src/server/db/agent-detail.ts` and shared pure timeline formatting in `src/server/db/timeline-format.ts`.
- 2026-05-15: Started timeline write repository extraction with `src/server/db/timeline-writes.ts` owning message/event/task/diff writes and thread summary updates.
- 2026-05-15: Completed timeline write repository extraction. Added direct DB persistence tests for Pi live turns, JSONL projection/task/context writes, and diff replacement. Review passed; typecheck, lint, effect audit, build, focused tests, and standalone perf gate passed.
- 2026-05-15: Started workspace snapshot projection extraction with `src/server/db/workspace-snapshot.ts` owning visible/hidden projects, archived sessions, context usage, pending questions, selected ids, and scratchpad passthrough.
- 2026-05-15: Completed workspace snapshot projection extraction. Added direct snapshot projection coverage; review passed; typecheck, lint, effect audit, diff check, focused projection/runtime tests, and perf gate passed.
- 2026-05-15: Started session operations extraction with `src/server/db/session-operations.ts` owning reset cleanup, forked Pi session copy/hydration, persisted Pi session discovery, deleted-slot filtering, and safe JSONL projection.
- 2026-05-15: Completed session operations extraction. Added direct reset/fork/hydration tests; review passed; typecheck, lint, effect audit, build, reset harness, and focused DB/runtime tests passed.
- 2026-05-15: Started DB bootstrap extraction with `src/server/db/bootstrap.ts` owning stale seeded Pi model normalization and legacy empty project cleanup.
- 2026-05-15: Completed DB bootstrap extraction. Added direct startup repair tests; review passed; typecheck, lint, effect audit, diff check, and focused DB/effect-layer tests passed.
- 2026-05-15: Started runtime command service migration with `RuntimeCommands` dispatching through `RuntimeRegistry` instead of direct adapter singleton indexing.
- 2026-05-15: Completed runtime command service migration. Added typed `RuntimeCommandError`, injected command-service tests, public async rejection harness, and runtime parity tests; review passed after fixing FiberFailure unwrapping and capability typing; typecheck, focused eslint, lint, effect audit, build, diff check, and runtime tests passed.
- 2026-05-15: Started config/settings service hardening. Added typed injectable `KiriConfigService` and `KiriSettingsService` constructors while preserving synchronous compatibility exports.
- 2026-05-15: Completed config/settings service hardening. Review caught and fixed a settings error-message compatibility regression; typed service tests now pin injected config/file reads, validation, and model assertions; typecheck, focused eslint, focused tests, lint, effect audit, build, and diff check passed.
- 2026-05-15: Started UI preferences service hardening. Added typed injectable `UiPreferencesService` over `KiriConfigService` and an atomic file adapter seam while preserving sync preference exports.
- 2026-05-15: Completed UI preferences service hardening. Review passed after adding layer wiring coverage and correcting tracker exactness; focused tests now cover default reads, atomic writes, typed errors, and service-layer provisioning.
- 2026-05-15: Started runtime binary resolver hardening. Added typed injectable `RuntimeBinariesService` for executable resolution and runtime PATH construction while preserving sync wrappers.
- 2026-05-15: Completed runtime binary resolver hardening. Review passed after tightening desktop fallback precedence and PATH de-duplication tests; focused runtime binary and terminal launch checks passed.
- 2026-05-15: Started git diff service hardening. Added typed injectable `GitDiffService` with git runner and clock injection while preserving sync diff collector/parser exports.
- 2026-05-15: Completed git diff service hardening. Review passed after adding service parser parity and typed runner-failure coverage; focused git-diff/runtime lifecycle/runtime binary checks passed.
- 2026-05-15: Started terminal diff refresh service hardening. Added typed injectable `DiffRefreshService` around terminal-only validation, git diff capture, diff replacement, and workspace snapshot return while preserving the sync export.
- 2026-05-15: Completed terminal diff refresh service hardening. Review passed after adding live public-export harness coverage and a child-process timeout; focused diff-refresh/git-diff/runtime lifecycle checks passed.
- 2026-05-15: Started project directory picker hardening. Extracted direct `osascript` process IO from `workspace.ts` into typed injectable `DirectoryPickerService`.
- 2026-05-15: Completed project directory picker hardening. Review found no issues; focused directory-picker and host-capability tests passed.
- 2026-05-15: Started terminal launch resolver hardening. Added typed injectable `TerminalLaunchService` for terminal command construction with env/filesystem/process/runtime-binary injection while preserving `buildTerminalProcessLaunch`.
- 2026-05-15: Completed terminal launch resolver hardening. Review passed after adding direct injected-service coverage for Claude/Codex/Pi/shell launch parity; focused terminal launch/runtime binary checks passed.
- 2026-05-15: Started terminal registry extraction. Moved retained terminal session map mechanics, replay buffer cap, idle cleanup, broadcast, exit, and close-all behavior into `terminal-registry.ts` with focused cleanup tests.
- 2026-05-15: Completed terminal registry extraction. Review caught and fixed stale PTY exit deleting replacement sessions; focused registry/launch checks and terminal persistence e2e smoke passed.
- 2026-05-15: Started runtime registry cleanup hardening. Added typed `RuntimeRegistry.forget` so retained-state cleanup dispatch is injectable while preserving `forgetProviderRuntimeAgent`.
- 2026-05-15: Completed runtime registry cleanup hardening. Review found no blockers; focused provider-runtime/runtime-command/runtime-retention checks passed.
- 2026-05-15: Started Codex retained-state extraction. Moved Codex adapter/listener/thread/turn/queue/generation/diff-turn maps behind `codex-retained-state.ts` while preserving runtime compatibility exports.
- 2026-05-15: Completed Codex retained-state extraction. Review caught and fixed queued-turn reset invalidation, stale-thread alias ownership, and immediate turn-id retention; focused Codex retained-state/runtime retention checks passed.
- 2026-05-15: Started Pi retained-state extraction. Moved Pi adapter/key/queue/generation maps behind `pi-retained-state.ts` and added generation-aware queued prompt invalidation on reset.
- 2026-05-15: Continued Pi retained-state hardening from review. Fixed stale queued prompts after delete/replacement, gated active Pi writes after reset, cancelled Pi prompt completion waiters on stop, and routed project delete through runtime cleanup.
- 2026-05-15: Completed Pi retained-state/RPC cleanup phase. Final review found no blockers; typecheck, lint, effect audit, build, focused CLI/MCP/runtime tests, full test suite, and perf gate passed.
- 2026-05-15: Started runtime projection split. Moved DB-backed live runtime projection out of `runtime-lifecycle.ts` into `runtime-projection.ts` while preserving the `RuntimeProjector` export and lifecycle API.
- 2026-05-15: Completed runtime projection split. Review caught and fixed event type drift and non-Error boundary drift; focused runtime lifecycle checks passed.
- 2026-05-15: Started workspace/control delete-session cleanup unification. Moved duplicated retained-runtime and terminal cleanup sequencing into `runtime-cleanup.ts`.
- 2026-05-15: Completed workspace/control delete-session cleanup unification. Review found no blockers; follow-up tests pin active-only workspace lookup, include-archived Kiri-control lookup, workspace helper result parity, and cleanup-failure behavior.
- 2026-05-15: Started workspace service extraction. Added `WorkspaceService` as the UI-facing use-case seam and reduced `workspace.ts` to schema/transport delegation through the service.
- 2026-05-15: Completed workspace service extraction. Review found no blockers; focused service tests, CLI/MCP parity, scratchpad trigger, diff refresh, typecheck, lint, and effect audit passed before full verification.
- 2026-05-15: Started KiriControl dependency injection. `makeKiriControl` now accepts explicit dependencies while the live layer preserves existing DB/settings/runtime-cleanup/scratchpad wiring.
- 2026-05-15: Completed KiriControl dependency injection. Review found no blockers; added sync/async error-shape tests, CLI model smoke passed, and focused CLI/MCP/service checks passed.
- 2026-05-15: Started scratchpad trigger service extraction. Added `ScratchpadTriggerService` with injected DB/session/runtime prompt/reporting dependencies while preserving `triggerScratchpadSession(input, prompt?)`.
- 2026-05-15: Completed scratchpad trigger service extraction. Review found no blockers; focused service tests, compatibility harness, workspace/KiriControl service tests, CLI/MCP parity, typecheck, eslint, and effect audit passed.
- 2026-05-15: Started Pi JSONL file boundary split. Moved session-file reads into `pi-jsonl-file.ts` while keeping `pi-jsonl.ts` as pure projection logic.
- 2026-05-15: Pi JSONL review pass completed with no blockers. Added injected projection-failure coverage, fixed the migration audit parser so note text containing `File` no longer hides tracker rows, and verified focused parser/file/session/task tests plus full typecheck/lint/audit/build/test/diff gates.
- 2026-05-15: Started backend readiness boundary split. Added `BackendReadinessService` over injected settings/DB probes and kept `backend-server.ts` as the HTTP transport wrapper.
- 2026-05-15: Completed backend readiness boundary split. Review caught async probe false-ready behavior; fixed with `Effect.tryPromise`, added async rejection/openDb failure coverage, and verified full typecheck/lint/audit/build/test/diff gates.
- 2026-05-15: Started Kiri MCP runtime split. Moved Effect execution, context refresh, and selected-session fallback helpers into `KiriMcpRuntimeService` while preserving MCP tool registration and CLI parity behavior.
- 2026-05-15: Kiri MCP runtime review found no blockers. Added MCP-level coverage for default selected-session rename, selected-project scratchpad fallback, and mutation context refresh.
- 2026-05-15: Completed Kiri MCP runtime split. Follow-up review approved the fallback/context assertions; full typecheck/lint/audit/build/test/diff gates passed.

## Remaining Knip Findings

- Unused dependency candidates retained for now instead of removing features blindly: `@tanstack/react-query-devtools`, `@tanstack/react-router-devtools`, `fast-check`, `pure-rand`, `redaxios`, `tailwind-merge`.
- Unused exported API candidates retained as public/internal contract surface until a separate API-pruning pass: storage helpers, contract symbols, UI preference constants, `createKiriMcpServer`, and `makeRuntimeRegistry`.

# Kiri Effect Migration Goal

## Objective

Move Kiri toward a complete Effect-backed server architecture without removing features, changing user-visible behavior, or weakening the current perf/memory guarantees.

Every file in migration scope should end in one of two clear states. Migration scope means every `src/server/**` file, every file touched by the migration, and frontend/script files when their migration phase starts.

- Migrated behind an Effect service/layer because it owns IO, state, runtime lifecycle, transport orchestration, config, persistence, or app use-cases.
- Explicitly classified as not needing Effect because it is pure logic, UI rendering, test fixture code, build/install script code, or a thin transport boundary that delegates into an Effect service.

## Success Criteria

- [ ] Every file in migration scope is tracked: every `src/server/**` file immediately, every touched file as soon as it is touched, and frontend/script files when their phase starts.
- [ ] Files that should be migrated have an owner module, target seam, test plan, and migration status.
- [ ] Files that should not be migrated have a short reason, so future audits do not re-litigate them.
- [ ] Every migrated file has a before/after note covering behavior preserved, dependencies moved, tests added, exact verification commands with pass/fail results, perf/memory impact, and residual risk.
- [ ] A review subagent is run after each migrated file or tightly-coupled file group, and findings are fixed or explicitly logged before continuing.
- [ ] No phase is considered complete until review-subagent findings, focused tests, and relevant smoke/perf checks are all resolved.
- [ ] Known baseline behavior is pinned by an existing or new focused test before refactoring when coverage is not already explicit.
- [ ] `db.ts` is split into connection, migrations, repositories, and projections while preserving compatibility exports during the migration.
- [ ] `workspace.ts` server functions are reduced to transport handlers over a shared `WorkspaceService`.
- [ ] `kiri-control.ts`, MCP, CLI, and workspace flows share the same use-case services instead of duplicating sequencing.
- [ ] Runtime orchestration is behind scoped/runtime-specific Effect services for Codex, Pi, and terminal sessions.
- [ ] Runtime retained maps are owned by injectable registries with cleanup tests; no unbounded retained state remains.
- [ ] Settings, preferences, runtime binary resolution, git diff capture, osascript directory selection, and filesystem/process IO are behind service seams.
- [ ] Oversized modules are split only after tests pin behavior, with `db.ts`, `codex-runtime.ts`, `pi-runtime.ts`, `workspace.ts`, `KiriBoard.tsx`, `chat-panel.tsx`, and `dialogs.tsx` treated as the main locality risks.
- [ ] Existing perf budgets remain enforced for snapshot hydration, agent detail hydration, payload size, returned timeline rows, returned diffs, and RSS delta.
- [ ] New migration harnesses prove old/new parity before each implementation flip.
- [ ] UI, CLI, MCP, terminal, scratchpad, runtime, and project/session flows keep passing focused smoke coverage.
- [ ] Final state is documented in a detailed interactive HTML explainer.

## Migration Phases

### Phase 1: Tracker And Guardrails

- [x] Add `docs/effect-migration-tracker.md`.
- [x] Classify every `src/server/**` file and every additional touched file as `pure`, `transport`, `use-case`, `repository`, `projection`, `runtime-adapter`, `process-adapter`, `config`, `ui`, `script`, or `legacy-compat`.
- [x] Add an audit command that detects migrated files importing forbidden direct globals: raw SQLite connection, raw filesystem, raw child process, module-global runtime maps, or direct transport calls.
- [ ] Add a test app layer harness that boots against temp DB/state/settings roots.
- [x] Add a per-file migration checklist template covering behavior, tests, perf/memory, imports, old compatibility exports, and review-subagent status.
- [x] Define the review-subagent gate: after each migrated file or inseparable file group, run a reviewer against the exact diff and block the next file until issues are resolved or logged with rationale and the tracker links the review result.

### Phase 2: DB Layer

- [ ] Keep current `src/server/db.ts` exports stable while extracting implementation.
- [ ] Create DB connection and transaction layer.
- [x] Move migrations into a dedicated module.
- [x] Move row schemas/parsers into a dedicated schema module.
- [x] Add legacy schema migration parity tests for runtime-check widening and renamed foreign-key repair.
- [ ] Extract project/session/scratchpad/runtime-state/thread repositories.
- [ ] Extract workspace snapshot and agent detail projections.
- [ ] Add repository parity tests using seeded DB fixtures.
- [ ] Verify detail paging and perf gates remain unchanged.
- [ ] Run review subagents after each extracted DB module: connection, transaction, migrations, schema, each repository, each projection, and final compatibility facade.

### Phase 3: Config And File IO

- [ ] Move `kiri-config.ts` into an Effect config layer.
- [ ] Move `settings.ts` JSON reads into `KiriSettingsService` with typed config errors.
- [ ] Move `preferences.ts` into `PreferenceStore` with atomic write tests and an in-memory test adapter.
- [ ] Move runtime binary lookup into a resolver service.
- [ ] Move osascript directory selection behind an integration service.
- [ ] Keep desktop/script entrypoints thin until the app layer is stable.
- [ ] Run review subagents after each config/IO service and verify test adapters cannot touch user state.

### Phase 4: Runtime Services

- [ ] Split `codex-runtime.ts` into retained state, runtime use-cases, protocol projection, attachment handling, and adapter wiring.
- [ ] Split `pi-runtime.ts` into retained state, runtime use-cases, attachment handling, and adapter wiring.
- [ ] Convert Codex/Pi retained maps into injected registries.
- [ ] Convert runtime cleanup into scoped finalizers where lifecycle owns resources.
- [ ] Keep fake Codex app-server and Pi RPC harnesses green.
- [ ] Expand leak tests for reset/delete/close/stale-turn paths.
- [ ] Run review subagents after each runtime module, with special focus on leaks, stale writes, queue ordering, resource cleanup, and no lost runtime events.

### Phase 5: Terminal Services

- [ ] Move `terminal-server.ts` singleton state into a scoped `TerminalRegistry`.
- [ ] Move `terminal-launch.ts` command construction into a launch resolver.
- [ ] Add tests for per-agent cleanup, idle cleanup, backend close, and tab-switch preservation.
- [ ] Keep terminal Playwright smoke passing.
- [ ] Run review subagents after terminal registry and launch resolver changes, with focus on PTY/session cleanup and preserving terminal UX.

### Phase 6: Workspace And Control Services

- [ ] Introduce `WorkspaceService` for UI-facing use-cases.
- [ ] Move server functions in `workspace.ts` to transport-only handlers.
- [ ] Make `KiriControl` depend on shared services rather than direct DB/runtime functions.
- [ ] Preserve CLI/MCP JSON output contracts.
- [ ] Keep scratchpad trigger semantics unified for UI, CLI, and MCP.
- [ ] Run review subagents after workspace/control transport changes, with focus on UI/CLI/MCP parity and cleanup sequencing.

### Phase 7: Frontend Locality

- [ ] Split `KiriBoard.tsx` by query/selection/action/layout responsibilities.
- [ ] Split `chat-panel.tsx` by timeline, composer, detail state, diffs, and draft handling.
- [ ] Split `dialogs.tsx` by dialog workflow.
- [ ] Keep render budgets and timeline mount caps in place.
- [ ] Add focused component tests only where split logic creates new seams.
- [ ] Run review subagents after each frontend split, with focus on keyboard behavior, polling, rendering cost, mobile layout, and no lost local draft state.

### Phase 8: Final Verification And Explainer

- [ ] Run typecheck, lint, unit tests, perf gates, migration audit, and focused Playwright smokes.
- [ ] Run Knip and explicitly triage remaining findings.
- [ ] Update `docs/effect-migration-audit.md` with final decisions and actual migrated shape.
- [ ] Create a detailed interactive HTML explainer showing final layers, file ownership, flows, harnesses, and remaining risks.
- [ ] Commit the migration in logical blocks by phase.
- [ ] Run final review subagents over the full branch diff before declaring the goal complete.

## Required Verification Per Phase

- `pnpm typecheck`
- `pnpm test -- --runInBand`
- Relevant focused tests for the touched module family.
- Relevant Playwright smoke when UI/transport behavior is touched.
- Perf harness when snapshot/detail/runtime retention behavior is touched.
- Migration audit command once added.
- Review subagent pass for every migrated file or inseparable file group.

## Per-File Migration Checklist

For each file or tightly-coupled file group:

- [ ] Record current behavior and callers before editing.
- [ ] Identify whether the target state is Effect service, pure module, transport adapter, or explicit non-migration.
- [ ] Add or identify the focused test that protects the behavior before moving logic.
- [ ] Preserve compatibility exports until every caller has moved.
- [ ] Move one responsibility at a time.
- [ ] Run typecheck and focused tests.
- [ ] Run perf/leak/smoke checks when the file touches DB hydration, runtime retention, terminal sessions, polling, or rendering.
- [ ] Run a review subagent against the exact diff.
- [ ] Fix review findings or log why they are not blockers.
- [ ] Link or summarize the review result in the migration tracker before starting the next file.
- [ ] Update `LOG.md` with status, exact verification commands, pass/fail results, and residual risk.
- [ ] Commit in a logical block before starting the next unrelated file group.

## Guardrails

- Do not change public behavior as part of a migration unless a test and note explicitly pin the new contract.
- Do not remove features to simplify Effect migration.
- Do not split files into shallow pass-through modules; split around real domain seams.
- Keep compatibility exports until all callers have moved and parity is proven.
- Prefer one migrated module family per commit.
- Keep LOG.md updated after each meaningful block.
- Treat review subagent findings as blockers unless there is a written rationale in `LOG.md`.
