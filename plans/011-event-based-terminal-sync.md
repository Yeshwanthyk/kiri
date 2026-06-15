# Plan 011: Subscribe-to-key terminal sync with respawn-as-an-event

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 297e31e..HEAD -- src/server/terminal-registry.ts src/server/terminal-server.ts src/server/terminal-subscriptions.ts src/server/terminal-control.ts src/server/kiri-control.ts src/components/kiri-board/terminal-panel.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED-HIGH
- **Depends on**: 010 (soft — 010 ships the urgent bugfix; 011 supersedes 010's client reconnect)
- **Category**: architecture (terminal/runtime consistency)
- **Planned at**: commit `297e31e`, 2026-06-15

## Why this matters

Today a terminal session's identity in the renderer is **the WebSocket
attachment to a specific PTY session object**. When the PTY exits, the socket
closes and the attachment is dead; nothing re-binds the consumer to the
replacement PTY. The MCP surface (`terminal.read`) re-resolves the live runtime
on every call, so the renderer and MCP consumers **diverge** across a respawn —
one renders a dead buffer while the other streams the new one. `terminal.read`
is also a screen-snapshot **poll**, and `terminal.wait-for` is capped by a
~15s backend control timeout, forcing client polling loops.

The root cause is architectural: there is no single, durable source of truth
for a session's terminal that survives PTY replacement, and consumers bind to a
transient process rather than a stable logical key. (Confirmed independently:
"the UI reconnects only on remount, prop/key change, or becoming visible after
a closed status; MCP respawn does not change any of those.")

This is the answer to "should this be MCP / event-based?": **keep MCP, but
change its semantics** from "snapshot-poll a session object" to "subscribe to a
logical key backed by a per-session event log + generation" that the renderer
and MCP both consume. Respawn becomes a first-class event every subscriber
follows.

## Target design

1. **Single source of truth — per-key event log + generation.** In
   `terminal-registry.ts`, each logical key (`` `${agentId}:runtime` `` /
   `` `${projectId}:shell[:term]` ``) owns: an output stream/ring buffer, a
   monotonically increasing `generation` (bumped on each PTY (re)spawn), and a
   small lifecycle event stream (`spawned` / `output` / `exit` / `replaced`).
   The PTY process is an *implementation detail behind the key*, not the
   identity.

2. **Subscribe to the key, not the session object.** The terminal WS attach in
   `terminal-server.ts` subscribes to the logical key. Subscribers persist
   across PTY replacement.

3. **Respawn is an event.** On PTY exit: mark "no live proc" but **keep
   subscribers attached** (do not force-close their sockets). On (re)spawn:
   bump `generation`, publish `replaced`, and push a fresh `snapshot` to all
   subscribers — renderer and MCP both re-bind automatically. No reconnect race,
   no visibility-toggle dependency.

4. **MCP becomes event-aware.** `terminal.read` returns
   `{ screen, generation, cursor }` for incremental/cursor-based reads;
   `terminal.wait-for` reruns on the event stream with `followReplacement: true`
   so a respawn does not abandon the wait; long waits use server-side
   await/wake semantics instead of client polling loops. The existing condition
   engine (wait-any / idle / pattern — see the unified `workflow.await` engine)
   becomes a **consumer of the event log**, not the bus itself.

5. **Minimal UI change.** `TerminalPanel` treats `exit` as
   offline-but-still-subscribed rather than "closed, stop"; its existing
   `snapshot` handler already calls `term.reset()`, so the `replaced`+snapshot
   sequence clears the stale frame with no new client reconnect logic.

## Current state

- `src/server/terminal-registry.ts`
  - `sessions: Map<string, TerminalRegistrySession>` keyed by `sessionKey`
    (109-113). Today the value is tightly coupled to one PTY proc + sockets.
  - `register` (~174) `sessions.set(...)`; `exit` (410-429) closes sockets +
    deletes + disposes. This is where the log/generation/lifecycle stream and
    the "keep subscribers on exit" behavior are introduced.
  - `snapshot(session, scrollbackLines)` (~280) already produces replayable
    output — reuse it for the post-`replaced` push.
- `src/server/terminal-server.ts`
  - WS attach + `getOrCreateTerminalSession` (446-513); `spawnAgentRuntime`
    (278-296). Attach must move from "bind to session" to "subscribe to key".
- `src/server/terminal-subscriptions.ts`
  - `spawnForDelivery` (237) and delivery target `` `${agentId}:runtime` ``
    (147). Should consume the event log; its idle/pattern condition engine is
    the reusable "await/wake" primitive.
- `src/server/terminal-control.ts` (193,201,230) — the `read` / `snapshot` /
  `wait-for` control routes; extend their contracts (generation/cursor;
  followReplacement).
- `src/server/kiri-control.ts` (496,574,924) and `kiri-mcp.ts` /
  `kirictl.ts` — MCP/CLI surfaces that construct the key and call the control
  routes; update to pass/return the new fields. The ~15s cap lives near the
  terminal control request path (search `15000` / `AbortSignal` /
  `terminalControlRequest`).
- `src/components/kiri-board/terminal-panel.tsx`
  - WS attach (~354) and `handleServerFrame` (`snapshot` resets xterm at ~229;
    `exit` at the close path 379-383). Change `exit` handling to
    offline-but-subscribed; remove the plan-010 reconnect-on-exit shim.

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
- `src/server/terminal-registry.ts` — event log, generation, lifecycle stream, keep-subscribers-on-exit.
- `src/server/terminal-server.ts` — subscribe-to-key attach; publish `replaced`+snapshot on respawn.
- `src/server/terminal-control.ts` — `read` returns `{screen, generation, cursor}`; `wait-for` `followReplacement`.
- `src/server/kiri-control.ts`, MCP/CLI surfaces — thread the new fields; server-side await/wake for long waits.
- `src/server/terminal-subscriptions.ts` — consume the event log (do not duplicate it).
- `src/components/kiri-board/terminal-panel.tsx` — exit = offline-but-subscribed.
- Contracts type files for the frame/route shapes.
- `tests/server/`, `tests/kiri-board/`.

**Out of scope** (do NOT touch):
- The browser keymap subsystem (plan 009).
- Shell-tab unmount behavior (plan 005) and daemon memory bounds (plan 004) —
  do not regress them; the ring-buffer/log must respect the existing scrollback
  cap (`terminal-registry.ts:91`).
- Rewriting the kiriterm daemon transport; this plan layers the log/generation
  inside the existing registry + WS, it does not replace the daemon.

## Git workflow

- Branch: `advisor/011-event-based-terminal-sync`
- Commit style: short imperative subject, no prefix.
- Land in the step order below as separate commits so each is independently
  reviewable/revertable.
- Do NOT push or open a PR unless the operator instructed it.

## Steps (smallest viable first, in order)

### Step 1: Per-key lifecycle events + generation in the registry

Introduce, per logical key: a `generation` counter, and a lifecycle event
emitter (`spawned`/`output`/`exit`/`replaced`). Keep the existing output
buffering/scrollback; expose a subscribe API that yields the current snapshot +
subsequent events. Do not change attach behavior yet — just publish.

**Verify**: `pnpm exec vitest run tests/server/` → pass; new test asserts
`generation` increments on respawn and a `replaced` event is emitted.

### Step 2: Move WS attach to subscribe-to-key

In `terminal-server.ts`, change the WS attach so a connection subscribes to the
logical key and receives the current snapshot + the live event stream, rather
than binding to a specific session object. Behavior parity for the steady
state (no respawn) must be exact.

**Verify**: `pnpm exec vitest run tests/server/`; manual: a normal terminal
session streams output as before.

### Step 3: Keep subscribers across exit; publish replaced + snapshot on respawn

Change `exit` (`terminal-registry.ts:410-429`) so it marks the key as having no
live proc and emits `exit`, but does **not** drop subscribers. On the next
spawn for that key, bump `generation`, emit `replaced`, and push a fresh
snapshot to all subscribers.

**Verify**: server test — subscribe, force exit, respawn, assert the same
subscriber receives `exit` then `replaced`+snapshot without re-subscribing.

### Step 4: Renderer treats exit as offline-but-subscribed

In `terminal-panel.tsx`, handle the `exit` frame as an offline indicator while
the socket/subscription stays open; when `replaced`+snapshot arrives, the
existing `term.reset()` path renders the new buffer. Remove the plan-010
reconnect-on-exit shim (Step 2 of plan 010) so there is exactly one mechanism.

**Verify**: `pnpm exec vitest run tests/kiri-board/`; manual: a visible runtime
pane shows the new buffer across respawn with no flicker/reconnect.

### Step 5: Event-aware MCP read/wait contracts

Extend `terminal-control.ts` `read` to return `{ screen, generation, cursor }`
and support cursor-based incremental reads; reimplement `wait-for` over the
event stream with `followReplacement: true`; route long waits through
server-side await/wake (reuse the condition engine in
`terminal-subscriptions.ts` as a consumer). Update `kiri-control.ts` /
`kiri-mcp.ts` / `kirictl.ts` accordingly. Remove or raise the client polling
loop now that waits are server-driven (locate the ~15s control timeout).

**Verify**: `pnpm exec vitest run tests/server/`; MCP manual: `terminal.read`
returns a stable `generation`; `wait-for` survives a respawn (followReplacement)
instead of resolving against the dead buffer.

### Step 6: Full regression + divergence check

1. App + MCP attached to the same session; force several respawns; confirm both
   always agree on the live buffer (the original divergence is gone).
2. Confirm scrollback cap honored (no unbounded log growth; plan 004 limits
   intact).
3. Confirm shell tabs (plan 005 unmount) and idle-kill still behave.

**Verify**: `pnpm verify:e2e` → pass; manual results recorded.

## Test plan

- Server unit tests per step (generation/replaced, subscribe-across-respawn,
  event-aware read/wait) are the core net.
- The app+MCP divergence check (Step 6.1) is the acceptance test for the whole
  plan — it must show zero divergence across respawns.
- Memory/scrollback regression (Step 6.2) guards against reintroducing the
  daemon-memory issues plan 004 fixed.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test:unit` exits 0
- [ ] `pnpm build` exits 0
- [ ] `pnpm verify:e2e` exits 0
- [ ] A subscriber stays attached across PTY exit→respawn and receives `replaced`+snapshot (test)
- [ ] App pane and MCP `terminal.read` agree across multiple respawns (Step 6.1)
- [ ] `terminal.wait-for` follows a replacement instead of resolving on the dead buffer (Step 5)
- [ ] Plan 010's client reconnect-on-exit shim removed (single reconnect mechanism)
- [ ] Scrollback cap / daemon memory bounds unregressed (Step 6.2)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match live code (drift) — especially `exit`, the WS
  attach, or the control routes.
- Keeping subscribers across exit breaks idle-kill / cleanup
  (`runtime-cleanup.ts`) such that dead keys never get reclaimed — the
  lifecycle/GC story needs design before proceeding.
- The event-log/ring buffer would grow unbounded or duplicate the daemon's
  scrollback (plan 004 conflict) — reconcile with the existing cap first.
- Changing the MCP `read`/`wait-for` contract would break existing MCP/CLI
  consumers without a compatible shape — version the contract or keep the old
  fields additive.
- The change balloons beyond the in-scope files (e.g. requires a daemon
  transport rewrite) — re-scope with the operator.

## Maintenance notes

- This plan makes "push instead of poll" real for terminals specifically; the
  README backlog item "Push instead of poll" (workspace snapshots) is the
  broader sibling — the event-log primitive here could later generalize.
- After this lands, `generation` is the canonical "did the runtime change"
  signal; new consumers (renderer, MCP, automation) should key off it rather
  than inferring respawn from socket closes.
- Keep MCP read/wait contract changes additive where possible so external
  automation built on `terminal.read` keeps working.
