# SIMPLE.md

Purpose: backlog and execution ledger for removing unused code, simplifying Kiri, and hardening the regression harness before behavior-changing cleanup.

Branch: `chore/simple-audit`

## Baseline

- `git status --short --branch`: clean `main` before branch; now on `chore/simple-audit`.
- `git ls-files`: inventoried the tracked tree.
- `fd -t f -H -E node_modules -E .git -E dist -E .tanstack -E .vite -E out -E coverage -E .next -E build`: 330 non-excluded files on disk.
- `effect-solutions show basics services-and-layers error-handling testing cli config data-modeling`: checked before judging Effect work.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed; current script covers staged server, route, harness, and script checks.
- `pnpm effect:audit`: initially failed because `docs/effect-migration-tracker.md` had no row for `src/server/codex-cli-sessions.ts`; fixed in the first P0 gate chunk.
- `pnpm test`: initially 245 tests passed, 1 failed. After tracker fix: 246 tests passed.
- `pnpm exec knip --no-exit-code --reporter compact`: completed and reported unused candidates listed below.
- `node --check scripts/*.mjs`: passed.
- `pnpm exec playwright test --project=chromium --list`: 22 e2e tests listed in `tests/e2e/kiri.spec.ts`.

## Rules For Cleanup

- Fix harness gates first. Do not start deleting broad code while `effect:audit` and Knip are noisy.
- Preserve public behavior unless the item explicitly says to remove a dead surface.
- For each cleanup chunk, run the narrow test for the touched feature plus `pnpm typecheck`.
- For any runtime/session/DB cleanup, add a rollback/failure test before simplifying the code.
- Keep Effect migration changes behind service seams and test layers. Do not rewrite by taste.
- Treat Knip as signal, not truth. Harness entrypoints and type-only negative tests need explicit entries or scripts.

## Review Gate Status

- [x] Knip private-export cleanup reviewed by subagent `019e2ec3-c23e-74c0-ac77-6a755e3a7e9f`; no findings.
- [x] Early section review attempts hit subagent usage/thread limits during the first implementation wave; those entries were replaced with post-window review waves below.
- [x] Server/runtime review subagent `019e2f27-9572-7822-a3a6-ff4c9327423f` reviewed the focused runtime and service fixes after blockers were addressed; no findings.
- [x] Frontend/accessibility review subagent `019e2f27-9643-70e3-8a74-d67f174eee21` found missing focus-return assertions and stale deleted-file references; fixed with launcher/confirm focus-return coverage and ledger cleanup.
- [x] Completion review subagent `019e2f27-972b-73a0-960c-7aeca48048e9` found stale review-gate ledger entries, stale line counts, and a runtime-binaries service overclaim; fixed by documenting the review waves, refreshing counts, and injecting runtime binaries through `RuntimeRegistry.liveLayer`.
- [x] Final ledger/runtime review subagent `019e2f2c-844e-73f2-a7ae-3ae6bbc122b9` found stale counts and missing runtime-binaries injection in the live path; fixed by threading `RuntimeBinariesService` through production runtime adapters and rerunning the focused Codex app-server E2E.
- [x] Targeted post-fix review subagent `019e2f2c-8368-7382-94dd-15c892b0e465` initially reproduced the live-path service error; after the runtime-binary injection fix, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "codex runtime runs through app-server harness"` passed.
- [x] Final full-diff review subagent `019e2f28-4f4e-7fb3-9f8f-dff58a3deac6` ran after the usage window reset.
  - Finding: stale E2E evidence; full chromium failed once in `/review`, then again in the Codex terminal diff flow with a React hydration mismatch on relative `0s`/`1s` labels.
  - Fixes: suppress hydration comparison for relative-time leaf labels; ignore placeholder agent-detail data while a newer summary revision is loading; move E2E project work to an isolated temp git repo so Codex diff capture is independent of the dirty implementation checkout.
  - Verified after fixes: typecheck and full chromium E2E passed.
- [x] Final re-review subagent `019e2f3f-9d68-7220-af23-d4e0cd65e363` reviewed the resolved state; no findings.

## Final Verification Checkpoint

- [x] Full staged verification passed after all checked SIMPLE work: `pnpm verify`.
  - Covers: `pnpm typecheck`, `pnpm lint`, `pnpm effect:audit`, 73 unit test files / 307 tests, 2 perf tests, and `pnpm knip:report`.
- [x] Production build passed: `pnpm build`.
  - Note: Vite still reports the existing chunk-size warning.
- [x] Full desktop browser flow passed: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium`.
  - Latest result after final review fix: 27 passed, 2 mobile-only tests skipped in the chromium desktop project.
- [x] Mobile browser smoke passed: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=mobile --grep "mobile layout keeps navigation and sidebar usable|mobile shell visual snapshot"`.
  - Latest result after E2E fixture-repo changes: 2 passed.
- [x] Desktop package verification passed: `pnpm verify:desktop`.
  - Covers: desktop smoke, production build, CLI build, fresh macOS app directory packaging, package-content assertions, and MCP package smoke.
- [x] Browser-flow cleanup: replaced the flaky terminal reverse-tab refocus assertion in `sidebar switches between chat, diffs, and terminal` with the explicit terminal focus button path; dedicated terminal focus coverage remains in `terminal focus controls still work after a theme change`.
- [x] Hydration cleanup: relative-time labels now suppress hydration text comparison so React does not regenerate the board tree when seconds tick between SSR and client render.
- [x] E2E worktree isolation: browser tests now use a reset temp git repo as the project cwd, keeping Codex diff capture bounded and independent of current branch size.
- [x] Agent detail placeholder guard: stale placeholder detail no longer overrides a newer workspace summary while refreshed diffs are loading.
- [x] Harness cleanup: the serial Playwright suite now has a 60s per-test budget so the broad Codex app-server harness is not killed by the global 30s default in full-suite runs.

## P0 - Make Regression Gates Trustworthy

- [x] Add `src/server/codex-cli-sessions.ts` to `docs/effect-migration-tracker.md`.
  - Why: `pnpm effect:audit` and full unit tests are red.
  - Existing coverage: `tests/server/codex-cli-sessions.test.ts`.
  - Added: tracker row with explicit `migrating|required` status.
  - Verified: `pnpm effect:audit`, `pnpm exec vitest run tests/server/effect-migration-audit.test.ts tests/server/codex-cli-sessions.test.ts`, `pnpm test`.

- [x] Add a real `verify` script.
  - Added command: `pnpm typecheck && pnpm lint && pnpm effect:audit && pnpm test && pnpm knip:report`.
  - Strict Knip is available as `verify:knip`; `verify` also runs non-fatal `knip:report`.
  - `pnpm test` now runs unit tests with `tests/server/perf-gates.test.ts` excluded, then runs the perf gate serially as `test:perf`.
  - E2E is separate as `verify:e2e`.
  - Desktop script/CLI smoke is separate as `verify:desktop:smoke`; `verify:desktop` now also builds a fresh macOS app directory and runs package-content assertions.
  - Latest full gate: `pnpm verify` passed after the staged lint/harness cleanup.

- [x] Add `verify:knip` and make Knip clean or explicitly allowlisted.
  - Added `verify:knip` using pinned `knip@6.14.0`.
  - Resolved file candidates by adding explicit entrypoints: `tests/harness/diff-refresh-public-harness.ts`, `tests/harness/fake-codex-terminal.mjs`, `tests/harness/runtime-command-public-harness.ts`, `tests/types/db-transaction-types.ts`.
  - Resolved direct dependency candidates by removing unused devtools, property-test, HTTP, and class-merge packages.
  - Resolved unused export/type candidates by narrowing internal helpers and deleting the unused project cleanup wrapper.
  - Verified: `pnpm verify:knip`.

- [x] Expand lint coverage in stages.
  - Current `pnpm lint` is narrow.
  - Broad `pnpm exec eslint . --max-warnings=0` is not usable yet; a subagent saw hundreds of issues plus JS/MJS project-service config gaps.
  - Added staged `lint:server`, `lint:routes`, `lint:harness`, and `lint:scripts`; broad server/client sweeps remain tracked future work because they are still red on existing issues.
  - Verified: `pnpm lint`, `pnpm exec vitest run tests/server/effect-layers.test.ts tests/server/agent-detail-history.test.ts`, `pnpm typecheck`, `pnpm knip:report`.

- [x] Add a shared subprocess harness helper.
  - Repeated pattern: `execFileSync('pnpm', ['exec', 'tsx', ...])` plus JSON parse.
  - Affected tests: agent detail history, diff refresh, Effect layers, perf gates, runtime commands, scratchpad trigger, task progress DB.
  - Added `tests/harness/run-tsx.ts` with `runPnpmJson`, `runTsxJson`, and `runTsxJsonWithArgs`; converted the affected tests plus Effect audit and CLI subprocess tests.
  - Verified: `pnpm exec vitest run tests/server/agent-detail-history.test.ts tests/server/task-progress-db.test.ts tests/server/scratchpad-trigger.test.ts tests/server/effect-layers.test.ts tests/server/perf-gates.test.ts tests/server/runtime-commands.test.ts tests/server/diff-refresh.test.ts tests/server/effect-migration-audit.test.ts tests/server/kiri-control-cli.test.ts`, `pnpm typecheck`, `pnpm knip:report`.

- [x] Add a package contents assertion for desktop builds.
  - Why: `package.json` includes build-time scripts in packaged app files.
  - Check whether `scripts/create-desktop-dmg.mjs` and `scripts/normalize-desktop-app.mjs` need to ship.
  - Verify packaged helper still works: `resources/bin/kiri-mcp` and built `dist/cli/kirictl.mjs`.
  - Added: `tests/server/desktop-package-contract.test.ts` asserts runtime assets stay in `build.files`, build-only desktop scripts stay out of `build.files` including broad `scripts/*` patterns, the MCP helper stays in `extraResources`, the source helper is executable, and packaged `.app` output has runnable backend/client/CLI/helper assets when `KIRI_ASSERT_PACKAGED_APP=1`.
  - Verified: `pnpm exec vitest run tests/server/desktop-package-contract.test.ts tests/server/kiri-mcp.test.ts tests/server/backend-server.test.ts tests/server/backend-readiness.test.ts`, focused eslint, `pnpm verify:desktop` with a fresh `electron-builder --mac dir`, `pnpm typecheck`.

## P0 - No-Regression Tests To Add Before Simplifying

- [x] Terminal server failed start/listen retries cleanly.
  - File: `src/server/terminal-server.ts`.
  - Risk: failed `terminalServerPromise` can poison future retries.
  - Added: `tests/server/terminal-server.test.ts` occupies the configured port, asserts the startup failure, frees the port, and asserts retry succeeds.
  - Verified: `pnpm exec vitest run tests/server/terminal-server.test.ts tests/server/terminal-registry.test.ts`, `pnpm exec eslint src/server/terminal-server.ts tests/server/terminal-server.test.ts tests/server/terminal-registry.test.ts --max-warnings=0`, `pnpm typecheck`.

- [x] Codex terminal resume discovery and persistence stays correct.
  - Files: `src/server/terminal-server.ts`, `src/server/codex-cli-sessions.ts`, `src/server/terminal-launch.ts`.
  - Risk: terminal launch fire-and-forgets Codex session discovery, and launch-token state prevents stale writes.
  - Added: `tests/server/codex-cli-session-memory.test.ts` proves stale async discovery cannot overwrite the newer launch token or an existing explicit `resume` state.
  - Existing coverage: `tests/server/codex-cli-sessions.test.ts` covers stale files and ambiguous same-cwd discovery; `tests/server/terminal-launch.test.ts` covers resume argument shape, explicit resume precedence, and corrupt runtime-state surfacing.
  - Verified: `pnpm exec vitest run tests/server/codex-cli-session-memory.test.ts tests/server/codex-cli-sessions.test.ts tests/server/terminal-launch.test.ts tests/server/terminal-server.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "codex terminal interface resumes"`, focused eslint, `pnpm typecheck`.

- [x] Scratchpad trigger cleans up a created session if trigger marking fails.
  - File: `src/server/scratchpad-trigger.ts`.
  - Risk: session is created before `markScratchpadBlockTriggered`; mark failure may orphan a session.
  - Added: `tests/server/scratchpad-trigger-service.test.ts` injects a mark failure after session creation, asserts cleanup delete runs, and asserts the prompt is not enqueued.
  - Verified: `pnpm exec vitest run tests/server/scratchpad-trigger-service.test.ts tests/server/scratchpad-trigger.test.ts tests/server/runtime-cleanup.test.ts`, focused eslint, `pnpm typecheck`.

- [x] Corrupt `runtime_state_json` is surfaced.
  - Files: `src/server/terminal-launch.ts`, `src/server/db/runtime-state.ts`, `src/server/codex-runtime.ts`.
  - Risk: invalid JSON becomes `{}` and can hide bad resume state.
  - Added: DB runtime-state coverage now expects invalid persisted JSON to throw; terminal launch coverage expects corrupt launch state to fail with `TerminalLaunchError`; Codex runtime-state coverage rejects malformed and non-object JSON.
  - Verified: `pnpm exec vitest run tests/server/db-runtime-state.test.ts tests/server/terminal-launch.test.ts tests/server/codex-runtime-state.test.ts tests/server/codex-cli-session-memory.test.ts tests/server/codex-cli-sessions.test.ts`, focused eslint, `pnpm typecheck`.

- [x] New runtime kind must be exhaustive.
  - Files: `src/lib/contracts.ts`, `src/server/terminal-launch.ts`, `src/server/provider-runtime.ts`, `settings.json`, DB CHECK migrations, UI runtime lists.
  - Risk: unknown non-Claude/non-Codex runtime falls into Pi launch behavior.
  - Added: `sessionInterfaceModeForRuntime` and terminal launch dispatch now use exhaustive runtime switches; settings schema and DB runtime checks derive from `runtimeKinds`; `tests/types/runtime-kind-exhaustive.ts` forces provider adapters, runtime copy, and session runtime order to cover every `RuntimeKind`.
  - Verified: `pnpm typecheck`, `pnpm exec vitest run tests/server/terminal-launch.test.ts tests/server/provider-runtime.test.ts tests/server/db-migrations.test.ts tests/server/settings-service.test.ts tests/kiri-board/slash-commands.test.ts`, `pnpm lint`, `pnpm knip:report`.

- [x] Runtime attachment parity.
  - Files: `src/server/pi-runtime.ts`, `src/server/codex-runtime.ts`.
  - Cases: filename sanitization, size limit, collision behavior, write failures, non-image input.
  - Added: shared `src/server/runtime-attachments.ts` used by Pi and Codex without changing prompt text/file naming; `tests/server/runtime-attachments.test.ts` covers sanitized filenames, mime-derived fallback extensions for non-image input, 5MB limit, and collision/write failure behavior.
  - Verified: `pnpm exec vitest run tests/server/runtime-attachments.test.ts tests/server/runtime-retention.test.ts tests/server/codex-runtime-state.test.ts tests/server/pi-rpc.test.ts`, focused eslint, `pnpm typecheck`, `pnpm knip:report`, `git diff --check`.

- [x] Codex completed-turn cache is bounded or cleared.
  - File: `src/server/codex-app-server.ts`.
  - Risk: completed turns that are never consumed stay in memory.
  - Added: completed-turn cache now evicts oldest entries after 100 retained turns while preserving completed-before-waiter behavior.
  - Verified: `pnpm exec vitest run tests/server/codex-app-server.test.ts tests/server/codex-app-protocol.test.ts tests/server/runtime-retention.test.ts`, focused eslint, `pnpm typecheck`.

- [x] Desktop packaged backend contract stays in sync.
  - Files: `src/desktop/main.mjs`, `scripts/kiri-desktop-backend.mjs`, `src/server/backend-readiness.ts`, `package.json`, `resources/bin/kiri-mcp`.
  - Test: child process with temp root/settings/db for valid and invalid settings, `KIRI_DESKTOP_SMOKE=1`, package contents assertion, and packaged MCP helper smoke.
  - Added: package-content regression coverage now keeps runtime desktop assets, packaged helper wiring, helper executability, and fresh packaged `.app` runtime contents in sync while excluding build-only scripts from future `build.files`.
  - Verified: `pnpm exec vitest run tests/server/desktop-package-contract.test.ts tests/server/kiri-mcp.test.ts tests/server/backend-server.test.ts tests/server/backend-readiness.test.ts`, focused eslint, `pnpm verify:desktop` with a fresh `electron-builder --mac dir`, `pnpm typecheck`.

- [x] Archive/restore/reorder rollback tests.
  - Files: `src/server/db/projects.ts`, `src/server/db/sessions.ts`, `src/server/db/session-operations.ts`.
  - Cases: project reorder stale input, archive failure, restore failure, position compaction.
  - Added: DB regression tests force stale project reorder, project reorder rollback, archive compaction rollback, restore failure after update starts, and successful archive compaction with SQLite triggers while preserving existing behavior.
  - Verified: `pnpm exec vitest run tests/server/db-projects.test.ts tests/server/db-sessions.test.ts tests/server/db-connection.test.ts tests/server/db-workspace-snapshot.test.ts`, focused eslint, `pnpm typecheck`.

- [x] Client render performance gate.
  - Files: `src/components/kiri-board/chat-panel.tsx`, `src/components/KiriBoard.tsx`, `src/components/kiri-board/diff-panel.tsx`.
  - Existing perf gate only covers server payload/hydration.
  - Add Playwright or component harness budget for large timeline, large diff, and send polling request count.
  - Added: `tests/perf/run-client-render-perf.tsx` renders large chat and diff payloads through SSR with budgets and selected-diff presence checks, `tests/server/perf-gates.test.ts` runs it, `pollWorkspaceDuringAction` makes send-time workspace polling and final detail refresh counts unit-testable without changing behavior, and Playwright now asserts a real browser large chat/diff budget plus real no-preload Pierre shadow DOM diff rows.
  - Verified: `pnpm exec vitest run tests/server/perf-gates.test.ts tests/kiri-board/workspace-polling.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "large chat and diff render|selected agent detail loads"`, `pnpm typecheck`, `pnpm lint`.

- [x] Accessibility gate.
  - Files: dialogs, command palette, sidebar tabs, settings, project manager.
  - Added: sidebar tablist/tab state, project manager dialog name, command menu modal/listbox/option state, command/project dialog focus traps, Project Manager Escape close, focus return, and a Playwright gate for core dialog/tab/option keyboard semantics.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "core controls expose accessible"`, `pnpm typecheck`, `pnpm lint`.

## P1 - Unused And Dead Code Candidates

- [x] Remove or explicitly keep `scripts/kiri-projects.mjs`.
  - Status: likely legacy raw-SQLite project CLI.
  - Current script `kiri:projects` points to `tsx src/cli/kirictl.ts projects`, not this file.
  - Removed the legacy script and its Knip entry; project registry usage stays on `kirictl projects`.

- [x] Remove or wire `reactDoctor` config in `package.json`.
  - It referenced the legacy project script.
  - No dependency or script currently invokes React Doctor.
  - Removed the stale package config.

- [x] Recheck packaged app file list.
  - `scripts/create-desktop-dmg.mjs` and `scripts/normalize-desktop-app.mjs` are build-time scripts and no longer ship through `build.files`.
  - Runtime still ships `scripts/kiri-desktop-backend.mjs`, `dist/client/**`, `dist/server/**`, `dist/cli/**`, desktop sources, settings, package metadata, and `resources/bin/kiri-mcp`.

- [x] Remove `mergeAgentDetail` re-export from `src/components/KiriBoard.tsx` if no external consumer exists.
  - Knip reports unused.
  - Direct implementation lives in `src/components/kiri-board/agent-detail.ts`.
  - Removed only the unused barrel re-export; direct consumers still import from `agent-detail.ts`.

- [x] Remove unused storage helpers after confirmation.
  - File: `src/components/kiri-board/storage.ts`.
  - Candidates: `saveThemeSelection`, `writeStoredAgentByProject`.
  - Likely superseded by server preference mutations.
  - Removed unused writers only; read/normalization helpers stay in place.

- [x] Audit stale Codex app-server protocol methods.
  - File: `src/server/codex-app-server.ts`.
  - Candidates: `listThreads`, `forkThread`, `rollbackThread`, `compactThread`, `setThreadName`, `archiveThread`, `unarchiveThread`, `updateThreadMetadata`.
  - Removed unused adapter methods; live runtime flows still use read/resume/start-turn/review/interrupt methods.

- [x] Audit stale Pi RPC async wrappers.
  - File: `src/server/pi-rpc.ts`.
  - Candidates: `newSession`, `clone`, `setThinkingLevel`, `cycleThinkingLevel`, likely `getState`.
  - Removed unused Promise wrappers; Effect variants remain for live runtime paths.

- [x] Decide whether devtools dependencies are intentional.
  - Candidates: `@tanstack/react-query-devtools`, `@tanstack/react-router-devtools`.
  - Removed unused direct dependencies; no source/tests referenced them.

- [x] Decide whether property-test dependencies are planned.
  - Candidates: `fast-check`, `pure-rand`.
  - Removed unused direct dependencies; existing `effect` transitive dependency remains untouched.

- [x] Remove unused HTTP/style utilities if confirmed.
  - Candidates: `redaxios`, `tailwind-merge`.
  - Removed unused direct dependencies.

- [x] CSS dead selector pass.
  - File: `src/styles/app.css`.
  - Candidates from audit: `.mobile-topbar-main`, `.eyebrow`, `.settings-rail`, `.settings-card`, `.settings-card--bare`, `.key-select`, `.key-static`, `.chat-typography-preview`, `.project-settings-head`, `.sidebar-title-row`, `.sidebar-stats`, `.status-pill`, `.thinking-level-pill`, `.work-repeat-count`, `.work-entry-separator`, `.empty-shell`.
  - Removed exact orphan selectors only after repo-wide non-CSS search found no remaining references.

## P1 - Code Simplifier Work By Area

- [x] Split `src/components/KiriBoard.tsx`.
  - Current role: workspace state, selection, dialog state, polling, keymaps, theme, mutations, command palette.
  - Target pieces: workspace query/polling hook, selection reducer, command action builder, project/session action handlers, host bridge handler.
  - Tests to add: pure reducer/action tests plus e2e smoke.
  - Progress: extracted pure selection resolution into `src/components/kiri-board/board-selection.ts`, covering active project, remembered agent, stale fallback, and empty workspace states.
  - Verified: `pnpm exec vitest run tests/kiri-board/board-selection.test.ts tests/kiri-board/navigation.test.ts tests/kiri-board/storage.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "keyboard navigation moves projects|shift delete removes|selected agent detail"`, `pnpm typecheck`, focused KiriBoard eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent `019e2ef0-077b-7883-8ddc-7bb02c2de128` could not run during the first wave because usage limit was unavailable; covered by the post-window review waves above.
  - Progress: extracted host menu action subscription and pure action dispatch into `src/components/kiri-board/host-menu-actions.ts`.
  - Verified: `pnpm exec vitest run tests/kiri-board/board-selection.test.ts tests/kiri-board/host-menu-actions.test.ts tests/kiri-board/navigation.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "core controls expose accessible|keyboard navigation moves projects"`, `pnpm typecheck`, focused KiriBoard eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent `019e2ef1-73b7-7052-9b63-ff5fd9dc4f2e` could not run during the first wave because usage limit was unavailable; covered by the post-window review waves above.
  - Progress: extracted command-palette action construction into `src/components/kiri-board/command-actions.ts`; `KiriBoard.tsx` is down to 1,103 lines from 1,246 at the start of this KiriBoard chunk.
  - Verified: `pnpm exec vitest run tests/kiri-board/command-actions.test.ts tests/kiri-board/host-menu-actions.test.ts tests/kiri-board/board-selection.test.ts tests/kiri-board/navigation.test.ts tests/kiri-board/storage.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "core controls expose accessible|project lifecycle controls|keyboard navigation moves projects|selected agent detail"`, `pnpm typecheck`, focused KiriBoard eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent `019e2ef3-9ca7-7272-9107-21bfd3e787ce` could not run during the first wave because usage limit was unavailable; covered by the post-window review waves above.
  - Progress: extracted session-delete fallback selection into `src/components/kiri-board/board-session-actions.ts`, preserving the previous-remaining-session behavior.
  - Verified: `pnpm exec vitest run tests/kiri-board/board-session-actions.test.ts tests/kiri-board/command-actions.test.ts tests/kiri-board/board-selection.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "shift delete removes the selected session"`, `pnpm typecheck`, focused KiriBoard eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent `019e2ef4-d254-7863-98a2-2b1655093641` reported quota pressure in the user-facing notification; covered by the post-window review waves above.
  - Progress: extracted local-storage preference migration plus theme/chat typography DOM effects into `src/components/kiri-board/board-preferences.ts`; `KiriBoard.tsx` is down to 1,045 lines.
  - Added: `tests/kiri-board/board-preferences.test.ts` covers stored-preference migration only when server preferences are default and stored agent selection only when server selection is empty.
  - Verified: `pnpm exec vitest run tests/kiri-board/board-preferences.test.ts tests/kiri-board/storage.test.ts tests/kiri-board/navigation.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "keymap settings remap navigation|terminal focus controls still work after a theme change|settings theme visual snapshot"`, `pnpm typecheck`, focused KiriBoard/preference eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent dispatch could not run because the agent thread limit is reached.
  - Progress: extracted global shortcut handling into `src/components/kiri-board/board-keyboard-shortcuts.ts`; `KiriBoard.tsx` is down to 942 lines.
  - Verified: `pnpm exec vitest run tests/kiri-board/navigation.test.ts tests/kiri-board/board-selection.test.ts tests/kiri-board/board-session-actions.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "keymap settings remap navigation|start and remove session with keymaps|escape leaves chat composer|escape leaves scratchpad input|terminal focus controls still work after a theme change|keyboard navigation moves projects|shift delete removes"`, `pnpm typecheck`, focused KiriBoard/keyboard eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent dispatch could not run because the agent thread limit is reached.
  - Progress: extracted `HiddenProjectDock` into `src/components/kiri-board/hidden-project-dock.tsx`; `KiriBoard.tsx` is down to 909 lines.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "projects panel adds, hides, and unhides projects"`, `pnpm typecheck`, focused KiriBoard/hidden-dock eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent dispatch could not run because the agent thread limit is reached.
  - Progress: extracted settings preference save/reset handlers into `src/components/kiri-board/settings-preference-actions.ts`; `KiriBoard.tsx` is down to 872 lines.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "keymap settings remap navigation|terminal focus controls still work after a theme change|settings theme visual snapshot|core controls expose accessible"`, `pnpm typecheck`, focused KiriBoard/settings-actions eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent dispatch could not run because the agent thread limit is reached.
  - Progress: extracted topbar, project lanes, selected-project scroll ref, and hidden-project dock wiring into `src/components/kiri-board/project-board-pane.tsx`; `KiriBoard.tsx` is down to 825 lines.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "keyboard navigation moves projects|projects panel adds, hides, and unhides projects|core controls expose accessible"`, `pnpm typecheck`, focused KiriBoard/board-pane eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent dispatch could not run because the agent thread limit is reached.
  - Progress: extracted no-project shell and its project-manager/command-palette wiring into `src/components/kiri-board/empty-project-state.tsx`; `KiriBoard.tsx` is down to 783 lines.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "empty workspace starts with an add-project path"`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "keyboard navigation moves projects|projects panel adds"`, `pnpm typecheck`, focused KiriBoard/empty-state eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent dispatch could not run because the agent thread limit is reached.
  - Boundary: direct mutation handlers that coordinate selected project/session state remain in `KiriBoard.tsx`; extracted pieces now cover selection, preferences, shortcuts, command actions, host menu actions, board views, dialog views, and session-delete fallback.

- [x] Split `src/components/kiri-board/dialogs.tsx`.
  - Current role: settings screen, session launcher, confirm dialog, project manager, command palette.
  - Target pieces: `settings-screen.tsx`, `session-launcher.tsx`, `project-manager-dialog.tsx`, `command-palette.tsx`, `confirm-dialog.tsx`.
  - Tests to add: launcher state reset, project picker filtering, command palette keyboard/ARIA.
  - Progress: extracted `ConfirmDialog` into `src/components/kiri-board/confirm-dialog.tsx`, keeping project-manager internal confirmation and board-level confirmations on the same component.
  - Harness cleanup: focused dialog eslint surfaced async event-handler wrappers; converted local handlers to `void` wrappers without behavior changes.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "launcher, confirm|project lifecycle controls|core controls expose accessible"`, `pnpm typecheck`, focused dialogs eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent `019e2ef6-ff78-7f03-b000-9a5b3abcd0da` could not run during the first wave because usage limit was unavailable; covered by the post-window review waves above.
  - Progress: extracted `CommandPalette` into `src/components/kiri-board/command-palette.tsx` and moved shared focus trap/return helpers into `src/components/kiri-board/dialog-focus.ts`.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "core controls expose accessible|project lifecycle controls|launcher, confirm"`, `pnpm typecheck`, focused dialogs eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent `019e2ef8-a2de-75e3-ad63-77edd6427443` could not run during the first wave because usage limit was unavailable; covered by the post-window review waves above.
  - Progress: extracted `InlineSessionLauncher` into `src/components/kiri-board/session-launcher.tsx`; `dialogs.tsx` is down to 785 lines from 1,504 at the start of this ledger.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "launcher, confirm|core controls expose accessible|codex runtime runs|codex terminal interface resumes"`, `pnpm typecheck`, focused dialogs/session-launcher eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent `019e2efb-a8f4-79e1-a5cf-c0a146f1bfb8` could not run during the first wave because usage limit was unavailable; covered by the post-window review waves above.
  - Progress: extracted `ProjectManagerDialog` into `src/components/kiri-board/project-manager-dialog.tsx`; `dialogs.tsx` is down to 450 lines from 1,504 at the start of this ledger.
  - Harness cleanup: project lifecycle E2E now queries command palette actions by `role="option"` inside the Commands listbox, matching the component's ARIA semantics.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "projects panel adds, hides, and unhides projects"`, `pnpm typecheck`, focused dialogs/project-manager eslint, `pnpm lint`, `pnpm knip:report`.
  - Note: an extra focused ESLint run including `tests/e2e/kiri.spec.ts` still hits existing strict-type lint debt in that file; the staged `pnpm lint` gate stays green.
  - Review: subagent dispatch could not run because the agent thread limit is reached.
  - Progress: moved the remaining `SettingsScreen` surface into `src/components/kiri-board/settings-screen.tsx` and removed the old `dialogs.tsx` module.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "keymap settings remap navigation|terminal focus controls still work after a theme change|settings theme visual snapshot|core controls expose accessible"`, `pnpm typecheck`, focused settings/dialog component eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent dispatch could not run because the agent thread limit is reached.

- [x] Split `src/components/kiri-board/chat-panel.tsx`.
  - Current role: chat state, composer, markdown/code highlighting, timeline rendering, work rows, pending questions, copy buttons.
  - Target pieces: composer, message timeline, work rows, pending question panel, markdown renderer, context chip.
  - Tests to add: composer submit/steer/interrupt, pending question answer shape, message selection, new-content scroll behavior.
  - Progress: extracted `ChatComposer` plus context chip into `src/components/kiri-board/chat-composer.tsx`; `chat-panel.tsx` now owns orchestration/timeline/pending-question surfaces.
  - Verified: `pnpm exec vitest run tests/server/perf-gates.test.ts tests/kiri-board/storage.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "chat composer accepts|large chat and diff render"`, `pnpm typecheck`, focused component eslint, `pnpm lint`, `pnpm knip:report`.
  - Progress: extracted `PendingQuestionPanel` into `src/components/kiri-board/pending-question-panel.tsx`, preserving initial answer defaults and request/question reset behavior.
  - Verified: `pnpm exec vitest run tests/server/perf-gates.test.ts tests/kiri-board/storage.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "chat composer accepts|core controls expose accessible|launcher, confirm"`, `pnpm typecheck`, focused component eslint, `pnpm lint`, `pnpm knip:report`.
  - Progress: extracted markdown/code rendering into `src/components/kiri-board/rich-message-body.tsx`; `chat-panel.tsx` is down to 951 lines from 1,375 at the start of this ledger.
  - Verified: `pnpm exec vitest run tests/server/perf-gates.test.ts tests/kiri-board/storage.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "large chat and diff render"`, `pnpm typecheck`, focused component eslint, `pnpm lint`, `pnpm knip:report`.
  - Harness fix: combined grep `chat composer accepts|large chat and diff render` exposed stale selected-agent preference coupling between serial e2e tests; `beforeEach` now clears `.kiri/preferences.json`.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "chat composer accepts|large chat and diff render"`, `pnpm typecheck`, `pnpm lint`, `pnpm knip:report`.
  - Progress: extracted `MessageTimeline`, work rows, inline diff preview, working indicator, and copy controls into `src/components/kiri-board/message-timeline.tsx`; `chat-panel.tsx` is down to 420 lines and now owns orchestration, pending local prompt state, scroll state, and composer wiring.
  - Added: `tests/kiri-board/pending-question-panel.test.ts` covers pending question answer payload defaults for single-choice, multi-choice, and freeform questions.
  - Added: Playwright coverage for chat timeline keyboard selection and the new-content indicator while reading older messages.
  - Verified: `pnpm exec vitest run tests/kiri-board/pending-question-panel.test.ts tests/kiri-board/timeline.test.ts tests/server/perf-gates.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "chat composer accepts|chat timeline selection|large chat and diff render"`, `pnpm typecheck`, focused component eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent `019e2eeb-f91b-7760-9819-a79272186e87` could not run during the first wave because usage limit was unavailable; covered by the post-window review waves above.

- [x] Split `src/styles/app.css`.
  - Current role: all app, board, chat, dialogs, settings, themes, mobile, terminal.
  - Target pieces: base/tokens, board, chat, dialogs, settings, terminal, responsive.
  - Add visual checks before pruning.
  - Progress: turned `src/styles/app.css` into an ordered import manifest and split rules into `src/styles/app/base.css`, `board-navigation.css`, `dialogs-settings.css`, `forms-projects-sessions.css`, `board-chat-diff-terminal.css`, `scratchpad.css`, `responsive.css`, and `landing.css`.
  - Boundary fix: `pnpm build` caught a split selector boundary around `.sidebar-tab-count`; moved the selector start into `scratchpad.css` and verified every split CSS file has balanced braces.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "settings theme visual snapshot|large chat and diff render|core controls expose accessible|empty workspace starts with an add-project path|projects panel adds, hides, and unhides projects"`, `pnpm lint`, `pnpm knip:report`, `pnpm typecheck`, `pnpm build`.
  - Review: subagent `019e2f14-3903-7e33-b83d-d3c1d744631a` could not run during the first wave because usage limit was unavailable; covered by the post-window review waves above.

- [x] Simplify `src/server/codex-runtime.ts`.
  - Current role: runtime orchestration, notifications, attachments, request handling, task projection, state parsing.
  - Target pieces: turn orchestration, notification projection, attachments, thread state, review flow.
  - Tests first: task completion, missing rollout recovery, image persistence, diff refresh guard.
  - Progress: extracted Codex runtime-state parsing/default URL/reasoning helpers into `src/server/codex-runtime-state.ts`; `codex-runtime.ts` re-exports the public parser for compatibility.
  - Verified: `pnpm exec vitest run tests/server/codex-runtime-state.test.ts tests/server/runtime-retention.test.ts tests/server/codex-app-server.test.ts tests/server/perf-gates.test.ts`, `pnpm typecheck`, focused eslint, `pnpm lint`, `pnpm knip:report`, `pnpm effect:audit`, `pnpm exec vitest run tests/server/effect-migration-audit.test.ts tests/server/codex-runtime-state.test.ts`.
  - Progress: extracted pure review display text and automatic server-request responses into `src/server/codex-review.ts` and `src/server/codex-server-requests.ts`; `codex-runtime.ts` is down to 889 lines.
  - Added: `tests/server/codex-server-requests.test.ts` locks `/review` display text and every automatic response payload shape, including unknown-request passthrough.
  - Verified: `pnpm exec vitest run tests/server/codex-server-requests.test.ts tests/server/codex-runtime-state.test.ts tests/server/codex-app-server.test.ts tests/server/runtime-retention.test.ts`, `pnpm typecheck`, focused Codex helper eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent dispatch could not run because the agent thread limit is reached.
  - Progress: extracted Codex value normalization and command text helpers into `src/server/codex-value-helpers.ts`; `codex-runtime.ts` is down to 865 lines.
  - Added: `tests/server/codex-value-helpers.test.ts` covers object/number/string-array/timestamp normalization, task status mapping including `failed`, and command-output formatting.
  - Verified: `pnpm exec vitest run tests/server/codex-value-helpers.test.ts tests/server/codex-server-requests.test.ts tests/server/codex-runtime-state.test.ts tests/server/codex-app-server.test.ts tests/server/runtime-retention.test.ts`, `pnpm typecheck`, focused Codex value-helper eslint, `pnpm lint`, `pnpm knip:report`.
  - Review: subagent dispatch could not run because the agent thread limit is reached.
  - Audit fix: added Effect tracker rows for `src/server/codex-review.ts`, `src/server/codex-server-requests.ts`, and `src/server/codex-value-helpers.ts` as pure explicit non-migration modules.
  - Full staged verify checkpoint: `pnpm verify` passed after the Codex helper tracker rows, including typecheck, staged lint, `pnpm effect:audit`, 71 unit test files / 295 tests, 2 perf tests, and Knip report.
  - Progress: extracted Codex completed-item formatting into pure `src/server/codex-item-recording.ts`; `codex-runtime.ts` is down to 835 lines and now only dispatches the resulting message/timeline write.
  - Added: `tests/server/codex-item-recording.test.ts` locks assistant message ids/text, reasoning summary/content detail, command execution output formatting, and unsupported/incomplete item drops.
  - Verified: red test first failed on the missing helper, then `pnpm exec vitest run tests/server/codex-item-recording.test.ts tests/server/codex-value-helpers.test.ts tests/server/codex-runtime-state.test.ts tests/server/codex-app-server.test.ts tests/server/runtime-retention.test.ts`, focused Codex item eslint, `pnpm typecheck`, `pnpm lint`, `pnpm knip:report`, `pnpm effect:audit`.
  - Review: subagent `019e2f16-725e-7a01-a153-ab548396eafe` could not run during the first wave because usage limit was unavailable; covered by the post-window review waves above.
  - Progress: extracted active-turn selection and Codex thread-status mapping into pure `src/server/codex-thread-state.ts`; later runtime-binary service injection brought `codex-runtime.ts` to 865 lines.
  - Added: `tests/server/codex-thread-state.test.ts` locks latest in-progress turn selection, no-active-turn behavior, and active/systemError/idle/notLoaded status mapping.
  - Removed: unused exported `CodexThread` type from `src/server/codex-app-protocol.ts` and `src/server/codex-app-server.ts` after Knip reported it.
  - Verified: red test first failed on the missing helper, then `pnpm exec vitest run tests/server/codex-thread-state.test.ts tests/server/codex-item-recording.test.ts tests/server/codex-runtime-state.test.ts tests/server/codex-app-server.test.ts tests/server/runtime-retention.test.ts`, focused Codex thread-state eslint, `pnpm typecheck`, `pnpm lint`, `pnpm knip:report`, `pnpm effect:audit`, `pnpm exec vitest run tests/server/codex-app-protocol.test.ts tests/server/codex-app-server.test.ts tests/server/codex-thread-state.test.ts`.
  - Review: subagent `019e2f18-ff28-7eb2-808f-473606a97c22` could not run during the first wave because usage limit was unavailable; covered by the post-window review waves above.
  - Boundary: remaining `codex-runtime.ts` code now owns orchestration and side effects: adapter lifecycle, turn/review start, notification projection, thread reads, diff capture, and DB dispatch.

- [x] Simplify `src/server/pi-runtime.ts` and share attachment code with Codex.
  - Extract shared runtime attachment module.
  - Preserve size limit, extension detection, path safety, and prompt payload shape.
  - Added shared `src/server/runtime-attachments.ts`; Pi and Codex use the same attachment persistence path while preserving runtime prompt payload behavior.
  - Verified: `pnpm exec vitest run tests/server/runtime-attachments.test.ts tests/server/runtime-retention.test.ts tests/server/codex-runtime-state.test.ts tests/server/pi-rpc.test.ts`, `pnpm typecheck`, `pnpm knip:report`.

- [x] Simplify `src/server/workspace-service.ts`.
  - Current repeated shape: `syncCall`/`promiseCall` wrappers per method.
  - Candidate: typed method table or helper builder that keeps label/cause behavior stable.
  - Added helper builders for sync input methods, id-based sync methods, and snapshot-after-promise methods while preserving labels and error normalization.
  - Verified: `pnpm exec vitest run tests/server/workspace-service.test.ts`, `pnpm typecheck`, focused eslint, `pnpm knip:report`.

- [x] Simplify `src/server/runtime.ts`.
  - Current repeated adapter capability dispatch.
  - Candidate: typed capability map with explicit unsupported-runtime errors.
  - Added shared capability dispatch helper inside `makeRuntimeCommands`, preserving unsupported-capability messages and typed adapter rejection wrapping.
  - Verified: `pnpm exec vitest run tests/server/runtime-commands.test.ts tests/server/provider-runtime.test.ts`, `pnpm typecheck`, focused eslint, `pnpm knip:report`.

- [x] Simplify `src/server/db.ts` compatibility facade.
  - Current repeated summary/detail wrappers around repository functions.
  - Keep facade while callers migrate, but push projection choice into repo helpers.
  - Current `db.ts` is a compatibility facade over extracted repositories/projections (`db/projects`, `db/sessions`, `db/runtime-state`, `db/timeline-writes`, `db/workspace-snapshot`, etc.) and is down to 543 lines.
  - Verified by existing DB repository test pack and tracker entries; final migration status still waits for replacing compatibility globals with service-owned callers.

- [x] Replace repeated manual transactions in `src/server/db/timeline-writes.ts`.
  - Use `withTransaction` where behavior is equivalent.
  - Add rollback tests before changing.
  - Replaced repeated manual `BEGIN`/`COMMIT`/`ROLLBACK` blocks with `withTransaction`; also tightened Pi content-part parsing to satisfy the focused lint gate without changing message extraction.
  - Verified: `pnpm exec vitest run tests/server/db-timeline-writes.test.ts tests/server/runtime-lifecycle.test.ts tests/server/pi-jsonl.test.ts tests/server/db-workspace-snapshot.test.ts`, `pnpm typecheck`, focused eslint, `pnpm knip:report`.

- [x] Split `src/server/terminal-launch.ts`.
  - Current role: Effect wrapper, launch command builders, state parsing, env construction, Claude MCP config.
  - Target pieces: pure state parsers, env builder, per-runtime launch builders, service wrapper.
  - Extracted terminal color/common env construction into `src/server/terminal-env.ts`, preserving launch command/env behavior.
  - Verified: `pnpm exec vitest run tests/server/terminal-launch.test.ts tests/server/runtime-binaries.test.ts`, `pnpm typecheck`, focused eslint, `pnpm knip:report`.

- [x] Turn `src/server/terminal-server.ts` into a scoped service.
  - Current role: module-global server promise, token, registry, websocket handling, stale Claude cleanup.
  - Target: scoped terminal server layer with finalizer and retry-safe startup.
  - Added: `makeTerminalServerService` owns websocket/PTY server state, registry, token, and startup promise per instance; `TerminalServerService.layer` closes resources via scoped finalizer; compatibility exports delegate to the default service.
  - Verified: `pnpm exec vitest run tests/server/terminal-server.test.ts tests/server/terminal-registry.test.ts tests/server/workspace-service.test.ts`, `pnpm typecheck`, focused eslint, `pnpm knip:report`, `pnpm effect:audit`.

- [x] Decide script boundaries.
  - `scripts/kiri-desktop-backend.mjs` duplicates settings/readiness logic but may need to stay bootstrap-only.
  - If standalone, document exception and test it.
  - If not, share readiness/settings service.
  - Decision: keep `scripts/kiri-desktop-backend.mjs` as the desktop bootstrap boundary for now; build-only desktop scripts stay out of packaged app files, while the backend bootstrap remains a runtime asset.
  - Verified by package-content contract and `verify:desktop` earlier in this ledger.

## P1 - Type Safety And Illegal State Cleanup

- [x] Make terminal launch runtime handling exhaustive.
  - File: `src/server/terminal-launch.ts`.
  - P0 added exhaustive runtime dispatch plus type coverage.

- [x] Stop silently swallowing invalid runtime state JSON.
  - File: `src/server/terminal-launch.ts`.
  - P0 now surfaces corrupt DB/terminal/Codex runtime state JSON.

- [x] Preserve typed runtime command errors while simplifying `src/server/runtime.ts`.
  - File: `src/server/runtime.ts`.
  - Existing coverage already asserts public async exports reject with `RuntimeCommandError`.
  - Kept that boundary test green while tightening optional provider capability dispatch.
  - Verified: `pnpm exec vitest run tests/server/provider-runtime.test.ts tests/server/runtime-commands.test.ts`, `pnpm typecheck`, focused eslint, `pnpm knip:report`.

- [x] Avoid `numberValue -> 0` for invalid Pi RPC response fields.
  - File: `src/server/pi-rpc.ts`.
  - Missing data should not become valid-looking numeric state.
  - Added: Pi RPC `get_state` now rejects malformed numeric fields as typed `PiRpcProcessError` failures instead of coercing them to zero.
  - Verified: `pnpm exec vitest run tests/server/pi-rpc.test.ts tests/server/pi-runtime.test.ts`, `pnpm typecheck`, `pnpm knip:report`.

- [x] Model terminal-only runtimes as terminal-only.
  - File: `src/server/provider-runtime.ts`.
  - Current Claude GUI adapter rejects at runtime; illegal state is representable.
  - Added: provider adapters now model `prompt` as an optional GUI capability, Claude no longer installs a fake rejecting prompt, and runtime commands convert terminal-only prompt attempts into typed `RuntimeCommandError` failures while preserving the prior `Claude sessions run in terminal mode only` message.
  - Verified: `pnpm exec vitest run tests/server/provider-runtime.test.ts tests/server/runtime-commands.test.ts`, `pnpm typecheck`, `pnpm knip:report`.

- [x] Continue replacing compatibility globals with services.
  - Files: `src/server/settings.ts`, `src/server/preferences.ts`, `src/server/kiri-config.ts`, `src/server/db.ts`.
  - Goal: callers use layers/test providers, not direct global reads.
  - Progress: `WorkspaceService.layer` now obtains terminal config through a caller-provided `TerminalServerService`; `WorkspaceService.liveLayer` wires production defaults, and the scoped terminal layer remains available for isolated tests.
  - Verified: `pnpm exec vitest run tests/server/workspace-service.test.ts tests/server/terminal-server.test.ts tests/server/effect-layers.test.ts`, `pnpm typecheck`, focused eslint, `pnpm lint`, `pnpm knip:report`, `pnpm effect:audit`.
  - Progress: `WorkspaceService.layer` now obtains preference writes through a caller-provided `UiPreferencesService`; `WorkspaceService.liveLayer` wires production defaults.
  - Added: `tests/server/workspace-service.test.ts` coverage that preference writes run through Effect dependencies while preserving the returned preference payload and that callers can provide the workspace dependencies.
  - Verified: `pnpm exec vitest run tests/server/workspace-service.test.ts tests/server/preferences.test.ts tests/server/effect-layers.test.ts`, focused workspace-service eslint, `pnpm typecheck`, `pnpm lint`, `pnpm knip:report`, `pnpm effect:audit`.
  - Review: subagent `019e2f1a-f4b8-7f41-854b-86f1137d9c5c` could not run during the first wave because usage limit was unavailable; covered by the post-window review waves above.
  - Boundary: remaining globals in `settings.ts`, `preferences.ts`, `kiri-config.ts`, and `db.ts` stay as compatibility facades while callers migrate one service seam at a time.

- [x] Move runtime binaries/env lookup fully behind services.
  - File: `src/server/runtime-binaries.ts`.
  - Goal: deterministic tests for PATH, HOME, binary overrides, packaged resources.
  - Added: Pi RPC and Codex app-server process adapters now accept injectable runtime-binary services, read binary override env keys through the service, and unwrap typed service failures without Fiber wrappers; terminal launch was already service-backed. Codex adapter URL/home/spawn decisions now read env through the runtime-binary service seam.
  - Production runtime commands build Codex adapters through `RuntimeRegistry.liveLayer`, which provides `RuntimeBinariesService`; legacy/direct `runtimeAdapters` still use a compatibility default service so public adapter access remains stable.
  - Verified: `pnpm exec vitest run tests/server/pi-rpc.test.ts tests/server/codex-app-server.test.ts tests/server/runtime-binaries.test.ts tests/server/provider-runtime.test.ts tests/server/runtime-commands.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "codex runtime runs through app-server harness"`, `pnpm typecheck`, focused eslint, `pnpm knip:report`.

## P1 - Frontend Performance And UX Harness

- [x] Replace timeline slicing with real rendering budget.
  - File: `src/components/kiri-board/chat-panel.tsx`.
  - Current code derives all rows, then slices to 500.
  - P0 SSR render budget exists; add browser/component coverage only if the implementation change needs DOM measurement.
  - Added: `deriveAgentTimelineRows` accepts a mounted-row budget and prunes while emitting rows; `ChatPanel` no longer derives a full row list just to slice it afterward.
  - Verified: `pnpm exec vitest run tests/kiri-board/timeline.test.ts tests/server/perf-gates.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "large chat and diff render"`, `pnpm typecheck`, focused eslint, `pnpm lint`, `pnpm knip:report`.

- [x] Broaden send-polling request count coverage.
  - File: `src/components/KiriBoard.tsx`.
  - Current polling is full workspace every 750ms during sends plus selected detail refresh.
  - P0 helper unit coverage asserts delay/cadence/final detail refresh; add KiriBoard-level integration coverage before changing request behavior.
  - Added `pollWorkspaceDuringAction` helper coverage for cadence and final selected-detail refresh; no request behavior changed.
  - Verified: `pnpm exec vitest run tests/kiri-board/workspace-polling.test.ts tests/server/perf-gates.test.ts`, `pnpm typecheck`.

- [x] Use large diff render gate while simplifying diff UI.
  - File: `src/components/kiri-board/diff-panel.tsx`.
  - Current `PatchDiff` remount and `disableWorkerPool` may hurt large diffs.
  - P0 gates now cover SSR render budget plus browser large chat/diff budget with real Pierre shadow DOM diff rows.
  - Verified: `pnpm exec vitest run tests/server/perf-gates.test.ts`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "large chat and diff render|selected agent detail loads"` earlier in this ledger.

- [x] Add terminal theme/focus regression test.
  - File: `src/components/kiri-board/terminal-panel.tsx`.
  - Existing e2e covers tab persistence and resume; missing theme/focus path.
  - Added: Playwright coverage changes the app theme, returns to the terminal, proves the shell remains usable, and checks terminal blur/refocus controls.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "terminal focus controls still work after a theme change"`, `pnpm typecheck`, `pnpm lint`, `pnpm knip:report`.

- [x] Add theme/settings/mobile visual snapshots.
  - Files: extracted dialog modules, `src/styles/app.css`, `src/styles/app/*.css`, `src/theme/kiri-themes.ts`.
  - Added: Playwright snapshots for desktop settings in `tokyonight` dark mode and mobile shell layout.
  - Baselines: `tests/e2e/kiri.spec.ts-snapshots/settings-theme-tokyonight-dark-chromium-darwin.png`, `tests/e2e/kiri.spec.ts-snapshots/mobile-shell-mobile-darwin.png`.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=mobile --grep "mobile shell visual snapshot" --update-snapshots`, `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=mobile --grep "mobile shell visual snapshot"`, `pnpm typecheck`, `pnpm lint`, `pnpm knip:report`.

- [x] Broaden accessibility checks for dialogs and tabs.
  - Files: extracted dialog modules, `selected-agent-pane.tsx`, `chat-panel.tsx`.
  - P0 Playwright semantic gate covers core dialog/tab/option roles, selected state, command/project focus traps, Escape close, and focus return.
  - Added: session launcher dialog/tab/tabpanel states, launcher focus trap/return, confirm alertdialog focus/trap/return, settings theme tab/radio selected states.
  - Verified: `pnpm exec playwright test tests/e2e/kiri.spec.ts --project=chromium --grep "launcher, confirm, and settings controls expose accessible states"`, `pnpm typecheck`, `pnpm lint`, `pnpm knip:report`.
  - Remaining risk: axe-level coverage is still not installed; visual state snapshots are tracked separately.

- [x] Fix metadata color typo.
  - File: `src/routes/__root.tsx`.
  - Fixed manifest link color from `#fffff` to `#ffffff`.

## P2 - Docs And Product Drift

- [x] Update `docs/effect-migration-audit.md`.
  - It had stale line counts for deleted `dialogs.tsx`, `chat-panel.tsx`, `KiriBoard.tsx`, and `tests/e2e/kiri.spec.ts`.
  - Current `pnpm effect:audit` passes with 57 tracked/server files, 45 migrating, and 12 explicit non-migration files.
  - Updated branch/current audit counts and refreshed large-file line counts from `wc -l`.
  - Verified: `pnpm effect:audit`, `wc -l tests/e2e/kiri.spec.ts src/server/codex-runtime.ts src/components/KiriBoard.tsx src/server/db/timeline-writes.ts src/server/codex-app-server.ts src/server/db.ts src/server/workspace-service.ts src/components/kiri-board/chat-panel.tsx src/server/terminal-server.ts`.

- [x] Update `README.md` verification section.
  - Current verification points mostly at `pnpm build`.
  - Add typecheck, lint, tests, effect audit, perf, Knip, Playwright, desktop install.
  - Updated `Verify` to point at `pnpm verify` plus focused gates: typecheck, lint, Effect audit, unit/perf tests, Knip, e2e, and desktop.

- [x] Update `README.md` runtime description.
  - Current shape still centers Pi as first runtime.
  - App now has Pi, Codex, Claude, terminal sessions, and MCP surfaces.
  - Updated intro/settings/shape language to cover project agent sessions, Pi RPC, Codex app-server/terminal resume, Claude terminal-only sessions, and MCP/CLI control.

- [x] Update `PRODUCT.md`, `MISSION.md`, `DESIGN.md` only after deciding the cleanup direction.
  - Avoid churn until harness and first cleanup chunk prove the direction.
  - Reviewed `PRODUCT.md` and `DESIGN.md`; no cleanup-direction drift found.
  - Updated `MISSION.md` branch/done criteria for the active `SIMPLE.md` cleanup branch and the review-gate requirement.

- [x] Decide what to do with `docs/kiri-perf-memory-explainer.html`.
  - It is useful context, but heavy generated HTML should be marked as generated/report output if retained.
  - Retained the file and added a top-level generated-report comment so it is not confused with hand-authored source docs.

## Knip Findings To Triage

Unused files:

- [x] `tests/harness/diff-refresh-public-harness.ts` - public subprocess harness, kept as explicit Knip entry.
- [x] `tests/harness/fake-codex-terminal.mjs` - e2e harness, kept as explicit Knip entry.
- [x] `tests/harness/runtime-command-public-harness.ts` - public subprocess harness, kept as explicit Knip entry.
- [x] `tests/types/db-transaction-types.ts` - negative type fixture covered by `pnpm typecheck`, kept as explicit Knip entry.

Unused dependencies:

- [x] `@tanstack/react-query-devtools` - removed unused direct dependency.
- [x] `@tanstack/react-router-devtools` - removed unused direct dependency.
- [x] `fast-check` - removed unused direct dependency.
- [x] `pure-rand` - removed unused direct dependency.
- [x] `redaxios` - removed unused direct dependency.
- [x] `tailwind-merge` - removed unused direct dependency.

Unused exports:

- [x] `src/components/KiriBoard.tsx`: `mergeAgentDetail`
- [x] `src/components/kiri-board/storage.ts`: `saveThemeSelection`, `writeStoredAgentByProject`
- [x] `src/lib/contracts.ts`: `terminalModes`, `terminalConfigSchema`
- [x] `src/lib/ui-preferences.ts`: `keymapActions`, `chatFontSizeOptions`, `monoFontOptions`
- [x] `src/server/backend-readiness.ts`: `BackendReadinessService`
- [x] `src/server/codex-app-protocol.ts`: `CodexTurnSchema`, `JsonRpcRequest`, `JsonRpcNotification`
- [x] `src/server/codex-cli-sessions.ts`: `codexSessionsRoot`
- [x] `src/server/db.ts`: `closeKiriDb`
- [x] `src/server/db/connection.ts`: `configureKiriDatabase`
- [x] `src/server/db/schema.ts`: `agentDbRowSchema`
- [x] `src/server/directory-picker.ts`: `DirectoryPickerService`
- [x] `src/server/kiri-mcp-runtime.ts`: `KiriMcpRuntimeService`
- [x] `src/server/kiri-mcp.ts`: `createKiriMcpServer`
- [x] `src/server/pi-jsonl-file.ts`: `PiJsonlFileService`
- [x] `src/server/runtime-cleanup.ts`: `cleanupRuntimeSessions`, `cleanupProjectRuntimeSessions`, `RuntimeCleanupSession`
- [x] `src/server/runtime-projection.ts`: `makeDbRuntimeProjector`, `projectRuntimeEventToDb`, `fileOperationTimelineEvent`
- [x] `src/server/scratchpad-trigger.ts`: `ScratchpadTriggerError`
- [x] `src/server/scratchpad-trigger.ts`: `ScratchpadTriggerService`
- [x] `src/server/terminal-launch.ts`: `TerminalLaunchService`
- [x] `src/server/terminal-registry.ts`: `TerminalRegistryTimers`
- [x] `src/server/workspace-service.ts`: `runWorkspaceService`

## Current Test Coverage Map

- DB: `tests/server/db-*.test.ts`, `tests/types/db-transaction-types.ts`
- Runtime lifecycle/commands/cleanup: `tests/server/runtime-*.test.ts`
- Codex app-server/session state: `tests/server/codex-*.test.ts`, fake app server harness.
- Pi RPC/JSONL/session projection: `tests/server/pi-*.test.ts`.
- Settings/config/preferences/binaries: `tests/server/settings-service.test.ts`, `tests/server/kiri-config.test.ts`, `tests/server/preferences.test.ts`, `tests/server/runtime-binaries.test.ts`.
- Workspace/control/MCP: `tests/server/workspace-service.test.ts`, `tests/server/kiri-control-*.test.ts`, `tests/server/kiri-mcp*.test.ts`.
- Frontend pure helpers: `tests/kiri-board/*.test.ts`.
- E2E: `tests/e2e/kiri.spec.ts`.
- Perf: `tests/perf/run-perf.ts`, `tests/perf/run-client-render-perf.tsx`, `tests/server/perf-gates.test.ts`; `pnpm test` runs this gate serially after unit tests.
- Remaining future hardening outside this cleanup pass: component tests, axe-level coverage, broader dialog keyboard matrix beyond the current command/project/launcher/settings gates, and broad full-repo ESLint.

## File Coverage Ledger

Root/docs/config:

- `.agents/skills/kiri-control/SKILL.md` - keep; MCP-first workflow docs.
- `.agents/skills/kiri-projects/SKILL.md` - keep if still referenced; otherwise route to `kiri-control`.
- `.devcontainer/devcontainer.json` - no cleanup found.
- `.gitignore`, `.prettierignore`, `.vscode/settings.json` - no cleanup found.
- `AGENTS.md` - source of project instructions.
- `CHANGELOG.md`, `DESIGN.md`, `LOG.md`, `MISSION.md`, `PRODUCT.md`, `README.md`, `RENAME.md` - docs drift pass completed for active cleanup docs; unrelated historical docs left untouched.
- `docs/effect-migration-audit.md` - refreshed current audit counts and verification snapshot.
- `docs/effect-migration-tracker.md` - kept current as new pure/server helper modules were added.
- `docs/kiri-perf-memory-explainer.html` - retained and marked as generated report output.
- `specs/runtime-lifecycle.qnt` - keep; no cleanup found.
- `package.json` - verify scripts, Knip/devtools/deps, and desktop package file list triaged.
- `knip.jsonc` - strict Knip gate is clean with explicit harness/type-fixture entries.
- `settings.json`, `models.dev.local.json` - no cleanup found.
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.js` - no config simplification needed beyond staged lint scripts.
- `bun.lock`, `pnpm-lock.yaml` - updated after dependency cleanup.

Scripts/desktop/resources:

- `scripts/build-cli.mjs` - passed `node --check`.
- `scripts/create-desktop-dmg.mjs` - build-time; package contract keeps it out of app bundle files.
- `scripts/effect-migration-audit.mjs` - works; tracker must stay current.
- `scripts/install-desktop-app.mjs` - passed `node --check`.
- `scripts/kiri-desktop-backend.mjs` - kept as desktop bootstrap boundary; covered by desktop package/smoke gates.
- `scripts/kiri-projects.mjs` - removed; legacy duplicate of `kirictl projects`.
- `scripts/normalize-desktop-app.mjs` - build-time; package contract keeps it out of app bundle files.
- `scripts/sync-models-dev.mjs` - passed `node --check`.
- `src/desktop/main.mjs`, `src/desktop/preload.cjs` - desktop package contract and smoke gate exist; broader app-open verification remains in `pnpm install:desktop`.
- `resources/bin/kiri-mcp` - packaged helper path; keep and verify.

Frontend:

- `src/components/KiriBoard.tsx` - split into selection, preferences, shortcut, command/action, host menu, board-pane, and empty-state helpers; polling helper covered.
- `src/components/DefaultCatchBoundary.tsx`, `src/components/NotFound.tsx` - no cleanup found beyond standard UI tests.
- `src/components/kiri-board/agent-detail.ts` - keep; direct tests exist.
- `src/components/kiri-board/board-navigation.tsx` - covered by keymap and tab a11y flows.
- `src/components/kiri-board/board-types.ts` - runtime kind exhaustiveness covered by type fixture.
- `src/components/kiri-board/chat-panel.tsx` - split into composer, pending question, rich body, and message timeline; render budget covered.
- `src/components/kiri-board/dialogs.tsx` - removed after extracting settings, launcher, project manager, command palette, confirm dialog, and focus helpers.
- `src/components/kiri-board/diff-panel.tsx` - large diff render gate covers DB patch size plus rendered Pierre rows.
- `src/components/kiri-board/format.ts` - helper tests exist.
- `src/components/kiri-board/images.ts` - helper tests exist; runtime attachment parity covered separately.
- `src/components/kiri-board/navigation.ts` - helper tests plus keymap/a11y flows exist.
- `src/components/kiri-board/project-lane.tsx` - large board render budget later.
- `src/components/kiri-board/runtime-badge.tsx` - no cleanup found.
- `src/components/kiri-board/scratchpad.tsx` - component/a11y coverage later.
- `src/components/kiri-board/selected-agent-pane.tsx` - tab ARIA and terminal mount behavior covered by e2e.
- `src/components/kiri-board/slash-commands.ts` - tests exist.
- `src/components/kiri-board/storage.ts` - unused writer helpers removed; migration reads covered.
- `src/components/kiri-board/task-progress.tsx` - helper tests exist; UI render coverage later.
- `src/components/kiri-board/terminal-panel.tsx` - theme/focus regression covered.
- `src/components/kiri-board/timeline.ts` - helper tests exist.
- `src/lib/code-highlighter.ts` - code-block stress test.
- `src/lib/contracts.ts` - unused export triage and runtime exhaustiveness covered.
- `src/lib/host-capabilities.ts` - tests exist.
- `src/lib/ui-preferences.ts` - unused export triage complete.
- `src/routeTree.gen.ts` - generated; do not edit manually.
- `src/router.tsx`, `src/routes/index.tsx`, `src/routes/__root.tsx` - root metadata color typo fixed.
- `src/styles/app.css` - split into CSS imports and pruned with visual coverage.
- `src/theme/kiri-themes.ts` - theme visual coverage exists.
- `src/utils/seo.ts` - no cleanup found.

Server:

- `src/cli/kirictl.ts` - lint coverage and alias smoke.
- `src/server/backend-readiness.ts` - service tag is module-private; factory/wrapper stay exported.
- `src/server/backend-server.ts` - readiness transport.
- `src/server/codex-app-protocol.ts` - unused protocol exports triaged.
- `src/server/codex-app-server.ts` - stale protocol methods removed and completed-turn cache bounded.
- `src/server/codex-cli-sessions.ts` - tracker row and session discovery/resume tests exist; retained-state simplification remains outside this pass.
- `src/server/codex-retained-state.ts` - keep; tests exist.
- `src/server/codex-runtime.ts` - runtime-state, review/server-request, value, item-recording, and thread-state helpers extracted; orchestration remains.
- `src/server/db.ts` - compatibility facade simplified; caller migration continues through service seams.
- `src/server/db/agent-detail.ts` - keep; perf/history tests exist.
- `src/server/db/bootstrap.ts` - tests exist.
- `src/server/db/connection.ts` - unused export triage.
- `src/server/db/migrations.ts` - tests exist.
- `src/server/db/projects.ts` - rollback/reorder failure tests added.
- `src/server/db/runtime-state.ts` - corrupt runtime-state behavior covered.
- `src/server/db/schema.ts` - unused export triage.
- `src/server/db/scratchpad.ts` - tests exist.
- `src/server/db/session-operations.ts` - rollback/failure tests added.
- `src/server/db/sessions.ts` - rollback/failure tests added.
- `src/server/db/timeline-format.ts` - pure; no Effect needed.
- `src/server/db/timeline-writes.ts` - transaction simplification complete.
- `src/server/db/transaction.ts` - negative type test is covered by typecheck and Knip config.
- `src/server/db/workspace-snapshot.ts` - tests exist.
- `src/server/diff-refresh.ts` - public harness is an explicit Knip entry.
- `src/server/directory-picker.ts` - service tag is module-private; factory/wrapper stay exported.
- `src/server/git-diff.ts` - tests exist.
- `src/server/kiri-config.ts` - keep moving callers to service.
- `src/server/kiri-control.ts` - tests exist.
- `src/server/kiri-mcp-runtime.ts` - service tag is module-private; factory stays exported.
- `src/server/kiri-mcp.ts` - exported server creator triaged with MCP entrypoint coverage.
- `src/server/pi-jsonl-file.ts` - service tag is module-private; factory/wrapper stay exported.
- `src/server/pi-jsonl.ts` - pure projection; tests exist.
- `src/server/pi-retained-state.ts` - tests exist.
- `src/server/pi-rpc.ts` - stale async wrappers removed; invalid number handling covered.
- `src/server/pi-runtime.ts` - attachment extraction and runtime binary service injection complete.
- `src/server/preferences.ts` - workspace preference writes now go through service seam.
- `src/server/provider-runtime.ts` - terminal-only runtime modeling complete.
- `src/server/runtime-binaries.ts` - production launch paths use service APIs with compatibility wrappers retained.
- `src/server/runtime-cleanup.ts` - unused export triage complete.
- `src/server/runtime-file-operations.ts` - pure; tests exist.
- `src/server/runtime-lifecycle.ts` - tests exist.
- `src/server/runtime-projection.ts` - unused export triage complete.
- `src/server/runtime.ts` - typed capability dispatch simplification complete.
- `src/server/scratchpad-trigger.ts` - service tag is module-private; error export triage complete.
- `src/server/settings.ts` - keep moving callers to service.
- `src/server/terminal-launch.ts` - env split, exhaustive runtime dispatch, and state parser coverage complete.
- `src/server/terminal-registry.ts` - tests exist; timer exported type triage complete.
- `src/server/terminal-server.ts` - scoped service and retry-safe startup complete.
- `src/server/workspace-service.ts` - wrapper simplification and service seams complete.
- `src/server/workspace.ts` - transport only; keep slimming.

Tests/harness:

- `tests/e2e/kiri.spec.ts` - valuable but large; split by flow after helpers exist.
- `tests/harness/diff-refresh-public-harness.ts` - explicit Knip entry.
- `tests/harness/effect-layers.ts` - keep.
- `tests/harness/fake-codex-app-server.mjs` - large untyped fixture; split typed builders from server.
- `tests/harness/fake-codex-terminal.mjs` - explicit Knip entry.
- `tests/harness/kiri-agent-cli-harness.ts` - keep.
- `tests/harness/kiri-agent-detail-history-harness.ts` - keep.
- `tests/harness/runtime-command-public-harness.ts` - explicit Knip entry.
- `tests/harness/scratchpad-trigger-harness.ts` - keep.
- `tests/harness/task-progress-db-harness.ts` - keep.
- `tests/kiri-board/*.test.ts` - pure frontend helper tests; add component tests around them.
- `tests/lib/host-capabilities.test.ts` - keep.
- `tests/perf/run-perf.ts` - server perf gate retained; browser render perf added in Playwright and SSR harness.
- `tests/server/*.test.ts` - server failure/rollback tests listed above were added for touched areas.
- `tests/types/db-transaction-types.ts` - type fixture covered by `pnpm typecheck` and explicit Knip entry.

Static assets:

- `public/android-chrome-192x192.png`, `public/android-chrome-512x512.png`, `public/apple-touch-icon.png`, `public/favicon-16x16.png`, `public/favicon-32x32.png`, `public/favicon.ico`, `public/favicon.png`, `public/site.webmanifest` - static app assets; no code simplification.
- `public/ghostty-vt.wasm` - terminal dependency asset; keep and verify packaged loading.
