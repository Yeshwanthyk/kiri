# Phase 1 — Protocol parity: `kiri-termd` fully replaces the Node daemon for shell + generic sessions

> **Goal**: `kiri-termd` reaches functional parity with `kiriterm-daemon.ts` +
> `terminal-registry.ts` for everything that isn't Kiri-agent-specific: flow
> control, resize, attach ordering, generation/replaced, scrollback +
> persisted restore for **all** modes, idle-kill, and the full `/api/*`
> control surface used by the app, MCP, and workflows.
>
> **Executor instructions**: Depends on P0. Follow [`CONTRACTS.md`](CONTRACTS.md)
> for exact route/frame schemas — reproduce observable behavior, not internal
> structure. The bring-up switch still lets you fall back to the Node daemon
> during development; by the end of P1 every shell + control-plane flow in
> `00-overview.md §5` passes against `kiri-termd`. Node daemon deletion is P4.
>
> **Drift check**:
> `git diff --stat 48acb9f..HEAD -- src/server/terminal-registry.ts src/server/terminal-control.ts src/server/terminal-subscriptions.ts src/server/kiriterm-daemon.ts`

## Status
- **Priority**: P1 · **Effort**: L · **Risk**: MED · **Depends on**: P0
- **Category**: infra/perf · **Planned at**: `48acb9f`

## Work items

### 1. Multi-session registry
- `SessionKey` matching `terminal-registry.ts:136-142`:
  `${agentId}:runtime` | `${projectId}:shell` | `${projectId}:shell:${termId}`.
- `Registry { sessions: DashMap<SessionKey, Arc<Session>>, key_states: ... }`.
- `getReusable` semantics: reuse a live session for the same key/dims; else
  create. Preserve `generation` across recreation under a key.

### 2. Flow control (must match thresholds)
- Per-subscriber `outstanding_bytes`. Pause PTY reads when any subscriber
  exceeds **256 KB**; resume when back under **64 KB**
  (`terminal-registry.ts:121-124, 575-597`).
- Handle client `{type:"ack", bytes}` → decrement that subscriber; re-evaluate
  pause/resume. `portable-pty` has no pause; implement by not reading the
  master (stop polling) while paused, with a bounded in-core buffer as backstop.

### 3. Attach ordering + generation/replaced
- Attach sequence: flush parser, emit `snapshot` (grid ANSI, current
  `generation`), then replay output buffered during the flush, in order, no
  dupes (port the sentinel/buffer logic, `terminal-registry.ts:222-257`).
- On recreation under an existing key: bump `generation`, emit `{type:"replaced",
  generation}` to existing sockets, then a fresh `snapshot`
  (`terminal-registry.ts:672-699`).
- On child exit: emit `{type:"exit", message}` (`terminal-registry.ts:512-533`).

### 4. Scrollback + persistence (all modes, not just shell)
- Grid keeps a scrollback ring (cap 10_000 lines). `snapshot(scrollback?)`
  serializes visible + optional N scrollback lines
  (`terminal-registry.ts:357-361`).
- Persist grid+scrollback to `~/.kiri/kiriterm/sessions/<url-encoded-key>.json`
  (or `.bin`), atomically, using a **per-key serialized writer with tombstones**
  (port Supacode `LayoutsIncrementalWriter` semantics — no whole-file clobber).
- Dump gating: only re-serialize when `outputSeq:cols:rows` changed since last
  dump (matches the P004 optimization, `kiriterm-daemon.ts:349-355`). Interval
  30s + on close.
- On startup / on new session for a persisted key: restore the grid from the
  snapshot and prepend a `\x1b[2m[kiri: restored]\x1b[0m` banner
  (`kiriterm-daemon.ts:283-293`). **Change vs today:** restore runtime mode too
  (today only `shell` is restored) — but a restored *runtime* session shows
  scrollback only; its child is gone after a core restart (document this).

### 5. Idle-kill
- `idle_kill_modes = ["shell"]`, `idle_kill_ms` matching current default. When
  a session has zero sockets and zero pending attaches, start the timer; kill
  on expiry if still idle (`terminal-registry.ts:282-289`).

### 6. Full HTTP `/api/*` (auth: Bearer, timing-safe)
Implement every route with the exact request/response JSON in
[`CONTRACTS.md`](CONTRACTS.md) §2–§3: `GET /api/sessions`;
`POST /api/sessions/{read,snapshot,input,resize,wait-for,wait-any,kill,kill-prefix}`;
`POST /api/sessions/subscribe` + `GET /api/subscriptions` (+ the subscriptions
**journal** file); `GET /api/health`; `POST /api/shutdown`. Watch the details
that break workflows/MCP if wrong:
- `sessions/read` cursor = `${generation}:${outputSeq}`; absent cursor → `""`;
  generation mismatch → all retained recent output; same generation → chunks
  after seq (CONTRACTS.md §2).
- `wait-for` scope `screen|output`, `followReplacement`; `wait-any` targets
  (1..32) with `pattern||idleMs`, quorum `any|all`.
- `subscribe` delivery: write wake text to `${agentId}:runtime`, then `\r`
  after 150ms; batch same receiver 25ms; statuses pending|delivered|failed.
- `sessions/input` writes `data + encodeTerminalKeys(keys)` (see
  `src/lib/terminal-keys.ts`).

### 7. `outputSeq` semantics
- Increment `outputSeq` once per appended PTY chunk (chunk-based, not
  byte-offset — `terminal-registry.ts:305-322`). Keep it **out** of WS `data`
  frames. Expose it only via `sessions/read` cursor
  (`terminal-control.ts:197-210`). Contract-test the delta protocol.

### 8. Daemon lifecycle
- Full `daemon.json` record + `daemon.lock` (atomic, stale 8s) + health, so
  `kiriterm-daemon-client.ts` discovers/spawns/reuses `kiri-termd` unchanged
  (`kiriterm-daemon.ts:139-215`).
- Graceful shutdown: dump all sessions, close sockets, remove record if owned.

## Acceptance criteria
- [ ] The full app terminal experience (shell + extra shell tabs/splits) works
      with `KIRI_TERM_CORE=rust`. (The frontend is still on the current WS
      shapes here; the native patch client is P3 — so P1 needs no frontend edit.)
- [ ] Flow control verified: `yes` / a 100 MB `cat` does not OOM the renderer;
      PTY pauses and resumes; no dropped/duplicated bytes vs the Node daemon.
- [ ] `sessions/read` cursor deltas match the Node daemon for the same input
      (golden contract test).
- [ ] `wait-for`/`wait-any` pass the existing harness
      (`tests/harness/kiri-agent-cli-harness.ts` against a Rust-core daemon).
- [ ] Scrollback survives Electron reload; shell scrollback survives a
      `kiri-termd` restart (persisted snapshot restore).
- [ ] The existing terminal/MCP/workflow suites pass against `kiri-termd`:
      `tests/server/{terminal-control,terminal-subscriptions,terminal-server,
      terminal-mcp-roundtrip,runtime-session-flows,workflow-mcp-orchestration}.test.ts`
      and `tests/harness/terminal-harness.ts` (point them at the Rust core).

## Tests
- `crates/kiri-termd/tests/flow_control.rs` — pause/resume thresholds, ack math.
- `crates/kiri-termd/tests/registry.rs` — key reuse, generation/replaced.
- `crates/kiri-termd/tests/persistence.rs` — atomic per-key writer, restore.
- `tests/server/kiriterm-rust-parity.test.ts` — same WS input → same client
  frames vs Node daemon; `/api/sessions/read` cursor parity.

## STOP conditions
- Any `wait-for`/`wait-any`/`sessions/read` cursor mismatch that would break
  the MCP/workflow harness → stop; parity here is non-negotiable.
- Flow-control implementation drops or reorders bytes under load → stop.
