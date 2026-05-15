# Kiri Effect Migration Audit

Date: 2026-05-15
Branch: `kyendamuri/perf-improvements`
Reference checked: `/private/tmp/AnswerOverflow`
Effect guidance checked: `effect-solutions show services-and-layers error-handling testing cli config`
Effect package checked: `node_modules/effect` at `effect@3.21.2`

## Executive Read

Kiri is not missing Effect entirely. The strongest Effect code is already around the CLI/control surface, runtime lifecycle projection, Codex app-server protocol handling, Pi RPC, and a few thin service layers.

The gap is that most of those Effect modules still sit on top of direct globals, direct SQLite access, direct filesystem reads, and direct runtime maps. That means Effect is currently useful as an orchestration wrapper, but it is not yet the app architecture.

The migration should not start with a broad rewrite. Start by turning the existing behavioral seams into deeper modules with test layers:

1. `db.ts` repository split and `KiriDb` transaction/repository layer.
2. `workspace.ts` server functions reduced to transport handlers over a `WorkspaceService`.
3. `codex-runtime.ts`, `pi-runtime.ts`, and `terminal-server.ts` moved behind scoped runtime registry modules.
4. `settings.ts`, `preferences.ts`, `git-diff.ts`, `terminal-launch.ts`, and binary resolution moved behind boundary services.
5. A migration tracker and harness that proves old/new parity before each flip.

## Current Effect Setup

Already set up:

- `effect`, `@effect/cli`, `@effect/platform`, `@effect/platform-node`, `@effect/vitest`, and `@effect/language-service` are installed.
- `tsconfig.json` has the Effect language service plugin.
- `src/cli/kirictl.ts` uses `@effect/cli`, `NodeContext`, `NodeRuntime`, and `Layer.merge`.
- `tests/server/*` includes Effect tests with `@effect/vitest`.
- `tests/harness/effect-layers.ts` proves `KiriDbService`, `KiriSettingsService`, and `RuntimeRegistry` can be wired through testable layers.

Missing for a complete Effect setup:

- One app layer that composes DB, config, settings, preferences, runtime registry, runtime clients, terminal registry, filesystem/process adapters, and transport adapters.
- Scoped resource layers for websocket/process/terminal lifetimes instead of module-global maps.
- Typed error families at the real boundaries: DB, config/settings, runtime protocol, terminal process, git diff, MCP/CLI/server-function transport.
- `@effect/platform` filesystem/process/config usage at IO seams. Current code mostly uses raw `node:fs`, `node:child_process`, and `process.env`.
- Schema consistency. Runtime protocol uses Effect `Schema`; contracts and DB rows mostly use `zod`. This can remain during migration, but each seam should own exactly one parser.
- Test layers for DB repositories, runtime registries, terminal registry, settings/preferences, and transport handlers.

## What Is Good Effect Code Today

| Module | What is good | What still blocks full migration |
|---|---|---|
| `src/server/runtime-lifecycle.ts` | Best current shape: typed `RuntimeProjectionEvent`, `RuntimeProjector` tag, live and in-memory projector layers, lifecycle wrapper with error capture and cleanup. | Live projector still directly imports DB functions. It should depend on repositories, not on `db.ts`. |
| `src/server/kiri-control.ts` | Good control-facing service: `Context.Tag`, `Effect.fn`, typed `KiriControlError`, CLI/MCP parity surface. | It calls DB/settings/runtime/terminal functions directly via `fromSync`. The service is deep at the interface but shallow at dependencies. |
| `src/cli/kirictl.ts` | Real Effect CLI boundary with `@effect/cli`, `NodeRuntime`, and a composed main layer. | CLI has its own command parsing, but shares the same thin `KiriControl` layer, so lower dependencies are still global. |
| `src/server/codex-app-server.ts` | Strong protocol boundary: Effect async wrappers around JSON-RPC, schema parsing, pending request cleanup, typed adapter errors. | The adapter class owns mutable maps/timeouts directly. A scoped layer would make lifecycle cleanup testable by construction. |
| `src/server/pi-rpc.ts` | Similar good boundary for subprocess/RPC: Effect command variants preserve typed process errors while Promise methods preserve public behavior. | Process lifetime and listener cleanup are class-owned rather than layer-scoped. |
| `src/server/provider-runtime.ts` | Introduces a runtime registry tag and testable adapter map. | Adapters are still imported singleton functions; no scoped runtime pools or injectable retention policy yet. |
| `src/server/db.ts`, `settings.ts`, `kiri-config.ts` | Thin tags exist, giving a first seam. | They expose old direct functions rather than repositories/config services. This is a compatibility shim, not the destination. |

Reference repo comparison: `/private/tmp/AnswerOverflow` uses Effect more pervasively. The useful patterns to copy are `Layer.scopedDiscard` for long-running handlers, `Ref` and `Schedule` for loops, service tags whose implementations are built from a context, `Effect.withSpan` for operations, and `@effect/vitest` tests that run programs with `Effect.provide(TestLayer)`.

Effect package check: installed Effect exposes the needed primitives in-source: `Layer.scoped`, `Layer.scopedDiscard`, `Layer.mergeAll`, `Layer.succeed`, `Layer.sync`, `Effect.acquireRelease`, `Effect.addFinalizer`, `Effect.forkDaemon`, `Effect.repeat`, `Effect.schedule`, `Effect.provide`, `Schema.TaggedError`, and `Schema.decodeUnknownOption`.

## Files On Effect

Server/control/runtime:

- `src/server/db.ts` - thin `KiriDbService`, but mostly direct SQLite/global implementation.
- `src/server/settings.ts` - thin `KiriSettingsService`, but direct JSON file read.
- `src/server/kiri-config.ts` - thin config service.
- `src/server/provider-runtime.ts` - `RuntimeRegistry`.
- `src/server/kiri-control.ts` - main control service.
- `src/server/kiri-mcp.ts` - MCP bridge using `Effect.runPromise`.
- `src/server/runtime-lifecycle.ts` - runtime lifecycle/projector service.
- `src/server/pi-rpc.ts` - Effect-aware Pi RPC process adapter.
- `src/server/pi-runtime.ts` - partial Effect orchestration over module-global Pi state.
- `src/server/codex-app-server.ts` - Effect-aware Codex app-server adapter.
- `src/server/codex-runtime.ts` - partial Effect orchestration over module-global Codex state.

CLI/tests/harness:

- `src/cli/kirictl.ts`
- `tests/harness/effect-layers.ts`
- `tests/server/effect-layers.test.ts`
- `tests/server/kiri-config.test.ts`
- `tests/server/provider-runtime.test.ts`
- `tests/server/pi-rpc.test.ts`
- `tests/server/runtime-lifecycle.test.ts`

## Server Files Not Yet On Effect

These are the important non-Effect server modules and their likely target seams.

| File | Current role | Target seam |
|---|---|---|
| `src/server/workspace.ts` | TanStack server functions directly call DB/runtime/preferences/terminal. | `WorkspaceService`; server functions become parse/run/respond transport. |
| `src/server/preferences.ts` | Direct JSON preference persistence. | `PreferenceStore` with atomic file adapter and in-memory test adapter. |
| `src/server/terminal-server.ts` | Singleton websocket/PTY registry. | `TerminalRegistry` scoped layer with per-agent session cleanup. |
| `src/server/terminal-launch.ts` | Runtime-specific terminal command construction and resume detection. | `TerminalLaunchResolver` pure/service split. |
| `src/server/git-diff.ts` | Direct `git` subprocess calls. | `GitDiffService` with process adapter and truncation/budget policy. |
| `src/server/diff-refresh.ts` | Thin runtime-state/diff refresh command. | Use-case under runtime projection/repository layer. |
| `src/server/pi-jsonl.ts` | JSONL parsing plus direct file read. | Pure projector plus `PiSessionFileReader` adapter. |
| `src/server/runtime-binaries.ts` | PATH and executable resolution. | `RuntimeBinaryResolver` service. |
| `src/server/backend-server.ts` | Backend transport/readiness. | App layer entrypoint; readiness should probe layer dependencies. |
| `src/server/runtime-file-operations.ts` | Pure-ish operation detection. | Keep mostly pure; does not need Effect except if attached to telemetry service. |
| `src/server/scratchpad-trigger.ts` | Shared scratchpad trigger use-case. | Already a good candidate to become a `ScratchpadService` method. |
| `src/server/runtime.ts` | Runtime dispatch surface. | Replace with `RuntimeRegistry`-backed use-cases. |

Scripts and desktop files are lower priority. `src/desktop/main.mjs`, `scripts/kiri-desktop-backend.mjs`, `scripts/kiri-projects.mjs`, and build/install scripts are process boundaries. They can stay raw Node until the app layer exists, then either call the CLI/control layer or remain deliberately outside Effect.

Frontend files are not primary Effect migration targets. Their risks are size/rendering/locality, not Effect architecture.

## Large File Split Candidates

Measured top files:

| File | Lines | Risk |
|---|---:|---|
| `src/server/db.ts` | 2,791 | DB connection, migrations, repositories, projections, hydration, row parsing, and detail paging all share one module. This is the main bug-locality problem. |
| `src/components/kiri-board/dialogs.tsx` | 1,428 | Modal/form/UI flows are dense and hard to isolate. Split by dialog domain, not by tiny components. |
| `src/components/kiri-board/chat-panel.tsx` | 1,312 | Timeline rendering, composer behavior, detail states, diffs, markdown/code rendering, and local draft behavior are coupled. |
| `src/components/KiriBoard.tsx` | 1,181 | Board orchestration owns query polling, selection, shortcuts, mutations, and layout state. |
| `src/server/codex-runtime.ts` | 1,048 | Runtime use-cases, retained maps, protocol projection, thread lifecycle, attachments, and task projection are together. |
| `tests/e2e/kiri.spec.ts` | 898 | Valuable coverage, but hard to run/triage by feature. Split by flow after server harnesses are in place. |
| `src/server/codex-app-server.ts` | 715 | Protocol schema, transport adapter, process launch, request bookkeeping, and decoding are together. |
| `src/server/pi-runtime.ts` | 415 | Smaller, but same pattern as Codex: retained maps, use-cases, attachments, and process adapter ownership. |

Recommended split order:

1. `db.ts` first, because every other migration depends on repository seams.
2. `codex-runtime.ts` and `pi-runtime.ts`, because they hold retained maps and runtime lifecycle risks.
3. `workspace.ts`, because it becomes much simpler once services exist.
4. UI large files after server use-cases settle, so UI split follows stable data contracts.

## Proposed Directory Shape

This is a target map, not a required one-shot move.

```text
src/server/
  app/
    layer.ts
    errors.ts
    readiness.ts
  config/
    kiri-config.ts
    settings-service.ts
    preferences-service.ts
  db/
    connection.ts
    migrations.ts
    schema.ts
    transaction.ts
    repositories/
      projects.ts
      sessions.ts
      threads.ts
      scratchpad.ts
      runtime-state.ts
      preferences.ts
    projections/
      workspace-snapshot.ts
      agent-detail.ts
      pi-jsonl.ts
  control/
    kiri-control.ts
    workspace-service.ts
  runtime/
    registry.ts
    lifecycle.ts
    projection.ts
    attachments.ts
    file-operations.ts
    codex/
      app-server-adapter.ts
      runtime-service.ts
      retained-state.ts
      protocol.ts
    pi/
      rpc-adapter.ts
      runtime-service.ts
      retained-state.ts
  terminal/
    registry.ts
    launch-resolver.ts
  integrations/
    git-diff.ts
    osascript.ts
    runtime-binaries.ts
  transport/
    workspace-functions.ts
    mcp.ts
    cli.ts
```

The important part is not the exact folders. The important part is that transport, use-cases, repositories/projections, runtime adapters, and process/filesystem adapters stop sharing one flat server namespace.

## Harness And Tracking Plan

Add a migration ledger before moving more code:

- `docs/effect-migration-tracker.md` with every server module classified as `pure`, `transport`, `use-case`, `repository`, `runtime-adapter`, `process-adapter`, `config`, `ui`, or `script`.
- `tests/harness/effect-app-layer.ts` that builds the app layer against a temp DB/state root.
- A generated audit command, for example `pnpm effect:audit`, that fails when a server module marked migrated imports forbidden globals directly.
- A parity harness per module family before flipping call sites.

Minimum no-regression harnesses:

| Harness | Proves |
|---|---|
| DB repository parity | New repositories return the same snapshots/details/session summaries as current `db.ts` for seeded histories. |
| Workspace service parity | Each TanStack server function has a transport test and a service-layer test with in-memory/fake dependencies. |
| Scratchpad flow | UI, CLI, MCP, GUI sessions, and terminal sessions share the same trigger semantics. This already has a first test. |
| Runtime lifecycle | Status/user message/runtime message/context/diff/task/runtime state events project identically through live and in-memory layers. |
| Runtime retention | Reset/delete/close clears Codex/Pi retained maps and terminal sessions. This already has first coverage. |
| Protocol adapters | Fake Codex app-server and fake Pi RPC cover timeout, malformed payload, close, stale turn, and listener cleanup. |
| Perf gates | Snapshot, detail hydration, detail payload size, timeline row count, diff count, RSS delta. This already has first coverage. |
| E2E smoke split | Keep one small Playwright suite for project/session/chat/detail/terminal/scratchpad flows; move heavy runtime flows behind focused commands. |

Suggested migration rule:

1. Create the new Effect service with a live adapter that delegates to the old function.
2. Add a test layer and parity test.
3. Move one call site to the service.
4. Run typecheck, unit tests, and the relevant harness.
5. Only then move implementation out of the old file.

This prevents a rewrite where behavior and architecture change at the same time.

## Deepening Opportunities

1. **DB Repository Module**
   - Files: `src/server/db.ts`, `tests/harness/*db*`, `tests/server/*db*`.
   - Problem: One module owns connection, migrations, row schemas, writes, read models, session hydration, detail paging, and projection helpers.
   - Solution: Keep the public compatibility exports initially, but move implementation behind repositories and projections under `src/server/db/`.
   - Benefits: Bugs in session restore, agent detail, scratchpad, or runtime projection become local. Tests can target repository interfaces instead of full workspace snapshots.

2. **Workspace Service Module**
   - Files: `src/server/workspace.ts`, `src/server/kiri-control.ts`, `src/server/runtime.ts`, `src/server/preferences.ts`.
   - Problem: Server functions are transport plus business logic plus cleanup sequencing.
   - Solution: Make server functions thin transport adapters over a shared `WorkspaceService`.
   - Benefits: UI, CLI, MCP, and future automation can share behavior without reimplementing cleanup or snapshot refresh rules.

3. **Runtime Registry And Retained State Modules**
   - Files: `src/server/codex-runtime.ts`, `src/server/pi-runtime.ts`, `src/server/provider-runtime.ts`, `src/server/runtime-lifecycle.ts`.
   - Problem: Effect lifecycle exists, but runtime state is still owned by module-global maps.
   - Solution: Put retained state and adapters behind runtime-specific scoped services.
   - Benefits: Cleanup becomes structural. Tests can instantiate fresh registries instead of using unsafe clear helpers.

4. **Terminal Registry Module**
   - Files: `src/server/terminal-server.ts`, `src/server/terminal-launch.ts`, `src/server/workspace.ts`.
   - Problem: Terminal sessions are global and lifecycle is manual.
   - Solution: A scoped terminal registry owns websocket server, PTY sessions, idle timers, and per-agent close semantics.
   - Benefits: Less leak risk and better testability for tab switches, delete/reset, and backend shutdown.

5. **Config And File IO Module**
   - Files: `src/server/kiri-config.ts`, `src/server/settings.ts`, `src/server/preferences.ts`, `src/server/runtime-binaries.ts`.
   - Problem: Environment, settings, preferences, and executable resolution are direct reads from scattered places.
   - Solution: Use one config/settings/preferences layer with test providers.
   - Benefits: Desktop, web dev, tests, and packaged helper flows stop needing env mutation discipline across many modules.

6. **Frontend Board Locality Pass**
   - Files: `src/components/KiriBoard.tsx`, `src/components/kiri-board/chat-panel.tsx`, `src/components/kiri-board/dialogs.tsx`.
   - Problem: These files are large enough that render bugs and polling behavior are difficult to isolate.
   - Solution: After backend services stabilize, split by workflow: board selection/query orchestration, session actions, chat timeline, composer/drafts, dialogs.
   - Benefits: UI regressions become easier to pin down, and render/perf gates can attach to smaller units.

## Recommended Next Decision

Pick the first migration block as either:

1. `DB repository split` - highest leverage and prerequisite for the rest.
2. `Runtime retained-state services` - best immediate leak/memory win.
3. `WorkspaceService` - best behavior unification across UI/CLI/MCP, but cleaner after DB/runtime seams exist.

My recommendation is `DB repository split` first, with compatibility exports preserved until parity tests are green.

## Final Branch Shape

The branch followed the recommended order instead of doing a broad rewrite. The final migrated shape is:

- DB is split into connection, migrations, schema, repositories, projections, paged agent detail, bootstrap repairs, session operations, and a compatibility `KiriDbService` facade.
- Config and IO boundaries now have typed service seams for settings, preferences, Kiri config, runtime binary resolution, directory picker, terminal launch, git diff, and diff refresh.
- Runtime lifecycle work now includes a command service, registry cleanup seam, retained-state modules for Codex and Pi, runtime projection, Pi JSONL file IO split, Kiri MCP runtime extraction, and pure Codex app protocol parsing.
- Control surfaces now share more use-case code through workspace service, Kiri control dependency injection, scratchpad trigger service with runtime cleanup on async prompt failure, backend readiness service, and MCP runtime context handling.
- The migration tracker covers 48 server files: 43 marked migrating and 5 marked explicit non-migration, with no not-started rows left in the audit.

## Final Verification

Final branch gates run on 2026-05-15:

- `pnpm typecheck` - passed.
- `pnpm lint` - passed.
- `pnpm effect:audit` - passed with 48 tracked server files, 43 migrating, 5 explicit non-migration, and no not-started rows.
- `pnpm exec tsx tests/perf/run-perf.ts` - passed with 6,000 stored timeline rows, 500 returned timeline rows, 80 stored diffs, 50 returned diffs, 1.08 MB detail JSON, 88.42 ms detail hydration, and 45.22 MB RSS delta against a 64 MB budget.
- `pnpm exec vitest run tests/server/agent-detail-history.test.ts tests/server/perf-gates.test.ts tests/kiri-board/detail-merge.test.ts` - passed after the final older-history paging patch, proving the latest page, older offset page, perf budget, and chronological page merge behavior.
- `pnpm exec vitest run tests/server/scratchpad-trigger.test.ts tests/server/scratchpad-trigger-service.test.ts tests/server/runtime-cleanup.test.ts tests/server/runtime-retention.test.ts` - passed after the final scratchpad cleanup patch, proving async prompt-failure cleanup archives through retained-runtime cleanup.
- `pnpm build` - passed; the existing Vite large-chunk warning remains.
- `pnpm test -- --runInBand` - passed, 57 files and 238 tests.
- `pnpm exec playwright test --project=chromium -g "codex runtime runs through app-server harness|selected agent detail loads chat, diffs, and local drafts|terminal preserves running shell across sidebar tab switches"` - passed, 3 focused Chromium tests.
- `pnpm dlx knip --no-exit-code --reporter compact` - completed; remaining findings are retained/triaged surfaces rather than deletion candidates for this branch.

## Remaining Risks

- Several compatibility facades intentionally remain so callers do not move all at once. The next tightening pass should compose one app layer and migrate callers from facade functions to service dependencies.
- `codex-app-server.ts`, `pi-runtime.ts`, and terminal process ownership still need deeper scoped finalization before they can be marked fully migrated.
- Knip still reports exported service tags, compatibility helpers, and subprocess harness files. Those are expected during migration; pruning should be a separate API-surface decision.
- The frontend board files remain large. Backend contracts and service seams are now more stable, so the next UI locality pass can split polling, selection, chat timeline, composer/drafts, dialogs, and terminal/diff tabs with lower risk.
- The initial selected-agent detail path is intentionally capped at 500 timeline rows. Older rows remain reachable through explicit offset paging and the "Load older history" UI path; user-triggered expansion can mount more rows by design.
