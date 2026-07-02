# Plan 015: Session state-machine hardening (blocked-status flicker, archive race, hydration perf, hard-delete)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1fa5160..HEAD -- src/server/codex-runtime.ts src/server/codex-server-requests.ts src/server/codex-retained-state.ts src/server/runtime.ts src/server/provider-runtime.ts src/server/runtime-cleanup.ts src/server/runtime-lifecycle.ts src/server/runtime-projection.ts src/server/db.ts src/server/db/runtime-state.ts src/server/db/sessions.ts src/server/db/session-operations.ts src/server/db/timeline-writes.ts src/server/db/transaction.ts src/server/db/projects.ts src/server/db/migrations.ts src/server/read-model-indexer.ts src/server/workspace-service.ts src/lib/contracts.ts`
> If any in-scope file changed since this plan was written, re-open it and
> compare the "Current state" excerpts below against the live code before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none to start; coordinate with plan 013 (codex runtime — B9's
  generation-bump race touches the same `codex-runtime.ts`/`codex-retained-state.ts`
  machinery this plan's Step 1 touches; do not stack an uncoordinated diff on
  `retainedState`/`projectCodexNotification`) and plan 018 (delete ordering —
  018's H7 owns `deleteProjectAndCleanupRuntimes`/`cleanupRuntimeSessions` in
  `runtime-cleanup.ts`; this plan's D12 item is cross-reference only, see
  Step 7).
- **Category**: bugfix/hardening
- **Planned at**: commit `1fa5160`, 2026-07-01

## Why this matters

The session state machine (`agent_slots.status`, `archived_at`, `runtime_state_json`,
and the Codex/Pi runtime adapters that drive them) has accumulated a set of
correctness and hygiene gaps that individually look small but compound:

- A Codex session can get stuck showing `blocked` forever because every
  server-to-client request — even ones kiri auto-resolves in the same tick —
  unconditionally projects `status: 'blocked'`, and only one narrow event
  (`thread/status/changed`) ever clears it. Worse, the one server-request
  method that represents a *real* interactive question
  (`item/tool/requestUserInput`) is silently auto-answered with empty answers
  today, even though a full renderer UI (`pending-question-panel.tsx`,
  `chat-panel.tsx`, `board-session-actions.ts`) already exists and is wired to
  call `answerQuestion` — the server-side capability was simply never
  implemented for any runtime.
- Archiving a session races its own in-flight runtime turn: the DB row is
  marked archived before the runtime is torn down, and none of the write
  paths a running turn touches (`setAgentStatus`, `recordRuntimeMessageRow`,
  `recordRuntimeTimelineEventRow`) check `archived_at`, so an archived session
  can keep silently accumulating status flips and messages.
- Every `getWorkspaceSnapshot`/`getAgentDetail` call does a full
  `readdirSync` over every project's pi-sessions directory, even when only
  one agent's detail was requested and nothing on disk changed.
- There is no real delete for sessions — `archived_at` is the only lifecycle
  end state, `agent_slots` rows and their on-disk directories accumulate
  forever, and the `deleted_sessions` tombstone table that exists specifically
  to prevent a hard-deleted pi session from being re-hydrated off disk has
  zero writers anywhere in the codebase.
- A cluster of smaller hygiene gaps (imprecise "delete" naming for what is
  actually archive, an unwired `queued` status, unbounded stamp-cache growth,
  no PK-collision retry on session-id generation, no transaction reentrancy
  guard, an unsupported-capability message that only special-cases `prompt`)
  add friction and latent risk without being individually urgent.

## Approach (decided)

- Fix the four P2 items first, in the order given (D5, D4, D7, D1), because
  each is independently user-visible or growth-unbounded; then D3 (folded
  into D1's step, since a correct hard-delete is unsafe without the tombstone
  write — see Step 4), D9, and D12 (cross-reference only — see Step 7); then
  a single "state-machine hygiene" cluster step for the remaining small P3
  items (D2, D6, D8, D10, D11, D13).
- D5's fix is **not** "remove the dead `answerQuestion` wiring." Tracing the
  call graph shows `runtime.ts`'s `RuntimeCommands.answerQuestion` and the
  `ProviderRuntimeAdapter.answerQuestion` capability slot are fully wired end
  to end (see Current state) — the only missing piece is a codex
  implementation and the write side of `pendingQuestion`. A renderer UI
  already depends on this working. Step 1 implements it.
- D12 is explicitly **not** implemented here. Plan 018's Step 4 (H7) already
  owns `deleteProjectAndCleanupRuntimes`/`cleanupRuntimeSessions` in
  `runtime-cleanup.ts` and states "fix it once, here... do not let 015
  duplicate the diff." This plan's D4 fix is scoped to
  `deleteSessionAndCleanupRuntime` (the per-session archive path) only, which
  018 explicitly leaves untouched. Step 7 records the cross-reference and a
  drift check; it makes no code change.
- D1's hard-delete is exposed as an internal server capability
  (`hardDeleteSession` in `db/sessions.ts` + `db.ts`) gated on
  `archived_at IS NOT NULL`. No new MCP/renderer-facing operation is added in
  this plan — wiring a "permanently delete" affordance into `kiri-control.ts`/
  the renderer is a follow-up, out of scope here (see Scope).
- D2 (delete→archive naming) is scoped down to the internal implementation
  functions only (`db.ts`'s `deleteSession`/`deleteSessionSummary`,
  `runtime-cleanup.ts`'s `deleteSessionWithRuntimeCleanup`/
  `deleteSessionAndCleanupRuntime`, and `kiri-control.ts`'s corresponding
  dependency field/effect names). The public `WorkspaceServiceApi.deleteSession`
  method name and the `DeleteSessionInput`/`session.archive` MCP contract are
  left unchanged — renaming those ripples into renderer mutation call sites
  that are out of scope for this plan.

## Current state

### D5 — Codex `blocked` status can stick, and interactive questions are silently auto-answered empty

`src/server/codex-runtime.ts` `projectCodexNotification` (lines 502-544)
handles every inbound `CodexServerMessage`:

```ts
if ('id' in message) {
  if (agentId) {
    yield* projectRuntimeEvent({ type: 'status', agentId, status: 'blocked' })   // :515, unconditional
    yield* projectRuntimeEvent({ type: 'timelineEvent', value: { ... } })
  }
  const response = automaticCodexServerRequestResponse(message.method)          // :528
  if (response) {
    adapter.respond(message.id, response)                                      // :530
  } else {
    adapter.reject(message.id, `kiri cannot handle ${message.method} yet`)      // :532
  }
  return
}
```

The **only** path that ever clears `blocked` is `thread/status/changed`
(lines 538-544, maps `active`→`running`, `systemError`→`failed`, else→`idle`).
If a server request arrives whose corresponding `thread/status/changed`
event never lands (or lands before the blocked projection races it), the
session shows `blocked` indefinitely.

`src/server/codex-server-requests.ts` `automaticCodexServerRequestResponse`
(30 lines, full file) auto-resolves every known method, including the one
method that represents a genuine interactive question:

```ts
if (method === 'item/tool/requestUserInput') {
  return { answers: {} }   // :11-13 — always answers empty, discards the question
}
```

Every other branch (`item/commandExecution/requestApproval`,
`item/fileChange/requestApproval` → decline; `item/permissions/requestApproval`
→ `{ permissions: {}, scope: 'turn' }`; `mcpServer/elicitation/request` →
decline; `item/tool/call` → failure stub; `execCommandApproval`/
`applyPatchApproval` → denied) is a legitimate auto-resolution that kiri
does not need to surface to the user — only `item/tool/requestUserInput`
represents an actual question.

The renderer already has a full, working consumer for a real answer path:
`src/components/kiri-board/pending-question-panel.tsx` renders when
`agent.pendingQuestion` is set, `chat-panel.tsx` shows it, and
`board-session-actions.ts`/`board-server-actions.ts` call a mutation that
reaches `WorkspaceService.answerQuestion` (wired in `workspace-service.ts:385`
to `dependencies.answerAgentQuestion`). The server side of that path is
fully wired too:

- `src/lib/contracts.ts`: `pendingQuestionSchema` (lines 110-123, fields
  `requestId`, `questions[]` each with `id`/`header`/`question`/`options[]`/
  `multiSelect`) and `answerQuestionInputSchema`/`AnswerQuestionInput` (lines
  516-524, fields `agentId`, `requestId`, `answers: Record<string, string |
  string[]>`).
- `src/server/runtime.ts`: `RuntimeCommandsApi.answerQuestion` (lines 37-41),
  `makeRuntimeCommands`'s `answerQuestion` case (lines 123-130) dispatches
  through the same generic `requireCapability`/`dispatch` path as every other
  capability, and `answerAgentQuestion` (lines 258-267) is the exported
  entry point workspace-service.ts calls.
- `src/server/provider-runtime.ts`: `ProviderRuntimeAdapter.answerQuestion`
  (lines 52-56) is already typed with the exact `{ agentId, requestId,
  answers }` shape.

The only gap: `runtimeAdapters.codex` (lines 81-88) has **no** `answerQuestion`
key, so `requireCapability` always fails with "codex agents do not support
interactive questions yet" — and nothing ever writes `pendingQuestion` into
`runtime_state_json` in the first place. `src/server/db/runtime-state.ts`
`readPendingQuestion` (lines 246-251) reads `getAgentRuntimeState(...).pendingQuestion`
but no function anywhere sets it (confirmed by grep across `src/server/**`).

### D4 — Archiving a session races its in-flight runtime turn

`src/server/runtime-cleanup.ts` `deleteSessionAndCleanupRuntime` (lines
101-111):

```ts
function deleteSessionAndCleanupRuntime<Result>(input, dependencies) {
  const session = dependencies.findSession(input.agentId)
  if (!session) throw new Error(`Session not found: ${input.agentId}`)

  const result = dependencies.deleteSession(input)          // archives (DB) first
  cleanupRuntimeSessions([session], dependencies)            // then tears down runtime
  return result
}
```

`dependencies.deleteSession` ultimately calls `archiveSessionRow`
(`db/sessions.ts:169-195`), which only sets `agent_slots.archived_at` and
renumbers positions — it does not interrupt or wait for any in-flight
runtime turn. Between that write and `cleanupRuntimeSessions` actually
forgetting the runtime adapter and closing the terminal, an in-flight turn's
callbacks can still fire. None of the DB writers those callbacks go through
check `archived_at`:

- `setAgentStatus` (`db/runtime-state.ts:157-175`) — unconditional
  `UPDATE agent_slots SET status = ? WHERE id = ?`.
- `recordRuntimeMessageRow` (`db/timeline-writes.ts:67-105`) and
  `recordRuntimeTimelineEventRow` (`db/timeline-writes.ts:174-216`) —
  unconditional inserts. (The original research note attributed these two to
  `db/runtime-state.ts:157-175` alongside `setAgentStatus`; verified against
  source, they actually live in `db/timeline-writes.ts` — a different file.)

`cleanupRuntimeSessions` (`runtime-cleanup.ts:37-45`) itself is a plain
`for` loop calling `forgetRuntime`/`closeTerminal` per session with no
try/catch — relevant to D12, not D4; left untouched here (see Step 7).

### D7 — Every workspace snapshot/agent-detail read walks every project's pi-sessions directory

`src/server/db.ts`: `getWorkspaceSnapshot` (lines 187-195) and
`getAgentDetail` (lines 224-230) both unconditionally call
`hydratePersistedPiSessions(database)` (defined lines 674-680, no scoping
params):

```ts
function hydratePersistedPiSessions(database: DatabaseSync) {
  const piSettings = getRuntimeSettings('pi')
  hydratePersistedPiSessionRows(database, {
    piSessionsDir: getKiriConfig().piSessionsDir,
    defaultModel: piSettings.defaultModel,
  })
}
```

`src/server/db/session-operations.ts` `hydratePersistedPiSessionRows`
(lines 161-257) loops **every** project (`for (const project of projects)`,
line 173) and, for each, does a `readdirSync(projectSessionRoot, {
withFileTypes: true })` (line 183) plus a `statSync` per session file
(`statSessionFile`, lines 259-266) — even when `getAgentDetail` was asked
about exactly one agent in one project. The per-file mtime/size cache
(`piHydrationStamps`, module-level `Map`, line 33) only skips re-projecting
an unchanged session file (line 212-218 `sameHydrationStamp` check) — it
does not skip the `readdirSync` itself, so the directory-listing cost is
paid on every call regardless of cache hits.

### D1 — No real delete; `agent_slots`/on-disk session dirs grow forever

`src/server/db.ts` `deleteSession`/`deleteSessionSummary` (lines 343-351)
and `archiveSession` (lines 353-355) all route to `archiveSessionRow`
(`db/sessions.ts:169-195`), which only sets `archived_at`. There is no
function anywhere that deletes an `agent_slots` row or unlinks its
`session_dir`. `src/server/db/connection.ts:18` sets
`PRAGMA foreign_keys = ON`, and the FK graph (`db/migrations.ts`, grepped
for `REFERENCES`/`FOREIGN KEY`/`ON DELETE`) makes a real delete
straightforward:

- `agent_slots.project_id` → `projects(id)` `ON DELETE CASCADE`
- `threads.agent_id` → `agent_slots(id)` `ON DELETE CASCADE`
- `messages.thread_id`, `timeline_events.thread_id`, `agent_tasks.thread_id`
  → `threads(id)` `ON DELETE CASCADE`
- `agent_context_usage.agent_id` (PK) → `agent_slots(id)` `ON DELETE CASCADE`
- `workflow_item_attempts.agent_id`, `workflow_items.active_agent_id`,
  `scratchpad_blocks.triggered_agent_id` → `agent_slots(id)`
  `ON DELETE SET NULL`

So `DELETE FROM agent_slots WHERE id = ?` cascades correctly through the
entire graph today; a real hard-delete only needs to additionally unlink
the on-disk `session_dir` and record a tombstone (D3, folded in — see
Step 4).

### D3 — `deleted_sessions` tombstone table has zero writers

`src/server/db/migrations.ts` (lines 87-93):

```sql
CREATE TABLE IF NOT EXISTS deleted_sessions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (project_id, slot)
);
```

The only reader anywhere is `hydratePersistedPiSessionRows`
(`db/session-operations.ts:176-181`):

```ts
const deletedSlots = new Set(
  database.prepare('SELECT slot FROM deleted_sessions WHERE project_id = ?')
    .all(project.id).map((row) => deletedSessionDbRowSchema.parse(row).slot),
)
```

used at line 185 to skip re-hydrating a slot's on-disk directory as a new
session. Without a writer, this table is permanently empty, meaning a hard
delete that only removed the DB row (without this tombstone) would have its
on-disk directory silently re-hydrated as a "new" session on the next
`hydratePersistedPiSessionRows` pass — a hard-delete is unsafe without this
table being populated in the same operation. Fixed together in Step 4.

### D9 — Read-model indexer has zero consumers

`src/server/read-model-indexer.ts` (364 lines):
`refreshReadModelEntriesIfChanged` (lines 41-55) and `replaceReadModelEntries`
(lines 253-278, full `DELETE`+re-`INSERT` inside a raw transaction) compute
and persist `read_model_entries`. `src/server/db.ts` `refreshReadModels`
(lines 205-217) wraps it. `src/server/workspace-service.ts` calls
`dependencies.refreshReadModels` after nearly every mutation (`snapshotAfter`
helpers at lines 261/270, plus `restoreSession:348`, `forkSession:372`,
`startSession:414`, `triggerScratchpadBlock:431`). Confirmed by grep across
`src/**`: nothing reads `read_model_entries` or calls `listReadModelEntries`
anywhere, and `src/server/kiri-control.ts`/`kiri-router.ts` never call
`refreshReadModels` at all — the MCP surface's mutations never populate it.

### D12 — `cleanupRuntimeSessions` aborts on first error; delete-order race in project delete

`src/server/runtime-cleanup.ts` `cleanupRuntimeSessions` (lines 37-45) is a
bare loop with no try/catch — a throwing `forgetRuntime`/`closeTerminal` for
one session aborts cleanup for the rest. `deleteProjectAndCleanupRuntimes`
(lines 91-99) deletes the DB row before cleaning up runtimes, leaving a
window where a snapshot/MCP read no longer sees the project but its PTYs are
still alive. **This is plan 018's Step 4 (H7) to fix** — see Approach and
Step 7; no code change happens in this plan for this item.

### D2, D6, D8, D10, D11, D13 — state-machine hygiene cluster

- **D2** (naming): `db.ts` exports `deleteSession`/`deleteSessionSummary`
  (lines 343-351, archive-only); `runtime-cleanup.ts` exports
  `deleteSessionWithRuntimeCleanup`/`deleteSessionAndCleanupRuntime` (lines
  69-78, 101-111); `kiri-control.ts` has `deleteSessionSummary` dependency
  type (line 255), wires `deleteSessionSummaryWithRuntimeCleanup` (line 303),
  and exposes a `deleteSessionEffect` (lines 406-407, 763). All of these mean
  "archive," not "delete" — misleading now that Step 4 adds a real delete.
- **D6** (unwired status): `src/lib/contracts.ts` `agentStatuses` (lines
  43-49) is `['idle', 'running', 'queued', 'blocked', 'failed']`. Duplicated
  as a raw SQL `CHECK` constraint in `db/migrations.ts` at line 26 (initial
  `CREATE TABLE agent_slots`) and again at line 410 (later migration that
  recreates the table). Grepped: nothing anywhere ever sets status to
  `'queued'` — `runtime-lifecycle.ts`'s `enqueueAgentTurn` (referenced at
  lines 102/104/109/111) queues turns per-agent but never reflects that in
  `agent_slots.status`.
- **D8** (stamp cache growth): `session-operations.ts`'s module-level
  `piHydrationStamps` Map (line 33) is deleted for a given `agentId` only in
  `resetSessionRows` (line 58) and in the test-only `clearPiHydrationStamps`
  (lines 35-37). `archiveSessionRow` (`db/sessions.ts:169-195`) never removes
  the stamp, so archived (and, post-Step-4, hard-deleted) sessions leave a
  permanent entry.
- **D10** (no PK-collision retry): `insertSessionRow` (`db/sessions.ts:106-159`)
  generates the slot suffix at line 113 (`input.slotSuffix?.() ??
  Math.random().toString(36).slice(2, 8)`), the id at line 115
  (`${projectId}-${slot}`), and does a raw `INSERT INTO agent_slots` (lines
  121-140) with no catch/retry on a primary-key collision. (Corrects the
  research doc's citation of `:106-129` — the function actually spans
  `106-159`.) Tests already inject `slotSuffix` (e.g.
  `tests/server/db-sessions.test.ts:36,47,194,221`), confirming the seam to
  build a retry around.
- **D11** (no transaction reentrancy): `db/transaction.ts` (18 lines, full
  file) `withTransaction` is a bare `database.exec('BEGIN')` (line 9) /
  `COMMIT` (line 12) / `ROLLBACK` (line 15) with no `SAVEPOINT` or depth
  counter. Grepped all callers (`db/sessions.ts`, `db/workflows.ts`,
  `db/session-operations.ts`, `db/projects.ts`, `db/timeline-writes.ts`):
  no current caller nests a second `withTransaction` inside another — this
  is a latent/defensive risk, not an active bug today.
- **D13** (unsupported-capability messaging): `runtime.ts`
  `unsupportedCapabilityMessage` (lines 172-181):
  ```ts
  function unsupportedCapabilityMessage(runtime, key, unsupported) {
    if ((runtime === 'claude' || runtime === 'opencode') && key === 'prompt') {
      return `${runtimeDisplayName(runtime)} sessions run in terminal mode only`
    }
    return `${runtime} agents do not support ${unsupported}`
  }
  ```
  Only `key === 'prompt'` gets the friendly "terminal mode only" framing;
  `steer`/`interrupt`/`reset`/`fork`/`review`/`answerQuestion` on
  `claude`/`opencode` fall through to the generic, less accurate message.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Server tests | `pnpm exec vitest run tests/server/` | all pass |
| Unit tests | `pnpm test:unit` | all pass |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope**:
- `src/server/codex-runtime.ts`, `src/server/codex-server-requests.ts`,
  `src/server/codex-retained-state.ts` — D5 (blocked-status projection,
  answerQuestion wiring for codex).
- `src/server/runtime.ts`, `src/server/provider-runtime.ts` — D5
  (`answerQuestion` capability registration), D13 (unsupported-capability
  message).
- `src/server/runtime-lifecycle.ts`, `src/server/runtime-projection.ts` — D5
  (new `pendingQuestion` projection event kind).
- `src/server/db/runtime-state.ts` — D5 (`setAgentPendingQuestion` writer),
  D4 (archived-aware `setAgentStatus`).
- `src/server/db/timeline-writes.ts` — D4 (archived-aware
  `recordRuntimeMessageRow`/`recordRuntimeTimelineEventRow`).
- `src/server/runtime-cleanup.ts` — D4 (`deleteSessionAndCleanupRuntime`
  reorder **only**; do not touch `cleanupRuntimeSessions` or
  `deleteProjectAndCleanupRuntimes` — those are plan 018's).
- `src/server/db.ts` — D5, D4, D7, D1, D9 (thin wrapper exports), D2
  (rename internal exports).
- `src/server/db/session-operations.ts` — D7 (scoped hydration), D8 (stamp
  cleanup helper).
- `src/server/db/sessions.ts` — D1 (`hardDeleteSession`), D3 (tombstone
  insert), D8 (stamp cleanup call from archive), D10 (PK-collision retry).
- `src/server/db/transaction.ts` — D11 (SAVEPOINT reentrancy).
- `src/server/read-model-indexer.ts` — D9 (documentation only, see Step 5).
- `src/server/workspace-service.ts` — D2 (rename internal dependency field),
  D1 (wiring if a `hardDeleteSession` dependency is threaded through).
- `src/server/kiri-control.ts` — D2 (rename `deleteSessionSummary`
  dependency/effect names only).
- `src/lib/contracts.ts` — D6 (no schema change planned, see Step 8) — read
  for reference only unless Step 8 decides otherwise.
- `tests/server/` — regression tests for every step below.

**Out of scope** (do NOT touch):
- `src/server/runtime-cleanup.ts`'s `cleanupRuntimeSessions` (:37-45) and
  `deleteProjectAndCleanupRuntimes` (:91-99) — owned by plan 018's H7
  (Step 4 there). This plan's D12 is cross-reference only (Step 7).
- Any renderer file (`pending-question-panel.tsx`, `chat-panel.tsx`,
  `board-session-actions.ts`, `board-server-actions.ts`, `agent-detail.ts`)
  — D5's server-side capability must match the existing renderer contract
  (`AnswerQuestionInput`/`PendingQuestion` in `contracts.ts`) exactly, but no
  renderer file is edited here.
- A new MCP/renderer-facing "permanently delete" operation for D1 — the
  hard-delete capability is server-internal only in this plan.
- `WorkspaceServiceApi.deleteSession`'s public method name, `DeleteSessionInput`,
  and the `session.archive` MCP operation string — kept stable (D2 is scoped
  to internal names only).
- `db/migrations.ts` schema changes — no column/table additions or CHECK
  constraint edits in this plan (D6's fix is additive code, not schema).

## Git workflow

- Branch: `advisor/015-session-state-machine-hardening`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (D5): Stop `blocked` from sticking; wire a real codex `answerQuestion`

1. In `codex-server-requests.ts`, do not change `automaticCodexServerRequestResponse`'s
   existing branches — they stay the single source of truth for which
   methods are auto-resolved. In `codex-runtime.ts`'s `projectCodexNotification`
   (lines 506-535), restructure the `if ('id' in message)` branch so the
   `blocked` status + timeline-event projection only fires when the method is
   `item/tool/requestUserInput` (a real question) or genuinely unrecognized
   (`automaticCodexServerRequestResponse` returns `null`) — not for methods
   kiri silently auto-resolves in the same tick (approvals, elicitation,
   tool/call stub). This removes the flicker for every auto-handled method.
2. Special-case `item/tool/requestUserInput` before calling
   `automaticCodexServerRequestResponse`: decode `message.params` into a
   `PendingQuestion`-shaped value (`requestId: String(message.id)`,
   `questions` from the request payload's question/options fields — inspect
   the actual `item/tool/requestUserInput` params shape via a codex fixture
   in `tests/server/codex-server-requests.test.ts` before assuming field
   names), project it via a new event kind (`{ type: 'pendingQuestion',
   agentId, value: PendingQuestion }`) added to `RuntimeProjectionEvent` in
   `runtime-lifecycle.ts` (alongside the existing `'status'`/`'timelineEvent'`
   members, lines 11-68), and do **not** call `adapter.respond`/`adapter.reject`
   for this method — leave the JSON-RPC request open. Remember the raw
   request id so a later answer can resolve it: add a
   `pendingServerRequests: Map<string, { id: CodexServerMessage['id'];
   method: string }>` to `makeCodexRetainedState()` in `codex-retained-state.ts`
   (alongside `threadAgents`/`agentThreads` etc.), with
   `rememberPendingServerRequest`/`takePendingServerRequest` accessors, and
   wire cleanup into the existing `forgetAgent`/`clearRuntimeStateForTest`
   functions (lines 70-84, 104-111) so a forgotten/archived agent's pending
   request doesn't leak.
3. Add the `'pendingQuestion'` case to `runtime-projection.ts`'s
   `projectRuntimeEventToDb` (lines 29-76, alongside the existing `if
   (event.type === ...)` chain): call a new `setAgentPendingQuestion` (see
   next sub-step) instead of the generic `setAgentRuntimeState` used by the
   `'runtimeState'` case (line 69-72) — that case **replaces** the whole
   `runtime_state_json` blob and would clobber `pendingTerminalInputs`/other
   keys if reused naively.
4. Add `setAgentPendingQuestion(database, agentId, pendingQuestion:
   PendingQuestion | null)` to `db/runtime-state.ts`, following the exact
   read-modify-write idiom already used by `queueAgentTerminalInput`/
   `takeAgentTerminalInputs` (lines 97-149): read `getAgentRuntimeState`,
   spread it, set or `delete` the `pendingQuestion` key, write back via
   `setAgentRuntimeState`. Export a thin `db.ts` wrapper matching the
   existing `setAgentStatus`/`setAgentRuntimeState` pattern (`db.ts:546-547`,
   `573-574`).
5. Implement `answerQuestionCodexAgent(input: { agentId, requestId, answers
   } & CodexRuntimeDependencies)` in `codex-runtime.ts`, modeled on
   `interruptCodexAgent` (lines 140-161): resolve the adapter via
   `getOrCreateCodexAdapter(state.websocketUrl, runtimeBinaries)`, take the
   pending request via `retainedState.takePendingServerRequest(agentId)`,
   verify `pending.id` corresponds to `input.requestId` (fail with a clear
   error if stale/mismatched — the UI may be answering a question that
   already timed out), call `adapter.respond(pending.id, { answers:
   input.answers })`, then clear `pendingQuestion` via
   `setAgentPendingQuestion(agentId, null)` and project a status back to
   `running` (or whatever `thread/status/changed` will report next). Register
   it as `answerQuestion` in `runtimeAdapters.codex` (`provider-runtime.ts:81-88`).
6. As a defense-in-depth self-heal (in case a `thread/status/changed` event
   is ever dropped after a non-question server request), keep the existing
   auto-resolve path's `blocked` status brief by not projecting it in step 1
   above for auto-handled methods — do not add a timeout/poller in this step;
   if a genuinely-unrecognized-method `blocked` state still needs a timeout
   self-heal, scope that as a follow-up rather than expanding this step.

**Verify**: `pnpm typecheck` → 0. Extend
`tests/server/codex-server-requests.test.ts` and
`tests/server/codex-runtime-state.test.ts`/`codex-retained-state.test.ts`
with: (a) a non-question server request (e.g.
`item/commandExecution/requestApproval`) does not project `status: 'blocked'`;
(b) `item/tool/requestUserInput` projects `pendingQuestion` and `blocked`,
and leaves the JSON-RPC request unanswered; (c) calling the new
`answerQuestionCodexAgent`/`answerQuestion` capability resolves the pending
request via `adapter.respond`, clears `pendingQuestion`, and a stale/mismatched
`requestId` fails clearly. `pnpm exec vitest run tests/server/` → pass.

### Step 2 (D4): Make session archive safe against an in-flight runtime turn

1. In `runtime-cleanup.ts`'s `deleteSessionAndCleanupRuntime` (lines
   101-111), reorder so runtime cleanup happens before the DB archive write:
   ```ts
   function deleteSessionAndCleanupRuntime<Result>(input, dependencies) {
     const session = dependencies.findSession(input.agentId)
     if (!session) throw new Error(`Session not found: ${input.agentId}`)

     cleanupRuntimeSessions([session], dependencies)
     return dependencies.deleteSession(input)
   }
   ```
   Do not touch `cleanupRuntimeSessions` itself (:37-45) — that function's
   error-handling is plan 018's to fix (see Step 7). This reorder alone
   narrows, but does not eliminate, the race (interrupt/forget may be
   asynchronous/best-effort).
2. Add defense-in-depth: guard the writers a running turn actually uses
   against writing into an archived row. In `db/runtime-state.ts`
   `setAgentStatus` (lines 157-175), check `archived_at IS NOT NULL` on the
   same `SELECT` that already reads `status` (line 163-165) and no-op (skip
   the `UPDATE`/event append) if archived. In `db/timeline-writes.ts`
   `recordRuntimeMessageRow` (lines 67-105) and
   `recordRuntimeTimelineEventRow` (lines 174-216), add an equivalent
   `archived_at IS NOT NULL` short-circuit before the insert (a small
   `SELECT archived_at FROM agent_slots WHERE id = ?` guard, consistent with
   the existing per-row lookups those functions already do for thread
   resolution).
3. The three writers above are not the whole projection surface. An
   in-flight turn can also reach `setAgentRuntimeState`
   (`db/runtime-state.ts:87-94`), context-usage writes
   (`db/runtime-state.ts:177-206`), and task replacement
   (`db/timeline-writes.ts:218-239`, pi projection writes at `:242-275`)
   via `projectRuntimeEventToDb` (`runtime-projection.ts:52-70`). Rather
   than guarding every writer individually, add **one** archived-check at
   the projection boundary: early-return in `projectRuntimeEventToDb` when
   the target agent row is archived (single `SELECT archived_at`). Keep
   sub-step 2's writer-level guards too — those functions are also called
   from outside the projection layer.

**Verify**: `pnpm typecheck` → 0. Add a `tests/server/runtime-cleanup.test.ts`
case asserting cleanup is invoked before the DB delete dependency for the
session path (fake dependencies recording call order). Add
`tests/server/db-runtime-state.test.ts`/`db-timeline-writes.test.ts` cases:
`setAgentStatus`/`recordRuntimeMessageRow`/`recordRuntimeTimelineEventRow`
against an already-archived agent id are no-ops (row/status unchanged). Add
a projection-boundary case: `projectRuntimeEventToDb` with a
`runtimeState`/`tasksUpdated` event for an archived agent is a no-op.
`pnpm exec vitest run tests/server/` → pass.

### Step 3 (D7): Stop walking every project's pi-sessions directory on every read

1. In `db/session-operations.ts` `hydratePersistedPiSessionRows` (lines
   161-257), add an optional `onlyAgentId?: string` to the `input` type.
   When set: skip the `for (const project of projects)` loop (line 173)
   entirely; instead resolve that one agent's `project_id`/`slot` with a
   single `SELECT project_id, slot FROM agent_slots WHERE id = ?`, and run
   the existing per-session hydration body (lines 191-255) for just that one
   `sessionDir` — no `readdirSync` at all for this call shape.
2. Update `hydratePersistedPiSessions` (`db.ts:674-680`) to accept an
   optional `agentId` and pass it through as `onlyAgentId`.
3. Update `getAgentDetail` (`db.ts:224-230`) to call
   `hydratePersistedPiSessions(database, input.agentId)` — it already has
   `input.agentId` in scope (line 227) before the hydrate call.
4. `getWorkspaceSnapshot` (`db.ts:187-195`) legitimately needs every
   project's sessions hydrated (it has no scope), so its call stays
   unscoped, but add a directory-listing cache: a module-level
   `Map<string, number>` in `session-operations.ts` keyed by
   `projectSessionRoot` storing the last-observed `statSync(projectSessionRoot).mtimeMs`;
   skip the `readdirSync` for a project whose root directory's mtime hasn't
   changed since the last full-workspace hydration pass. Invalidate/update
   this cache entry after every `readdirSync` call, same lifecycle as the
   existing `piHydrationStamps` per-file cache.

**Verify**: `pnpm typecheck` → 0. Extend
`tests/server/db-session-operations.test.ts`: (a) calling
`hydratePersistedPiSessionRows` with `onlyAgentId` set touches only that
project's directory (assert via a spy/counter on a fake `readdirSync`, or by
asserting other projects' untouched sessions are absent from the result);
(b) a second full-workspace hydration call with no on-disk changes does not
re-`readdirSync` an unchanged project root. `pnpm exec vitest run
tests/server/` → pass.

### Step 4 (D1 + D3): Real hard-delete for sessions, with tombstone and disk cleanup

D1 is unsafe without D3 (see Current state) — implemented together.

1. Add `hardDeleteSessionRow(database: DatabaseSync, agentId: string)` to
   `db/sessions.ts`, gated on the session already being archived: `SELECT
   id, project_id AS projectId, slot, session_dir AS sessionDir, archived_at
   AS archivedAt FROM agent_slots WHERE id = ?`; throw if not found or if
   `archivedAt` is `NULL` (mirrors the `assertStartedSession` guard style
   already used by `archiveSessionRow`/`restoreSessionRow`, lines 175/203).
2. Inside one `withTransaction`: `INSERT INTO deleted_sessions (project_id,
   slot, deleted_at) VALUES (?, ?, ?)` (matches the schema at
   `migrations.ts:87-93` and the reader at
   `session-operations.ts:176-181`), then `DELETE FROM agent_slots WHERE id
   = ?` (cascades through `threads`/`messages`/`timeline_events`/
   `agent_tasks`/`agent_context_usage` and `SET NULL`s the remaining FKs, per
   the FK graph in Current state — no other explicit deletes needed).
3. After the transaction commits, best-effort unlink the on-disk
   `sessionDir` (`rmSync(sessionDir, { recursive: true, force: true })`) —
   outside the SQL transaction since filesystem operations are not
   transactional with SQLite; log (do not throw) on failure, since the DB
   state is already correctly committed at that point.
4. Add `hardDeleteSession(agentId: string)` to `db.ts` wrapping
   `hardDeleteSessionRow`, following the existing thin-wrapper pattern
   (`archiveSession`, lines 353-355). Do not add a `WorkspaceServiceApi`
   method, MCP operation, or renderer wiring for it in this plan (see
   Scope) — it is a server-internal capability for now.

**Verify**: `pnpm typecheck` → 0. Add `tests/server/db-sessions.test.ts` (or
a new `db-session-hard-delete.test.ts`) cases: (a) hard-deleting a
non-archived session throws; (b) hard-deleting an archived session removes
the `agent_slots` row and cascades to `threads`/`messages`/`timeline_events`/
`agent_context_usage`; (c) a `deleted_sessions` row is inserted with the
correct `project_id`/`slot`; (d) after hard-delete, a subsequent
`hydratePersistedPiSessionRows` pass over the same project does **not**
re-create the agent from its (if not yet unlinked in the test fixture)
on-disk directory, proving the tombstone is honored. `pnpm exec vitest run
tests/server/` → pass.

### Step 5 (D9): Document the read-model indexer's zero-consumer status

Given `read_model_entries` has no consumer anywhere (renderer, MCP surface,
or otherwise) and no other part of this plan needs it, stripping the write
path is riskier than it's worth (it may be scaffolding for planned, not-yet-
built work) and wiring a consumer is out of scope for a hardening plan. The
decided fix is documentation, not code deletion:

1. Add a short comment directly above `refreshReadModelEntriesIfChanged`'s
   export in `read-model-indexer.ts` (near line 41) and above
   `refreshReadModels` in `db.ts` (near line 205) stating plainly: as of this
   plan, `read_model_entries` has no readers anywhere in the codebase or the
   MCP surface (`kiri-control.ts`/`kiri-router.ts` never call
   `refreshReadModels`); if this remains true, the write path should be
   removed rather than continuing to pay its cost on every mutation.
2. No behavior change; no new test required for this step.

**Verify**: `pnpm typecheck` → 0 (comment-only change should be a no-op).

### Step 6 (D2, D6, D8, D10, D11, D13): State-machine hygiene cluster

1. **D2** — rename internal-only implementation names from delete→archive:
   `db.ts`'s `deleteSession`→`archiveSession`* (careful: `db.ts` already has
   a private `archiveSession` helper at line 353 wrapping `archiveSessionRow`
   — rename the currently-public `deleteSession`/`deleteSessionSummary`
   (343-351) to `archiveSessionSummary`/fold the naming so there is no
   collision), `runtime-cleanup.ts`'s `deleteSessionWithRuntimeCleanup`→
   `archiveSessionWithRuntimeCleanup`,
   `deleteSessionAndCleanupRuntime`→`archiveSessionAndCleanupRuntime`, and
   `kiri-control.ts`'s `deleteSessionSummary` dependency field/
   `deleteSessionEffect`→`archiveSessionSummary`/`archiveSessionEffect`.
   Update `workspace-service.ts`'s internal dependency wiring accordingly.
   Do not rename `WorkspaceServiceApi.deleteSession`, `DeleteSessionInput`,
   or the `'session.archive'` MCP string (see Scope).
2. **D6** — wire `'queued'` for real instead of removing it (removing it
   needs a migration to rewrite the `CHECK` constraint at
   `migrations.ts:26`/`410`, more invasive than wiring it): in
   `runtime-lifecycle.ts`'s `enqueueAgentTurn`, when a new turn is enqueued
   behind an already-running one for the same agent, project `status:
   'queued'`; when the queued turn starts executing, project the status the
   turn would have set anyway (`running`). Keep the change scoped to the
   enqueue/dequeue transition only.
3. **D8** — add `forgetPiHydrationStamp(agentId)` export to
   `session-operations.ts` (deletes from the module-level `piHydrationStamps`
   Map, same as the inline call already in `resetSessionRows:58`), and call
   it from `archiveSessionRow` (`db/sessions.ts:169-195`) and from the new
   `hardDeleteSessionRow` (Step 4).
4. **D10** — wrap `insertSessionRow`'s transaction body (`db/sessions.ts:120-156`)
   in a small retry loop (bounded, e.g. 5 attempts): on a primary-key
   collision (`SQLITE_CONSTRAINT_PRIMARYKEY`/message match on the `INSERT`),
   regenerate the suffix (respecting `input.slotSuffix` if the caller
   supplied a fixed one — in that case, do not retry silently past a caller-
   forced collision; only retry when using the default `Math.random()`
   generator) and retry; throw after exhausting attempts.
5. **D11** — add SAVEPOINT-based reentrancy to `db/transaction.ts`'s
   `withTransaction`: track nesting depth (module-level counter is
   sufficient given the single-`DatabaseSync`-instance usage pattern
   confirmed by grep), `BEGIN`/`COMMIT`/`ROLLBACK` at depth 0, `SAVEPOINT
   sp_<depth>`/`RELEASE SAVEPOINT`/`ROLLBACK TO SAVEPOINT` at deeper levels.
6. **D13** — in `runtime.ts`'s `unsupportedCapabilityMessage` (lines
   172-181), drop the `key === 'prompt'` restriction so any capability key
   on `claude`/`opencode` gets the "sessions run in terminal mode only"
   framing, not just `prompt`.

**Verify**: `pnpm typecheck` → 0. Extend existing test files
(`tests/server/db-sessions.test.ts` for D10, `tests/server/db-session-operations.test.ts`
for D8, a new or extended `tests/server/db-transaction.test.ts` for D11
nested-transaction commit/rollback, `tests/server/runtime.test.ts` or
equivalent for D13's message text, `tests/server/db-runtime-state.test.ts`/
lifecycle tests for D6's `'queued'` transition). `pnpm exec vitest run
tests/server/` → pass. `pnpm test:unit` → pass. `pnpm build` → exit 0.

### Step 7 (D12): Cross-reference only — no code change

Confirm (re-read `runtime-cleanup.ts:37-99` per the drift check at the top
of this plan) that `cleanupRuntimeSessions`/`deleteProjectAndCleanupRuntimes`
have not been modified by this plan's own Steps 2/6 (they should not have
been — Step 2 only touches `deleteSessionAndCleanupRuntime`). Record in
`plans/README.md`'s row for this plan (per the executor instructions) that
D12 is owned by plan 018's Step 4 (H7), and that plan 018 should be checked
for landed status before assuming `cleanupRuntimeSessions`'s error-swallowing
behavior in this plan's own tests (Step 2's tests use fake dependencies and
do not depend on 018 having landed).

**Verify**: no code change; `git diff --stat` for this step should show
zero hunks in `runtime-cleanup.ts` beyond Step 2's `deleteSessionAndCleanupRuntime`
reorder.

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt above doesn't match live code after the drift
  check — especially `codex-runtime.ts`'s `projectCodexNotification` (large
  file, easy to drift) and `runtime-cleanup.ts`'s three functions, since
  plan 018's H7 may have already landed a fix to `cleanupRuntimeSessions`/
  `deleteProjectAndCleanupRuntimes` by the time this plan executes.
- Step 1: the actual `item/tool/requestUserInput` params shape (inspect via
  a real codex fixture, not assumption) doesn't map cleanly onto
  `pendingQuestionSchema`'s `questions[]`/`options[]` shape — do not
  fabricate a mapping; escalate with the real payload shape observed.
- Step 1: `adapter.respond`/`adapter.reject` (on `CodexAppServerAdapter`)
  don't actually support being called asynchronously/later (i.e., they
  assume synchronous same-tick resolution) — re-read `codex-app-server.ts`'s
  adapter implementation before assuming a request can be left open across
  an `answerQuestion` round-trip.
- Step 2: `setAgentStatus`/`recordRuntimeMessageRow`/`recordRuntimeTimelineEventRow`'s
  callers elsewhere (outside the archive-race path) rely on writing to an
  already-archived agent for a legitimate reason (e.g. a final "turn
  interrupted" status/message after archive) — if so, the archived-aware
  guard must not silently drop that specific write; escalate rather than
  blanket-suppressing.
- Step 3: `getWorkspaceSnapshot`'s callers depend on hydration picking up a
  brand-new project directory whose parent `piSessionsDir` mtime wouldn't
  reflect a new per-project subdirectory reliably on the target OS/filesystem
  — verify the mtime-changes-on-child-creation assumption holds for the
  actual deployment filesystem before shipping the cache.
- Step 4: the FK cascade graph in `migrations.ts` has changed since this
  plan was written (re-grep `REFERENCES`/`ON DELETE` before assuming the
  cascade list in "Current state" is exhaustive) — an incomplete cascade
  could silently leave orphaned rows after hard-delete.
- Step 6 (D2): renaming `db.ts`'s public `deleteSession`/`deleteSessionSummary`
  exports turns out to have call sites outside `workspace-service.ts`/
  `kiri-control.ts` (re-grep before renaming) — do not rename a function
  that's part of a wider public contract without full caller visibility.
