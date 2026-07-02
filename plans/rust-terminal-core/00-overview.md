# Rust Terminal Core (`kiri-termd`) — Design & Roadmap

> **Status**: DESIGN / PROPOSED. Written against `HEAD = 48acb9f` (2026-07-02).
> Grounded in the **current** Kiri terminal code, verified by reading source —
> not the older `docs/kiriterm-plan.md` vision doc.
>
> **Executor instructions**: This directory is a phased plan. Implement in
> order: `10-phase0-spike` → `20-phase1-parity` → `30-phase2-kiri-semantics`
> → `40-phase3-v2-protocol` → `50-phase4-ship`. Each phase file is
> self-contained with scope, contracts, acceptance criteria, and tests.
> Do not skip the drift check at the top of each phase file.

---

## 1. Why

Kiri's terminal core today does expensive, duplicated work and has a
durability ceiling. Three facts from the current code drive this plan:

1. **The daemon runs a full VT emulator in JS, per session.**
   `src/server/terminal-registry.ts` creates a `@xterm/headless` `Terminal`
   + `SerializeAddon` + `Unicode11Addon` for **every** session
   (`terminal-registry.ts:180-189`). Every PTY byte is parsed in JS
   *server-side* (`append()` → `headless.write`, `:305-310`), then the same
   bytes are parsed **again** client-side in xterm.js
   (`terminal-panel.tsx:245-250`). That double parse is the main steady-state
   CPU cost while agents run, and snapshot cost is a full `serializer.serialize()`
   of scrollback on every attach and every 30s dump.

2. **Durability is process-survival only, and partial.** The Node daemon
   (`kiriterm-daemon.ts`) survives Electron reloads, but a **daemon crash
   kills all runtime (agent) PTYs** — only `shell` sessions get scrollback
   snapshots persisted (`kiriterm-daemon.ts:282-288, 338-347`). Runtime
   sessions are explicitly not restored.

3. **The seams are already clean.** Only `terminal-server.ts` imports
   `node-pty` (single spawn point, `:8, :272-276`). The daemon is already
   detached behind an HTTP `/api/*` + WS `/terminal` boundary that the
   frontend and backend both speak (`kiriterm-daemon-client.ts`). **A Rust
   daemon slots in behind that same seam** — and since we own the frontend, we
   start on the current shapes to get running, then evolve the protocol freely.

**External validation:** Solo (soloterm, `/Applications/Solo.app`) ships this
exact architecture in production — `portable-pty` + `vte`/`vt100` + a custom
Rust `terminal_document`/`terminal_grid`/`terminal_history`/
`terminal_patch_stream`, with the WebKit frontend subscribing to frame
patches. Supacode uses a bundled Zig multiplexer (`zmx`, `portable-pty` +
`ghostty-vt`) with a robust detach/reattach algorithm. We are not inventing;
we are porting a proven pattern into Kiri's existing daemon boundary.

## 2. Goal

Replace the JS VT emulator + PTY ownership inside the daemon with a native
Rust sidecar, **`kiri-termd`**, that:

- owns PTYs (`portable-pty`),
- maintains the authoritative virtual screen (grid + scrollback + damage) in
  native code,
- preserves every working flow (§5) — starting on the current WS/HTTP shapes to
  get running fast, then moving to a native patch protocol (we own both ends),
- persists **all** sessions' screen state (shell *and* runtime),
- later (v2) streams structured grid diffs + binary frames for the big
  full-screen-TUI wins (codex/claude/opencode TUIs).

Success = same UX, measurably lower CPU/latency, higher durability, and a
deterministic testable core.

## 3. Key decisions (decision record)

### D1 — Sidecar daemon, not NAPI. **CONFIRMED.**
Ship `kiri-termd` as a long-running compiled binary, matching the existing
Rust convention (`crates/read-model-indexer` → `scripts/build-rust-bins.mjs`
→ `dist/bin` → electron-builder `extraResources`). NAPI (in-process addon)
would couple PTY lifetime to the Node process and **destroy the durability
that is the entire point**. The WS/HTTP boundary already exists, so the IPC
cost is not new.

### D2 — VT engine: `vte` (parser) + a purpose-built grid. **RECOMMENDED, spike-validated.**
- **Primary:** `vte` (Paul Williams state machine, the same parser Alacritty
  and Solo use) + a small owned grid/scrollback modeled on the `vt100` crate.
  Owning the grid gives us the damage/patch representation we need for v2 and
  a serialization we control.
- **Alternative:** `alacritty_terminal` (full `Term`/`Grid` with reflow +
  damage tracking) if resize-reflow fidelity proves more valuable than
  control over the diff format. Heavier, more API churn.
- **P0 decides** via a golden VT-conformance corpus (see `10-phase0-spike`).
  Solo shipping `vte`+`vt100` is the evidence the lighter path is sufficient.

### D3 — Direct replacement, not a compatibility layer. **CONFIRMED (per user).**
`kiri-termd` **is** the terminal core. We delete the Node `kiriterm-daemon.ts`
+ the server-side `@xterm/headless` emulator in `terminal-registry.ts`. We own
the frontend and the backend, so the wire protocol is **free to change** — we
go native (structured patches, binary hot path) wherever it's better. There is
**no** dual-core selector, no `KIRI_TERM_CORE` flag, no "keep the Node daemon
for a release," no wire-format back-compat. The **only** invariant is §5: every
currently-working flow keeps working flawlessly. Staging (P0→P4) is purely to
de-risk implementation, not to preserve compatibility. (P0 may still emit an
ANSI `snapshot` + raw `data` as the fastest route to a working shell, then the
frontend moves to the native patch client — an implementation convenience, not
a compat requirement.)

### D4 — Snapshot format is ours to choose. **CONFIRMED.**
No cross-language byte-parity requirement (xterm's `SerializeAddon` output is
not a schema we must match). `kiri-termd` serializes its grid+scrollback in
whatever form its own frontend client consumes — ANSI reconstruction early,
structured frame-snapshot once the patch client lands. Correctness is proved by
a screen-equality test (serialize → reload into a fresh grid → assert identical
cells+cursor), not by matching any legacy output.

### D6 — Launch config stays in the Node backend; the daemon execs verbatim. **CONFIRMED.**
`terminal-launch.ts` already resolves the full command, args, cwd, and env
(incl. `TERM/COLORTERM/FORCE_COLOR`, the PATH shim dir from
`terminal-shim.ts`/`terminal-env.ts`, `KIRI_AGENT_ID`, hook scripts, MCP config
paths). It is entangled with Effect/DB and must **stay in Node**. It pushes the
fully-resolved spec via `/api/agents/upsert`; `kiri-termd` spawns exactly that
and does **no** env/shim resolution of its own. This keeps the Rust core small
and language-agnostic.

### D5 — Durability becomes native and uniform. **CONFIRMED.**
`kiri-termd` is the durable server (like a tmux server): it survives Electron
reloads, and it persists grid+scrollback for **all** modes. It reattaches by
stable session key using Supacode's conservative algorithm (probe → reattach
only if no other client owns it → never kill on ambiguous probe). Optional
lower-layer process survival across a *core* crash is kept as the existing
`KIRI_ZMX` fail-open wrap, not a requirement.

## 4. Target architecture

```
Electron renderer (xterm.js + WebglAddon)        [unchanged in v1]
        │  WS /terminal  (snapshot|data|replaced|exit ; input|ack|resize)
        │  HTTP /api/*   (health, sessions/*, agents/*, subscribe, ...)
        ▼
┌──────────────────────────────────────────────┐
│  kiri-termd  (Rust sidecar, tokio/axum)       │  ← replaces kiriterm-daemon.ts
│                                                │     + terminal-registry.ts
│  Session { pty, term, subscribers, seq, gen }  │
│   ├─ portable-pty      spawn/resize/kill       │  ← replaces node-pty
│   ├─ vte + grid        authoritative screen    │  ← replaces @xterm/headless
│   ├─ scrollback ring   history/replay          │
│   ├─ presence parser   OSC markers → events    │  ← ports registerPresenceParser
│   ├─ snapshot(ANSI v1 / patch v2)              │  ← replaces SerializeAddon
│   └─ persistence       grid+scrollback → disk  │  ← ~/.kiri/kiriterm/sessions
└──────────────────────────────────────────────┘
        ▲  launch configs pushed in via /api/agents/upsert (no DB access)
Node backend (Effect)  builds TerminalAgentLaunchConfig  [unchanged]
  terminal-launch.ts stays in Node; sends resolved config to kiri-termd
```

**Ownership split we keep:** the daemon has no DB access; the Node backend
resolves per-runtime launch configs (`terminal-launch.ts`, entangled with
Effect/DB/hooks/shims) and pushes them in via `/api/agents/upsert`
(`kiriterm-daemon.ts:31-35, 436-448`). `kiri-termd` reimplements the daemon,
**not** launch-config construction.

## 5. The invariant — working flows that must not regress

This is the real spec. We are free to change the wire protocol; we are **not**
free to break any of these. The current implementation details below are the
**behaviors to reproduce**, not a wire format to preserve. **Exact request/
response schemas, presence byte format, and env/shim details for every route
and flow are in [`CONTRACTS.md`](CONTRACTS.md)** — the authoritative reference
the P1/P2 implementer follows literally.

**Flows (each must pass end-to-end against `kiri-termd`):**
- Interactive shell panes — main shell, extra shell tabs, splits (keys
  `${projectId}:shell[:${termId}]`), reattach on Electron reload.
- Agent runtime sessions — codex/claude/pi/opencode: launch, stream, resize,
  steer/input, close; detached (headless) runtime survives with no UI attached.
- MCP control — `kiri_get`/`kiri_do` terminal ops (`terminal.read`,
  `terminal.input`) via `kiri-control.ts` → `/api/sessions/*`.
- Workflow orchestration + agent harness — `wait-for`/`wait-any`/`subscribe`
  and the `generation:outputSeq` read-cursor deltas.
- Presence — OSC **3008** markers (`ESC ] 3008 ; <payload> BEL`) parsed by
  `parseAgentPresenceOsc` → `session_start|busy|awaiting_input|idle|session_end`
  + `notify{title,body}` (base64), agents `claude|codex|opencode|pi`. Must be
  reproduced byte-for-byte by a `vte` OSC-3008 handler in Rust
  (`terminal-registry.ts:612-627`, `agent-presence.ts`).
- Flow control under load — big output (`cat` a huge file, `yes`) never OOMs
  the renderer; PTY pauses/resumes.
- Reconnect — dropped socket never kills a live session; explicit close does.

**Current contract details (behaviors to reproduce)** — from
`src/lib/contracts.ts:444-471`, `terminal-server.ts`, `terminal-registry.ts`.

**WS `/terminal`** — query: `token`, `agentId`, `mode` (`shell|runtime`),
`cols`, `rows`, optional `termId`. Bearer-equivalent token in query; reject on
mismatch (timing-safe).

Client → server (JSON text):
- `{type:"input", data:string}` → `session.proc.write(data)`
- `{type:"resize", cols, rows}` → `proc.resize` + grid resize
- `{type:"ack", bytes:number}` → decrement `outstandingBytes[socket]`; resume PTY

Server → client (JSON text):
- `{type:"snapshot", data:<ANSI>, cols, rows, generation}` — sent first on attach
- `{type:"data", data:<utf8>}` — streamed output
- `{type:"replaced", generation}` — session recreated under same key
- `{type:"exit", message:string}` — child exited / offline

**Ordering rule (must preserve):** on attach, flush the parser, emit
`snapshot`, then replay any output that arrived during the flush, in order,
with no duplication (current impl uses a zero-byte write sentinel +
per-socket buffering, `terminal-registry.ts:222-257`).

**Flow control (must preserve):** track `outstandingBytes` per socket; pause
PTY reads above **256 KB**, resume below **64 KB**; client acks applied bytes
(`terminal-registry.ts:121-124, 575-597`; `terminal-panel.tsx:206-231`).

**HTTP `/api/*`** — routes to reach parity (from `terminal-control.ts`,
`terminal-subscriptions.ts`, `kiriterm-daemon.ts`):
- `GET /api/health`
- `GET /api/sessions`; `POST /api/sessions/{read,snapshot,input,resize,wait-for,wait-any,kill,kill-prefix}`
- `POST /api/sessions/subscribe`; `GET /api/subscriptions`
- Daemon: `POST /api/agents/{upsert,spawn,close-runtime,input}`; `POST /api/shutdown`
- Auth: Bearer token, timing-safe compare (`terminal-control.ts:306-312`).

**State-dir contract** (`~/.kiri/kiriterm/`, `kiriterm-daemon.ts:135-215`):
`daemon.json` (pid/host/port/path/token/version/startedAt), `daemon.lock`
(atomic `wx`, stale after 8s), `sessions/*.json` persisted snapshots. Keep
these so `kiriterm-daemon-client.ts` discovers `kiri-termd` unchanged.

**Kiri-specific behaviors to port (do not drop):**
- **OSC presence parser** (`registerPresenceParser`): parses agent presence
  markers from PTY output → `busy|awaiting_input|session_start|idle|session_end`,
  feeding `agent-presence.ts`. Must run on the byte stream in Rust.
- **`readScreen`**: plain-text grid lines + cursor for MCP/headless reads
  (`terminal-registry.ts:363-377`; drives `kiri-control.ts`).
- **`generation:outputSeq` cursor** for control-plane read deltas
  (`terminal-registry.ts:379-391`, `terminal-control.ts:197-210`). `outputSeq`
  increments once per appended chunk; it is **not** in WS frames — keep that.

## 6. What we steal, and from where

| Idea | Source | Where it lands |
|---|---|---|
| Backend-owned grid + patch stream (frontend stops parsing) | Solo `terminal_document`/`terminal_patch_stream` | Core of v2 (`40-phase3`) |
| `epoch` + `screen_seq` resumable attach handshake (resume-if-compatible, snapshot-if-stale) | Solo `attach_terminal knownRunEpoch knownScreenSeq` | v2 attach; maps onto `generation`+`outputSeq` |
| Split live frame snapshot vs paged immutable history (`fetch_terminal_history beforeLineId limit`) | Solo | v2 scrollback API (`40-phase3`) |
| Binary transport for hot paths, JSON for control | Solo `_binary` variants | v2 (`40-phase3`) |
| Deterministic session id = stable UI key → daemon session name | Supacode `supa-<uuid>` | Already Kiri's session key; keep |
| Conservative reattach: probe → reattach only if `clients==0`, never kill on ambiguous probe | Supacode `WorktreeTerminalState.swift:2327+` | `30-phase2` reattach |
| Layout/keep-set drives launch-time orphan reaping | Supacode `AppFeature.swift:240` | `30-phase2` orphan cleanup |
| Explicit-close marker separate from process exit | Supacode `pendingExplicitSurfaceCloseIDs` | `30-phase2` |
| Per-key serialized snapshot writer w/ tombstones, atomic, no whole-file clobber | Supacode `LayoutsIncrementalWriter` | `20-phase1` persistence |
| Bounded subprocess calls w/ pipe draining (no hangs) | Supacode `ZmxClient` | any spawned-child handling |
| Fail-open to raw PTY when a lower layer is unavailable | Supacode | keep `KIRI_ZMX` optional |
| Loopback discovery file (token/pid/apiBaseUrl) | Solo `GET /api/discovery` | already `daemon.json`; formalize |
| Separate agent-coordination store (KV/locks/leases/timers/todos) from terminal store | Solo `agent-channels.db` | **out of scope** for the core; noted for Kiri control-plane (§8) |

## 7. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| VT conformance gaps vs xterm (edge SGR, DEC modes, wide/combining chars) | HIGH | Golden corpus (P0) incl. vim/htop/codex-TUI captures; `vt100`/`vte` are mature; this is now the top risk |
| A working flow silently regresses (MCP read-cursor, `wait-for`, presence) | HIGH | §5 flow checklist is the acceptance gate; run the existing MCP/workflow/agent harnesses against `kiri-termd` in P1/P2 |
| `outputSeq` chunking semantics feed MCP cursors | MED | Preserve chunk-based `outputSeq`; contract test on `sessions/read` deltas |
| Presence OSC 3008 parsing divergence | MED | Port `parseAgentPresenceOsc` exactly; marker corpus test (P2) |
| Runtime "durable" expectation | MED | D5: persist all modes; a *core* crash still ends live children (true of any owner) — document it |
| Cross-platform PTY / universal binary / signing | MED | P4: `portable-pty` is cross-platform; build both arches; reuse `read-model-indexer` packaging path |

## 8. Explicitly out of scope (noted for later)

- **Agent coordination substrate** (Solo's `agent-channels.db`: shared KV,
  lock leases, durable timers as agent wakeups w/ PTY injection, todos,
  scratchpad). This is a control-plane feature, independent of the terminal
  core. Worth a separate plan; Kiri already has scratchpad + workflow pieces.
- **Custom GPU renderer** replacing xterm.js. v2 keeps xterm.js as the
  renderer (fed by patches). A native renderer is a possible v3, not planned
  here.
- **Remote (SSH) worktrees.** Supacode wraps SSH in the local multiplexer;
  `kiri-termd` owning a PTY that runs `ssh …` works the same way. No remote
  daemon. Covered incidentally; no dedicated phase.

## 9. Roadmap at a glance

| Phase | File | Outcome | Effort | Risk |
|---|---|---|---|---|
| P0 Spike | `10-phase0-spike.md` | `kiri-termd` runs a `shell` session end-to-end; VT engine chosen; xterm attaches. Temporary `KIRI_TERM_CORE=rust` bring-up switch (deleted in P4) | M | LOW |
| P1 Parity | `20-phase1-parity.md` | All shell + control-plane flows: flow control, resize, attach ordering, generation/replaced, scrollback + persisted restore (all modes), idle-kill, `/api/*` incl. `wait-for`/`subscribe`, lock/record/health | L | MED |
| P2 Kiri semantics | `30-phase2-kiri-semantics.md` | Agent runtimes via `agents/*`, OSC-3008 presence, `readScreen`/MCP reads, conservative reattach + orphan reaping | M | MED |
| P3 Native protocol | `40-phase3-v2-protocol.md` | Binary grid-diff frames, epoch/seq resumable attach, paged history; xterm fed by patches; **delete** server-side ANSI passthrough | L | MED |
| P4 Ship | `50-phase4-ship.md` | Delete Node daemon + `@xterm/headless`; build:rust wiring, universal binary, packaging/signing, contract tests; `kiri-termd` is the only core | M | MED |
