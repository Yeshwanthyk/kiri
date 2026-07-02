# Plan 019: Terminal-stream agent presence via OSC (supacode-informed)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1fa5160..HEAD -- src/server/terminal-registry.ts src/server/terminal-server.ts src/server/kiriterm-daemon.ts src/server/terminal-launch.ts src/server/db/runtime-state.ts package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: soft on plan 014 (agent hooks tightening) — 014 owns hook
  *registration* (claude `--settings` bundle, codex hook args) and the
  `agent.status.set` write op; this plan changes the *transport* for
  status-shaped events from `kirictl`-per-event to an OSC escape sequence
  parsed out of the PTY stream. Either order works; if this lands first, it
  defines the hook commands 014's bundle registers. Soft on plan 011 for
  daemon-mode event delivery (see Step 4).
- **Category**: architecture/feature
- **Planned at**: commit `1fa5160`, 2026-07-02

## Why this matters

Study of supacode (`github.com/supabitapp/supacode`, cloned at
`/tmp/supacode`) found the strongest portable idea in its stack: **agent
hooks report presence by printing a custom OSC escape sequence to their own
tty, and the embedder parses it out of the terminal byte stream**, attributing
each event to the PTY it arrived on (`AgentPresenceOSC.swift`,
`WorktreeTerminalState.swift:1609-1620` in that repo). Compared to Kiri's
current/planned transport (hook → spawn `kirictl` → HTTP op → DB):

1. **Attribution by PTY, not env identity.** The event belongs to whichever
   session's stream carried it. No `KIRI_AGENT_ID`/`KIRI_SESSION_DIR`
   required, no binding files, no cwd/timestamp disambiguation — the whole
   class of cross-binding bugs (plan 013's B4/B6 analog for *presence*)
   cannot occur. This also covers what plan 014 Step 4 explicitly cannot:
   a hand-typed `codex`/`claude` in a plain Kiri shell terminal can report
   presence with zero ambient identity.
2. **Emission is a `printf`.** No Node/tsx process spinup per event (plan
   014's C2 latency concern disappears for status events), no HTTP, no
   backend reachability requirement.
3. **Works over SSH** — the sequence rides the terminal stream, so a future
   remote-project feature gets presence for free (supacode's stated reason
   for choosing OSC).

Kiri has a ready-made interception point: every PTY byte already flows
through a per-session `@xterm/headless` instance
(`terminal-registry.ts` `append`, `:243-247`), each created with
`allowProposedApi: true` (`:143-148`), and the installed `@xterm/headless`
exposes `parser.registerOscHandler` (verified against `node_modules` on
2026-07-02: `typeof t.parser.registerOscHandler === 'function'`).

**Format compatibility bonus**: adopt supacode's OSC `3008` grammar rather
than inventing a Kiri-specific number. Users who have supacode-installed
hooks in `~/.claude/settings.json` (they install `# supacode-managed-hook`
commands globally) already emit these sequences — Kiri would passively pick
up presence from those hooks with zero installation of its own.

The grammar (verify the exact escaping against supacode's
`AgentPresenceOSC.swift:212-260` before hardcoding; keep the parser
tolerant of unknown fields):

```
ESC ] 3008 ; start=<agent> ; event=<session_start|busy|awaiting_input|idle>[;pid=<pid>] ESC \
ESC ] 3008 ; end=<agent>   ; event=session_end[;pid=<pid>] ESC \
ESC ] 3008 ; start=<agent> ; kind=notify;title=<base64>;body=<base64> ESC \
```

Supacode's per-agent event mapping (its `ClaudeHookSettings.swift`):
`SessionStart→session_start`, `UserPromptSubmit`/`PreToolUse`→`busy`,
`PreToolUse` matcher `AskUserQuestion|ExitPlanMode`→`awaiting_input`,
`PostToolUse`→`idle`, `Notification`→`awaiting_input`+notify,
`Stop`→`idle`+notify, `SessionEnd`→`session_end`.

## What this plan is NOT

- Not a replacement for plan 014's binding/todo work: `SessionStart` resume
  binding (needs the session id written to disk) and `PostToolUse` TodoWrite
  capture (payload too large/structured for comfortable OSC transport) stay
  on the `kirictl` path. OSC carries the small, frequent, status-shaped
  events.
- Not a replacement for codex GUI-mode status (`thread/status/changed` via
  the app-server) — that path is richer and stays authoritative for
  GUI-mode sessions. OSC presence is for *terminal-mode* sessions
  (claude/opencode/terminal-codex), which today have no deterministic status
  at all.

## Current state

- `src/server/terminal-registry.ts`
  - `register` (`:133-177`) creates the per-session headless terminal with
    `allowProposedApi: true` (`:143-148`), loads `Unicode11Addon` +
    `SerializeAddon` (`:149-152`). No parser hooks registered anywhere.
  - `append` (`:243-258`) writes every PTY chunk into
    `session.headless.write(...)` — the parse happens here, asynchronously,
    already.
  - `broadcast` (`:261-268`) sends the **raw** chunk to attached sockets
    independently of the headless parse — an OSC 3008 sequence therefore
    also reaches the renderer xterm, which silently ignores unknown OSC
    identifiers (no visual artifact; confirmed xterm.js behavior for
    unhandled OSC). `SerializeAddon` snapshots serialize buffer *state*,
    not the raw stream, so the sequences do not replay on reattach.
  - `input.onSessionExit` style callbacks: `register` wires `proc.onExit`
    (check exact name at implementation time) — the hook point for clearing
    presence on PTY death (simpler than supacode's `kill(pid, 0)` sweep,
    which it needs only because its agent processes aren't its PTY
    children; Kiri's are).
- `src/server/terminal-server.ts` — `makeTerminalServerService` constructs
  the registry (embedded), `kiriterm-daemon.ts` constructs its own (daemon
  mode). Presence events must reach the backend's DB in both modes; only
  embedded mode has direct DB access.
- `src/server/db/runtime-state.ts` — `setAgentStatus` (`:157-175`) is the
  existing status writer (plan 015 Step 2 adds an archived-guard to it;
  compose, don't conflict).
- `src/server/terminal-launch.ts` — hook registration sites this plan's
  Step 3 extends: `codexSessionStartHookArgs` (`:340-349`), and plan 014
  Step 3's claude `--settings` bundle (not yet landed).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Server tests | `pnpm exec vitest run tests/server/` | all pass |
| Targeted | `pnpm exec vitest run tests/server/terminal-registry.test.ts` | all pass |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope**:
- `src/server/terminal-registry.ts` — OSC 3008 handler registration, typed
  presence event, per-session presence state, exit-clears-presence.
- New `src/server/agent-presence.ts` (or similar) — grammar parser (pure,
  unit-testable), event types, agent-name allowlist.
- `src/server/terminal-server.ts` — wire registry presence events to
  `setAgentStatus` for `${agentId}:runtime` keys (embedded mode).
- `src/server/kiriterm-daemon.ts` — daemon-mode delivery seam (Step 4;
  may be documented-deferred, see step).
- `src/server/terminal-launch.ts` — emit-OSC hook commands (Step 3,
  coordinate with plan 014).
- `tests/server/` — parser + registry + status-mapping tests.

**Out of scope** (do NOT touch):
- Hook *registration* mechanics (`--settings` bundle, codex hook args
  structure) — plan 014. This plan only supplies the command strings those
  hooks run.
- Resume/session-id binding (`codex-hook-session.json` etc.) — plans 013/014.
- TodoWrite capture — plans 014/017.
- Renderer UI for presence badges on shell terminals — record as follow-up;
  this plan lands the signal, not new UI.

## Git workflow

- Branch: `advisor/019-osc-agent-presence`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pure parser + typed events

New `src/server/agent-presence.ts`:

- `parseAgentPresenceOsc(payload: string): AgentPresenceEvent | null` —
  parses the `start=<agent>;event=...` / `end=<agent>;...` /
  `kind=notify;...` grammar. Tolerant: unknown keys ignored, unknown agent
  names rejected against an allowlist (`claude`, `codex`, `opencode`, `pi`,
  plus supacode's extras only if we want them), malformed → `null`, bounded
  input length (reject payloads > ~8KB before parsing).
- `AgentPresenceEvent = { agent: string; event: 'session_start' | 'busy' |
  'awaiting_input' | 'idle' | 'session_end'; pid?: number } | { agent:
  string; kind: 'notify'; title: string; body: string }` (base64-decode
  title/body with a size cap).

**Verify**: `pnpm typecheck` → 0. New `tests/server/agent-presence.test.ts`
covering: each event kind, pid parsing, base64 notify, malformed/oversized
payloads → `null`, unknown agent → `null`.

### Step 2: Registry integration — parse per session, clear on exit

In `terminal-registry.ts` `register` (`:133-177`), after the addons load:

```ts
headless.parser.registerOscHandler(3008, (data) => {
  const event = parseAgentPresenceOsc(data)
  if (event) input.onPresenceEvent?.(session.key, session.mode, event)
  return true
})
```

- `onPresenceEvent` is a new optional field on the registry's constructor
  input (same pattern as `restoreContent`), so tests/daemon/embedded each
  wire their own consumer.
- Track the last presence event per session (a small field on
  `TerminalRegistrySession`) so a late-attaching consumer can read current
  state; clear it, and emit a synthetic `session_end`, when the PTY exits
  (the existing exit path that sets `session.exited = true`).
- Returning `true` from the handler marks the OSC as handled in the
  headless parse only — it does not (and must not) strip it from the raw
  `broadcast` stream; the renderer ignoring it is expected and harmless.

**Verify**: `pnpm typecheck` → 0. Registry test: write a synthetic
`\x1b]3008;start=claude;event=busy\x1b\\` chunk into a registered session
via the same path PTY data takes, assert the `onPresenceEvent` fake fired
with the session key and parsed event; kill the session, assert a
`session_end` was emitted/cleared.

### Step 3: Status mapping + OSC-emitting hook commands

1. In `terminal-server.ts` (embedded mode), wire `onPresenceEvent`: for
   sessions whose key matches `${agentId}:runtime`, map
   `busy→'running'`, `awaiting_input→'blocked'`, `idle→'idle'`,
   `session_end→'idle'` and call the existing `setAgentStatus` write (via
   the runtime dependencies, matching how other server-side status writes
   flow — after plan 015 lands, its archived-guard applies automatically).
   For `:shell` keys, keep the event in the registry's per-session presence
   field only (no agent row exists) — surfacing it in the UI is the
   follow-up noted in Scope.
2. Hook command strings: add a small helper in `terminal-launch.ts` (or the
   new `agent-presence.ts`) that renders the `printf` command for a given
   agent/event, e.g.
   `printf '\033]3008;start=claude;event=busy;pid=%d\033\\' "$PPID" > /dev/tty`
   (write to `/dev/tty`, not stdout — hook stdout may be captured by the
   agent CLI; verify against a real binary). Coordinate with plan 014
   Step 3: in its claude `--settings` bundle, use these printf commands for
   `UserPromptSubmit`/`Stop`/`SessionEnd`/`PreToolUse`(question matcher)
   instead of (or alongside) `kirictl claude-hook <event>` — the kirictl
   path remains for SessionStart binding and TodoWrite. If 014 has not
   landed, this step ships the helper + tests only, and 014 consumes it.

**Verify**: `pnpm typecheck` → 0. Server test: presence event for a runtime
key flips the agent's status in a fake/real test DB; a shell-key event does
not touch the DB. Manual: run a claude terminal session with the printf
hooks wired (hand-edit a settings file if 014 hasn't landed), submit a
prompt, watch status flip running→idle without any kirictl process
appearing in `ps`.

### Step 4: Daemon-mode delivery (design-then-implement, may defer)

In daemon mode the registry (and thus the OSC parse) lives in the kiriterm
daemon process, which has no DB access. Options, in preference order:

1. **Ride plan 011's subscribe-to-key channel** if it has landed — presence
   events are exactly the kind of "event, not poll" payload 011's WS
   subscription carries; add an event type there.
2. Interim: the daemon already receives control POSTs from the backend;
   add a lightweight `GET /api/presence?since=<seq>` the backend polls at
   its existing cadence, or piggyback the last-presence field on an
   existing session-listing response the backend already fetches.
3. If neither is cheap at implementation time: implement embedded-mode only,
   and record in this plan + `plans/README.md` that daemon-mode presence is
   pending 011 — do NOT build a new bespoke daemon→backend push channel
   just for this.

**Verify**: whichever option is taken, a daemon-mode test (or a recorded
deferral note) exists; `pnpm exec vitest run tests/server/` → pass.

## Completion notes (2026-07-02)

- Shipped `src/server/agent-presence.ts` with the OSC 3008 parser, bounded
  notify decoding, runtime allowlist, and `printf` command rendering.
- `terminal-registry.ts` now registers a per-session xterm OSC handler,
  stores current status presence, and emits a synthetic `session_end` when a
  present PTY exits or is killed.
- Embedded `terminal-server.ts` maps runtime-session presence into DB status:
  `busy -> running`, `awaiting_input -> blocked`, and
  `session_start`/`idle`/`session_end -> idle`. Shell session presence stays
  local to the registry because there is no agent row to update.
- New Claude runtime launches use OSC commands for status-shaped hooks:
  `UserPromptSubmit`, `Stop`, `SessionEnd`, `PreToolUse` question matcher,
  and `PermissionRequest`. `kirictl` remains for `SessionStart` binding and
  `PostToolUse` TodoWrite projection.
- PATH shims were intentionally not changed. The supported shipped path is
  newly launched runtime sessions, not compatibility behavior for existing
  shell wrappers.
- Daemon-mode DB projection is deferred by the Step 4 decision gate:
  `kiriterm-daemon` owns the registry in daemon mode, while
  `kiriterm-daemon-client` only sends backend-to-daemon control requests and
  processes Codex launch records returned by those requests. There is no
  existing daemon-to-backend event/writeback path to carry presence into the
  database, and this plan explicitly forbids a bespoke new channel just for
  presence.
- Verification run:
  `pnpm exec vitest run tests/server/agent-presence.test.ts tests/server/terminal-registry.test.ts tests/server/terminal-server.test.ts tests/server/terminal-launch.test.ts`
  and `pnpm typecheck`.

## STOP conditions

Stop and report back (do not improvise) if:

- `parser.registerOscHandler` is missing or the handler never fires for
  writes through `session.headless.write` (would contradict the verified
  probe — re-check `@xterm/headless` version drift in `package.json`).
- The OSC payload arrives truncated at a parser-imposed limit smaller than
  the grammar needs for notify events — cap or drop notify support rather
  than patching xterm.
- Supacode's actual emitted grammar (check `AgentPresenceOSC.swift`)
  differs from the format above in a way that breaks compatibility — prefer
  matching supacode exactly; if impossible, document the divergence and drop
  the "passive pickup of supacode hooks" bonus claim.
- Writing to `/dev/tty` from a hook subprocess does not reach the PTY for a
  given agent CLI (e.g. the CLI detaches the controlling tty) — fall back to
  stdout only if verified safe for that CLI's hook contract; otherwise flag.
- Plan 014 has landed with kirictl-only status transport and changing it
  would churn its just-written tests — coordinate; this plan then only adds
  the parser/registry layer and 014's transport swap becomes a follow-up
  commit in this plan's branch.

## Maintenance notes

- If a future remote/SSH project feature lands, presence works over it by
  construction — but the `pid` field refers to the *remote* pid; the
  PTY-exit-clears-presence logic still holds (the SSH process is the PTY
  child). Revisit only if sessions outlive their PTY (zmx-style host — see
  plan 020, which changes who owns the PTY).
- If plan 020 (durable PTY sessions) lands, the OSC parse point moves with
  the headless mirror — wherever the stream is parsed for scrollback is
  where presence parses too; keep them together.
- The agent-name allowlist is the only Kiri-side coupling to supacode's
  vocabulary; extend it deliberately, not by accepting arbitrary ids.
