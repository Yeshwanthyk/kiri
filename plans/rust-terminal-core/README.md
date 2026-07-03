# Rust Terminal Core — plan set

A native Rust sidecar (`kiri-termd`) that replaces the Node `kiriterm` daemon's
PTY ownership + server-side `@xterm/headless` VT emulator, for lower CPU/latency
and uniform durability. Start on the current WS/HTTP shapes to get running fast,
then evolve to a native binary patch protocol. Grounded in the **current** code
at `HEAD=48acb9f`, verified by
reading source; validated against Solo (ships `portable-pty`+`vte`/`vt100`+Rust
grid/patch stream) and Supacode (Zig `zmx` multiplexer + robust reattach).

Read `00-overview.md` first — it holds the decision record, the working-flows
invariant, the steal-list, and risks. [`CONTRACTS.md`](CONTRACTS.md) is the
authoritative route/frame/presence/env spec the P1/P2 implementer follows
literally.

**Framing (per user):** this is a **replacement, not a compatibility layer**.
We own the frontend and backend, so the wire protocol is free to change. There
is no long-term dual-core selector and no wire back-compat. The single hard rule:
every currently-working flow keeps working flawlessly.

## Execution order & status

| Phase | File | Outcome | Priority | Effort | Risk | Status |
|---|---|---|---|---|---|---|
| — | [00-overview](00-overview.md) | Design, decisions, protocol contract, risks | — | — | — | DESIGN |
| P0 | [10-phase0-spike](10-phase0-spike.md) | Shell session end-to-end; VT engine chosen; initial daemon resolver wiring | P0 | M | LOW | TODO |
| P1 | [20-phase1-parity](20-phase1-parity.md) | All shell + control-plane flows (see [CONTRACTS.md](CONTRACTS.md)); scrollback+persist all modes | P1 | L | MED | TODO |
| P2 | [30-phase2-kiri-semantics](30-phase2-kiri-semantics.md) | Agent runtimes, OSC-3008 presence, MCP reads, conservative reattach | P1 | M | MED | TODO |
| P3 | [40-phase3-v2-protocol](40-phase3-v2-protocol.md) | Binary grid diffs, resumable attach, paged history; delete ANSI passthrough | P2 | L | MED | TODO |
| P4 | [50-phase4-ship](50-phase4-ship.md) | Delete Node daemon + `@xterm/headless`; package, universal binary, contract tests | P1 | M | MED | TODO |

Status values: TODO / IN PROGRESS / DONE / BLOCKED / REJECTED. Executors:
update your row when you start and finish; DONE rows should note the measured
result (e.g. CPU delta on a `cat`/`vim` session, bytes-out reduction for P3).

## The single most important fact

Only `src/server/terminal-server.ts` imports `node-pty`, and the daemon runs a
full `@xterm/headless` emulator **per session** (`terminal-registry.ts:180-189`)
— every PTY byte is parsed in JS server-side and again client-side. Moving that
authoritative screen into Rust behind the existing daemon boundary is a
zero-frontend-change swap that removes the duplicate parse and lifts durability.
