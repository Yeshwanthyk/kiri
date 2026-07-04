# Kiri Roadmap Completion Goal

## Outcome

Complete the remaining Kiri roadmap plans end to end: 011, 013, 014, 015, 017, 019, and 020. Each row must be implemented or explicitly decision-closed in the plan README, with verification evidence and clean commits.

## Baseline

- Branch: `main`, ahead of `origin/main` by the previously shipped roadmap commits.
- Current completed rows: 001-010, 012, 016, 018.
- Remaining rows:
  - 011 terminal event sync.
  - 013 tactical Codex thread mapping correctness.
  - 014 agent hook foundation.
  - 015 session state-machine hardening.
  - 017 Codex todos, titles, scratchpad, and knowledge surface.
  - 019 OSC 3008 agent presence.
  - 020 zmx durable sessions spike and decision gate.

## Constraints

- Preserve user and prior agent changes.
- Keep changes scoped to roadmap behavior and its tests/docs.
- Use real app/runtime verification, not only unit tests.
- No history rewrites, destructive database edits, or pushing without explicit user approval.
- Do not hard-code runtime model menus; runtime choices come from `settings.json`.
- Consult `effect-solutions` before writing Effect patterns.

## Non-Goals

- Do not broaden into unrelated UI redesigns or runtime model changes.
- Do not implement future roadmap ideas outside 001-020 unless required as a decision note.
- Do not mutate Kiri SQLite by hand; use the control CLI for real items.

## Verification

- Targeted tests for each changed subsystem.
- `pnpm build`.
- Full test run, with any pre-existing drift fixed or documented.
- `pnpm install:desktop`.
- Installed app launches from `~/Applications/kiri.app`.
- Packaged backend is live.
- Real project/session/terminal checks cover respawn, rejoin, hook delivery, and durable state behavior.
- xhigh review subagents report no blockers.

## Completion Proof

- `plans/README.md` rows 001-020 are all `DONE`, `REJECTED`, or decision-closed with notes.
- Relevant plan files are updated with final status/evidence.
- Verification commands and real app checks are recorded.
- Commits are logical and leave the worktree clean.
