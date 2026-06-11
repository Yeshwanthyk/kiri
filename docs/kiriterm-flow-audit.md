# Kiriterm Flow Audit — Real Agents, Solo Comparison, Missing Invariants

> Results of exercising every orchestration flow with **real** binaries (Claude Code v2.1.170,
> Codex v0.139.0, pi, opencode v1.16.2) against `~/Documents/personal/dump`, driven entirely
> through the MCP/CLI operation surface against the detached kiriterm daemon, plus a researched
> comparison with Solo (soloterm.com). Date: 2026-06-11.

---

## 1. What was tested and what happened

All flows ran via `kirictl call` (short-lived processes) against an isolated root
(`KIRI_ROOT_DIR=/tmp/kiri-real-flows`, `KIRI_TERMINAL_DAEMON=1`), so every step also exercised
daemon discovery/reattach.

| Flow | Result | Notes |
|---|---|---|
| `session.create` + `terminal.input` + `terminal.wait-for` + `terminal.read` — **claude** | ✅ | Real TUI booted, prompt delivered via argv, replied `KIRI-OK-CLAUDE` |
| Same — **codex** | ✅ | Replied `MARKER-CODEX-DONE`; YOLO mode + `--no-alt-screen` as launched |
| Same — **pi** | ⚠️→✅ | First prompt **lost** (boot race, finding F2); re-send to live TUI worked |
| Same — **opencode** | ⚠️→✅ | Same boot race; plus raw-output regex defeated by styled output (F6) |
| Conversation resume after `terminal.kill` — claude | ✅ | Respawn used `--resume`; recalled prior marker → `RESUMED:KIRI-OK-CLAUDE` |
| `workflow.create/dispatch` with 2 real agents | ✅ | `launched: 2, scratchpadOnly: 1, failed: 0` |
| `workflow.await` (all-quorum readiness, any-quorum response) | ✅ | Named the matching item (`Implementer`, `Reviewer`) each time |
| Daemon restart mid-workflow | ✅* | New daemon reported both workers `missing` (tolerant, correct); `terminal.spawn` recovered them; claude resumed with context, codex did **not** (F3) |
| Full adversarial loop (claude implements → codex reviews) | ✅ | `PATCH-V1-SLUGIFY` → `VERDICT-APPROVED`, orchestrator slept on `workflow.await` |
| `scratchpad.add` → `scratchpad.trigger` → `terminal.spawn` → wait | ✅ | Real claude spun from a note, replied marker in 2.5s after spawn |
| Sessions persisting across dozens of short-lived `kirictl` processes | ✅ | The daemon model works for real orchestration |
| Cleanup (`terminal.kill` ×N, `kirictl term stop`) | ✅ | |

## 2. Findings (bugs / sharp edges discovered with real agents)

### F1 — `terminal.wait-for` matches the echoed prompt (severity: high for orchestration correctness)
The first claude wait matched at `elapsedMs: 0` because the *typed prompt itself* contained the
marker. PTY echo means any pattern contained verbatim in the input will match instantly.
Workaround used: instruct agents to *compute* the marker ("the word MARKER joined with -X").
**Fix:** add `since: 'now'` to wait-for (capture the recent-output offset / a monotonic output
sequence number at registration and match only against output appended after it). Cheap:
`session.recentOutputChunks` already exists; track a cumulative byte counter. Also document the
computed-marker convention in the agent prompt.

### F2 — Initial input is dropped by pi and opencode (severity: high)
`claudeLaunch`/`codexLaunch` pass the queued body as **argv** (plus the 8s delayed `\r` submit);
`piLaunch`/`opencodeLaunch` ignore `initialTerminalInput`, so `writePendingTerminalInputs` fires
the text into the PTY **while the TUI is still booting**, and it is silently swallowed. Both
agents sat at an empty composer; tokens were only spent after a manual re-send.
**Fix options** (in order of preference): (a) pass the prompt as a launch arg where the CLI
supports it (pi and opencode both accept a positional/`run` prompt); (b) gate
`writePendingTerminalInputs` on a readiness signal — first output settle (no output for ~500ms
after first burst) or a per-runtime ready pattern, using the headless screen we already maintain;
(c) at minimum re-queue instead of write when the session is <N seconds old.

### F3 — Codex resume linkage is lost when spawned from short-lived processes (severity: high)
`rememberCodexTerminalSession` polls `~/.codex/sessions` asynchronously *in the process that
requested the spawn*. In the desktop backend that process lives forever; under `kirictl` it exits
within seconds, the poll dies, `runtime_state_json` never records the codex session id — and the
next respawn starts a **fresh** codex (observed: `Context 0%` after daemon restart, conversation
gone). Claude is immune because its session id is deterministic (`claudeTerminalSessionId`).
**Fix:** move the remember loop into the **daemon** (it owns the PTY and the lifetime; report the
discovered session id back via the existing codexLaunches channel or a control callback), or make
`kirictl` await the discovery before exit when it initiated a codex spawn.

### F4 — `text+\r` in one PTY write does not submit in Claude Code's live TUI (severity: high)
Writing the prompt and the carriage return in a single chunk triggers the TUI's paste heuristic:
the text lands in the composer with a trailing newline and is **not** submitted (observed
directly; recovered with a separate `terminal.keys ["enter"]`). pi and opencode submitted fine;
codex untested on live-TUI input. All earlier claude successes had used the argv path, which is
why this never surfaced in the desktop app either — but `terminal.input` to a *running* claude
(the workflow steer path, `writePendingTerminalInputs`, daemon `/agents/input`) is affected.
**Fix:** make submit a two-phase write everywhere input reaches a live runtime session: write
text, flush, wait ~100–200ms, write `\r` separately (per-runtime overridable). One helper in the
daemon/terminal-server input path covers MCP, workflow paste, and queued inputs.

### F5 — Daemon version skew bites in practice (severity: medium, predicted by plan §3.3)
The daemon had been auto-spawned from a **stale** `dist/cli/kirictl.mjs` built before
`wait-any` existed → `workflow.await` failed with `Unknown route`. Diagnosis required knowing the
architecture. **Fix:** stamp `daemon.json` with a build/version hash; the client compares on
ensure and (a) logs a precise warning naming the mismatch, (b) optionally requests
`shutdown?when=idle` and respawns. At minimum, map unknown-route errors to "daemon is running an
older build — run `kirictl term stop`".

### F6 — Raw-output regex is defeated by styled TUI output (severity: medium)
opencode emitted the marker, but SGR sequences interleaved mid-string defeat `scope: 'output'`
matching (raw bytes), while `scope: 'screen'` only sees the **viewport** — a response that
scrolls off (or renders in a cleared alt-screen region) is unfindable. Cost was real: $0.08 spent
with no observable result until a re-ask.
**Fix:** add a third scope (and make it the default for orchestration): match against the
**parsed buffer including scrollback tail** — iterate the headless buffer's last N lines
(`buffer.length`), not just the viewport. The emulator already holds 10k lines; this closes both
the styling hole (cells are post-parse) and the scroll-away hole.

### F7 — Observability gaps the run surfaced (severity: low each, real friction summed)
- `workflow.await`'s `matched:false` doesn't distinguish timeout from "pattern can never match"
  — return `timedOut: true` and per-target liveness.
- Claude showed "2 setup issues: MCP"; nested kiri-MCP health inside spawned agents isn't
  surfaced anywhere. A `terminal.read`-visible warning is the only signal today.
- `terminal.read` has no scrollback paging (`lines` param is in the plan, unimplemented).
- No op returns *agent activity state* (busy/idle/awaiting-input); orchestrators infer it from
  screen content.

## 3. Solo comparison — flows and invariants worth adopting

Solo (soloterm.com, Tauri; researched from docs/changelog/blog) is a process metaharness: solo.yml
declares processes (`command`, `auto_start`, `auto_restart`, `restart_when_changed`, `env`),
agents are first-class processes, and ~40 MCP tools span process control, output reading,
scratchpads, todos, timers, key-value state, and coordination locks. Kiri is ahead on: detached
sessions surviving the app (Solo kills everything on quit), workflow generation/dispatch,
adversarial loops, per-session conversation resume, and a real multiplexed `workflow.await`.
Solo is ahead on the following — ranked by value to kiri:

| # | Solo invariant/flow | Kiri today | Adopt? |
|---|---|---|---|
| S1 | **Idle/turn-completion wake**: "wake me when that process goes idle" — push-based, no pattern needed | `workflow.await` needs a regex; idle = silence is unexpressible | **Yes, high.** Add `terminal.await-idle` / `workflow.await {until:'idle', settleMs}` — the headless write-callback stream makes "no output for N ms after activity" trivial to detect daemon-side. This also fixes half of F1/F6 (no marker contortions). |
| S2 | **Attention bell / needs-attention** detection + OS notification | Nothing; a blocked agent waits silently | **Yes, high.** Detect prompt-question patterns / permission dialogs on the headless screen per runtime; expose `attention` in `terminal.list` + a board badge + optional OS notification. |
| S3 | **Crash auto-restart with rate limit** (10/60s, exhausted state) for service processes | Runtime sessions: spawn-on-demand only; shells idle-killed | Partial. For *agent* sessions auto-restart is wrong (Solo agrees — agents aren't auto-restarted), but workflow items could get `restartPolicy: {onCrash, maxPerHour}` for service-ish items. Medium. |
| S4 | **Trust gate** for declarative/file-sourced commands; approval history | Workflows arrive via MCP from agents — effectively ungated arbitrary terminal input | **Yes, medium-high** once workflows are file-sourced (S6). Today's MCP caller is already a trusted agent; revisit with kiri.yml. |
| S5 | **Richer scratchpad MCP**: edit/append-section/tail/find/paginated list | `scratchpad.add/list/delete/trigger` only — agents must re-read full bodies | **Yes, medium.** `scratchpad.append`, `scratchpad.tail`, `scratchpad.find` are cheap DB ops and directly improve multi-agent handoffs (our verdict-reporting flow wanted append). |
| S6 | **Declarative project config** (solo.yml committed to repo; teammates share topology) | Workflows are imperative, per-run | **Yes, medium.** `kiri.yml` with named workflow templates (`workflow.create {template: 'review'}`) + the S4 trust gate. |
| S7 | **Nested agent hierarchy** in UI (spawned-by relationships) | Flat session rows; workflow items link agents but the board doesn't show lineage | Medium. We already store workflow→item→agentId; render it. |
| S8 | **Timers** ("schedule a future turn for this agent") | None | Low-medium. `terminal.input {at: ...}` or a scheduler op; useful for self-paced loops. |
| S9 | **Orphan detection** on app restart (reattach-or-kill dialog) | Daemon handles its own lifetime, but a killed daemon leaves agent PTY children running unobserved? (PTY children die with the daemon — verified) | Covered, except: stale `daemon.json` after SIGKILL — health check already handles. OK. |
| S10 | **Shell environment capture** (login-shell PATH for spawned processes) | Daemon inherits spawner's env; if spawned from the desktop app it may miss nvm shims | Worth a check: source login shell once at daemon start (or document `KIRI_*_BIN`). Low. |
| S11 | **Coordination primitives**: locks + key-value state between agents | Scratchpad only | Low for now; workflow items + scratchpad cover current loops. |
| S12 | **Structured next-step guidance in MCP responses** (v0.7.1: responses tell the agent what to call next) | Plain results | Low effort, nice: add `hint` fields (e.g. terminal.input → "wait via workflow.await/terminal.wait-for"). |

## 4. Recommended work, in order

1. **Input correctness pack (F2+F4)** — two-phase submit for live TUIs + readiness-gated (or argv)
   initial input for pi/opencode. Without this, unattended workflows silently stall; everything
   else assumes input lands. *Small.*
2. **`since:'now'` + scrollback-scope matching (F1+F6)** — makes wait patterns trustworthy without
   marker gymnastics. *Small.*
3. **Idle/attention detection (S1+S2)** — `await {until:'idle'}` and `attention` surfacing; the
   single biggest orchestration-quality jump, and it converts our pull-pattern waits into Solo's
   push model. *Medium.*
4. **Codex remember in the daemon (F3)** — conversation continuity must not depend on the
   requester's lifetime. *Small-medium.*
5. **Daemon version stamp + drain (F5)** — one-line check, saves a confusing failure class. *Small.*
6. **Scratchpad append/tail/find (S5)** and **workflow result reporting** — let workers write
   their own reports instead of the orchestrator scraping screens. *Small.*
7. **kiri.yml workflow templates + trust gate (S6+S4)**, **hierarchy UI (S7)**, timers (S8) — the
   declarative layer, after the runtime is solid. *Larger.*

## 5. Invariants now verified to hold (keep tests guarding them)

- Sessions and conversations survive: client process exit (kirictl), UI absence, PTY kill
  (claude resume), and daemon restart (with explicit `missing` reporting + spawn recovery).
- `workflow.await` never hangs on dead workers; missing sessions are reported, not fatal.
- The full control plane works identically through the daemon and the embedded server.
- A scratchpad note can become a working real-agent session with two MCP calls.
- Cleanup is total: kill ops + `term stop` left no stray PTYs (verified via `terminal.list` → 0
  and process table).
