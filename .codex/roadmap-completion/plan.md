# Kiri Roadmap Completion Plan

## Phase 0: Goal Ledger

- Create durable goal and phase plan.
- Reconfirm README roadmap status.

## Phase 1: Plan 011 Terminal Event Sync

- Status: code complete; public README status waits for final app/full gate.
- Added per-key terminal state, generation/cursor read metadata, replacement frames, key-based WS routing, and follow-replacement waits.
- Removed the renderer reconnect-on-exit shim; exit now means offline-but-subscribed, and `replaced` plus snapshot restores the live buffer.
- Verified:
  - `pnpm typecheck`
  - `pnpm exec vitest run tests/server/terminal-registry.test.ts tests/server/terminal-control.test.ts tests/server/terminal-server.test.ts tests/server/kiri-control-service.test.ts`
  - `pnpm exec eslint src/server/terminal-registry.ts src/server/terminal-control.ts src/server/terminal-server.ts tests/server/terminal-registry.test.ts tests/server/terminal-control.test.ts tests/server/terminal-server.test.ts tests/server/kiri-control-service.test.ts --max-warnings=0`
  - `pnpm exec vitest run tests/kiri-board/`
  - `pnpm exec vitest run tests/server/` reached the existing non-011 failures only: missing Effect tracker row for `src/server/codex-hook-handler.ts`, stale `claude-sonnet-4-5` in `runtime-command-public-harness.ts`.

## Phase 2: Plan 014 Agent Hook Foundation

- Implement resume-aware hook binding.
- Make hooks fire-and-forget with bounded failure surfaces.
- Add Claude settings hook bundle and PATH shims as specified.
- Anchor transcript/event ingestion to process identity where required.

## Phase 3: Plan 013 Tactical Thread Mapping

- Layer tactical thread mapping correctness on the hook foundation.
- Ensure slot/session/thread identity survives resume/restart boundaries.
- Verify with actual Codex sessions and control APIs.

## Phase 4: Plan 015 State Machine Hardening

- Tighten session lifecycle states and illegal transitions.
- Update cleanup/recovery behavior and tests.
- Keep D12 overlap closed by plan 018/H7 evidence.

## Phase 5: Plan 017 Agent Surfaces

- Implement Codex todos, titles, scratchpad, and knowledge surfaces.
- Verify UI/API behavior with real sessions.

## Phase 6: Plan 019 OSC 3008 Presence

- Add OSC 3008 agent presence support or explicitly decision-close if the plan's evidence rejects it.
- Verify terminal transport and UI behavior.

## Phase 7: Plan 020 zmx Durable Sessions

- Run the spike/prototype called for by the plan.
- Record the decision gate outcome.
- Implement the accepted minimal integration or mark as decision-closed with evidence.

## Phase 8: Ship Gate

- Run targeted tests, `pnpm build`, and full test sweep.
- Run `pnpm install:desktop`.
- Exercise the installed app with real projects/sessions/terminals.
- Run xhigh review subagents and fix blockers.
- Commit logical shipped slices.
