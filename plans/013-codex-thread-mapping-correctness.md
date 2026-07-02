# Plan 013: Codex thread mapping correctness (reset leakage, fast-path mapping, hook clobbering, generation races)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1fa5160..HEAD -- src/server/codex-runtime.ts src/server/codex-terminal-session.ts src/server/codex-hook-handler.ts src/server/codex-cli-sessions.ts src/server/codex-retained-state.ts src/server/codex-app-server.ts src/server/codex-item-recording.ts src/server/terminal-launch.ts`
> If any in-scope file changed since this plan was written, re-open it and
> compare the "Current state" excerpts below against the live code before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none to start; Steps 3 (B4) and 4 (B6) are principled-superseded
  by plan 014's C5 (pid-anchored transcript resolution) and C1 (resume re-bind) —
  do this plan's tactical fixes regardless, but do not let them block 014.
  Plan 012 (A-KILL default idle-kill) is the amplifier that makes resumes this
  frequent; fixing 012 lowers the frequency of every bug here but does not fix
  any of them.
- **Category**: bugfix (codex runtime / thread-agent mapping)
- **Planned at**: commit `1fa5160`, 2026-07-01

## Why this matters

Codex has two id spaces that never share failure handling: the CLI/terminal
session id (`codex-terminal-session.ts`, raw PTY, resume via `codex resume
<id>`) and the app-server thread id (`state.threadId`, shared
`CodexAppServerAdapter` websocket, GUI-mode turns). Both are reconstructed from
best-effort on-disk files and an in-memory singleton
(`retainedState` in `src/server/codex-runtime.ts:61`) that is wiped on every
backend restart. There are no TODO/FIXME markers anywhere in this code —
the fragility is structural, not a known-and-deferred gap. Symptoms in the
field: agents stuck "running" forever, reset silently reviving a discarded
thread, two terminals opened close together cross-binding to each other's
rollout, and long sessions silently losing items from their transcript.

This plan fixes the direct/tactical bugs in the current DB + in-memory state
machine. It does **not** attempt the principled pid-anchored fix (that's plan
014 C5) — B4/B6 get a fail-closed tactical fix here, then get subsumed when
014 lands.

## Approach (decided)

Tactical, minimal-diff fixes in priority order, each independently testable:

1. **B1** — `resetCodexSession` must unlink the two on-disk resume-binding
   files, not just clear DB/in-memory state.
2. **B2** — call `rememberCodexThread` unconditionally on every path that
   reads a `threadId`, not only the queued turn-start path.
3. **B4** — capture and reject subagent/child `SessionStart` hooks before
   they clobber the primary binding.
4. **B6** — fail closed (no resume) when the cwd-scan fallback can't
   disambiguate concurrent same-cwd launches, instead of guessing via
   closest-timestamp.
5. **B9** — re-check the generation immediately around
   `resetCodexSession`'s interrupt+forget so an in-flight closure can't
   silently re-persist a thread the user just reset.
6. **B5** — classify codex errors via the codex app-server's structured
   `error.code`/`data` when present; fall back to the current substring match
   only when it isn't, with the version-fragility called out at the call site.
7. **B7** — TTL/invalidate the `codexHooksSupported` process-wide cache.
8. **B11** — audit codex item types and add explicit handling/unrecognized-item
   logging instead of silently dropping unknown item types.
9. **B8** — scope `CodexAppServerAdapter`'s completed-turn cache and
   `codex-retained-state`'s turn-start-projection cache per-agent/thread
   instead of one shared bound.
10. **B10** — document (comment only) the asymmetry that `codexLaunch`'s
    resume lookup passes no `launchedAtMs`, so the `writtenAtMs` staleness
    guard is unconditionally skipped pre-launch.

## Current state

### B1 — reset doesn't clear on-disk resume bindings

`src/server/codex-runtime.ts:182-204`:

```ts
export async function resetCodexSession(input: { agentId: string } & CodexRuntimeDependencies) {
  const runtimeBinaries = runtimeBinariesFor(input)
  retainedState.bumpGeneration(input.agentId)
  const state = codexState(getAgentRuntimeState(input.agentId))
  if (state.threadId) {
    try {
      const adapter = getOrCreateCodexAdapter(state.websocketUrl, runtimeBinaries)
      const thread = await readCodexThread(adapter, state.threadId)
      const activeTurnId = activeCodexTurnId(thread)
      if (activeTurnId) {
        await adapter.interruptTurn({ threadId: state.threadId, turnId: activeTurnId })
      }
    } catch {
      // Reset should clear local state even if the remote turn is already gone.
    }
  }
  forgetCodexRuntimeAgent(input.agentId, { keepGeneration: true })
  clearAgentRuntimeState(input.agentId)
  resetStoredSession(input.agentId)
}
```

This clears in-memory (`retainedState`) and DB (`resetStoredSession` →
`resetSession` in `src/server/db.ts:385-387` → `resetSessionRows` in
`src/server/db/session-operations.ts:39-59`, which deletes `messages`,
`timeline_events`, `agent_tasks` rows for the thread and clears
`agent_slots.session_file`). It never touches disk. The two files live in
`src/server/codex-terminal-session.ts`:

```ts
// :19-21
export function codexTerminalSessionIdPath(sessionDir: string) {
  return join(sessionDir, codexSessionIdFile) // 'codex-session-id'
}

// :23-25
export function codexHookSessionBindingPath(sessionDir: string) {
  return join(sessionDir, codexHookSessionFile) // 'codex-hook-session.json'
}
```

`readCodexTerminalResumeId` (`codex-terminal-session.ts:68-84`) checks the hook
binding file *first*:

```ts
export function readCodexTerminalResumeId(input: { ... }) {
  const binding = readCodexHookSessionBinding(input.sessionDir)
  const hookSessionId = codexHookSessionIdForLaunch(binding, input)
  ...
  return hookSessionId
    ?? rejectCodexSessionId(readCodexTerminalSessionId(input.sessionDir), rejectedHookSessionId)
    ?? rejectCodexSessionId(normalizeCodexSessionId(input.state?.codexSessionId), rejectedHookSessionId)
    ?? normalizeCodexSessionId(input.state?.resume)
}
```

`codexLaunch` (`src/server/terminal-launch.ts:302-338`) calls this at
`terminal-launch.ts:307-312` with no `launchedAtMs` (see B10). Since the
stale binding still matches `agentId`/`cwd` (`codexHookSessionBindingMatchesLaunch`,
`codex-terminal-session.ts:99-110`, which only rejects on agentId mismatch or
a `launchedAtMs`-gated staleness check that isn't provided here), the next
terminal-mode `codex resume <old-id>` silently resumes the discarded thread —
reset appears to "not stick" on next terminal relaunch.

### B2 — fast steer paths never register the thread→agent mapping

`rememberCodexThread` (`codex-runtime.ts:779-781`):

```ts
function rememberCodexThread(agentId: string, threadId: string) {
  retainedState.rememberThread(agentId, threadId)
}
```

Only called from the **queued** path, inside `startOrSteerCodexTurn`
(`codex-runtime.ts:298-357`, call at line 312):

```ts
yield* Effect.sync(() => {
  input.setActiveThreadId(threadId)
  rememberCodexThread(input.config.id, threadId)  // :312
})
```

and identically in `startCodexReview` (`:359-411`, call at line 373).

The **fast** paths skip it entirely. `promptCodexAgent`
(`codex-runtime.ts:69-108`), lines 82-98:

```ts
if (state.threadId) {
  const adapter = getOrCreateCodexAdapter(state.websocketUrl, runtimeBinaries)
  const thread = await readCodexThreadIfAvailable(adapter, state.threadId)
  if (thread) {
    syncCodexThreadStatus(config.id, thread)
    const activeTurnId = activeCodexTurnId(thread)
    if (activeTurnId) {
      await steerCodexTurn(config.id, { ...state, threadId: state.threadId }, activeTurnId, text, runtimeBinaries)
      return
    }
  } else {
    forgetCodexThread(config.id, state)
  }
}
```

`steerCodexAgent` (`:110-138`), lines 116-137, same shape — reads
`state.threadId` from DB, steers an active turn, never calls
`rememberCodexThread`. `interruptCodexAgent` (`:140-161`) also reads/uses
`state.threadId` without remembering it.

`retainedState` is a module-level singleton (`codex-runtime.ts:61`), wiped on
backend restart. `projectCodexNotification` (`:506-641`) resolves the owning
agent purely from this in-memory map:

```ts
// :508-511
const params = objectValue(message.params)
const threadId = stringValue(params.threadId)
const agentId = threadId ? retainedState.agentForThread(threadId) : undefined
if (agentId && retainedState.threadForAgent(agentId) !== threadId) return
...
// :537
if (!agentId) return
```

If a long turn is in flight at restart, the next prompt for that agent takes
the fast path (thread + active turn both still exist server-side) and steers
without ever calling `rememberCodexThread` — so every subsequent
`status/changed`, `item/completed`, `turn/completed`, `tokenUsage/updated`
notification for that thread is silently dropped at line 537, and the agent
shows "running" forever.

### B4 — SessionStart hook has no subagent/child-thread guard

`src/server/codex-cli-sessions.ts:76` (the discovery scan fallback, aware of
the problem):

```ts
if ('thread_source' in payload && payload.thread_source === 'subagent') continue
```

But `handleCodexSessionStartHook` / `parseHookPayload`
(`src/server/codex-hook-handler.ts:13-86`) apply no such filter. The cwd check
is the only gate (`:25-28`):

```ts
const expectedCwd = stringValue(input.env.KIRI_PROJECT_CWD)
if (expectedCwd && (!payload.cwd || resolve(payload.cwd) !== resolve(expectedCwd))) {
  return { ok: true, reason: 'Ignored SessionStart hook for a different cwd' }
}

writeCodexTerminalSessionId(sessionDir, payload.sessionId)
writeCodexHookSessionBinding(sessionDir, { agentId, sessionId: payload.sessionId, ... })
```

`parseHookPayload` (`:50-86`) never reads or returns `thread_source` at all —
any SessionStart whose `cwd` matches `KIRI_PROJECT_CWD` overwrites both
`codex-hook-session.json` and `codex-session-id` unconditionally. A child/
subagent rollout created in the same cwd (inheriting `KIRI_SESSION_DIR`/
`KIRI_AGENT_ID` from the parent's env) fires its own SessionStart and clobbers
the binding with the subagent's thread id — the next resume then maps to the
wrong thread.

### B6 — concurrent same-cwd launches cross-map by scan fallback

`rememberCodexTerminalSession` (`src/server/codex-cli-sessions.ts:104-165`)
waits up to `hookWaitMs` for the hook binding (`:120`):

```ts
const hookWaitMs = Math.min(input.hookWaitMs ?? 15_000, totalWaitMs)
```

then falls back (`:138-145`) to `waitForLatestCodexSessionForCwd` →
`findLatestCodexSessionForCwd` (`:56-102`), matching purely on cwd + closest
launch timestamp, with no per-launch nonce anywhere in
`CodexSessionDiscoveryInput` (`:25-32`) or `RememberCodexTerminalSessionInput`
(`:39-45`). Two terminals for the same project cwd launched within seconds of
each other (e.g. two panes reattaching after an idle-kill batch, see plan
012's A-KILL) can each resolve to the *other's* rollout file.

### B9 — generation-bump race can orphan a live server-side turn

Re-reading `resetCodexSession` (`codex-runtime.ts:182-204`, excerpted above):
the actual order is **bump generation first** (`:184`), *then* await
interrupt (`:187-199`, includes a `readCodexThread` network round trip), then
forget (`:201-203`). `startOrSteerCodexTurn` (`:298-357`) only checks
`isCurrentCodexGeneration` at two points — `:309` (right after
`ensureCodexThreadEffect` resolves) and `:346` (after
`waitForTurnCompleted`, which can block up to `turnTimeoutMs` = 30 minutes,
`codex-app-server.ts:61`). There is no check around the `startTurn` call
itself (`:328-334`) or around `rememberCodexThread` (`:312`).

Because the generation captured for a closure is fixed at enqueue time
(`codex-runtime.ts:100`, `retainedState.generation(config.id)`), a closure
that already passed the `:309` check before `resetCodexSession` runs will:
continue to `rememberCodexThread` (`:312`, re-inserting the agentId↔threadId
mapping that `forgetCodexRuntimeAgent` just removed from `retainedState`),
call `startTurn` against the old (already-forgotten, DB-cleared) `threadId`,
and — only after `waitForTurnCompleted` resolves — hit the `:346` check and
bail *without* calling `recordCodexTurn`/`setCodexState`. In that window the
in-memory `retainedState` mapping and the DB `runtimeState.threadId` (cleared
by `resetCodexSession`'s `clearAgentRuntimeState`, `:202`) disagree, and a real
turn runs server-side on a thread the reset call believed it had already
interrupted and abandoned.

### B5 — missing-rollout auto-respawn keyed to a fragile English substring match

`ensureCodexThreadEffect` (`codex-runtime.ts:413-465`), the resume branch
(`:420-441`):

```ts
if (!isMissingRolloutError(runtimeCause(resumed.left))) {
  return yield* resumed.left
}
yield* Effect.sync(() => { forgetCodexThread(input.config.id, input.state) })
```

then falls through to `startThread` (`:443-448`) — a brand-new thread,
discarding the previous conversation. The classifiers
(`codex-runtime.ts:753-762`):

```ts
function isUnmaterializedThreadReadError(error: unknown) {
  return error instanceof Error &&
    error.message.includes('not materialized yet') &&
    error.message.includes('includeTurns')
}

function isMissingRolloutError(error: unknown) {
  return error instanceof Error &&
    error.message.includes('no rollout found for thread id')
}
```

Both consume `error.message` from `CodexAppServerError` built in
`codexProtocolPromise` (`codex-runtime.ts:735-743`), which wraps whatever
`response.error.message` the codex app-server returned
(`codex-app-server.ts:415-419`); `response.error` (with `.code`/`.data`) is
discarded — only `.message` reaches `CodexAppServerError.cause`. A codex
version reword of either string breaks classification silently (either a
recoverable "no rollout" case surfaces as a hard error, or an unrelated error
coincidentally matches and triggers an unwanted thread-forget-and-respawn).

### B7 — `codexHooksSupported` cached forever per-process per-binary-path

`src/server/terminal-launch.ts:90` (module scope):

```ts
const codexHookSupportByCommand = new Map<string, boolean>()
```

`codexHooksSupported` (`:392-408`):

```ts
function codexHooksSupported(command: string, context: TerminalLaunchContext) {
  if (context.env.KIRI_CODEX_HOOKS === '0') return false
  if (context.env.KIRI_CODEX_HOOKS === '1') return true

  const cached = codexHookSupportByCommand.get(command)
  if (cached !== undefined) return cached

  const result = spawnSync(command, ['--help'], { encoding: 'utf8', env: context.env, timeout: 5_000 })
  const supported = result.status === 0
    && `${result.stdout ?? ''}\n${result.stderr ?? ''}`.includes('dangerously-bypass-hook-trust')
  codexHookSupportByCommand.set(command, supported)
  return supported
}
```

Once cached `false` for a resolved `command` path, upgrading the codex binary
in place (same path) to add hook support never gets re-probed without
restarting Kiri — every subsequent launch silently falls back to the racy B6
scan path.

### B11 — unhandled codex item types silently dropped

`codexItemRecord` (`src/server/codex-item-recording.ts:29-82`) has an explicit
branch per known type — `agentMessage` (`:39-50`), `reasoning` (`:52-66`),
`commandExecution` (`:68-79`) — and falls through to `return null` (`:81`) for
everything else. `recordCodexItem` (`codex-runtime.ts:814-822`):

```ts
function recordCodexItem(agentId: string, item: unknown, timestamp = new Date().toISOString()) {
  const record = codexItemRecord(agentId, item, timestamp)
  if (!record) return
  if (record.type === 'message') {
    recordRuntimeMessage(record.value)
    return
  }
  recordRuntimeTimelineEvent(record.value)
}
```

`item.type` values the codex protocol emits beyond these three (e.g. web
search, MCP tool call, file-change, plan-as-item — check the current protocol
schema in `src/server/codex-app-protocol.ts` as part of Step 8) are dropped
with zero trace; there is no log line, no fallback timeline event.

### B8 — retained-state bounds are global, not per-agent

`codex-retained-state.ts:20-31`:

```ts
export function makeCodexRetainedState(input: {
  readonly maxTurnStartProjections?: number
} = {}) {
  const maxTurnStartProjections = input.maxTurnStartProjections ?? 1_000
  ...
  const turnStartProjections = new Set<string>()
```

and `codex-app-server.ts:62`:

```ts
const maxCachedCompletedTurns = 100
```

`getOrCreateCodexAdapter` (`codex-runtime.ts:471-492`) shares one
`CodexAppServerAdapter` (and thus one `completedTurns` cache, bounded at 100
total) across every agent whose `websocketUrl` resolves the same (the common
case — one local app-server). `makeCodexRetainedState()` is instantiated once
module-wide (`codex-runtime.ts:61`) and its `turnStartProjections` bound
(1,000) is shared across all agents too. A high-churn agent's turns can evict
another agent's dedup/cache entries, causing a duplicate "Turn started"
timeline event or a `waitForTurnCompleted` cache miss (falls through to the
live-wait path in `codex-app-server.ts:242-284`, which is still correct but
loses the fast path).

### B10 — codexLaunch's resume lookup has no launch timestamp

`terminal-launch.ts:307-312`:

```ts
const resume = readCodexTerminalResumeId({
  agentId: config.id,
  cwd: config.cwd,
  sessionDir: config.sessionDir,
  state,
  // no launchedAtMs
})
```

`codexHookSessionBindingMatchesLaunch` (`codex-terminal-session.ts:99-110`):

```ts
export function codexHookSessionBindingMatchesLaunch(binding, input) {
  if (binding.agentId !== input.agentId) return false
  if (input.launchedAtMs !== undefined && binding.writtenAtMs < input.launchedAtMs - 2_000) return false
  return !binding.cwd || resolve(binding.cwd) === resolve(input.cwd)
}
```

Since `codexLaunch` never passes `launchedAtMs` (by construction — the
timestamp doesn't exist until after the process spawns), the staleness guard
is unconditionally skipped at this call site and any prior binding for the
agentId/cwd pair is trusted, regardless of age. This is a known, structural
gap (no launch timestamp exists pre-spawn) that strengthens the case for B1
and B4 rather than something independently fixable here — document only.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Server tests (this plan's surface) | `pnpm exec vitest run tests/server/` | all pass |
| Unit tests | `pnpm test:unit` | all pass |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope**:
- `src/server/codex-runtime.ts`
- `src/server/codex-terminal-session.ts`
- `src/server/codex-hook-handler.ts`
- `src/server/codex-cli-sessions.ts`
- `src/server/codex-retained-state.ts`
- `src/server/codex-app-server.ts`
- `src/server/codex-item-recording.ts`
- `src/server/terminal-launch.ts` (only `codexHooksSupported` cache, Step 7)
- `tests/server/codex-*.test.ts` — new/updated regression tests

**Out of scope** (do NOT touch):
- Codex resume re-bind on `codex resume` (no SessionStart fires) — plan 014 C1.
- pid-anchored transcript resolution — plan 014 C5 (the principled fix for
  B4/B6; this plan's B4/B6 fixes are tactical stopgaps, not the final design).
- Fire-and-forget hook execution / launch latency — plan 014 C2.
- Claude/OpenCode hook wiring — plan 014 C3, plan 017 G3-1/G3-3.
- `terminal-server.ts` / `terminal-registry.ts` PTY spawn dedup — plan 012.
- Idle-kill default (`idleKillModes`) — plan 012 A-KILL.
- `answerQuestion`/`pendingQuestion` dead wiring, blocked-status stuck state —
  plan 015 D5.

## Git workflow

- Branch: `advisor/013-codex-thread-mapping-correctness`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: B1 — unlink on-disk resume bindings on reset

In `codex-runtime.ts`, import `codexTerminalSessionIdPath` and
`codexHookSessionBindingPath` from `./codex-terminal-session`, and `rmSync`
from `node:fs`. In `resetCodexSession` (`:182-204`), after
`forgetCodexRuntimeAgent`/`clearAgentRuntimeState`/`resetStoredSession`, add a
best-effort unlink of both files using the agent's `sessionDir` (obtain via
`getAgentLaunchConfig(input.agentId).sessionDir` — check the exact field name
on `TerminalAgentLaunchConfig`, `terminal-launch.ts:17-26`, which has
`sessionDir: string`):

```ts
import { rmSync } from 'node:fs'
import {
  codexHookSessionBindingPath,
  codexTerminalSessionIdPath,
} from './codex-terminal-session'
```

```ts
forgetCodexRuntimeAgent(input.agentId, { keepGeneration: true })
clearAgentRuntimeState(input.agentId)
resetStoredSession(input.agentId)
unlinkCodexResumeBindings(getAgentLaunchConfig(input.agentId).sessionDir)
```

```ts
function unlinkCodexResumeBindings(sessionDir: string) {
  for (const path of [codexTerminalSessionIdPath(sessionDir), codexHookSessionBindingPath(sessionDir)]) {
    try {
      rmSync(path, { force: true })
    } catch {
      // Best-effort: a missing/unreadable binding file must not fail reset.
    }
  }
}
```

Do this unconditionally (not just when `state.threadId` was set) — a hook
binding can exist on disk even if the in-memory/DB `threadId` was already
cleared by a previous partial reset or restart.

**Verify**: `pnpm typecheck` → 0. Add/extend a test in
`tests/server/codex-runtime.test.ts` (create if it doesn't exist, following
the fake-adapter pattern already used by `tests/server/codex-app-server.test.ts`
and `tests/harness/fake-codex-app-server.mjs`): write both binding files to a
temp `sessionDir`, call `resetCodexSession`, assert both files no longer
exist. `pnpm exec vitest run tests/server/` → pass.

### Step 2: B2 — remember the thread mapping unconditionally

In `codex-runtime.ts`, call `rememberCodexThread` at the top of every function
that reads `state.threadId` off a live thread, not only inside
`startOrSteerCodexTurn`/`startCodexReview`. Specifically:

- `promptCodexAgent` (`:69-108`): right after `if (thread) {` (currently
  `:88`), before `syncCodexThreadStatus`, add
  `rememberCodexThread(config.id, state.threadId)`.
- `steerCodexAgent` (`:110-138`): right after the `if (!thread)` early-return
  (currently `:123-126`), before `syncCodexThreadStatus` at `:127`, add
  `rememberCodexThread(config.id, state.threadId)`.
- `interruptCodexAgent` (`:140-161`): right after the `if (!thread)`
  early-return (currently `:148-151`), before `syncCodexThreadStatus` at
  `:152`, add `rememberCodexThread(input.agentId, state.threadId)`.

`rememberCodexThread` is idempotent (`retainedState.rememberThread`,
`codex-retained-state.ts:86-95`, is a plain map upsert with cleanup of the
prior mapping) so calling it redundantly on the already-queued path is safe.

**Verify**: `pnpm typecheck` → 0. Add a test: seed `retainedState` as empty
(simulating a post-restart singleton, use
`__unsafeClearCodexRuntimeStateForTest`), call `promptCodexAgent` /
`steerCodexAgent` against a fake adapter whose thread has an active turn, and
assert `codexRuntimeRetainedStateStats().agentThreads === 1` afterward (or use
a more direct accessor if one exists — check `codex-retained-state.ts`'s
public surface before adding a new test-only export). `pnpm exec vitest run
tests/server/` → pass.

### Step 3: B4 — reject non-primary SessionStart hooks before overwriting

In `codex-hook-handler.ts`, extend `parseHookPayload` (`:50-86`) to capture
`thread_source` from the payload, and reject `'subagent'` (matching the
existing convention in `codex-cli-sessions.ts:76`) before any file write:

```ts
const record = parsed as Record<string, unknown>
if (record.hook_event_name !== 'SessionStart') {
  return { ok: false, reason: 'Unsupported hook event' }
}
const sessionId = normalizeCodexSessionId(record.session_id)
if (!sessionId) return { ok: false, reason: 'Missing session_id' }
const threadSource = stringValue(record.thread_source)
if (threadSource === 'subagent') {
  return { ok: false, reason: 'Ignored SessionStart hook for a subagent thread' }
}
return {
  ok: true,
  sessionId,
  source: stringValue(record.source),
  cwd: stringValue(record.cwd),
  transcriptPath: stringValue(record.transcript_path),
  model: stringValue(record.model),
}
```

Update the return type union of `parseHookPayload` if needed (it already
returns `{ ok: false; reason: string }` for other rejections — this is the
same shape, no type change required). In `handleCodexSessionStartHook`
(`:13-48`), the existing `if (!payload.ok) return payload` at `:24` already
routes this rejection correctly — confirm no behavior change needed there.

While in this file, also fix the write ordering in
`handleCodexSessionStartHook` (`:30-40`): today the plain
`codex-terminal-session-id` file is written *before* the richer
`codex-hook-session.json` binding, so a failure between the two writes
leaves a bare session-id that `readCodexTerminalResumeId` will trust with no
agentId/cwd/staleness guard at all. Write the binding JSON first, the plain
file second (same commit as the subagent filter — both touch the same
function).

If codex's actual hook JSON does not expose `thread_source` on `SessionStart`
payloads (verify against the current codex CLI's hook schema — check the
existing test fixtures in `tests/server/codex-hook-handler.test.ts` for the
real payload shape used there first), find another primary discriminator
(e.g. presence/absence of a `parent_id`/`originator` field) — do not fabricate
a field that codex doesn't actually send; if no discriminator exists at all in
the current codex hook payload, stop and report per the STOP conditions below
rather than shipping a filter that never fires.

**Verify**: `pnpm typecheck` → 0. Extend
`tests/server/codex-hook-handler.test.ts` with a case: stdin payload with
`thread_source: 'subagent'` → `handleCodexSessionStartHook` returns
`{ ok: false }` and does not write either binding file (assert via a fake/tmp
`sessionDir` the test already sets up). `pnpm exec vitest run
tests/server/codex-hook-handler.test.ts` → pass.

### Step 4: B6 — fail closed on ambiguous concurrent-launch scan fallback

In `codex-cli-sessions.ts`, `findLatestCodexSessionForCwd`
(`:56-102`) already supports a `requireUnique` option (applied at
`:100-101`), but no caller ever passes it — and when `closestToMs` is
supplied, the closest-match ranking returns at `:93-99` **before** the
uniqueness check is even reached, so `requireUnique` alone would not fix the
concurrent-launch case. In `rememberCodexTerminalSession`'s fallback call to
`waitForLatestCodexSessionForCwd` (`:138-145`), the closest-timestamp
disambiguation path (no `requireUnique`) is what's actually reached after the
hook binding wait times out. Change the fallback to first attempt a
**unique** match (no timestamp guessing) before falling back to
closest-timestamp, and treat "still ambiguous after the full wait" as fail
closed:

- Add a `requireUnique: true` attempt in `waitForLatestCodexSessionForCwd`
  (or a new wrapper) that returns `null` (not the closest guess) whenever
  `matchingSessions.length > 1` at the end of the wait window.
- In `rememberCodexTerminalSession` (`:104-165`), when the hook binding never
  arrives (`:126` binding is falsy) **and** `findLatestCodexSessionForCwd`
  with `requireUnique: true` returns multiple candidates for the cwd, do not
  fall through to the closest-timestamp guess (`:138-145` as currently
  written) — instead return `false` (matching the existing `remainingAttempts
  <= 0` early return at `:137`), which the caller must treat as "start fresh,
  no resume" rather than resuming a guessed session id. Trace the caller of
  `rememberCodexTerminalSession`'s boolean return (search for its call site —
  likely in the terminal-spawn path, `terminal-server.ts` or similar) and
  confirm a `false` return already means "proceed without a bound session id"
  before relying on that contract; if it currently means something else
  (e.g. silently ignored), fix the caller to fail closed too.

Keep the existing single-candidate closest-timestamp path (`:93-99`) exactly
as-is for the true single-match case — this only changes behavior when the
scan itself is ambiguous.

**Verify**: `pnpm typecheck` → 0. Extend
`tests/server/codex-cli-sessions.test.ts` (or
`codex-cli-session-memory.test.ts`, whichever already covers
`findLatestCodexSessionForCwd`) with a case: two `.jsonl` rollout files for the
same cwd created within the same window, no hook binding written → assert the
fallback does NOT resolve either id (returns `null`/`false`), rather than
picking one by closest timestamp. `pnpm exec vitest run tests/server/` → pass.

### Step 5: B9 — close the generation-bump race in resetCodexSession

Two complementary changes, both needed:

1. In `codex-runtime.ts`, make `resetCodexSession`'s interrupt+forget
   sequence run through the **same per-agent queue** as prompts
   (`retainedState.queues`, used by `enqueueAgentTurn` — see
   `runtime-lifecycle.ts`'s `enqueueAgentTurn` signature and how
   `promptCodexAgent`/`reviewCodexSession` call it at `:101` and `:216`).
   Wrap `resetCodexSession`'s body (after the generation bump, which must stay
   synchronous and first so in-flight closures see it immediately) in
   `enqueueAgentTurn(input.agentId, retainedState.queues, () => { ...existing
   interrupt/forget/clear... })`, so it cannot interleave with an in-flight
   `promptCodexAgentNow`/`reviewCodexSessionNow` closure for the same agent —
   it either runs before the closure starts (closure then sees the bumped
   generation at its first check) or after it fully completes (closure's
   completion already happened with the pre-reset thread, which was the
   pre-existing, presumably-intended behavior for a fully-in-flight turn).
2. Add a generation check immediately before `startTurn` in
   `startOrSteerCodexTurn` (`codex-runtime.ts:328`), not just at `:309` and
   `:346` — cheap and closes the specific window between
   `rememberCodexThread` (`:312`) and the actual `startTurn` call:

```ts
if (!isCurrentCodexGeneration(input.config.id, input.generation)) return false
const turnResponse = yield* codexProtocolPromise(() => input.adapter.startTurn({ ... }))
```

3. Apply the same guard to `startCodexReview` (`:359-411`): the identical
   race exists around its `startReview` call and `setCodexState`
   persistence (`:384` area) — add the generation re-check immediately
   before both, mirroring sub-step 2. Do not fix one path and leave the
   other.

Confirm `enqueueAgentTurn`'s queue semantics (does it run tasks strictly
sequentially per key, and does a `resetCodexSession` call currently bypass it
entirely, as the current code does?) by reading `runtime-lifecycle.ts` before
wiring this — if `enqueueAgentTurn` requires a generation-check argument or a
different signature than `promptCodexAgent`'s usage, adapt the call rather
than assuming it matches.

**Verify**: `pnpm typecheck` → 0. Add a test that: starts a fake in-flight
turn closure (generation N) that has passed its first check, calls
`resetCodexSession` for the same agent, then lets the closure proceed —
assert it now either never reaches `startTurn` or, if the queue serializes it
before completion, that no thread/state mismatch results (i.e. either the
turn fully wins because reset was queued after, or reset fully wins because
the check now catches it). `pnpm exec vitest run tests/server/` → pass.

### Step 6: B5 — prefer structured error classification

In `codex-app-server.ts`, `CodexAppServerError` (`:44-47`) already discards
`response.error.code`/`.data` (only `.message` is kept, see
`handleMessage`, `:415-419`). Extend `CodexAppServerError`'s fields to retain
`code`/`data` from the JSON-RPC error when constructing it from a response:

```ts
class CodexAppServerError extends Data.TaggedError('CodexAppServerError')<{
  readonly message: string
  readonly cause?: unknown
  readonly code?: number
  readonly data?: unknown
}> {}
```

At `:415-419`, pass through `response.error.code`/`response.error.data` into
the constructed error. In `codex-runtime.ts`, update
`isMissingRolloutError`/`isUnmaterializedThreadReadError` (`:753-762`) to
check a structured code first (find the actual numeric/string code codex's
app-server uses for "no rollout found" — inspect
`tests/harness/fake-codex-app-server.mjs` and any existing codex app-server
protocol docs/fixtures in `src/server/codex-app-protocol.ts` for what's
already modeled; do not invent a code that isn't observed anywhere in the
codebase) and fall back to the current substring match only if no structured
code is present, with a comment noting the fallback is version-fragile:

```ts
function isMissingRolloutError(error: unknown) {
  if (error instanceof CodexAppServerErrorLike && error.code === /* observed code */) return true
  // Fallback: codex versions without a structured error code for this case.
  // Fragile — re-check this substring against the codex CLI changelog if it stops matching.
  return error instanceof Error && error.message.includes('no rollout found for thread id')
}
```

If no structured code is ever observable from the current fake harness or
protocol types (i.e. codex genuinely only returns a message string for this
case today), do not fabricate one — centralize the substring constants
instead (single exported regex/string constant each, reused by both
classifiers) and add the version-fragility comment; this is an acceptable
narrower outcome for this step, note it in the PR description.

**Verify**: `pnpm typecheck` → 0. `pnpm exec vitest run
tests/server/codex-runtime.test.ts tests/server/codex-app-server.test.ts` →
pass (extend existing error-path tests rather than only adding new ones, to
confirm the fallback still catches today's real error strings).

### Step 7: B7 — TTL/invalidate the codexHooksSupported cache

In `terminal-launch.ts`, change `codexHookSupportByCommand`
(`:90`) from `Map<string, boolean>` to store a timestamped entry, and
invalidate on TTL expiry rather than caching forever:

```ts
const codexHookSupportTtlMs = 60 * 60_000 // re-probe hourly
const codexHookSupportByCommand = new Map<string, { supported: boolean; checkedAtMs: number }>()
```

In `codexHooksSupported` (`:392-408`), check `checkedAtMs` age before trusting
the cache; re-probe and overwrite on expiry. Keep the `KIRI_CODEX_HOOKS=0/1`
env override short-circuits exactly as-is (`:393-394`). Prefer TTL over an
mtime/version check unless resolving the binary's mtime is already cheap in
this code path (`resolveExecutable`/`context.exists` — check whether a stat is
already being done nearby that could be reused without adding a new syscall
per launch; if not, TTL alone is the simpler, sufficient fix here).

**Verify**: `pnpm typecheck` → 0. Add a test (or extend an existing
terminal-launch test) that: caches `supported: false` with a `checkedAtMs` far
in the past, calls `codexHooksSupported` again, asserts `spawnSync` is invoked
again (re-probed) rather than returning the stale cached value. `pnpm exec
vitest run tests/server/` → pass (search for existing terminal-launch tests
first; if none exist for this function, add a minimal one, don't build new
test infra beyond what's needed).

### Step 8: B11 — audit and handle remaining codex item types

Read `src/server/codex-app-protocol.ts` for the full set of `item.type` values
the codex app-server protocol currently defines (the schema types back
`ItemCompletedParamsSchema`, imported in `codex-runtime.ts`). For each type not
already handled in `codexItemRecord` (`codex-item-recording.ts:29-82`):
add an explicit branch (timeline event, following the `reasoning`/
`commandExecution` shape) if the type carries meaningful content, or an
explicit "unrecognized item" fallback branch (instead of the current bare
`return null` at `:81`) that still logs/records a minimal timeline event
(`kind: 'codex_unrecognized_item'`, `payload: item`) so nothing is silently
dropped without trace, even for genuinely-new future types.

```ts
// replace the trailing `return null` at :81
return {
  type: 'timelineEvent',
  value: {
    agentId,
    kind: 'codex_unrecognized_item',
    tone: 'info',
    label: `Unrecognized item: ${type}`,
    detail: null,
    payload: item,
    timestamp,
  },
}
```

Do not remove the early `if (!id || !type) return null` at `:37` — that's a
malformed-payload guard, not an unhandled-type guard, and should stay a no-op.

**Verify**: `pnpm typecheck` → 0. Extend
`tests/server/codex-item-recording.test.ts` with a case for at least one
currently-unhandled type from the protocol schema (e.g. whatever the
protocol's item union actually includes beyond the three handled today) and
assert it now produces a timeline event rather than `null`. `pnpm exec vitest
run tests/server/codex-item-recording.test.ts` → pass.

### Step 9: B8 — scope retained-state bounds per-agent

In `codex-app-server.ts`, `completedTurns` (`:71`) is per-`CodexAppServerAdapter`
instance, but one adapter is shared across all agents on the same
`websocketUrl` (`getOrCreateCodexAdapter`, `codex-runtime.ts:471-492`). Scope
the eviction bound per-thread instead of per-adapter: change
`maxCachedCompletedTurns` (`:62`) from a single global cap
(`cacheCompletedTurn`, `:450-460`, evicts oldest globally) to a
per-`threadId` cap (e.g. keep at most N completed turns per thread, evicting
oldest-per-thread rather than oldest-global) — since `completedTurns` keys are
already `${threadId}:${turnId}` (`completedTurnKey`, `:549-551`), this is a
matter of tracking insertion order per-thread-prefix rather than one flat
insertion-ordered `Map`.

In `codex-retained-state.ts`, `turnStartProjections` (`:31`) is bounded
globally at `maxTurnStartProjections` (`:23`, default 1,000) via
`rememberBoundedTurnKey` (`:44-54`), which evicts the oldest key in the whole
set regardless of which agent/thread it belongs to. Since keys are
`${threadId}:${turnId}` (`codexTurnKey`, `codex-runtime.ts:656-658`) and
`pruneTurnKeysForThread`/`pruneThreadTurnKeys` (`:33-42`) already know how to
scan-and-delete by thread prefix, change eviction to be per-thread bounded
(small cap per thread, e.g. last N turn-starts per thread) rather than one
shared 1,000-entry pool across every agent.

Keep the public API shape (`rememberTurnStartProjection`,
`cacheCompletedTurn`) stable — this is an internal eviction-policy change, not
a signature change, unless the per-thread bound requires passing `threadId`
explicitly where it's currently implicit (check both call sites,
`codex-runtime.ts:601-605` and `codex-app-server.ts:454`, already have
`threadId` in scope).

**Verify**: `pnpm typecheck` → 0. Extend
`tests/server/codex-retained-state.test.ts` and
`tests/server/codex-app-server.test.ts`: simulate two threads, one with
high churn (many turn-starts/completions) and one with a single turn; assert
the low-churn thread's single entry is NOT evicted by the high-churn thread's
volume. `pnpm exec vitest run tests/server/` → pass.

### Step 10: B10 — document the launch-timestamp asymmetry (comment only)

In `terminal-launch.ts`, at the `readCodexTerminalResumeId` call in
`codexLaunch` (`:307-312`), add a comment explaining why `launchedAtMs` is
omitted here (no launch timestamp exists pre-spawn) and that this
unconditionally skips the staleness guard in
`codexHookSessionBindingMatchesLaunch` (`codex-terminal-session.ts:99-110`),
cross-referencing that Steps 1/3 (B1/B4) are what keep a stale binding from
existing in the first place:

```ts
// No launchedAtMs available pre-spawn, so codexHookSessionBindingMatchesLaunch's
// writtenAtMs staleness guard (codex-terminal-session.ts:108) is unconditionally
// skipped here — any prior binding for this agentId/cwd is trusted regardless of
// age. B1 (reset unlinks bindings) and B4 (reject subagent SessionStart) are what
// keep a stale/wrong binding from existing to be trusted. See plans/013.
const resume = readCodexTerminalResumeId({
  agentId: config.id,
  cwd: config.cwd,
  sessionDir: config.sessionDir,
  state,
})
```

No behavior change. This step has no separate test — covered by Step 1/3's
tests.

**Verify**: `pnpm typecheck` → 0 (comment-only change, no test run needed
beyond confirming no syntax break).

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt above doesn't match live code after the drift
  check — especially line numbers in `codex-runtime.ts` (large file, easy to
  drift) and the exact shape of `resetCodexSession`/`ensureCodexThreadEffect`.
- Step 3 (B4): the current codex CLI's `SessionStart` hook payload has no
  `thread_source` field or equivalent discriminator anywhere observable in
  `tests/server/codex-hook-handler.test.ts` fixtures or codex's own hook
  schema — do not fabricate one.
- Step 4 (B6): the caller of `rememberCodexTerminalSession`'s boolean return
  does not already treat `false` as "proceed without a bound resume id" —
  fixing only the producer without checking the consumer would silently
  break terminal launch instead of failing closed correctly.
- Step 5 (B9): `enqueueAgentTurn`/`retainedState.queues` does not actually
  serialize per-agent (e.g. it's fire-and-forget or keyed differently than
  assumed) — re-read `runtime-lifecycle.ts` fully before wiring reset through
  it; do not assume the queue behaves as described without confirming.
- Step 6 (B5): the codex app-server protocol genuinely never surfaces a
  structured code for missing-rollout/unmaterialized-thread errors in any
  currently-observable fixture — ship the narrower centralize-and-comment
  outcome, do not invent a code.
- Step 9 (B8): changing eviction from global to per-thread would require a
  broader API change than described (e.g. `completedTurns`/
  `turnStartProjections` callers can't easily supply `threadId` at the
  eviction point) — stop and re-scope rather than widening the change beyond
  this plan's other files.
- Any step's regression test can't be added without building new test
  infrastructure beyond what's already used by sibling `codex-*.test.ts`
  files — record the gap and do the manual-check equivalent instead of
  inventing a new harness.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test:unit` exits 0
- [ ] `pnpm build` exits 0
- [ ] Steps 1–9 each have a passing regression test in `tests/server/`
- [ ] `resetCodexSession` unlinks both on-disk binding files (Step 1)
- [ ] `promptCodexAgent`/`steerCodexAgent`/`interruptCodexAgent` all call
      `rememberCodexThread` before returning on the fast path (Step 2)
- [ ] Subagent `SessionStart` hooks no longer overwrite the primary binding
      (Step 3) — or Step 3's STOP condition was hit and reported
- [ ] Ambiguous concurrent same-cwd scan fallback fails closed instead of
      guessing (Step 4)
- [ ] `resetCodexSession` cannot be raced by an in-flight turn closure into
      re-persisting the reset thread (Step 5)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row added/updated for plan 013

## Maintenance notes

- Steps 3 (B4) and 4 (B6) are tactical stopgaps. When plan 014's C5
  (pid-anchored transcript resolution) lands, re-evaluate whether these
  fail-closed guards are still needed or can be simplified/removed — the
  pid-anchored approach should make cwd/timestamp-based disambiguation
  unnecessary in the common case.
- Step 5 (B9)'s queue-based serialization should be re-examined once plan 014
  C1 (resume re-bind) lands, since resume re-binding changes when/how
  `state.threadId` becomes valid after a relaunch — confirm the reset race
  fix still holds against a freshly-rebound thread.
- Plan 012's A-KILL fix (default embedded `idleKillModes` to exclude
  `'runtime'`) reduces how often codex terminals are killed and relaunched,
  which reduces the frequency every bug in this plan is hit — it does not fix
  any of them and should not be treated as a substitute for these steps.
