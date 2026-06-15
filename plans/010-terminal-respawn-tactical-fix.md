# Plan 010: Stop duplicate PTY spawns and auto-reattach the renderer on respawn

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 297e31e..HEAD -- src/server/terminal-server.ts src/server/terminal-registry.ts src/server/terminal-subscriptions.ts src/components/kiri-board/terminal-panel.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (precedes / is subsumed by plan 011)
- **Category**: bugfix (terminal lifecycle)
- **Planned at**: commit `297e31e`, 2026-06-15

## Why this matters

Two confirmed defects make a terminal session diverge from its live runtime —
the renderer pane freezes on a dead PTY buffer while a new PTY streams
elsewhere (observed when driving a session over the Kiri MCP terminal ops,
where `terminal.read` resolves the live runtime fresh but the app pane does
not):

1. **Spawn race → duplicate PTYs.** `spawnAgentRuntime`
   (`terminal-server.ts:278-296`) is `async` and guards reuse only with the
   synchronous `getReusable` Map lookup (`terminal-registry.ts:116-131`). There
   is no in-flight dedup. Two concurrent callers for the same agent both see no
   session and both `spawnPty`; the second `register`
   (`terminal-server.ts:~473` → `terminal-registry.ts:174` `sessions.set`)
   overwrites the first entry under key `` `${agentId}:runtime` ``
   (`terminal-registry.ts:109-113`), **leaking** the first PTY (untracked,
   never killed). Concurrent callers exist: subscription wake
   (`terminal-subscriptions.ts:237` `spawnForDelivery`) and the renderer's
   terminal-config request (`workspace-service.ts:397-400`), plus the daemon
   path (`kiriterm-daemon.ts:364-368`).

2. **No renderer re-attach on respawn.** On PTY exit the server sends an `exit`
   frame, closes every socket, and removes the session
   (`terminal-registry.ts:410-429`). The renderer's `socket.onclose`
   (`terminal-panel.tsx:379-383`) sets `status='Closed'` but does **not**
   reconnect. Reconnect only fires on a visibility toggle while already closed
   (`terminal-panel.tsx:125-137`, gen counter in deps at line ~437). A pane
   that is already visible during respawn stays frozen on the old xterm buffer.

The 404 string `No session <id>:runtime` is the control API
(`terminal-control.ts:193,201,230`) failing to find the key while this is in a
bad state.

## Relationship to plan 011

Plan 011 reworks the WS attach to subscribe to a logical key with a per-key
event log + `replaced` event (the correct architecture, also fixing MCP). This
plan (010) is the **tactical patch**: smallest diff that stops the data loss
now. If the team commits to 011 immediately, 010's Step 2 (renderer
auto-reconnect) may be skipped in favor of 011's subscribe-across-respawn — but
010's Step 1 (spawn dedup) is worth doing regardless and is independent.

## Current state

- `src/server/terminal-server.ts`
  - `makeTerminalServerService` scope (~line 229) — where a per-key in-flight
    map will live.
  - `spawnAgentRuntime` (278-296) — calls
    `getOrCreateTerminalSession(runtime, config, 'runtime', cols, rows)`.
  - `getOrCreateTerminalSession` (446-513) — `getReusable` then `spawnPty` +
    `register`. The async gap between the lookup and the register is the race
    window.
- `src/server/terminal-registry.ts`
  - `sessionKey` (109-113): `` `${config.id}:runtime` `` for non-shell modes.
  - `getReusable` (116-131): sync Map lookup; kills mismatched-cwd session.
  - `register` (~174): `sessions.set(session.key, session)` — silent overwrite.
  - `exit` (410-429): closes sockets, `deleteOwnedSession`, `disposeEmulator`.
  - If `sessionKey` is not exported from the service surface, expose a tiny
    read-only key helper rather than duplicating the string literal.
- `src/components/kiri-board/terminal-panel.tsx`
  - `connect()` effect (~167-437): fetches config, builds xterm, opens WS to
    `?agentId=<id>&mode=<mode>`.
  - `handleServerFrame` `'snapshot'` branch does `term.reset()` (~line 229) —
    so a fresh snapshot after reconnect wipes the stale buffer automatically.
  - `socket.onclose` (379-383): sets `status='Closed'`, no reconnect.
  - visibility-based reconnect (125-137); `connectionGeneration` in effect deps
    (~437).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Server tests | `pnpm exec vitest run tests/server/` | all pass |
| Board tests | `pnpm exec vitest run tests/kiri-board/` | all pass |
| Unit tests | `pnpm test:unit` | all pass |
| Build | `pnpm build` | exit 0 |
| E2E (chromium) | `pnpm verify:e2e` | all pass |

## Scope

**In scope**:
- `src/server/terminal-server.ts` — in-flight spawn dedup.
- `src/server/terminal-registry.ts` — only if a key helper must be exposed for Step 1 (no behavior change).
- `src/components/kiri-board/terminal-panel.tsx` — auto-reconnect on runtime exit.
- `tests/server/` and/or `tests/kiri-board/` — regression tests.

**Out of scope** (do NOT touch):
- The WS attach model / event log (that is plan 011).
- MCP `terminal.read` / `wait-for` contract (plan 011).
- Shell-mode sessions (`${projectId}:shell`) — the race fix is keyed and
  applies to `:runtime`; do not change shell reuse semantics.
- The kiriterm daemon's own maps (plan 004 territory).

## Git workflow

- Branch: `advisor/010-terminal-respawn-tactical-fix`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Dedup concurrent runtime spawns

In `terminal-server.ts`, add a per-key in-flight promise map in the
`makeTerminalServerService` scope:

```ts
const spawnInFlight = new Map<string, Promise<TerminalRegistrySession>>()
```

Rewrite `spawnAgentRuntime` to collapse concurrent spawns for the same key:

```ts
spawnAgentRuntime: async (input) => {
  await ensureRuntimeTerminalServer(runtime)
  const config = runtime.dependencies.getAgentLaunchConfig(input.agentId)
  const key = runtime.registry.sessionKey(config, 'runtime') // `${agentId}:runtime`
  let inflight = spawnInFlight.get(key)
  if (!inflight) {
    inflight = getOrCreateTerminalSession(
      runtime, config, 'runtime', input.cols ?? 100, input.rows ?? 30,
    ).finally(() => { spawnInFlight.delete(key) })
    spawnInFlight.set(key, inflight)
  }
  const session = await inflight
  runtime.registry.scheduleIdleKill(session)
  return { agentId: input.agentId, mode: 'runtime' }
},
```

If `registry.sessionKey` is not part of the registry's public surface, add a
minimal read-only accessor (or compute the same key inline using the existing
helper) — do NOT hand-inline the `${id}:runtime` string in a way that can drift
from `sessionKey`.

**Verify**: `pnpm typecheck` → 0; `pnpm exec vitest run tests/server/` → pass.

### Step 2: Auto-reconnect the renderer after a runtime PTY exits

In `terminal-panel.tsx`, distinguish a normal PTY exit (server sent an `exit`
frame → a respawn is expected) from an arbitrary socket drop, and reconnect
only for runtime mode:

- Track `let receivedExitFrame = false` in the connect scope; set it true in the
  `handleServerFrame` `'exit'` branch.
- In `socket.onclose` (379-383):

```ts
socket.onclose = () => {
  if (disposed) return
  setStatus('Closed')
  appendTranscript('\r\n[kiri terminal socket closed]\r\n')
  if (mode === 'runtime' && receivedExitFrame) {
    window.setTimeout(() => {
      if (!disposed) setConnectionGeneration((g) => g + 1)
    }, 1500)
  }
}
```

Bumping `connectionGeneration` re-runs the connect effect → new
`terminalConfig` fetch → `spawnAgentRuntime` (now deduped) → new WS → fresh
`snapshot` frame → existing `term.reset()` wipes the frozen buffer.

Guard against an infinite reconnect loop: only auto-reconnect after an `exit`
frame (not on every close), use the delay, and bail when `disposed`. If a
reconnect immediately gets another `exit`, do not escalate — let the next close
go through the same single delayed bump (no unbounded retry counter needed for
the common respawn case; if a backoff is wanted, cap at a small constant and
record it).

**Verify**: `pnpm typecheck` → 0; `pnpm exec vitest run tests/kiri-board/` → pass.

### Step 3: Regression tests

- Server: a test that calls `spawnAgentRuntime` twice concurrently
  (`Promise.all`) for one agent and asserts `spawnPty` ran once / only one
  session exists under the key. Use the existing terminal-server test
  harness/fakes (`tests/server/`); follow how other tests fake `spawnPty`.
- Renderer: if `terminal-panel` has a test seam, assert that an `exit` frame
  followed by socket close bumps the connection generation (reconnect) for
  `mode==='runtime'`, and does NOT for a plain close without an exit frame.
  If no seam exists, do not build new infra — record the manual check below.

**Verify**: `pnpm exec vitest run tests/server/ tests/kiri-board/` → pass.

### Step 4: Behavior check (manual)

1. Run the app; open an agent runtime terminal and keep it visible.
2. Cause the runtime to exit/respawn (kill the runtime proc, or trigger a
   wake-delivery respawn). The pane should briefly show closed, then reconnect
   and render the NEW runtime's snapshot — not stay frozen.
3. Drive the same session over MCP (`terminal.read`) and confirm the app pane
   and `terminal.read` now show the SAME live buffer (no divergence).
4. Confirm no orphaned PTYs accumulate across several respawns (e.g. process
   count / registry size stays bounded).

**Verify**: `pnpm verify:e2e` → pass; manual results recorded in PR description.

## Test plan

- The concurrent-spawn test is the core net for defect 1.
- The exit→reconnect test (or manual Step 4.2) covers defect 2.
- Step 4.3 is the divergence regression check that motivated the work.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test:unit` exits 0
- [ ] `pnpm build` exits 0
- [ ] `pnpm verify:e2e` exits 0
- [ ] Concurrent `spawnAgentRuntime` for one agent creates exactly one PTY (test asserts)
- [ ] A visible runtime pane reconnects and shows the new snapshot after respawn (Step 4.2)
- [ ] App pane and MCP `terminal.read` agree after respawn (Step 4.3)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match live code (drift) — especially `spawnAgentRuntime`,
  `getReusable`, or `socket.onclose`.
- Auto-reconnect causes a reconnect storm (repeated immediate `exit` frames) —
  the cause is upstream (the new PTY also dies); fix that, do not add unbounded
  retries.
- The dedup map changes shell-mode reuse behavior or breaks idle-kill
  scheduling.
- A reconnect loses scrollback because the new session's snapshot does not
  replay — that points at the registry snapshot path, escalate to plan 011.

## Maintenance notes

- This is the bridge to plan 011. Once 011's subscribe-to-key + `replaced`
  event lands, Step 2's client-side reconnect-on-exit becomes redundant (the
  subscriber stays attached across respawn) and should be removed to avoid two
  reconnect mechanisms. Note that in the 011 PR.
- The in-flight dedup (Step 1) is correct independently and should remain even
  after 011.
