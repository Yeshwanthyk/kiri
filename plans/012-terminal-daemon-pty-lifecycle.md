# Plan 012: Stop runtime PTYs from being idle-killed on switch-away; harden daemon spawn/lifecycle

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1fa5160..HEAD -- src/server/terminal-registry.ts src/server/terminal-server.ts src/server/kiriterm-daemon.ts src/server/kiriterm-daemon-client.ts src/components/kiri-board/terminal-panel.tsx src/components/kiri-board/selected-agent-pane.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (010 and 011 own the WS-reconnect/subscribe story — see
  "Relationship to 010/011/013" below; this plan does not modify 010/011's
  in-scope reconnect logic beyond the ref-stability change in Step 6)
- **Category**: bugfix (terminal/daemon lifecycle, reliability)
- **Planned at**: commit `1fa5160`, 2026-07-01

## Why this matters

Six confirmed defects in terminal spawn / PTY lifecycle / kiriterm daemon,
found by a parallel research pass across `terminal-registry.ts`,
`terminal-server.ts`, `kiriterm-daemon.ts`, `kiriterm-daemon-client.ts`, and
the renderer's terminal panes. The headline is **A-KILL**: switching away
from an agent for 5 minutes SIGKILLs its live codex/claude PTY mid-turn, then
silently respawns a fresh one on return — scrollback and any in-flight turn
are gone. This is the single biggest amplifier of "terminals respawn"
complaints and touches everything else in this plan (a dead-and-respawned PTY
is also a fresh opportunity for the spawn race in A1.1 and the daemon
TOCTOU in A1.3).

In priority order:

1. **A-KILL [P1/S]** — the embedded terminal server's default
   `idleKillModes` includes `'runtime'`, so any agent runtime PTY with zero
   attached sockets for 5 minutes gets `session.proc.kill()`'d
   (`terminal-registry.ts:104`, `:222-229`, `:231-241`). Only the kiriterm
   daemon path overrides this to `['shell']`
   (`kiriterm-daemon.ts:214-215`); the embedded server (the default when
   `KIRI_TERMINAL_DAEMON` isn't `1`) never does. Switching project/agent
   unmounts the previous `TerminalPanel` (`selected-agent-pane.tsx:153-158`
   resets `mountedTerminalModes` on `selectedProject.id`/`selectedAgent?.id`
   change), which closes its WebSocket
   (`terminal-panel.tsx:414-436` cleanup, `socket?.close()` at `:422`), which
   detaches the last socket (`terminal-registry.ts:214-220` `detach` →
   `scheduleIdleKill`). Five minutes later the live agent turn is SIGKILLed.
2. **A1.1 [P1/S]** — the WS-attach path (`handleTerminalConnection` →
   `getOrCreateTerminalSession`, `terminal-server.ts:420`) has the same
   async-race dedup gap that plan 010 patches only for
   `spawnAgentRuntime` (`terminal-server.ts:278-297`). The renderer opens its
   own WS immediately after `prepareAgent`, hitting the undeduped path
   directly — 010's Step 1 dedup map must wrap `getOrCreateTerminalSession`
   itself so both callers are covered, or 010 ships a fix that only closes
   half the race.
3. **A1.3/A1.4 [P1/M, P3/S]** — cross-process daemon spawn has no OS-level
   lock: `discoverOrSpawn` (`kiriterm-daemon-client.ts:48-65`) and
   `startKiritermDaemon`'s guard (`kiriterm-daemon.ts:175-178`) are pure
   check-then-act against `daemon.json` + an HTTP health probe. Every Kiri
   process (backend + every agent's own `kirictl mcp` child) races this
   independently. A1.4 makes it worse: the "is this actually a new daemon"
   check (`kiriterm-daemon-client.ts:59`, `candidate !== existing`) always
   evaluates `true` because `readKiritermDaemonRecord` JSON-parses a fresh
   object every call — a transient health blip triggers a redundant spawn
   that then self-terminates via the `startKiritermDaemon` guard, but not
   before racing.
4. **A2.1/A2.2 [P1/S, P2/M]** — `loadPersistedSessions`
   (`kiriterm-daemon.ts:429-448`) loads *every* persisted session file
   (`mode` is `'shell'` or `'runtime'`) into `restoredSessions` at boot, but
   `restoreContent` (`kiriterm-daemon.ts:219-225`) only ever consumes and
   deletes `mode==='shell'` entries — every runtime entry is dead weight in
   RAM for that daemon's lifetime (the map is rebuilt per boot, but it
   reloads from a `sessionsDir` that only grows), and `dumpSessions`
   (`kiriterm-daemon.ts:261-292`) keeps *writing* runtime-mode snapshots
   that nothing will ever read back. Separately, nothing
   ever unlinks a session's file in `sessionsDir` when its owning
   agent/project is deleted (only `daemon.json` is removed, on daemon close,
   `kiriterm-daemon.ts:253-256`) — unbounded disk growth.
5. **A2.3 [P2/S]** — the daemon health check's 700ms timeout
   (`checkKiritermDaemonHealth`, `kiriterm-daemon.ts:158`) races synchronous
   work on the same event loop: `dumpSessions` (`kiriterm-daemon.ts:261-292`)
   does `JSON.stringify` + `writeFileSync` per dirty session every 30s, and
   `cleanupStaleClaudeSession` (`terminal-server.ts:731-746`) does
   `execFileSync('ps', ...)` on every claude spawn. A burst of output can
   stall the health check past 700ms, which A1.3/A1.4 turn into a spurious
   respawn.
6. **A3.2 [P3/S]** — `toggleFocusKey` (a keybinding *setting*, not terminal
   identity) sits in the connect-effect's dependency array
   (`terminal-panel.tsx:437`). Changing the toggle-focus keybinding tears
   down and reconnects every mounted terminal pane's xterm+WS, re-round-trips
   `terminalConfig`/`prepareAgent`, and re-enters the undeduped
   `getOrCreateTerminalSession` path (A1.1).

## Relationship to plans 010 / 011 / 013 / 015 / 018

- **010** (`plans/010-terminal-respawn-tactical-fix.md`, TODO) targets the
  same `spawnAgentRuntime` dedup and adds client-side reconnect-on-exit. This
  plan's Step 2 **extends 010's dedup map to cover the WS-attach caller**
  (`getOrCreateTerminalSession` itself, not just `spawnAgentRuntime`) — if 010
  lands first, re-verify its dedup wraps the shared function per this plan's
  Step 2 rather than re-wrapping only `spawnAgentRuntime`; if this plan lands
  first, 010's Step 1 becomes a no-op confirmation, not new work. Do not
  implement 010's Step 2 (client auto-reconnect) or Step 3 here — out of
  scope.
- **011** (`plans/011-event-based-terminal-sync.md`, TODO) is the durable
  architectural fix (subscribe-to-key, respawn-as-event) that supersedes
  010's reconnect shim. This plan does not touch that design; A-KILL's fix
  (excluding runtime from idle-kill) reduces how often 011's respawn path is
  even exercised, but 011 is still the correct fix for the *legitimate*
  respawn cases (crash, host restart).
- **013** (codex thread mapping, not yet written) is amplified by A-KILL: a
  SIGKILLed codex PTY mid-turn is exactly the kind of "session ended
  unexpectedly, need to re-resume" event that stresses codex's resume-binding
  bugs (B1/B2/B6 in the shared research). Fixing A-KILL here reduces how
  often 013's bugs are hit; it does not fix them.
- **015** (session state machine, not yet written) owns `runtime-cleanup.ts`
  and archive/delete semantics; this plan's A2.2 disk-GC fix should key off
  the same "agent/project deleted" signal 015 will formalize — if 015 lands
  a project/agent-deleted event bus first, prefer wiring into that over the
  ad hoc check this plan adds.
- **018** (workspace hygiene, not yet written) covers `H3`: project delete
  never closes its `${projectId}:shell` PTY. That is a different key
  (`:shell`, not `:runtime`) and a different cleanup path
  (`deleteProjectAndCleanupRuntimes` in `runtime-cleanup.ts`, not in this
  plan's scope) — out of scope here, cross-reference only.

## Approach (decided)

1. **A-KILL is a one-line default change with a design question**: exclude
   `'runtime'` from the embedded server's default `idleKillModes`, matching
   what the daemon already does. Liveness for a runtime PTY should be judged
   by the agent's own lifecycle (deleted/archived), not by transient socket
   attachment — a background agent with no pane open is a *feature*
   (that's the whole point of the daemon path), not a leak. This plan
   changes the **default** at the embedded-server construction site
   (`makeTerminalServerFacade`'s `embeddedService()`, `terminal-server.ts:151-154`)
   rather than the registry's own default, so the registry's default remains
   available for tests/tools that want strict idle-kill for both modes.
2. **A1.1 dedup wraps `getOrCreateTerminalSession`**, not
   `spawnAgentRuntime` — a per-key in-flight promise map at the
   `makeTerminalServerService` scope, keyed by `registry.sessionKey`, checked
   by both `spawnAgentRuntime` and `handleTerminalConnection`. A caller that
   joins an in-flight spawn must still resize the returned session to its own
   requested `cols`/`rows`; otherwise a `spawnAgentRuntime` prewarm at
   `100x30` can win the race and make the renderer attach to stale geometry.
3. **A1.3/A1.4 fix with an OS-level exclusive lock file**, following the
   existing `{ flag: 'wx' }` exclusive-write pattern already used in
   `src/server/runtime-attachments.ts:47` — a `daemon.lock` file written with
   `wx` (fails if it exists) brackets the read-check-spawn-write sequence in
   both `discoverOrSpawn` and `startKiritermDaemon`. A1.4's comparison bug is
   fixed by comparing `pid`/`startedAt` fields, not object identity.
4. **A2.1 fix**: attack the waste at the source, not just the symptom.
   (a) `dumpSessions` stops persisting `mode !== 'shell'` sessions — runtime
   snapshots are write-only data (`restoreContent` never consumes them).
   (b) `loadPersistedSessions` unlinks-and-skips legacy runtime-mode files
   instead of loading them into `restoredSessions`. (c) Keep a defensive
   `restoredSessions.delete(key)` in `restoreContent`'s `mode !== 'shell'`
   branch, matching the shell-hit deletion at `kiriterm-daemon.ts:223`.
   Plan 004's dump-gating (outputSeq stamps) must stay intact for shell
   sessions.
5. **A2.2 fix**: a bounded eviction policy on `sessionsDir` — delete a key's
   snapshot file when `closeAgentRuntime`/session `kill` removes the last
   in-memory reference for a key whose agent no longer exists in the
   daemon's `agents` map (best-effort, does not require a project-delete
   event bus; a stronger fix is 015's job per above).
6. **A2.3 fix**: raise the health-check timeout to something that comfortably
   exceeds one `dumpSessions` tick's worst case (small, not a redesign) and
   make `dumpSessions` yield between sessions rather than blocking through
   all of them synchronously — both are cheap changes, not the deep fix
   (an exclusive daemon lock from A1.3 removes the failure mode this enables).
7. **A3.2 fix**: mirror the existing `onKeyboardFocusExitRef` pattern
   (`terminal-panel.tsx:78`, `:107-108`) for `toggleFocusKey` — a ref updated
   in its own effect, read inside `attachCustomKeyEventHandler`, removed from
   the connect-effect's dependency array.

## Current state

### `src/server/terminal-registry.ts`

```ts
// :104
const idleKillModes = input.idleKillModes ?? ['shell', 'runtime']
```
```ts
// :214-229
function detach(session: TerminalRegistrySession, socket: TerminalRegistrySocket) {
  session.sockets.delete(socket)
  session.outstandingBytes.delete(socket)
  removePendingAttach(session, socket)
  maybeResume(session)
  scheduleIdleKill(session)
}

function scheduleIdleKill(session: TerminalRegistrySession) {
  if (session.exited || session.idleTimer) return
  if (!idleKillModes.includes(session.mode)) return
  if (session.sockets.size > 0 || session.pendingAttaches.length > 0) return
  session.idleTimer = timers.setTimeout(() => {
    if (session.sockets.size === 0 && session.pendingAttaches.length === 0) kill(session)
  }, input.idleKillMs)
}
```
```ts
// :231-241
function kill(session: TerminalRegistrySession) {
  if (session.exited) return
  session.exited = true
  if (session.idleTimer) {
    timers.clearTimeout(session.idleTimer)
    session.idleTimer = null
  }
  deleteOwnedSession(session)
  session.proc.kill()
  disposeEmulator(session)
}
```
`sessionKey` (`:109-114`): `mode !== 'shell'` → `` `${config.id}:runtime` ``.
`getReusable` (`:116-131`), `register` (`:133-177`, `sessions.set` at `:174`).
Flow-control pause/resume (`:465-478`, `:480-487` — A4, not addressed by this
plan; flagged as speculative in research, needs empirical check first).

### `src/server/terminal-server.ts`

```ts
// :140-154 — the facade that picks daemon vs embedded, sticky per process
function makeTerminalServerFacade(): TerminalServerApi {
  let chosen: TerminalServerApi | null = null
  let choosing: Promise<TerminalServerApi> | null = null
  let embedded: TerminalServerApi | null = null

  const embeddedService = () => {
    embedded ??= makeTerminalServerService()   // <- no idleKillModes passed
    return embedded
  }
  ...
```
```ts
// :278-297 — spawnAgentRuntime, 010's Step-1 target, no in-flight dedup
spawnAgentRuntime: async (input) => {
  await ensureRuntimeTerminalServer(runtime)
  const config = runtime.dependencies.getAgentLaunchConfig(input.agentId)
  const session = await getOrCreateTerminalSession(
    runtime, config, 'runtime', input.cols ?? 100, input.rows ?? 30,
  )
  runtime.registry.scheduleIdleKill(session)
  return { agentId: input.agentId, mode: 'runtime' as const }
},
```
```ts
// :396-444 — handleTerminalConnection, the WS attach itself
async function handleTerminalConnection(runtime, socket, request) {
  ...
  let session: TerminalRegistrySession
  try {
    const config = runtime.dependencies.getAgentLaunchConfig(agentId)
    const mode = parseTerminalMode(query.mode)
    const cols = positiveInt(query.cols, 100)
    const rows = positiveInt(query.rows, 30)
    const termId = parseTermId(query.termId)
    session = await getOrCreateTerminalSession(runtime, config, mode, cols, rows, termId)  // :420
    attachTerminalSocket(runtime, session, socket)
  } catch (error) { ... }
  ...
}
```
```ts
// :446-513 — getOrCreateTerminalSession, the real async race window
async function getOrCreateTerminalSession(runtime, config, mode, cols, rows, termId = 'main') {
  const key = runtime.registry.sessionKey(config, mode, termId)
  const existing = runtime.registry.getReusable(config, mode, cols, rows, termId)
  if (existing) { ...; return existing }

  const launch = runtime.dependencies.buildTerminalProcessLaunch(config, mode, defaultShell())
  await cleanupStaleClaudeSession(launch)      // <- await gap #1
  ...
  const proc = runtime.dependencies.spawnPty(...)
  ...
  const session = runtime.registry.register({ key, ... })  // sessions.set clobbers on race
  ...
  return session
}
```
`cleanupStaleClaudeSession` (`:731-746`) — `execFileSync('ps', ...)` inside
`findClaudeSessionPids` (`:748-765`), synchronous, runs on every claude
runtime spawn (A2.3).

### `src/server/kiriterm-daemon.ts`

```ts
// :175-178 — check-then-act daemon guard, no lock
const existing = readKiritermDaemonRecord(stateDir)
if (existing && (await checkKiritermDaemonHealth(existing))) {
  throw new Error(`kiriterm daemon already running (pid ${existing.pid}, port ${existing.port})`)
}
```
```ts
// :214-215 — the ONLY place idleKillModes is overridden away from the default
{
  idleKillModes: ['shell'],
  ...
}
```
```ts
// :219-225 — restoreContent, only deletes on the shell-hit path
restoreContent: (key, mode) => {
  if (mode !== 'shell') return null       // <- runtime entries never deleted (A2.1)
  const persisted = restoredSessions.get(key)
  if (!persisted) return null
  restoredSessions.delete(key)
  return `${persisted.snapshot}\r\n...`
},
```
```ts
// :246-257 — close() only removes daemon.json, never sweeps sessionsDir (A2.2)
const close = async () => {
  if (closed) return
  closed = true
  clearInterval(dumpInterval)
  dumpSessions()
  await service.close()
  const current = readKiritermDaemonRecord(stateDir)
  if (current && current.pid === process.pid) {
    rmSync(join(stateDir, 'daemon.json'), { force: true })
  }
}
```
`dumpSessions` (`:261-292`) — already gated on `outputSeq` stamp (plan 004),
still one synchronous loop over every live session per 30s tick (A2.3).
`loadPersistedSessions` (`:429-448`) loads all `*.json` regardless of `mode`.

### `src/server/kiriterm-daemon-client.ts`

```ts
// :37-46 — ensureDaemon
async function ensureDaemon(): Promise<KiritermDaemonRecord> {
  if (record && (await checkKiritermDaemonHealth(record))) return record
  record = null
  if (!ensuring) {
    ensuring = discoverOrSpawn().finally(() => { ensuring = null })
  }
  return ensuring
}
```
```ts
// :48-65 — discoverOrSpawn, cross-process TOCTOU (A1.3) and the broken
// "is this a new daemon" check (A1.4, line 59)
async function discoverOrSpawn(): Promise<KiritermDaemonRecord> {
  const existing = readKiritermDaemonRecord(stateDir)
  if (existing && (await checkKiritermDaemonHealth(existing))) {
    record = existing
    return existing
  }
  spawnDaemonProcess(stateDir)
  const deadline = Date.now() + (options.spawnTimeoutMs ?? 8_000)
  while (Date.now() < deadline) {
    await sleep(120)
    const candidate = readKiritermDaemonRecord(stateDir)
    if (candidate && candidate !== existing && (await checkKiritermDaemonHealth(candidate))) {
      //             ^^^^^^^^^^^^^^^^^^^^^^^ always true — fresh JSON.parse object every call
      record = candidate
      return candidate
    }
  }
  throw new Error('kiriterm daemon did not become healthy in time')
}
```
`checkKiritermDaemonHealth` (`kiriterm-daemon.ts:154-166`) —
`AbortSignal.timeout(700)` (A2.3).

### `src/components/kiri-board/terminal-panel.tsx`

```ts
// :78, :106-108 — the existing ref pattern this plan mirrors for toggleFocusKey
const onKeyboardFocusExitRef = React.useRef(onKeyboardFocusExit)
...
React.useEffect(() => {
  onKeyboardFocusExitRef.current = onKeyboardFocusExit
}, [onKeyboardFocusExit])
```
```ts
// :321-334 — toggleFocusKey read directly from the prop closure (not a ref)
term.attachCustomKeyEventHandler((event) => {
  if (isTerminalToggleFocusEvent(event, toggleFocusKey)) {   // <- closes over prop
    ...
  }
  return true
})
```
```ts
// :414-436 — connect-effect cleanup; closes the WS on unmount
return () => {
  disposed = true
  if (socket) {
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
  }
  socket?.close()     // :422
  ...
}
}, [agent.id, connectionGeneration, mode, project.cwd, termId, toggleFocusKey])  // :437
```
`socket.onclose` (`:379-384`) sets `status='Closed'`, no reconnect (owned by
010/011, not this plan).

### `src/components/kiri-board/selected-agent-pane.tsx`

```ts
// :153-158 — the effect that unmounts the previous agent's TerminalPanel
React.useEffect(() => {
  setMountedTerminalModes({
    runtime: selectedAgent?.interfaceMode === 'terminal' && tab === 'chat',
    shell: Boolean(selectedAgent) && tab === 'terminal',
  })
}, [selectedProject.id, selectedAgent?.id, selectedAgent?.interfaceMode])
```
This is the trigger that starts A-KILL's 5-minute clock — not itself
changed by this plan (unmounting on switch is correct UI behavior; the bug is
that the *server* treats "no socket" as "kill the agent").

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Server tests | `pnpm exec vitest run tests/server/` | all pass |
| Unit tests | `pnpm test:unit` | all pass |
| Build | `pnpm build` | exit 0 |
| Targeted: registry/daemon/server | `pnpm exec vitest run tests/server/terminal-registry.test.ts tests/server/terminal-server.test.ts tests/server/kiriterm-daemon.test.ts` | all pass |
| Board tests (A3.2 only) | `pnpm exec vitest run tests/kiri-board/` | all pass |

## Scope

**In scope**:
- `src/server/terminal-registry.ts` — idle-kill default is read here but the
  override point is `terminal-server.ts` (see Step 1); no behavior change to
  the registry's own default.
- `src/server/terminal-server.ts` — embedded idle-kill default override
  (Step 1), in-flight spawn dedup covering both `spawnAgentRuntime` and
  `getOrCreateTerminalSession`/WS attach (Step 2).
- `src/server/kiriterm-daemon.ts` — daemon spawn lock (Step 3),
  `restoreContent` runtime-entry cleanup (Step 4), sessionsDir eviction
  (Step 5), health-check timeout / dumpSessions yield (Step 6).
- `src/server/kiriterm-daemon-client.ts` — daemon spawn lock (Step 3),
  candidate-identity comparison fix (Step 3b).
- `src/components/kiri-board/terminal-panel.tsx` — `toggleFocusKey` ref,
  drop from connect-effect deps (Step 7).
- `tests/server/terminal-registry.test.ts`, `tests/server/terminal-server.test.ts`,
  `tests/server/kiriterm-daemon.test.ts` — regression tests per step.
- `tests/kiri-board/` — regression test for Step 7 if a seam exists.

**Out of scope** (do NOT touch):
- `src/components/kiri-board/selected-agent-pane.tsx` — read for context only;
  the unmount-on-switch behavior is correct UI, not a bug this plan fixes.
- Client-side WS reconnect-on-exit and the subscribe-to-key rearchitecture —
  owned by plans 010/011.
- Codex thread/resume mapping (B1/B2/B6/C1) — plan 013.
- `deleteProjectAndCleanupRuntimes` / `${projectId}:shell` cleanup (H3) —
  plan 018.
- A4 (background-window flow-control stall) — speculative, needs an empirical
  repro before it's worth a code change; not addressed here.
- Scrollback size (`defaultScrollback = 10_000`) and the daemon's `agents`
  map eviction — explicitly deferred by plan 004; do not revisit.

## Git workflow

- Branch: `advisor/012-terminal-daemon-pty-lifecycle`
- Commit style: short imperative subject, no prefix.
- Land in step order below as separate commits so each is independently
  reviewable/revertable.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Default the embedded server's runtime PTYs out of idle-kill (A-KILL)

In `terminal-server.ts`, `embeddedService()` (`:151-154`) currently calls
`makeTerminalServerService()` with no options, so `idleKillModes` falls
through to the registry's default `['shell', 'runtime']`
(`terminal-registry.ts:104`). Change the embedded facade to pass
`idleKillModes: ['shell']` explicitly, matching the daemon
(`kiriterm-daemon.ts:214-215`):

```ts
const embeddedService = () => {
  embedded ??= makeTerminalServerService({}, { idleKillModes: ['shell'] })
  return embedded
}
```

Do not change `makeTerminalServerService`'s own default (leave callers that
construct it directly — tests, the daemon — free to opt into strict
idle-kill for both modes if they need it). Runtime PTYs are now reclaimed
only by explicit `closeAgentRuntime` (agent delete/archive) — confirm that
path still exists and is exercised on session delete
(`runtime-cleanup.ts` → `closeAgentRuntime` → `terminal-registry.ts:431-434`).

**Verify**: `pnpm typecheck` → 0. Add a `terminal-server.test.ts` case: a
runtime session with zero sockets, after `idleKillMs` elapses (use the test's
fake timers), is NOT killed; a shell session under the same conditions IS
killed. `pnpm exec vitest run tests/server/terminal-server.test.ts` → pass.

### Step 2: Dedup concurrent spawns across BOTH entry points (A1.1)

In `terminal-server.ts`, inside `makeTerminalServerService`, add an in-flight
promise map keyed by the registry's session key, and make
`getOrCreateTerminalSession` itself collapse concurrent callers — not just
`spawnAgentRuntime`:

```ts
const spawnInFlight = new Map<string, Promise<TerminalRegistrySession>>()

async function dedupedGetOrCreateTerminalSession(
  runtime: TerminalServerRuntime,
  config: TerminalAgentLaunchConfig,
  mode: TerminalMode,
  cols: number,
  rows: number,
  termId = 'main',
) {
  const key = runtime.registry.sessionKey(config, mode, termId)
  let inflight = spawnInFlight.get(key)
  if (!inflight) {
    inflight = getOrCreateTerminalSession(runtime, config, mode, cols, rows, termId)
      .finally(() => spawnInFlight.delete(key))
    spawnInFlight.set(key, inflight)
  }
  const session = await inflight
  if (!session.exited && (session.cols !== cols || session.rows !== rows)) {
    runtime.registry.resize(session, cols, rows)
  }
  return session
}
```

Replace both call sites — `spawnAgentRuntime` (`:285`) and
`handleTerminalConnection` (`:420`) — with calls to
`dedupedGetOrCreateTerminalSession`. This closes the gap 010's Step 1 leaves
open (010 only wraps `spawnAgentRuntime`); if 010 has already landed,
refactor its dedup map into this shared function rather than keeping two.
The resize-after-await is required for the real race where the prewarm caller
and the renderer WS attach request different dimensions; do not omit it as a
cosmetic cleanup.

**Verify**: `pnpm typecheck` → 0. Test: concurrently call
`spawnAgentRuntime({agentId})` and simulate a WS attach for the same agent
(drive `handleTerminalConnection`'s session-acquisition path directly if the
existing harness allows, else via two `spawnAgentRuntime` calls plus one
direct `getOrCreateTerminalSession`-equivalent path if exposed) — assert
`spawnPty` fakes ran exactly once and `registry.sessions` has exactly one
entry under the key. Include a mismatched-geometry case (`spawnAgentRuntime`
defaults `100x30`, WS attach requests a different size) and assert the final
session/snapshot dimensions match the later attach request. `pnpm exec vitest
run tests/server/terminal-server.test.ts` → pass.

### Step 3: OS-level exclusive lock around daemon spawn (A1.3)

Add a `daemon.lock` file, written with the same exclusive-write pattern
already used in `src/server/runtime-attachments.ts:47`
(`writeFileSync(path, bytes, { flag: 'wx' })` — fails with `EEXIST` if the
file exists).

In `kiriterm-daemon.ts` `startKiritermDaemon` (`:168-178`): before the
existing `readKiritermDaemonRecord`/health-check guard, attempt to create
`join(stateDir, 'daemon.lock')` with `{ flag: 'wx' }`. If creation fails with
`EEXIST`, treat it the same as "another daemon is starting" — re-run the
existing existing-record/health check (a concurrent starter may already have
written `daemon.json`) and throw the existing "already running" error if
healthy, or wait briefly and retry the lock a bounded number of times
otherwise. On success, proceed with the existing startup sequence, and
`rmSync` the lock file in `close()` (alongside the existing `daemon.json`
removal at `:253-256`) — and also on any thrown startup error, so a crashed
attempt doesn't wedge the lock forever (use try/finally around the body from
the lock acquisition through `writeFileAtomic(daemon.json, ...)`).

In `kiriterm-daemon-client.ts` `discoverOrSpawn` (`:48-65`): before calling
`spawnDaemonProcess`, attempt the same `wx` lock create. If it fails with
`EEXIST`, skip spawning (another process in this or another Kiri process is
already spawning) and fall through directly to the existing poll loop
(`while (Date.now() < deadline) { ... }`) waiting for `daemon.json` to appear
healthy. If lock creation succeeds, spawn as today, then remove the lock file
once the poll loop resolves (success or timeout) — a `finally` around the
spawn+poll.

Handle the stale-lock case: if the lock file is older than a small ceiling
(e.g. `spawnTimeoutMs`, already `8_000` by default at
`kiriterm-daemon-client.ts:55`), treat it as abandoned (a previous
spawner crashed before cleanup) — `rmSync` it and retry acquisition once.
Use `statSync(lockPath).mtimeMs` for the age check.

**Verify**: `pnpm typecheck` → 0. Test in
`tests/server/kiriterm-daemon.test.ts` (or a new
`tests/server/kiriterm-daemon-client.test.ts` if a client-side harness
exists — check first): two concurrent `startKiritermDaemon`/`discoverOrSpawn`
calls against the same `stateDir` with a fake filesystem/child-process spawn
stub result in exactly one daemon actually starting; the second caller either
throws the "already running" error or resolves to the same record. Also
test: a lock file older than the ceiling is removed and acquisition retried.

### Step 3b: Fix the broken "is this a new daemon" identity check (A1.4)

In `kiriterm-daemon-client.ts:59`, replace object-identity comparison with a
field comparison:

```ts
if (
  candidate &&
  (!existing || candidate.pid !== existing.pid || candidate.startedAt !== existing.startedAt) &&
  (await checkKiritermDaemonHealth(candidate))
) {
  record = candidate
  return candidate
}
```

Do this in the same commit as Step 3 (both touch `discoverOrSpawn`).

**Verify**: `pnpm typecheck` → 0. Test: a health-check failure followed by an
immediate success against the SAME daemon record (same pid/startedAt,
different object instance from re-parsing) does NOT trigger
`spawnDaemonProcess`.

### Step 4: Stop persisting/loading runtime-mode snapshots at all (A2.1)

In `kiriterm-daemon.ts`, three coordinated changes:

1. `dumpSessions` (`:261-292`): skip sessions whose `mode !== 'shell'`.
   Runtime snapshots are never consumed by `restoreContent`, so writing them
   is pure disk/CPU waste — and the synchronous `JSON.stringify` +
   `writeFileSync` per runtime session is part of A2.3's health-check stall.
   Do not touch the plan-004 outputSeq stamp gating for shell sessions.
2. `loadPersistedSessions` (`:429-448`): when a loaded file's `mode` is not
   `'shell'`, `rmSync` it (legacy cleanup from builds that dumped runtime
   snapshots) and do not insert it into `restoredSessions`.
3. `restoreContent` (`:219-225`): keep a defensive delete for any non-shell
   entry that still sneaks in:

```ts
restoreContent: (key, mode) => {
  if (mode !== 'shell') {
    restoredSessions.delete(key)   // never reachable again; free it now
    return null
  }
  const persisted = restoredSessions.get(key)
  if (!persisted) return null
  restoredSessions.delete(key)
  return `${persisted.snapshot}\r\n\x1b[2m[kiriterm: restored scrollback from previous session]\x1b[0m\r\n`
},
```

If a future plan wants runtime scrollback restore across daemon restarts
(plan 011's territory), it should reintroduce runtime persistence
deliberately with a consumer — not by reverting this step.

**Verify**: `pnpm exec vitest run tests/server/kiriterm-daemon.test.ts` → new
cases: (a) a pre-existing runtime-mode snapshot file on disk is removed at
daemon boot and not re-created by a dump tick; (b) a live runtime session
produces no snapshot file after a forced dump, while a shell session still
does; (c) plan 004's existing dump-gating tests pass unmodified.

### Step 5: Evict `sessionsDir` snapshot files for gone agents (A2.2)

Note: after Step 4, runtime snapshots are no longer written and legacy ones
are swept at boot, so this step's eviction matters mainly as belt-and-braces
for files written between a kill and the next boot. The remaining real gap
is **shell** snapshot files (`${projectId}:shell*.json`) for deleted
projects — plan 018's Step 1 (kill-prefix on project delete) is where the
daemon-side kill happens; its kill path should also unlink the matching
snapshot files (cross-reference, don't implement 018 here).

In `kiriterm-daemon.ts`, extend the `/api/agents/close-runtime` handler
(`:371-376`) — the point where an agent's runtime session is deliberately
torn down — to also remove that key's snapshot file:

```ts
if (route === 'POST /api/agents/close-runtime') {
  const input = agentIdSchema.parse(body)
  service.closeAgentRuntime(input.agentId)
  const key = `${input.agentId}:runtime`
  lastDumpByKey.delete(key)
  try {
    rmSync(join(sessionsDir, `${encodeURIComponent(key)}.json`), { force: true })
  } catch (error) {
    console.error('kiriterm: failed to remove session snapshot', key, error)
  }
  sendControlJson(response, 200, { ok: true })
  return
}
```

This covers the common case (session delete/archive calls
`closeAgentRuntime`, per Step 1's confirmation). It does not cover
project-delete-without-agent-close or an agent whose file was written but
whose in-memory session already exited before a close-runtime call arrives
— note this gap explicitly in the commit message; a full "sweep files for
agents that no longer exist in the DB" pass needs DB access the daemon
doesn't have (it only has what `agents/upsert` pushed), and is better done
from the backend side once 015 defines the delete/archive event — do not
build that here.

**Verify**: `pnpm exec vitest run tests/server/kiriterm-daemon.test.ts` → new
case: spawn a runtime session, force a dump (advance the fake dump interval
or call the test harness's dump trigger), assert the snapshot file exists,
call close-runtime for that agent, assert the file is gone.

### Step 6: Health-check timeout headroom + non-blocking dumpSessions (A2.3)

In `kiriterm-daemon.ts`:

1. Raise `checkKiritermDaemonHealth`'s timeout (`:158`,
   `AbortSignal.timeout(700)`) to a value with headroom over one
   `dumpSessions` tick's worst observed case — `2_000`ms is a reasonable,
   still-responsive ceiling; do not make this configurable, just bump the
   constant.
2. In `dumpSessions` (`:261-292`), yield to the event loop between sessions
   instead of looping synchronously through all of them in one tick — wrap
   the per-session body in a microtask/short-timeout yield (e.g.
   `await new Promise(resolve => setImmediate(resolve))` every N sessions,
   or after each session if the daemon's typical session count is small
   enough that this doesn't meaningfully delay the dump). Check whether
   `dumpSessions` is already `async`/awaited by its caller (`setInterval`
   callback at `:241-244`) before changing its signature — if it isn't
   awaited, make it `async` and let the interval fire-and-forget it (do not
   block the interval callback).

Note in the commit message: this reduces the health-check false-positive
window but does not eliminate the underlying race — Step 3's daemon lock is
the actual fix for "spurious respawn from a transient health blip."

**Verify**: `pnpm typecheck` → 0. `pnpm exec vitest run tests/server/kiriterm-daemon.test.ts` →
existing dump-gating tests (from plan 004) still pass unmodified (yielding
must not change the stamp-gating semantics, only its blocking behavior).

### Step 7: Stop `toggleFocusKey` from tearing down every terminal pane (A3.2)

In `terminal-panel.tsx`:

1. Add a ref, mirroring the existing `onKeyboardFocusExitRef` pattern
   (`:78`, `:106-108`):

```ts
const toggleFocusKeyRef = React.useRef(toggleFocusKey)

React.useEffect(() => {
  toggleFocusKeyRef.current = toggleFocusKey
}, [toggleFocusKey])
```

2. In the connect effect's `term.attachCustomKeyEventHandler` callback
   (`:321-334`), read `toggleFocusKeyRef.current` instead of the closed-over
   `toggleFocusKey` prop:

```ts
term.attachCustomKeyEventHandler((event) => {
  if (isTerminalToggleFocusEvent(event, toggleFocusKeyRef.current)) {
    ...
  }
  return true
})
```

3. Remove `toggleFocusKey` from the connect effect's dependency array
   (`:437`):

```ts
}, [agent.id, connectionGeneration, mode, project.cwd, termId])
```

Also update `toggleFocusLabel` (`:440`, outside the effect, reads the prop
directly) — leave as-is, it's a render-time label, not inside the effect, so
it already reflects the latest prop without needing the ref.

**Verify**: `pnpm typecheck` → 0. If `terminal-panel` has a test seam for
the connect effect (check `tests/kiri-board/` for an existing pattern —
e.g. a fake WebSocket harness), add a case: changing `toggleFocusKey` across
a rerender does NOT close/reopen the socket (assert the same WebSocket
instance, or that `spawnPty`/connect fakes were called only once). If no
seam exists, do not build new test infra — record a manual check: open a
runtime terminal, change the toggle-terminal-focus keybinding in settings,
confirm the pane's status does not flash "Connecting" and scrollback is not
lost. `pnpm exec vitest run tests/kiri-board/` → pass (no regressions).

### Step 8: Full regression gates

**Verify**: `pnpm typecheck && pnpm test:unit && pnpm build` → all exit 0.
`git status` shows only in-scope files changed.

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts above don't match live code (drift) — especially
  `idleKillModes`, `getOrCreateTerminalSession`, `discoverOrSpawn`,
  `restoreContent`, or the connect-effect deps array in `terminal-panel.tsx`.
- Excluding `'runtime'` from the embedded server's idle-kill default (Step 1)
  turns up a caller that relies on runtime PTYs being reaped without an
  explicit `closeAgentRuntime` — find and fix that caller's cleanup path
  first; do not leave a real leak to ship the idle-kill exclusion.
- The daemon spawn lock (Step 3) introduces a deadlock or a case where a
  crashed process's lock file is never cleaned up and blocks all future
  daemon starts — the stale-lock age check must be verified against a
  simulated crash (kill the "spawner" mid-lock in a test) before this step is
  considered done.
- Plan 010 has already landed with its own dedup map wrapping only
  `spawnAgentRuntime` — do not add a second, competing dedup map; refactor
  010's map into Step 2's shared function in the same commit and note it in
  the PR description.
- Fixing A2.1/A2.2 requires DB access the daemon doesn't have (it doesn't,
  per the "Approach" notes — if you find a case where it does, that's new
  information, re-scope with the operator rather than reaching into `db.ts`
  from the daemon process).

## Maintenance notes

- Once plan 015 defines a formal project/agent-deleted event, revisit Step
  5's ad hoc `close-runtime`-triggered file eviction — it should become a
  subscriber to that event instead of piggybacking on one specific route.
- Once plan 011 lands, re-check whether A-KILL's idle-kill exclusion is still
  the right default — 011's subscribe-to-key model may make "no live
  subscriber for N minutes" a better liveness signal than "no socket", in
  which case the exclusion in Step 1 could be replaced by a longer,
  subscriber-aware timeout instead of a blanket exemption.
- The A1.3 lock file is a coarse per-`stateDir` mutex; if kiriterm ever needs
  finer-grained locking (e.g. per-session), do not extend this file's scheme
  ad hoc — introduce a proper lock abstraction at that point.
