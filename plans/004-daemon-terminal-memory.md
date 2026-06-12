# Plan 004: Stop the kiriterm daemon's periodic full-scrollback serialization and unbounded map growth

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat eadc8a0..HEAD -- src/server/terminal-registry.ts src/server/kiriterm-daemon.ts src/server/terminal-subscriptions.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `eadc8a0`, 2026-06-12

## Why this matters

The kiriterm daemon is a long-lived detached process (it survives app
restarts) that holds every PTY plus a headless xterm emulator with **10,000
rows of scrollback per session**. Three growth/churn problems live in it:

1. **Dump churn**: every 30s, `dumpSessions` serializes the FULL scrollback
   of every live session (`service.registry.snapshot(session)`) and only
   *then* compares it to the previous dump to decide whether to write. For an
   idle session with a full 10k-row buffer that is megabytes of string
   allocation per session per tick, forever — and `lastDumpByKey` retains the
   entire serialized scrollback of every session ever dumped as live strings.
2. **`lastDumpByKey` and stale keys**: entries are never deleted, even after
   a session exits.
3. **Subscription records**: every `workflow.await` subscription record stays
   in the in-memory `records` map and is rewritten to the JSON journal on
   every `persist()` — delivered and failed records are never pruned, so the
   map and the journal file grow without bound over the daemon's lifetime.

The fix: track an output sequence number on each registry session, gate the
dump on it (serialize only when output actually arrived), store the cheap
stamp instead of the full snapshot string, sweep dead keys, and cap retained
settled subscription records.

## Current state

Relevant files:

- `src/server/terminal-registry.ts` — `TerminalRegistrySession` type
  (lines 46-65), `register()` (line 132), `append()` (lines 241-255, the
  single place output enters the emulator), `snapshot()` (lines 280-284,
  serializes full scrollback).
- `src/server/kiriterm-daemon.ts` — `lastDumpByKey` (line 183),
  `dumpSessions()` (lines 261-286).
- `src/server/terminal-subscriptions.ts` — `records` map (line 87),
  settle sites: `watch`'s catch (lines 133-136), `flushDelivery`
  (lines 204-208), `failPending` (lines 225-231); `persist()`
  (lines 260-266) writes ALL records; `loadJournal` (lines 297-305).

### `append` — the only output entry point (`terminal-registry.ts:241-255`)

```ts
function append(session: TerminalRegistrySession, data: string) {
  if (!data) return
  session.headless.write(data, () => {
    for (const listener of session.screenListeners) listener()
  })
  session.recentOutputChunks.push(data)
  session.recentOutputBytes += data.length
  while (
    session.recentOutputBytes > maxRecentOutputBytes &&
    session.recentOutputChunks.length > 1
  ) { ... }
}
```

(`recentOutputBytes` is a rolling-window size, NOT monotonic — it cannot be
used as a dirty signal; that is why this plan adds a sequence counter.)

### `dumpSessions` — serialize-then-compare (`kiriterm-daemon.ts:261-286`)

```ts
function dumpSessions() {
  for (const session of service.registry.sessions.values()) {
    if (session.exited) continue
    try {
      const snapshot = service.registry.snapshot(session)        // full scrollback serialize
      if (lastDumpByKey.get(session.key) === snapshot) continue  // compare AFTER the work
      lastDumpByKey.set(session.key, snapshot)                   // retains the full string
      const persisted: PersistedSession = {
        key: session.key,
        mode: session.mode,
        label: session.label,
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        snapshot,
        savedAt: new Date().toISOString(),
      }
      writeFileAtomic(
        join(sessionsDir, `${encodeURIComponent(session.key)}.json`),
        JSON.stringify(persisted),
      )
    } catch (error) { ... }
  }
}
```

### Subscription settle sites (`terminal-subscriptions.ts`)

```ts
// watch(): line 133-136
}).catch((error) => {
  record.status = 'failed'
  record.outcome = error instanceof Error ? error.message : String(error)
  persist()
})

// flushDelivery(): line 204-208
for (const item of pending.items) {
  item.record.status = 'delivered'
  item.record.outcome = item.result.matched ? 'condition met' : 'timed out'
}
persist()

// failPending(): line 225-231
for (const item of pending.items) {
  item.record.status = 'failed'
  item.record.outcome = outcome
}
persist()
```

Sessions are properly removed from the registry on exit (`exit()` at
`terminal-registry.ts:407-426` calls `deleteOwnedSession` + `disposeEmulator`),
so the registry itself does not leak — only the daemon-level maps do.

### Repo conventions

- TypeScript: no `any`, no `!`, no `as Type`.
- Registry/daemon tests use injected fake timers and stub procs — see
  `tests/server/terminal-registry.test.ts`, `tests/server/kiriterm-daemon.test.ts`,
  and `tests/server/terminal-subscriptions.test.ts`. Match their style.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Targeted tests | `pnpm exec vitest run tests/server/terminal-registry.test.ts tests/server/kiriterm-daemon.test.ts tests/server/terminal-subscriptions.test.ts tests/server/terminal-server.test.ts` | all pass |
| Unit tests | `pnpm test:unit` | all pass |
| Perf gates | `pnpm test:perf` | all pass |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/server/terminal-registry.ts` (add `outputSeq` only)
- `src/server/kiriterm-daemon.ts` (`dumpSessions` + `lastDumpByKey` typing)
- `src/server/terminal-subscriptions.ts` (settled-record pruning)
- `tests/server/terminal-registry.test.ts`, `tests/server/kiriterm-daemon.test.ts`,
  `tests/server/terminal-subscriptions.test.ts` (add cases)

**Out of scope** (do NOT touch):
- The `agents` map in `kiriterm-daemon.ts` (line 180). It is never evicted,
  but deleting entries on `close-runtime` would break wake-delivery respawn
  (`spawnForDelivery` needs the retained launch config to revive a closed
  agent). Leave it; it is bounded by distinct agents, not time.
- Scrollback size (`defaultScrollback = 10_000`, `terminal-registry.ts:91`)
  — a product trade-off, not in this plan.
- `restoreContent` / persisted-session loading, `subscriptions.list()`
  response shape, and the control-route schemas.
- `src/server/terminal-server.ts`.

## Git workflow

- Branch: `advisor/004-daemon-terminal-memory`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a monotonic output sequence to registry sessions

In `src/server/terminal-registry.ts`:

1. Add `outputSeq: number` to the mutable section of
   `TerminalRegistrySession` (next to `recentOutputBytes`).
2. Initialize `outputSeq: 0` in `register()`'s session literal.
3. In `append()`, after the existing bookkeeping, add
   `session.outputSeq += 1`.

`append` is the single funnel for PTY output, banners, and exit messages, so
`outputSeq` changes iff emulator content changed. Resizes do not bump it —
the dump stamp in Step 2 includes cols/rows separately.

**Verify**: `pnpm typecheck` → exit 0;
`pnpm exec vitest run tests/server/terminal-registry.test.ts` → pass.

### Step 2: Gate `dumpSessions` on the stamp, serialize only when dirty

In `src/server/kiriterm-daemon.ts`:

1. Repurpose `lastDumpByKey` to store the cheap stamp instead of the full
   snapshot string. Keep the `Map<string, string>` type; the value becomes
   `` `${session.outputSeq}:${session.cols}:${session.rows}` ``.
2. Rewrite the loop body:

```ts
function dumpSessions() {
  const liveKeys = new Set<string>()
  for (const session of service.registry.sessions.values()) {
    if (session.exited) continue
    liveKeys.add(session.key)
    const stamp = `${session.outputSeq}:${session.cols}:${session.rows}`
    if (lastDumpByKey.get(session.key) === stamp) continue
    try {
      const snapshot = service.registry.snapshot(session)
      const persisted: PersistedSession = { ...unchanged fields..., snapshot, savedAt: new Date().toISOString() }
      writeFileAtomic(join(sessionsDir, `${encodeURIComponent(session.key)}.json`), JSON.stringify(persisted))
      lastDumpByKey.set(session.key, stamp)
    } catch (error) {
      console.error('kiriterm: failed to persist session snapshot', session.key, error)
    }
  }
  for (const key of lastDumpByKey.keys()) {
    if (!liveKeys.has(key)) lastDumpByKey.delete(key)
  }
}
```

Behavior notes (preserve them):
- Set the stamp only after a successful write so failures retry next tick
  (the old code set the map before writing; this is a deliberate small fix —
  keep it, it only changes the failure path).
- Do NOT delete the persisted JSON file for dead sessions — those files are
  what `restoreContent` replays after a daemon restart.

**Verify**: `pnpm exec vitest run tests/server/kiriterm-daemon.test.ts` → pass.

### Step 3: Prune settled subscription records

In `src/server/terminal-subscriptions.ts`:

1. Add a constant `const maxSettledRecords = 100` near the top of
   `makeTerminalSubscriptions`.
2. Add a private helper inside the factory:

```ts
function pruneSettled() {
  const settled = Array.from(records.values())
    .filter((record) => record.status !== 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  while (settled.length > maxSettledRecords) {
    const oldest = settled.shift()
    if (oldest) records.delete(oldest.id)
  }
}
```

3. Call `pruneSettled()` immediately before each of the three `persist()`
   calls at the settle sites quoted in "Current state" (watch's catch,
   `flushDelivery`, `failPending`). Do NOT call it in `subscribe` — pending
   records must never be pruned.

Since `persist()` serializes `records.values()`, the journal shrinks
automatically; `loadJournal` needs no change.

**Verify**: `pnpm exec vitest run tests/server/terminal-subscriptions.test.ts` → pass.

### Step 4: Add tests

1. `tests/server/terminal-registry.test.ts` (match existing style — the file
   builds a registry with stub procs/timers): `append` increments
   `outputSeq`; empty-string append does not.
2. `tests/server/kiriterm-daemon.test.ts`: if the existing file has a harness
   that reaches `dumpSessions` (look for `dumpIntervalMs` usage), add: two
   consecutive dump ticks with no output between them write the session file
   once (count writes via the sessions dir mtime/content or by injecting a
   short `dumpIntervalMs` and sampling the file's `savedAt`). If the harness
   cannot observe dumps without real timers, test at the registry level only
   and note it in the PR description — do not build new daemon test
   infrastructure for this.
3. `tests/server/terminal-subscriptions.test.ts` (the file uses injected
   timers and a stub registry): create `maxSettledRecords + 1` settled
   subscriptions (drive them to delivered/failed via the existing test
   helpers), assert `list()` contains at most `maxSettledRecords` settled
   records plus all pending ones, and that the journal file parses and has
   the same bound.

**Verify**: `pnpm exec vitest run tests/server/terminal-registry.test.ts tests/server/kiriterm-daemon.test.ts tests/server/terminal-subscriptions.test.ts` → all pass.

### Step 5: Full gates

**Verify**: `pnpm typecheck && pnpm test:unit && pnpm test:perf && pnpm build` → all exit 0.

## Test plan

Covered in Step 4. Pattern files: the three test files named there. The
load-bearing assertions: (a) no serialize when `outputSeq` unchanged
(indirectly: dump file not rewritten), (b) settled-record count bounded,
(c) pending records never pruned.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test:unit` exits 0, including new outputSeq / prune tests
- [ ] `pnpm test:perf` exits 0
- [ ] `pnpm build` exits 0
- [ ] `grep -n "registry.snapshot(session)" src/server/kiriterm-daemon.ts` shows the call inside the stamp-gated branch only
- [ ] `grep -n "records.delete" src/server/terminal-subscriptions.ts` returns at least one match
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift).
- You find a second place (besides `append`) where emulator content is
  written (`grep -n "headless.write" src/server/terminal-registry.ts` — as of
  planning there are two: the attach flush sentinel `headless.write('', ...)`
  at line 193, which writes nothing, and `append` at line 243). A third,
  content-bearing writer breaks the dirty-signal assumption.
- Existing daemon restore tests fail in a way that suggests persisted session
  files are now missing content they previously had.
- `subscriptions.list()` consumers (search `GET /api/subscriptions` callers
  in `src/cli/` and `src/server/kiri-mcp*`) turn out to require the full
  historical record set.

## Maintenance notes

- If a new output path into the emulator is ever added, it must bump
  `outputSeq` (or call `append`) or dumps will go stale — reviewers should
  watch for direct `headless.write` calls in future PRs.
- Deferred from this plan: a scrollback-size knob for runtime sessions
  (`defaultScrollback = 10_000` is the dominant per-session RAM cost in the
  daemon — ~several MB per session), and eviction policy for the daemon's
  `agents` map (blocked on wake-delivery respawn semantics; see Scope).
- `maxSettledRecords = 100` is arbitrary but generous; if the kirictl UX later
  wants full history, move settled records to an append-only log file instead
  of raising the cap.
