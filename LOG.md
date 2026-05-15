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

## Remaining Knip Findings

- Unused dependency candidates retained for now instead of removing features blindly: `@tanstack/react-query-devtools`, `@tanstack/react-router-devtools`, `fast-check`, `pure-rand`, `redaxios`, `tailwind-merge`.
- Unused exported API candidates retained as public/internal contract surface until a separate API-pruning pass: storage helpers, contract symbols, UI preference constants, `createKiriMcpServer`, and `makeRuntimeRegistry`.
