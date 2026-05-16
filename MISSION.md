# Mission

Complete the Kiri performance, memory, and Effect migration in safe phases without feature loss, behavioral regressions, or unbounded retained state.

## Current Goal

Implement `SIMPLE.md` section by section with coverage before refactors, no functionality changes, and review subagents after each meaningful chunk.

# Done Criteria

- [ ] Current `SIMPLE.md` work is implemented and committed in logical blocks on `chore/simple-audit`.
- [x] `LOG.md` tracks the goal, phase progress, verification, review findings, and residual risks.
- [x] `docs/effect-migration-tracker.md` tracks every server migration target and per-file review gate.
- [ ] Every migration-scope server file is either behind an Effect service/layer or explicitly classified as a non-migration with rationale.
- [ ] Oversized DB/config/runtime/workspace/terminal modules are split only behind tests and compatibility exports.
- [ ] Perf budgets stay enforced for snapshot hydration, agent detail hydration, returned timeline rows, returned diffs, payload size, and RSS delta.
- [ ] Runtime and terminal retained state has bounded ownership and cleanup coverage.
- [ ] UI, CLI, MCP, scratchpad, terminal, runtime, and project/session flows keep focused smoke coverage.
- [ ] A review subagent runs after every migrated file or tightly-coupled group; blockers are fixed before the next phase.
- [ ] Review gate exceptions caused by external usage limits are recorded in `SIMPLE.md` and cleared before final completion.
- [ ] Each phase is committed in a logical block after tests, lint, migration audit, and review pass.
- [ ] Final branch verification runs typecheck, lint, unit tests, perf gates, migration audit, Knip triage, and relevant browser/Playwright smokes.
- [ ] Final detailed interactive HTML explainer documents the completed architecture, harnesses, perf/memory wins, and remaining risks.

# Guardrails

- Preserve public behavior unless a test and tracker note explicitly pin a narrowed contract.
- Do not remove features to simplify the Effect migration.
- Consult `effect-solutions` before writing new Effect code.
- Keep compatibility exports until all callers have moved to the service boundary.
- Use focused tests before moving behavior, then review subagents before commits.
- Do not rewrite large modules for aesthetics; split one responsibility at a time.

# Critical Learnings

- `getAgentDetail(limit)` now enforces bounded detail hydration and the perf gate proves row/diff/payload/RSS budgets.
- Scratchpad session creation is unified through `triggerScratchpadSession`, preserving terminal behavior and GUI prompt enqueue cleanup.
- DB extraction is progressing through compatibility exports; final migrated status waits for DB service/layer ownership.
- Config, settings, preferences, runtime commands, runtime binaries, and git diff capture now have typed injectable service seams while legacy callers remain supported.
- Review gates have caught real compatibility gaps, including FiberFailure unwrapping and settings error-message parity; keep exact sync export behavior pinned.
