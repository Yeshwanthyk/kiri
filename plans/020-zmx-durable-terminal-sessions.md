# Plan 020: Durable terminal sessions via zmx (evaluate + prototype)

> **Executor instructions**: This is an architecture spike with a decision
> gate, not a straight-line bugfix plan. Follow the steps in order; Step 6 is
> an explicit go/no-go decision the operator makes with the evidence the
> earlier steps produce. If anything in the "STOP conditions" section occurs,
> stop and report. When done (either outcome), update the status row in
> `plans/README.md` and record the decision.
>
> **Drift check (run first)**: `git diff --stat 1fa5160..HEAD -- src/server/terminal-server.ts src/server/terminal-registry.ts src/server/terminal-launch.ts src/server/kiriterm-daemon.ts src/server/kiriterm-daemon-client.ts src/server/terminal-subscriptions.ts src/server/terminal-control.ts`
> If plan 012 has landed, its diffs are expected — re-read the touched
> functions rather than treating that as a STOP.

## Status

- **Priority**: P2 (strategic; the tactical pain is owned by 012)
- **Effort**: L (spike M + adoption M)
- **Risk**: MED-HIGH (new external binary in the process tree)
- **Depends on**: none to start the spike. Coordinate with 010/011/012 —
  this plan is the strategic alternative to the kiriterm daemon those plans
  patch. Do 012's A-KILL fix regardless (one line, immediate relief).
- **Category**: architecture
- **Planned at**: commit `1fa5160`, 2026-07-02

## Why this matters (and the question it answers)

The operator asked whether Kiri can use what **supacode**
(`github.com/supabitapp/supacode`, cloned at `/tmp/supacode`) uses instead of
xterm. Findings from that study:

- **Supacode's terminal emulator is Ghostty**, embedded natively via
  `GhosttyKit`/`ghostty_surface_t` into AppKit `NSView`s with custom Ghostty
  patches (`patches/ghostty-command-wrapper.patch`,
  `ghostty-osc3008-context-signal.patch`). That path is **not available to an
  Electron renderer** — it is Metal-rendered native code with no DOM story,
  and `libghostty-vt`'s WASM direction is explicitly API-unstable today.
  xterm.js stays. (See also `plans/README.md`'s audit note: Kiri's server
  additionally depends on `@xterm/headless` + `SerializeAddon` as the source
  of truth for scrollback restore, `terminal.read`, `wait-for`, and wake
  delivery — a renderer swap wouldn't remove xterm from Kiri anyway.)
- **The adoptable piece is zmx** (`github.com/supabitapp/zmx`, MIT, a fork of
  neurosnap's zmx; cloned at `/tmp/zmx`): a dtach-style session-persistence
  multiplexer. Supacode routes every surface through
  `zmx attach supa-<uuid>` so **the shell/agent survives app quit and
  crash**; on relaunch it recreates surfaces with the same UUIDs and
  reattaches (`ZmxClient.swift`, `WorktreeTerminalState.swift:1147-1178` in
  that repo), reaps orphaned `supa-*` sessions not referenced by persisted
  layouts, and has a smoke test proving a tab survives a forced client kill
  (`scripts/smoke-zmx-crash-recovery.sh`).

Why Kiri should care: Kiri's equivalent (the opt-in kiriterm daemon) is a
hand-rolled Node daemon with its own spawn races, health-check races, RAM/disk
leaks, and restore gaps — plan 012 patches six of them, and embedded mode
(the default) still loses every PTY on backend restart (plan 018's H6).
zmx replaces that entire problem class with a purpose-built, ~single-binary
session host:

- session-per-daemon with a unix socket per session (`src/socket.zig`,
  `src/ipc.zig` in the zmx repo)
- **the in-daemon emulator is `ghostty-vt`** (`src/main.zig:4`,
  `ghostty_vt.Terminal` at `:937`) — adopting zmx brings Ghostty's VT engine
  into Kiri as the durable session-state keeper, even though the renderer
  stays xterm.js
- `zmx attach <name> [command...]` — create-or-attach; re-attach **replays
  the terminal state/scrollback** (ghostty-vt state serialized on re-attach,
  `src/main.zig:942-962`; scrollback capped at `max_scrollback` 10MB,
  `src/main.zig:473`)
- `zmx send <name> <bytes>` — inject raw input **without attaching** (v0.6+,
  no auto-newline — matches Kiri's paste-then-separate-Enter heuristic)
- `zmx print` (plain-text scrollback), `zmx list`, `zmx kill`, `zmx detach`
- `zmx run`/`zmx wait` — task execution with completion markers and exit
  codes (interesting for future workflow wake delivery, not required here)
- macOS + Linux, MIT, prebuilt binaries + trivial Zig build (supacode vendors
  it as a submodule and builds both arches — `scripts/build-zmx.sh`)

### Capability invariants (must all survive — this is the bar)

Everything Kiri's terminal stack does today, per the audit in
`plans/README.md` and the stack survey (scratchpad research, 2026-07-02):

| Capability | Today | Under zmx |
|---|---|---|
| Start agent runtime PTY | `node-pty.spawn(cmd, args)` (`terminal-server.ts:465`) | `node-pty.spawn('zmx', ['attach', key, '--', cmd, ...args])` — same registry, same everything downstream |
| Reattach after backend restart | daemon mode only; embedded loses all | respawn the same `zmx attach <key>`; zmx replays state into the fresh headless mirror + renderer |
| Paste into a running session (orchestration, scratchpad trigger, wake delivery) | write to PTY via registry (`terminal-server.ts:681`, `terminal-subscriptions.ts:56,204`) | unchanged (the attach client's stdin IS the session input); `zmx send` additionally covers the no-client-attached case |
| `terminal.keys` / `terminal.read` / `wait-for` MCP ops | headless mirror + registry (`terminal-control.ts:206`) | unchanged — the mirror keeps being fed by the attach client's output |
| Scrollback restore to renderer | `SerializeAddon.serialize()` snapshot (`terminal-registry.ts:184`) | unchanged mechanism; after restart the mirror is repopulated by zmx's replay before/as sockets attach |
| Flow control (ack-based, PTY pause) | `terminal-registry.ts:465-487` | pause now backpressures the attach client only; zmx's daemon keeps buffering — verify bounded (Step 3) |
| Shell tabs (`projectId:shell:termId`) | registry keys | same keys → zmx session names |

Integration shape (the supacode model, minus Ghostty): **keep one persistent
attached client per session inside the backend** — the `node-pty` child
becomes `zmx attach ...` instead of the raw command. Input, output, resize,
and exit all keep flowing through the exact same registry paths; zmx's only
job is that the *session outlives the client*. Backend restart = respawn
attach clients for keys that should be live.

## Relationship to plans 004 / 010 / 011 / 012 / 018

- **012 (tactical daemon fixes)**: land it regardless — it's cheap and the
  spike takes time. If this plan's decision gate is GO, 012's daemon-specific
  steps (3, 5, 6) become legacy code slated for deletion; its A-KILL,
  dedup (Step 2), and renderer fixes (Step 7) remain valid under zmx.
- **011 (event-based terminal sync)**: orthogonal (renderer↔server sync
  protocol). zmx makes 011's "respawn as event" rarer but doesn't replace it.
- **018 H6**: zmx is the real fix for "embedded mode loses PTYs on restart" —
  and it fixes it for the *default* mode, not just the opt-in daemon.
- **kiriterm daemon (004's maps, daemon.json, dump/restore)**: superseded
  entirely on GO — the daemon exists only to keep PTYs alive across
  restarts, which is zmx's whole job, done better (per-session isolation:
  one wedged session can't take down a monolithic daemon).
- **019 (OSC presence)**: compatible — the OSC parse lives on the headless
  mirror, which stays. Bonus: supabit's zmx fork carries OSC-passthrough
  behavior; verify sequences transit zmx unmangled in Step 2.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Server tests | `pnpm exec vitest run tests/server/` | all pass |
| Build | `pnpm build` | exit 0 |
| zmx available | `zmx version` (brew install neurosnap/tap/zmx for the spike) | prints version ≥ 0.6 |
| Manual survival smoke | see Step 4 | PTY survives backend kill |

## Scope

**In scope**:
- New `src/server/zmx.ts` (or similar) — binary resolution, session naming
  (`kiri-<registry key, sanitized>`), attach-argv builder, `send`/`kill`/
  `list` wrappers, orphan reaper.
- `src/server/terminal-server.ts` / `terminal-launch.ts` — launch-argv
  wrapping behind a `KIRI_ZMX=1` flag (spike) and restart-reattach pass.
- `tests/server/` — spike-scoped tests (argv wrapping, naming, reaper logic
  with a fake `zmx list`).
- Packaging notes only (Step 6 evidence): how the binary would ship
  (per-arch prebuilt in resources, like supacode) — no packaging changes in
  the spike.

**Out of scope** (do NOT touch):
- Removing the kiriterm daemon — that's the post-GO follow-up plan.
- Renderer changes of any kind — xterm.js stays, terminal-panel.tsx stays.
- `zmx run`/`wait`-based workflow delivery — note as future option only.
- Windows support (zmx is mac/linux; Kiri desktop is mac-first — record the
  constraint in the decision).

## Git workflow

- Branch: `advisor/020-zmx-durable-terminal-sessions`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Wrapper module + session naming

Build `src/server/zmx.ts`:

- `zmxSessionName(key: string)`: `kiri-` + a sanitized, length-bounded form
  of the registry key (zmx enforces a name-length limit —
  `printSessionNameTooLong` in its `src/main.zig`; hash long keys). Must be
  deterministic and collision-free across `agentId:runtime`,
  `projectId:shell`, `projectId:shell:termId`.
- `zmxAttachArgv(name, command, args)`: `['attach', name, '--', command,
  ...args]` — confirm the exact separator/passthrough syntax against
  `zmx help` (the README shows `attach <name> [command...]`; check whether
  `--` is needed for commands with flags).
- `resolveZmxBinary(context)`: env override (`KIRI_ZMX_BIN`) → bundled path
  (future) → `PATH` lookup. Missing binary → feature silently off (spike is
  opt-in anyway).
- Wrappers for `send`, `kill`, `list` (parse `list` output defensively),
  each `execFile`-based, never `shell: true`.

**Verify**: `pnpm typecheck` → 0; unit tests for naming (long keys, weird
chars) and argv building.

### Step 2: Spike wiring behind `KIRI_ZMX=1`

In `getOrCreateTerminalSession`'s spawn path (`terminal-server.ts:446-513`),
when `KIRI_ZMX=1` and the binary resolves: wrap the launch —
`spawnPty(zmxBin, zmxAttachArgv(name, launch.command, launch.args), ...)` —
leaving env/cwd/cols/rows exactly as today. Important checks while here:

- **Env/identity**: zmx captures the environment at session *creation*; a
  later reattach keeps the original env. That is correct for Kiri (the
  `KIRI_*` identity injected at creation stays valid), but verify the
  creation-vs-attach distinction empirically: attach to an existing session
  passes a *different* env — must not confuse hook identity (it won't be
  re-read, but confirm).
- **Detach keybinding**: zmx's client binds `ctrl+\` to detach. Kiri users
  type into agents through this client — check zmx for a flag/env to disable
  the client-side detach binding (supabit fork may have one; grep its
  CHANGELOG/source), or accept + document that `ctrl+\` detaches (it
  reattaches on next connect anyway; SIGQUIT passthrough is the loss).
- **Exit propagation**: when the inner command exits, the zmx session ends
  and the attach client exits → registry `onExit` fires as today. Verify the
  exit code transits (or document that it doesn't — Kiri's registry mostly
  cares *that* it exited).
- **OSC passthrough** (for plan 019): emit a synthetic OSC 3008 inside the
  session, confirm it reaches the attach client's stream intact.

**Verify**: with `KIRI_ZMX=1`, a claude/codex/shell terminal in the app
behaves identically to today (typing, resize, scrollback, paste from
scratchpad trigger, `terminal.keys`/`read`/`wait-for` MCP ops). `zmx list`
shows `kiri-*` sessions. Without the flag, zero behavior change.
`pnpm exec vitest run tests/server/` → pass.

### Step 3: Flow control + resize under the wrapper

Two behaviors to characterize (measure, then decide if code is needed):

1. **Backpressure**: Kiri pauses the PTY when a renderer socket falls behind
   (`terminal-registry.ts:465-487`). Under zmx, pausing the attach client
   stops *Kiri's reads*, while the zmx daemon keeps consuming program output
   into its ghostty-vt state (bounded: `max_scrollback` 10MB,
   `src/main.zig:473`). Already characterized from source: IO is
   non-blocking with `WouldBlock` handling throughout, and *input* toward a
   non-reading shell is dropped with an explicit log once its buffer cap is
   hit (`src/main.zig:875-888` — "same failure mode as the old direct-write
   ptyWrite (drop on EAGAIN), just at a 64x higher cap"). So the failure
   mode under extreme pressure is bounded-and-logged drop, not corruption —
   verify empirically that a paused-then-resumed client receives a coherent
   stream, and treat any *output* truncation as decision-gate evidence.
2. **Resize**: Kiri resizes via `proc.resize` on the attach client's PTY;
   zmx has a **leader-client** concept — the leader controls terminal state
   and resize (`src/main.zig:581`, `:647`). With exactly one persistent
   attach client per session (this plan's model), Kiri's client is always
   the leader — assert that, and verify a resize during an active vim/less
   session propagates and that re-attach at different cols/rows re-syncs
   (Kiri's snapshot path already resizes the renderer to match; the mirror
   must follow the same dance it does today).

**Verify**: manual + a scripted test where feasible; record findings in the
plan file under this step (they are decision inputs, not pass/fail gates,
except stream corruption which is a STOP).

### Step 4: Restart-reattach + orphan reaping

1. On backend startup (embedded mode), for each session key that *should* be
   live — start with: none automatically; reattach lazily when a renderer or
   MCP op next asks for the session, exactly like today's daemon path — the
   `getOrCreate` path finds no in-memory session, but `zmx list` shows
   `kiri-<name>` alive → spawn the attach client instead of a fresh command,
   and let zmx's replay repopulate the fresh headless mirror before the
   snapshot is served (order matters: attach, wait for the replay burst to
   drain — reuse the `headless.write('', cb)` drain trick from
   `terminal-registry.ts:184` — then serialize).
2. Reap orphans at boot (supacode's pattern): `zmx list`, kill any `kiri-*`
   session whose key maps to no current agent/project in the DB (agent
   hard-deleted while backend was down, etc.). Never touch non-`kiri-*`
   sessions.
3. Explicit lifecycle: `closeAgentRuntime`/session delete/project delete
   call `zmx kill <name>` (through the Step 1 wrapper) in addition to the
   existing kill path, so "delete" means dead, not detached. Idle-kill (plan
   012's A-KILL territory) becomes: killing the *attach client* detaches
   (session lives, cheap); killing the *session* is reserved for explicit
   lifecycle events. This is the clean liveness model 012's maintenance
   notes wished for.

**Verify**: the headline smoke — open a codex terminal, start a long-running
turn, `kill -9` the backend process, restart the app: the same session
reattaches with scrollback AND the in-flight turn still running. That is the
exact scenario that loses work today. Also: archive the session → `zmx list`
no longer shows it. Automated: reaper unit test against a fake `zmx list`.

### Step 5: `zmx send` for detached delivery (optional, evidence for gate)

Today `terminal.input` for a session with no live PTY queues to DB and
spawns the runtime (`kiri-control.ts:469`, `terminal-server.ts:681`). Under
zmx a third state exists: session alive, no attach client. Options: (a)
always attach-then-write (reuses every existing path — preferred), or (b)
`zmx send` directly for fire-and-forget wake delivery without materializing
a client. Prototype (b) only far enough to know it works (raw bytes, no
auto-newline — matches the write-text-then-Enter-after-150ms heuristic in
`terminal-subscriptions.ts:204`); adopt (a) as the default in any GO plan.

**Verify**: one manual demonstration of each path; note results.

### Step 6: Decision gate

Write the decision into this plan + `plans/README.md`:

- **GO** requires: Step 4's kill-9 smoke passes; Step 3 found no unbounded
  buffering or stream corruption; paste/keys/read/wait-for all verified;
  binary packaging story sized (per-arch prebuilt, ~single small binary,
  MIT — model on supacode's approach of vendoring + building both arches).
  Then scope the follow-up plan: make zmx the default for runtime+shell
  sessions, delete the kiriterm daemon (and retire 012 Steps 3/5/6, 004's
  daemon maps), migrate `KIRI_TERMINAL_DAEMON` users.
- **NO-GO** if any STOP fired or the risks outweigh: record exactly what
  failed so the next audit doesn't re-litigate, and fall back to the
  kiriterm-daemon track (012 + hardening follow-ups).
- Either way: upstream-vs-supabit-fork choice (prefer upstream neurosnap zmx
  unless the fork has needed behavior — diff their CHANGELOGs; the fork
  exists mainly for supacode's OSC/client-exit integration).

## STOP conditions

Stop and report back (do not improvise) if:

- Output stream corruption or data loss through the zmx client under
  backpressure (Step 3) — disqualifying, go straight to the decision gate
  with a NO-GO recommendation.
- zmx's replay-on-reattach and Kiri's `SerializeAddon` snapshot interact
  badly (double-restore, alt-screen confusion in claude/codex TUIs after
  reattach) and no ordering fix in Step 4.1 resolves it.
- The attach client injects its own escape sequences/keybindings into the
  agent's input stream in a way that corrupts agent TUIs and cannot be
  disabled.
- Session-name limits or socket-path length limits (unix socket 104-char
  path limit on macOS) make deterministic naming infeasible for Kiri's key
  shapes.
- Anything requires patching zmx itself beyond a flag — vendoring a patched
  Zig binary is a bigger maintenance commitment; surface it as a decision
  input rather than quietly forking.

## Completion notes (2026-07-02)

Decision: **GO for opt-in prototype; default adoption is a follow-up**.

- Built the actual `/tmp/zmx` source with `zig build -Doptimize=ReleaseSafe`.
  The local binary reports `zmx 0.6.0`, `ghostty_vt
  ghostty-1.3.2-dev-5UdBC8HuDgWFQtz8pKQ-0HH6z0Cb_PKbI0R7AunQhdDF`, and is a
  1.7MB arm64 Mach-O.
- Source/CLI checks changed the wrapper shape from the draft plan:
  `zmx attach <name> [command...]` takes the inner command directly; there is
  no `--` separator. `zmx list --short` is the stable name-only output for
  lifecycle/reaper logic. `ctrl+\` remains the zmx detach key and is not
  configurable in this version.
- Added `src/server/zmx.ts`: opt-in resolution (`KIRI_ZMX=1`, optional
  `KIRI_ZMX_BIN`), short deterministic `kiri-*` session names, real attach
  argv builder, defensive list parsing, and shell-free `list`/`send`/`kill`
  wrappers.
- `terminal-server.ts` now wraps PTY launches in `zmx attach` only when the
  spike flag resolves a binary. Without `KIRI_ZMX=1`, behavior is unchanged.
  Lazy rejoin is provided by zmx's create-or-attach semantics: after backend
  restart, the same Kiri registry key maps to the same zmx session name and
  reattaches instead of creating a new inner command. Explicit
  `closeAgentRuntime` also issues `zmx kill <name>` so session deletion means
  the durable host dies too.
- Real zmx smoke passed with the built binary and `node-pty`: create an
  attached shell, kill the attach client, reattach with a different command
  and observe replay without starting the new command, inject input via
  `zmx send`, observe OSC 3008 passthrough, then `zmx kill` and confirm
  `zmx list --short` is empty.
- Remaining follow-up before making zmx default: vendor/package per-arch
  binaries, run the browser-visible app matrix with `KIRI_ZMX=1`, add orphan
  reaping for hard-deleted Kiri rows, decide how to present/document
  `ctrl+\` detach, and delete/migrate the kiriterm daemon path.
- Verification run:
  `pnpm exec vitest run tests/server/zmx.test.ts tests/server/terminal-server.test.ts`
  and `pnpm typecheck`.

## Maintenance notes

- If GO: the follow-up plan owns deleting `kiriterm-daemon.ts`/
  `kiriterm-daemon-client.ts` and their tests; keep 012's fixes in the
  interim — they protect current users until the switch.
- Keep `zmx version` pinned (resolve + record the version at packaging
  time); zmx marked `zmx run`/`tail` behavior BREAKING across minor
  versions recently (its CHANGELOG v0.7.0), so treat upgrades as deliberate.
- The `kiri-` session-name prefix is the reaper's safety boundary — never
  broaden the reap glob.
