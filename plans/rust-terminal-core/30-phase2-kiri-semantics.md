# Phase 2 — Kiri semantics: agent runtimes, presence, MCP reads, robust reattach

> **Goal**: Port the Kiri-agent-specific behavior so `kiri-termd` fully
> replaces the Node daemon end-to-end, including runtime (codex/claude/pi/
> opencode) sessions, OSC presence, MCP `readScreen`, and a Supacode-grade
> reattach/orphan-reaping model.
>
> **Executor instructions**: Depends on P1. Follow [`CONTRACTS.md`](CONTRACTS.md)
> §4 (presence bytes), §5 (env/shim + per-runtime launch), §1/§6 (flows +
> rewire points). Per D6, the Node backend builds the full command+args+env in
> `terminal-launch.ts` and pushes it via `agents/upsert`; `kiri-termd` execs it
> verbatim — do **not** reimplement env/shim resolution in Rust.
>
> **Drift check**:
> `git diff --stat 48acb9f..HEAD -- src/server/terminal-launch.ts src/server/agent-presence.ts src/server/kiri-control.ts src/server/kiriterm-daemon.ts`

## Status
- **Priority**: P1 · **Effort**: M · **Risk**: MED · **Depends on**: P1
- **Category**: infra · **Planned at**: `48acb9f`

## Work items

### 1. Agent runtime sessions via `/api/agents/*`
- Implement `POST /api/agents/upsert` (store `TerminalAgentLaunchConfig` +
  pending inputs, no DB access), `agents/spawn` (spawn the `:runtime` PTY from
  the stored config, drain queued inputs), `agents/close-runtime`,
  `agents/input` (write if live, else queue) — semantics from
  `kiriterm-daemon.ts:436-498`.
- The backend keeps constructing configs in `terminal-launch.ts` (Effect/DB/
  hooks/shims) and pushes them in. Do **not** port launch-config construction.
- `idle_kill_modes` stays `["shell"]` so detached runtime sessions persist.

### 2. OSC 3008 presence parser (exact — CONTRACTS.md §4)
- `vte` OSC handler for id **3008**; callback gets the payload only. Payload is
  `;`-separated `key=value`, ≤8192 bytes: agent from `start`/`end`
  (`claude|codex|opencode|pi`), `event` ∈ `session_start|busy|awaiting_input|
  idle|session_end`, optional `pid` (`/^[1-9]\d{0,15}$/`), `notify` kind with
  base64 `title`/`body` (≤4096). If `end` present, event must be `session_end`.
  Reproduce `parseAgentPresenceOsc` byte-for-byte (`agent-presence.ts`).
- Emit transitions to the backend so `agent-presence.ts` / DB status update
  unchanged. Preserve the mapping the backend applies: `busy→running`,
  `awaiting_input→blocked`, `session_start|idle|session_end→idle`
  (`terminal-server.ts:361`); killing/exiting a present session emits a
  synthetic `session_end`. Contract-test each marker → transition + DB status.

### 3. MCP / headless `readScreen`
- `read_screen()` → `{ lines[], cursorX, cursorY, cols, rows, bufferType }`
  from the grid (`terminal-registry.ts:363-377`). Wire it to `sessions/read`
  and the `kiri-control.ts` paths that MCP `kiri_get`/`kiri_do` use so
  `terminal.read`/`terminal.input` behave identically.

### 4. Conservative reattach + orphan reaping (from Supacode)
- **Stable id**: session key already is the stable id (like `supa-<uuid>`).
- **Reattach algorithm** (port `WorktreeTerminalState.swift:2327+`): on an
  unexpected socket drop for a session, do **not** kill. On reconnect, if the
  session still lives, reattach + snapshot. Never kill on an ambiguous/failed
  internal probe.
- **Explicit-close marker**: distinguish user close (kill the session) from a
  dropped socket (keep it) — port `pendingExplicitSurfaceCloseIDs`. Expose via
  an explicit `sessions/kill` vs passive detach.
- **Launch-time orphan reaping**: on `kiri-termd` start, the set of keys the
  app still references (pushed via `agents/upsert` + shell layout) is the
  keep-set; reap persisted/live sessions with zero owners and zero clients
  (port `AppFeature.swift:240` keep-set logic). Conservative: unknown → keep.

### 5. Optional `KIRI_ZMX` fail-open (keep existing behavior)
- Preserve the existing `wrapZmxLaunch` option: when `KIRI_ZMX=1`, `kiri-termd`
  may spawn the child as `zmx attach <name> <cmd>` so the process survives a
  `kiri-termd` crash (belt-and-suspenders). Fail open to a raw PTY when `zmx`
  is absent (Supacode semantics). This is optional and off by default.

## Acceptance criteria
- [ ] codex/claude/pi/opencode runtime sessions launch, stream, and accept
      steer/input via `agents/*` identically to the Node daemon.
- [ ] Agent presence badges in the UI update correctly (each marker →
      transition verified).
- [ ] MCP `terminal.read`/`terminal.input` and the agent CLI harness pass
      against the Rust core.
- [ ] Dropping a socket (Electron reload / network blip) never kills a runtime
      session; explicit close does.
- [ ] Restarting `kiri-termd` reaps only truly orphaned sessions; referenced
      sessions survive.

## Tests
- `crates/kiri-termd/tests/presence.rs` — marker corpus → transitions.
- `tests/server/kiriterm-rust-agents.test.ts` — `agents/upsert|spawn|input|
  close-runtime` parity; queued-input drain on spawn.
- `tests/harness/*` re-run against the Rust core (env-flagged).

## STOP conditions
- Presence transitions diverge from the Node parser → stop (drives UI state).
- Any path where a dropped socket kills a live agent session → stop.
