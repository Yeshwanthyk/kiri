# Plan 002: Skip Pi JSONL re-hydration when session files have not changed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat eadc8a0..HEAD -- src/server/db/session-operations.ts src/server/db/timeline-writes.ts src/server/db.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (lands well with plan 001; they multiply)
- **Category**: perf
- **Planned at**: commit `eadc8a0`, 2026-06-12

## Why this matters

Every workspace snapshot read and every agent-detail read calls
`hydratePersistedPiSessions`, which — for **every Pi session slot on disk,
on every call** — reads the session's entire JSONL file from disk, parses
every line, projects it into messages, then runs `hydrateProjectionMessages`,
which reads all existing thread messages from SQLite, DELETEs them, and
re-INSERTs the projected set. With the 2s background poll this is a full
re-parse + table rewrite of every Pi session **per poll tick**, scaling with
total session history size, not with what changed. Gating hydration on the
session file's `(mtimeMs, size)` makes the steady-state cost a `stat()` call
per session.

## Current state

Relevant files:

- `src/server/db.ts` — `getWorkspaceSnapshot()` (line 181) and
  `getAgentDetail()` (line 220) both call `hydratePersistedPiSessions(database)`
  first (lines 183 and 222). The private wrapper at line 674 forwards to
  `hydratePersistedPiSessionRows` with `piSessionsDir` + default model.
- `src/server/db/session-operations.ts` — `hydratePersistedPiSessionRows`
  (line 148): the loop to modify.
- `src/server/db/timeline-writes.ts` — `hydrateProjectionMessages` (line 514)
  and `existingThreadMessages` (line 571): the expensive work being skipped.
  **Read-only for this plan.**
- `src/server/pi-jsonl-file.ts` — `projectPiSessionFile` reads the whole file
  with `readFileSync(path, 'utf8')` (line 32) and parses it. **Read-only.**

### The per-call hydration loop — `session-operations.ts:148-235` (excerpt)

```ts
export function hydratePersistedPiSessionRows(
  database: DatabaseSync,
  input: {
    readonly piSessionsDir: string
    readonly defaultModel: string
  },
) {
  const projects = database
    .prepare('SELECT id FROM projects ORDER BY position ASC')
    ...
  for (const project of projects) {
    const projectSessionRoot = join(input.piSessionsDir, project.id)
    if (!existsSync(projectSessionRoot)) continue
    ...
    const slots = readdirSync(projectSessionRoot, { withFileTypes: true })
      ...
    for (const slot of slots) {
      ...
      const sessionFile = activePiSessionFile(sessionDir, existingAgent?.sessionFile)
      const projection = sessionFile ? safeProjectPiSessionFile(sessionFile) : undefined   // line 198: full read+parse
      const agent = existingAgent ?? createPersistedSessionAgent(database, { ... })
      ...
      const threadId = ensureThreadForAgent(database, id, projection)
      if (projection) {
        hydrateProjectionMessages(database, id, projection)     // line 217: DELETE + re-INSERT all messages
        replaceAgentTasksForThread(database, { ... })
      }
      if (projection?.messages.length) {
        upsertAgentContextUsage(database, { ... })
      }
    }
  }
}
```

`hydrateProjectionMessages` (`timeline-writes.ts:514-563`) is idempotent: it
reads all non-user messages for the thread, DELETEs them
(`DELETE FROM messages WHERE thread_id = ? AND id NOT LIKE ?`, line 530), and
re-inserts from the projection. Running it on an unchanged file produces an
identical end state — which is exactly why skipping it on an unchanged file
is safe.

### Repo conventions that apply

- TypeScript: no `any`, no non-null `!`, no `as Type`.
- Pure-function + injected-dependency style: see how
  `hydratePersistedPiSessionRows` takes a config object, and how tests in
  `tests/server/db-session-operations.test.ts` exercise it against a real
  `DatabaseSync` and real temp dirs. Match that.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Targeted tests | `pnpm exec vitest run tests/server/db-session-operations.test.ts tests/server/db-timeline-writes.test.ts tests/server/agent-detail-history.test.ts` | all pass |
| Unit tests | `pnpm test:unit` | all pass |
| Perf gates | `pnpm test:perf` | all pass |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/server/db/session-operations.ts`
- `tests/server/db-session-operations.test.ts` (add cases)

**Out of scope** (do NOT touch):
- `src/server/db/timeline-writes.ts` — `hydrateProjectionMessages` stays as-is;
  it is also called from the fork path and from Claude hydration.
- `src/server/pi-jsonl-file.ts` / `src/server/pi-jsonl.ts` — the parser.
- `src/server/db.ts` — call sites stay; the gate lives inside
  `hydratePersistedPiSessionRows`.
- Claude session hydration (`hydrateClaudeSession`, called from
  `db.ts:225`) — same disease, separate treatment; do not refactor it here.

## Git workflow

- Branch: `advisor/002-pi-hydration-cache`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a module-level freshness cache

In `src/server/db/session-operations.ts`, add near the top:

```ts
type PiHydrationStamp = {
  readonly sessionFile: string
  readonly mtimeMs: number
  readonly size: number
}

const piHydrationStamps = new Map<string, PiHydrationStamp>()

export function clearPiHydrationStamps() {
  piHydrationStamps.clear()
}
```

Key = agent id (`${project.id}-${slot}`). Import `statSync` from `node:fs`
(the file already imports `existsSync`, `readdirSync`, etc. from there).

### Step 2: Gate the per-slot work

Inside the `for (const slot of slots)` loop, after `sessionFile` is resolved
(line 197) and **only when `existingAgent` is defined** (a brand-new slot must
still take the full path so the agent row, thread, tasks, and context usage
get created):

```ts
const stamp = sessionFile ? statSessionFile(sessionFile) : undefined
if (
  existingAgent &&
  stamp &&
  sameHydrationStamp(piHydrationStamps.get(id), stamp)
) {
  continue
}
...
// existing body unchanged
...
if (stamp) piHydrationStamps.set(id, stamp)
```

with two small helpers in the same file:

```ts
function statSessionFile(path: string): PiHydrationStamp | undefined {
  try {
    const stats = statSync(path)
    return { sessionFile: path, mtimeMs: stats.mtimeMs, size: stats.size }
  } catch {
    return undefined
  }
}

function sameHydrationStamp(
  previous: PiHydrationStamp | undefined,
  next: PiHydrationStamp,
) {
  return previous !== undefined &&
    previous.sessionFile === next.sessionFile &&
    previous.mtimeMs === next.mtimeMs &&
    previous.size === next.size
}
```

Important details:

- The stamp records the **resolved sessionFile path**, so a slot whose active
  file rotates to a new JSONL (`activePiSessionFile` picks the latest) misses
  the cache and re-hydrates.
- Set the stamp only **after** the hydration body completed without throwing,
  so a failed hydration retries next call.
- When `sessionFile` is undefined or `statSync` throws, behave exactly as
  today (no caching, full path).
- Also handle the small early block at lines 210-214
  (`if (sessionFile && !agent.sessionFile) UPDATE agent_slots ...`): it only
  runs when the DB row lacks a session file; on the cached path
  `existingAgent.sessionFile` was already used to resolve the file, and if it
  was null the stamp lookup should not short-circuit — covered by requiring
  `existingAgent` and a stamp whose `sessionFile` matches.

### Step 3: Invalidate on session mutation paths in this file

Two functions in this file write Pi session state outside the hydration loop;
make them clear their agent's stamp so the next hydration re-reads:

- `forkPiSessionAgent` (around line 60-146) creates a new agent — no stamp
  exists yet, nothing to do, but verify no stale key can collide (keys are
  agent ids; new id ⇒ no collision).
- If this file contains delete/reset helpers that remove or replace session
  files for an existing agent id (search for `deleted_sessions`,
  `rmSync`, `unlink`), add `piHydrationStamps.delete(agentId)` there. If
  session deletion lives in another file, do NOT chase it — the stamp's
  `sessionFile + mtime + size` comparison already misses when the active file
  changes, and a deleted slot stops being iterated entirely.

**Verify (steps 1-3)**: `pnpm typecheck` → exit 0.

### Step 4: Add tests

In `tests/server/db-session-operations.test.ts`, following the existing
pattern in that file (real temp dir + real `DatabaseSync`):

1. **Skip when unchanged**: create a project + a `session-*` dir with a JSONL
   file; call `hydratePersistedPiSessionRows` twice; between calls, INSERT a
   sentinel row into `messages` for that thread with an id matching the
   deleted-by-hydration pattern (anything not starting `user-<agentId>-`).
   After the second call the sentinel must **still exist** (hydration was
   skipped). Call `clearPiHydrationStamps()` in the test's setup/teardown so
   tests stay independent.
2. **Re-hydrate when the file changes**: same setup, then append a line to
   the JSONL (and bump mtime — appending does), call hydrate again; the
   sentinel must be **gone** and the new projected message present.
3. **New slot still hydrates fully**: fresh slot dir, single call, assert the
   agent row, thread, and messages exist (this is mostly covered by existing
   tests — extend only if not already asserted).

**Verify**: `pnpm exec vitest run tests/server/db-session-operations.test.ts` → all pass including 2-3 new cases.

### Step 5: Full gates

**Verify**: `pnpm test:unit && pnpm test:perf && pnpm build` → all exit 0.

## Test plan

Covered in Step 4. Pattern file: `tests/server/db-session-operations.test.ts`.
The sentinel-row trick is the load-bearing assertion: it proves the skip
actually skips (test 1) and that change detection actually re-runs the
delete/insert reconciliation (test 2).

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test:unit` exits 0; new skip/rehydrate tests exist and pass
- [ ] `pnpm test:perf` exits 0
- [ ] `pnpm build` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift).
- `tests/server/agent-detail-history.test.ts` or
  `tests/server/runtime-session-flows.test.ts` fail after the gate — these
  exercise live-session flows where messages arrive between hydrations; a
  failure there means skipping reconciliation breaks a real flow, and the
  approach needs review rather than test patching.
- You find that hydration is relied on to repair DB rows even when the file
  is unchanged (e.g. a caller that intentionally deletes messages and expects
  the next snapshot to restore them). Search for callers manipulating
  `messages` rows for pi threads outside `timeline-writes.ts` before assuming.
- The fix appears to require touching `timeline-writes.ts` or the Pi parser.

## Maintenance notes

- The cache is process-local. The desktop backend is a single long-lived
  process, so this holds; if the server ever becomes multi-process, stamps
  must move into SQLite.
- `mtimeMs + size` is a sufficient freshness signal for append-only JSONL
  files. If Pi ever rewrites session files in place within the same
  millisecond at identical length, the gate would miss it — considered and
  accepted; the file is append-only in practice.
- Claude session hydration (`hydrateClaudeSession` in the Claude path) has
  the same per-read full-parse shape and is the natural follow-up, using this
  plan's stamp helpers as the pattern.
