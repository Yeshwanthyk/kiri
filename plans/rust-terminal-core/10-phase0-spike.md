# Phase 0 — Foundations: `kiri-termd` runs a shell session end-to-end

> **Goal**: First slice of the replacement. A minimal Rust daemon owns one
> `shell` PTY, maintains a real grid, serves WS `/terminal` + `/api/health`,
> and the xterm.js frontend attaches to it. Decide the VT engine with a
> conformance corpus. `KIRI_TERM_CORE=rust` is a **temporary bring-up switch**
> so the Rust core develops alongside the Node daemon until parity — it is
> deleted in P4 when the Node daemon is removed. No back-compat goal; the
> frontend may be edited freely.
>
> **Executor instructions**: Follow steps in order. Run every verification.
> STOP conditions at the bottom. To get a working shell fastest, P0 may emit an
> ANSI `snapshot` + raw `data` (xterm renders it directly); the native patch
> client lands in P3.
>
> **Drift check (run first)**:
> `git diff --stat 48acb9f..HEAD -- src/server/terminal-registry.ts src/server/terminal-server.ts src/server/kiriterm-daemon.ts src/server/kiriterm-daemon-client.ts src/lib/contracts.ts`
> If the WS/HTTP protocol in `contracts.ts:444-471` changed, reconcile
> `00-overview.md §5` before coding.

## Status
- **Priority**: P0 · **Effort**: M · **Risk**: LOW · **Depends on**: none
- **Category**: infra/perf · **Planned at**: `48acb9f`

## Scope (in)
- New crate `crates/kiri-termd` (workspace member).
- One code path: spawn a login shell PTY, parse output into a grid, serve
  WS `/terminal` (`snapshot` + `data`, accept `input`/`resize`), and
  `GET /api/health`.
- ANSI snapshot serialization from the grid.
- A VT conformance harness that decides `vte`+grid vs `alacritty_terminal`.
- Node selector: `KIRI_TERM_CORE=rust` makes `kiriterm-daemon-client` discover
  the Rust binary instead of spawning the Node daemon.

## Scope (out — later phases)
- Flow-control pause/resume + `ack` (P1). Spike may send unthrottled.
- `replaced`/`generation`, scrollback persistence, idle-kill, all other
  `/api/*` routes, runtime/agent sessions, presence, `readScreen` (P1/P2).

## Steps

### 1. Add the crate
- `crates/kiri-termd/Cargo.toml` — deps: `tokio` (rt-multi-thread, macros,
  io-util, net, sync, process), `axum` + `tokio-tungstenite` (or `axum`'s
  `ws`), `portable-pty = "0.8"`, `vte = "0.15"`, `serde`/`serde_json`,
  `anyhow`, `tracing`.
- Add `"crates/kiri-termd"` to root `Cargo.toml` `[workspace].members`.
- `crates/kiri-termd/src/main.rs` binary `kiri-termd`.

### 2. VT engine decision harness (do this before committing to a grid)
- `crates/kiri-termd/src/grid/` — a `Grid` with: cells (char + SGR attrs),
  cursor, alt-screen buffer, scrollback ring (cap 10_000 lines to match
  `terminal-registry.ts:121`), `resize(cols,rows)`, `feed(&[u8])` via a `vte::Parser`
  + `Perform` impl, `serialize_ansi() -> String`, `read_screen() -> ScreenText`.
- `crates/kiri-termd/tests/vt_conformance.rs` — a golden corpus:
  - Capture raw PTY byte streams from real programs into
    `crates/kiri-termd/tests/corpus/*.bytes` (vim editing, `htop`, `ls --color`,
    a codex/claude TUI session, wide + combining Unicode, `tput` SGR matrix).
  - For each: feed bytes → snapshot ANSI → feed snapshot into a **second**
    fresh grid → assert the two grids' visible cells + cursor are equal
    (round-trip / screen-equality). This is the D4 proof.
  - Optionally cross-check against `@xterm/headless` by writing a tiny Node
    script that parses the same corpus and dumping its `translateToString`
    grid; compare cell text (allow known-benign SGR differences).
- **Decision gate**: if `vte`+owned grid passes the corpus with acceptable
  effort, lock D2 primary. If reflow/edge cases are too costly, swap the grid
  impl for `alacritty_terminal` behind the same `Grid` trait and re-run. Record
  the choice at the top of `grid/mod.rs`.

### 3. PTY + session
- `src/session.rs` — `Session { pty_pair, child, grid: Mutex<Grid>, tx: broadcast::Sender<Frame> }`.
- Spawn via `portable-pty`: `native_pty_system().openpty(PtySize{rows,cols,..})`,
  build `CommandBuilder` from `$SHELL` (fallback `/bin/zsh`), set `cwd`, inherit
  env + `TERM=xterm-256color`.
- Reader task: read master → `grid.feed(bytes)` → broadcast `{type:"data",
  data:utf8_lossy}`. Writer: WS `input` → `pty.take_writer().write_all`.

### 4. WS `/terminal`
- `src/ws.rs` — axum route. Parse query (`token`,`agentId`,`mode`,`cols`,`rows`,
  `termId`). Reject bad token (timing-safe; reuse the token from `daemon.json`).
- On connect: `grid.serialize_ansi()` → send `{type:"snapshot", data, cols,
  rows, generation:0}`; subscribe to the broadcast; forward `data` frames.
- Handle inbound `input`/`resize`. Ignore `ack` for now.
- Frames are JSON text matching `terminalServerFrameSchema` /
  `terminalClientFrameSchema` exactly (`contracts.ts:449-471`).

### 5. HTTP `/api/health` + state dir
- Write `~/.kiri/kiriterm/daemon.json` (same shape as
  `kiriterm-daemon.ts:36-44`): pid/host/port/path/token/version/startedAt.
  Bind `127.0.0.1:0`, path `/terminal`, random 32-byte base64url token.
- `GET /api/health` → `{ok:true, pid, version, sessions}`.
- Acquire `daemon.lock` (atomic create, stale 8s) — mirror
  `acquireKiritermDaemonLock` semantics so Node and Rust never double-bind.

### 6. Node selector shim
- In `kiriterm-daemon-client.ts` `discoverOrSpawn()`: when
  `process.env.KIRI_TERM_CORE === 'rust'`, spawn the `kiri-termd` binary
  (resolve from `dist/bin/kiri-termd` in packaged app, or
  `target/debug/kiri-termd` in dev) instead of the Node daemon entrypoint.
  Everything downstream (health check, record read, WS URL) is unchanged.
- Add `scripts/build-rust-bins.mjs` binary `'kiri-termd'` to its list (build
  only; packaging wired in P4).

### 7. Manual verification
- `cargo run -p kiri-termd` then `KIRI_TERM_CORE=rust KIRI_TERMINAL_DAEMON=1 pnpm dev`.
- Open a shell terminal in the app. Type `ls`, run `vim`, resize the pane,
  run `htop`. Confirm: snapshot paints correctly on attach, live output is
  correct, resize reflows, alt-screen apps enter/exit cleanly.
- Reload the Electron window; confirm the shell reattaches to the **same**
  `kiri-termd` session (scrollback intact via fresh snapshot).

## Acceptance criteria
- [ ] `cargo test -p kiri-termd` passes the VT conformance corpus (screen-equality).
- [ ] `pnpm build:rust` produces `dist/bin/kiri-termd`.
- [ ] With `KIRI_TERM_CORE=rust`, an interactive shell (incl. `vim`/`htop`)
      works: correct snapshot on attach, live output, resize/reflow, alt-screen.
- [ ] With the switch off, the app still runs on the Node daemon (so
      development is unblocked until P1/P2 reach parity).
- [ ] Electron reload reattaches to the running `kiri-termd` session.
- [ ] `pnpm typecheck && pnpm lint` pass.

## Tests to add
- `crates/kiri-termd/tests/vt_conformance.rs` (corpus round-trip).
- `crates/kiri-termd/tests/ws_protocol.rs` — connect a WS client, assert the
  first frame is `snapshot` with correct `cols/rows`, then `input:"echo hi\r"`
  yields a `data` frame containing `hi`.
- `tests/server/kiriterm-selector.test.ts` — `KIRI_TERM_CORE=rust` resolves the
  Rust binary path; unset resolves the Node daemon (mock spawn).

## STOP conditions
- VT corpus cannot reach screen-equality with **either** engine → stop, report
  which sequences fail; do not proceed to P1.
- The shell cannot be made to work at all against `kiri-termd` (PTY, grid, or
  WS fundamentally broken) → stop and reassess the crate/engine choice before
  building further on it.
