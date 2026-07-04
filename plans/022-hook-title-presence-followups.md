# Plan 022: Hook, title & presence follow-ups (post-014/017/019)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e464651..HEAD -- src/server/terminal-launch.ts src/server/claude-hook-handler.ts src/server/codex-hook-handler.ts src/server/agent-presence.ts src/server/terminal-shim.ts src/cli/kirictl.ts src/server/db/timeline-writes.ts src/server/db/session-title.ts tests/server/claude-hook-handler.test.ts tests/server/codex-hook-handler.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 014/017/019 (all DONE — this plan closes gaps between
  them); 021 step 1 (hook write reliability improves once the proxy
  fallback is fixed)
- **Category**: bugfix / reliability
- **Planned at**: commit `e464651`, 2026-07-04
- **Status**: DONE — unified hook table, Stop fallback, blocked recovery, Claude subagent/session guard, Codex terminal task push, mid-session retitle, and hook write reliability landed; focused gates pass

## Why this matters

Plans 014 (hook bundle), 017 (auto-titles from projections), and 019 (OSC
presence) each landed, but their seams don't fully close. A 2026-07-03
audit of the hook→title→presence pipeline found the launch-path split left
capabilities wired in one path but not the other, and titles still go stale
mid-session:

1. **The `Stop` title fallback is dead on the normal launch path.**
   `handleClaudeHook('stop')` can rename a default title from the payload
   (`maybeRenameDefaultTitle`, `src/server/claude-hook-handler.ts:277-294`),
   but `terminal-launch.ts:243` routes `Stop` to OSC-only presence
   (`agentPresenceShellCommand('claude','idle')`). Only the PATH-shim
   compatibility path (`src/server/terminal-shim.ts:113`) reaches it. The
   two wirings disagree on which events reach kirictl at all
   (launch: SessionStart + PostToolUse only; shim: all seven).
2. **`blocked` status can stick.** `PreToolUse(AskUserQuestion|ExitPlanMode)`
   and `PermissionRequest` emit `awaiting_input` (`terminal-launch.ts:245-246`)
   but nothing emits a recovery transition when the tool completes —
   plan 019 specified PostToolUse→idle
   (`plans/019-osc-agent-presence.md:76`) and the launch split omitted it.
3. **Claude subagents can clobber parent state.** The Codex handler rejects
   `thread_source:"subagent"` and wrong cwd
   (`src/server/codex-hook-handler.ts:27,80`); the Claude handler gates only
   on `KIRI_AGENT_ID`/`KIRI_SESSION_DIR` (`claude-hook-handler.ts:49-53`),
   so a subagent inheriting env can overwrite the parent's binding, status,
   and TodoWrite-derived tasks (plan 013 fixed this for Codex only).
4. **Terminal Codex has no lifecycle coverage past SessionStart.**
   `codexLaunch` wires only `hooks.SessionStart`
   (`terminal-launch.ts:355`); status/tasks rely on JSONL pulls that happen
   on `agent.detail`/`task.list` *reads*, so an unwatched Codex session
   shows stale status/title until something reads it.
5. **Titles still drift mid-session.** Auto-title fires only from
   first-message projection or task replacement while
   `title_set_manually=0` (`src/server/db/session-title.ts:9`,
   `db/timeline-writes.ts:85,190,263`). A session that changes topic
   without TodoWrite/`update_plan` keeps its old title unless the model
   volunteers `session.rename`.
6. **Hook writes can vanish silently.** The hook watchdog exits at 5s
   (`src/cli/kirictl.ts:297-299`) while the backend proxy waits up to 15s;
   `readHookStdinFile` unlinks the payload even when handling fails
   (`src/cli/kirictl.ts:289-295`); `handleClaudeHook` never checks the
   operation response (`claude-hook-handler.ts:75,118`), so `ok:false`
   writes are recorded as hook success.

## Steps

### 1. Unify the two hook wirings

Make `terminal-launch.ts` and `terminal-shim.ts` produce the same event→
handler mapping from one shared table (new export in
`claude-hook-handler.ts` or a small module both import). Policy per event:
**presence transitions stay OSC** (019's win: zero process spawn), **state
writes go through kirictl** — i.e. launch path adds `Stop` (title fallback
+ idle) and keeps SessionStart/PostToolUse; both paths get
PostToolUse→idle presence recovery (step 2). Claude supports multiple hook
commands per event, so `Stop` can carry both the OSC printf and the kirictl
invocation; verify against the settings schema written at
`terminal-launch.ts:249-253`.

### 2. Presence recovery transitions

Add `PostToolUse` → `agentPresenceShellCommand('claude','busy')` (the turn
is still running after a tool completes — Stop marks idle) so
`awaiting_input` from PreToolUse/PermissionRequest cannot stick past the
tool call. Confirm the OSC parser dedupes repeated states cheaply
(`src/server/agent-presence.ts`), since PostToolUse fires often.

### 3. Claude subagent guard

Mirror the Codex guard: Claude hook payloads for subagents (check
documented payload markers — `parent_tool_use_id`, `agent_type`, or
transcript path differences; verify against a real subagent payload before
trusting field names) must no-op for binding/status/tasks writes. At
minimum, compare payload `session_id` against the recorded binding's
`sessionId` for non-SessionStart events and skip on mismatch
(`claude-hook-handler.ts:139-175` already persists it).

### 4. Codex terminal lifecycle push

Move Codex status from read-time pull to a push: the existing JSONL
watcher/read-model path (`src/server/codex-jsonl-tasks.ts:80`,
`src/server/codex-terminal-session.ts:114`) should emit
`agent.status.set`/task updates when the file changes, not when a read
happens. If a file watcher is too invasive, a bounded poll owned by the
backend (not the reader) is acceptable. Scope: terminal-mode Codex only;
GUI runtimes already project status.

### 5. Hook write reliability

- Check operation responses in `handleClaudeHook`; return `ok:false` with
  the operation error so kirictl logs it (`console.error` path already
  exists, `src/cli/kirictl.ts:307-311`).
- Only unlink `--stdin-file` after successful handling; on failure leave it
  and log the path (`src/cli/kirictl.ts:289-295`).
- Raise the hook watchdog to cover one proxy attempt (proxy timeout + 2s)
  or pass a short `KIRI_BACKEND_CONTROL_TIMEOUT_MS` (e.g. 3s) into hook
  invocations so the 5s watchdog can't truncate a pending write.

### 6. Mid-session title refresh (scoped)

Extend 017's projection auto-title: while `title_set_manually=0`, allow
re-title on `UserPromptSubmit` (derive from the new prompt text, same
truncation rules as `titleCandidate`, `claude-hook-handler.ts:296-304`) —
not just on first message. This requires wiring `user-prompt-submit`
through kirictl in the launch path (step 1 table) or deriving it
server-side from message projection (preferred: no new hook spawn; the
projection already sees the user message). Keep `session.rename` (manual)
sticky as today.

### 7. Verification

- `pnpm typecheck && pnpm lint`
- Focused: `pnpm vitest run tests/server/claude-hook-handler.test.ts tests/server/codex-hook-handler.test.ts tests/server/terminal-launch.test.ts tests/server/terminal-shim.test.ts` (adjust names to actual files)
- New tests: launch-vs-shim wiring parity (one table drives both), subagent
  no-op, failed-write retention of stdin file, stuck-blocked recovery
  (PreToolUse→PostToolUse sequence ends `busy`), mid-session retitle while
  `title_set_manually=0` and not after manual rename.
- Manual smoke: spawn a terminal Claude session from Kiri, let it TodoWrite,
  answer a permission prompt, and confirm board status transitions
  busy→awaiting_input→busy→idle and the title updates from the first todo.

## STOP conditions

- If Claude Code's settings schema rejects multiple commands per hook event
  (step 1), stop — the split needs a combined shell command instead.
- If real subagent payloads carry no distinguishing field (step 3), stop and
  report; do not guess a heuristic that could drop legitimate parent events.
- If the JSONL watcher (step 4) measurably raises idle CPU with many
  sessions, fall back to the bounded backend-owned poll and note it.
- 019 deliberately deferred daemon-mode OSC projection; if step 2 requires
  it, keep the daemon path out of scope and note the gap.
