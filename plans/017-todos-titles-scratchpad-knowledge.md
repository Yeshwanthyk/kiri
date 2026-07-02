# Plan 017: Todos, titles, scratchpad & knowledge features

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1fa5160..HEAD -- src/server/scratchpad-trigger.ts src/server/db/scratchpad.ts src/server/db/knowledge.ts src/server/db/timeline-writes.ts src/server/db/agent-detail.ts src/server/db/sessions.ts src/server/db/session-operations.ts src/server/read-model-indexer.ts src/server/runtime-projection.ts src/server/codex-runtime.ts src/server/pi-jsonl.ts src/server/kiri-router.ts src/server/kiri-control.ts src/server/terminal-launch.ts src/server/provider-runtime.ts src/lib/contracts.ts src/components/kiri-board/scratchpad.tsx src/components/kiri-board/task-progress.tsx src/components/kiri-board/board-scratchpad-actions.ts src/server/db/migrations.ts src/cli/kirictl.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plan 014 (agent hooks tightening) for deterministic todo/title
  signals — this plan owns the DB/read-model/UI/aggregation/derivation layers
  that *consume* those hook signals; plan 014 owns emitting them (claude hook
  bundle, codex resume re-bind, PATH-shim wrappers).
- **Category**: feature
- **Planned at**: commit `1fa5160`, 2026-07-01

## Why this matters

Four user-facing feature areas are either half-wired or entirely missing, all
sharing one root cause: the terminal-launch system prompts *ask* the model to
keep titles/todos current (`terminal-launch.ts:279-288` for claude,
`terminal-launch.ts:367-373` for codex) instead of the app deriving/enforcing
them. This makes titles and todos unreliable exactly where they matter most —
long-running sessions the user isn't watching.

- **Titles**: sessions default to `Session N` (`db/sessions.ts:116`) forever
  unless the model remembers to call `session.rename`. No code ever
  auto-derives or refreshes a title.
- **Todos**: Claude Code — the most-used runtime in terminal mode — never
  populates `agent_tasks`. The system prompt's claim that "Kiri projects
  TodoWrite into its Tasks view where supported" (`terminal-launch.ts:283`) is
  false for claude. There's also no cross-session todo view and no
  OpenCode/terminal-codex task sync.
- **Scratchpad**: capture→list→trigger→session-create is the most complete
  flow of the four, but triggered sessions still get generic `Session N`
  titles even though the block body (the prompt itself) is sitting right
  there.
- **Knowledge**: the DB layer is correct and already per-project, but there is
  **no UI** at all — it's MCP-only, so users can't audit, curate, or delete a
  bad entry, and search is keyword-only with no fallback for a differently
  phrased query.

## Approach (decided)

- Treat plan 014's hook signals (claude PostToolUse/Stop, codex resume
  re-bind) as the deterministic trigger source once it lands; this plan's
  consumer code must degrade gracefully (no-op, not crash) if a hook signal
  never arrives, since 014 may land after or alongside this work.
- Titles: gate all auto-retitling behind an explicit "was this title ever set
  by the user" flag (`title_set_manually`) rather than pattern-matching
  `Session N` — pattern matching breaks the moment a user renames a session to
  something that happens to look generic.
- Todos: reuse the exact `agent_tasks` write path already used by pi/codex
  (`replaceAgentTasksForThread`, `db/timeline-writes.ts:577-607`) for claude —
  no schema or contract change needed, `'claude'` is already a valid
  `agent_tasks.source` (`contracts.ts:129-136`, CHECK constraint via
  `runtimeCheckValues` in `db/migrations.ts:75`).
- Knowledge: mirror the existing scratchpad UI pattern
  (`src/components/kiri-board/scratchpad.tsx`) rather than inventing a new
  interaction model — same sidebar-panel shape, same capture/list/delete
  affordances, project-scoped like scratchpad's project chips.
- Ship independently: each pillar (Titles / Todos / Scratchpad / Knowledge) is
  scoped so it can merge and ship on its own; only G5-2 gates G5-1 within
  Titles, and G3-1 gates G3-5 within Todos. Cross-pillar there is no ordering
  requirement.

## Current state

### Scratchpad (most complete: capture→list→trigger→session-create wired)

- `src/server/scratchpad-trigger.ts:24-32` `TriggerScratchpadInput.title` is
  already an optional field, and `triggerScratchpadSessionWithDeps`
  (`:157-219`) already forwards `input.title` into `startSessionAndGetId`
  (`:167-174`), which forwards to `insertSessionRow` (`db/sessions.ts:106-149`).
  The **only** missing link is the caller: `board-scratchpad-actions.ts:75-97`
  `handleTriggerBlock` already threads an optional `overrides.title` through to
  the mutation (`:89`), but `scratchpad.tsx:164-188` `handleTrigger` never
  passes one — confirmed by reading the full function body: the overrides
  object it builds only contains `runtime` and `interfaceMode` (`:174-177`).
  Falls back to `Session ${nextPosition.position + 1}`
  (`db/sessions.ts:116`, exact text confirmed).
- `db/scratchpad.ts:65-81` `markScratchpadBlockTriggered` does a single-row
  `UPDATE scratchpad_blocks SET triggered_at = ?, triggered_agent_id = ?` — a
  re-trigger overwrites the previous trigger's provenance with no history.
  `scratchpad_blocks` schema (`db/migrations.ts:102-109`) has exactly one
  `triggered_at`/`triggered_agent_id` pair, no back-reference table.
  `ScratchpadBlock` contract (`contracts.ts:265-274`) mirrors this: no
  `sourceScratchpadId` exists on the session/agent side at all — nothing links
  a triggered session back to its originating block.
- `scratchpad-trigger.ts:176-213` — failure cleanup after `markScratchpadBlockTriggered`
  succeeds but `promptAgent`/`pasteAgentRuntimeTerminal` fails is wrapped in a
  bare `try { deleteSessionSummary(...) } catch {}` (best-effort, e.g. `:204-212`
  for GUI-mode, `:193-197` for terminal-mode `pasteAgentRuntimeTerminal` — note
  the terminal-mode path does NOT delete the session on paste failure, only
  reports it). Can leave a scratchpad block marked "triggered" (sent) with a
  dead/missing session.

### Knowledge (per-project already correct)

- `db/migrations.ts:114-125` — `knowledge_entries.project_id TEXT NOT NULL
  REFERENCES projects(id) ON DELETE CASCADE`. Already project-scoped, no
  schema change needed.
- `db/knowledge.ts:17-54` `searchKnowledgeEntries` and `:56-85`
  `addKnowledgeEntry` both require and validate `projectId` via
  `requireProjectId`/`assertProjectExists` (`:178-187`). Confirmed correct.
- **No UI at all.** `grep -r "Knowledge" src/components` returns nothing.
  MCP-only via `kiri_get "knowledge.search"` / `kiri_do "knowledge.add"` /
  `"knowledge.markSeen"` (prompt text at `terminal-launch.ts:285`,
  `contracts.ts:614,640-641`, router wiring `kiri-router.ts:277-278,351-356`).
  Users cannot see, edit, or delete a knowledge entry from the app.
- No delete or update op. Only `knowledge.add` and `knowledge.markSeen` exist
  in `kiriWriteOperations` (`contracts.ts:640-641`) and `db/knowledge.ts` has
  exactly three exported functions: `searchKnowledgeEntries`,
  `addKnowledgeEntry`, `markKnowledgeEntrySeen`. Bad/stale entries accumulate
  forever with no curation path.
- `db/knowledge.ts:149-160` `scoreEntry` is pure keyword substring scoring
  (`normalizeSearchText` + `includes(term)`), filtered to `score > 0`
  (`:47`). No embedding/vector column anywhere in the schema. A
  differently-phrased query scores 0 and returns nothing.
- No automatic ingestion path — the only writer is the explicit
  `knowledge.add` MCP call the terminal prompt asks the model to make
  (`terminal-launch.ts:285`); in practice this means the index stays empty
  unless a model remembers to call it.

### Todos (weakest area vs. the terminal prompt's promise)

- `provider-runtime.ts:89-92` — `claude: {}` and `opencode: {}` are empty
  adapter objects (confirmed exact). Claude only ever runs in terminal mode as
  a raw subprocess (`terminal-launch.ts:180-224` `claudeLaunch`); there is no
  hook, parser, or MCP wrapping of `TodoWrite` calls today.
  `claudeKiriTerminalPrompt` (`terminal-launch.ts:279-288`) line `:283` reads
  "Kiri projects TodoWrite into its Tasks view where supported" — this is
  **false** for claude; NOT IMPLEMENTED.
  `agent_tasks.source` CHECK constraint already includes `'claude'`
  (`db/migrations.ts:75`, derived from `runtimeCheckValues` = all of
  `runtimeKinds` = `['codex','pi','claude','opencode']`, `contracts.ts:10-12`),
  and `agentTaskSchema.source` is `runtimeKindSchema` (`contracts.ts:129-136`)
  — so `'claude'` is already a legal, validated source. **No DB/contract
  change needed for G3-1** — only a new write path.
  `replaceAgentTasksForThread` (`db/timeline-writes.ts:577-607`) is the
  existing DELETE-then-INSERT-OR-REPLACE primitive already used by pi
  (`session-operations.ts:239-244`, `db/agent-detail.ts` — actually
  `db/timeline-writes.ts:268-273` `recordPiProjectionMessages`) and by codex
  (`runtime-projection.ts:60-67` dispatches the `'tasksUpdated'` event to
  `replaceAgentTasks`/`replaceAgentTasksForThread`). This is the correct target
  for a new claude write path.
- Only automatic todo path today is codex GUI-mode: `codex-runtime.ts:572-594`
  handles `message.method === 'turn/plan/updated'`, maps `decoded.plan` to
  `AgentTask[]` with `source: 'codex'`, and yields a `{ type: 'tasksUpdated' }`
  runtime-projection event; `runtime-projection.ts:60-67` calls
  `replaceAgentTasks({ agentId, source: event.source, tasks: event.tasks,
  updatedAt: event.updatedAt })`. Terminal-mode codex (`codexLaunch`,
  `terminal-launch.ts:302-338`) has only a `SessionStart` hook
  (`codexSessionStartHookArgs`, `:340-349`) — no plan/task sync at all in
  terminal mode.
- Pi parses its own JSONL for tasks at hydration time
  (`pi-jsonl.ts` — `taskState` map built from `TodoWrite`-shaped tool calls,
  confirmed lines 43-259, `normalizeTaskStatus` at `:302`) and persists via
  `replaceAgentTasksForThread` in `session-operations.ts:239-244` /
  `db/timeline-writes.ts:268-273`.
- `agent-detail.ts:165-193` `readAgentTasks` is strictly per-agent: `WHERE
  t.active = 1 AND t.agent_id = ?` (`:178`). `TaskProgressStrip`
  (`task-progress.tsx:5-51`) renders exactly this per-agent list, no
  cross-session aggregation. `read-model-indexer.ts:188-250`
  `collectAgentTimelineCandidates` aggregates only a `taskCount` number per
  agent (`:213,233,245`) — no consumer reads `read_model_entries` anywhere
  (confirmed: no `listReadModelEntries` caller outside its own module and
  tests). No `task.list` read op exists in `kiriReadOperations`
  (`contracts.ts:606-620`) or in `dispatchReadOperation`
  (`kiri-router.ts:260-296`).
- OpenCode gets zero Kiri MCP wiring: `opencodeLaunch`
  (`terminal-launch.ts:433-451`) builds `args = [config.cwd]` plus
  `--model`/`--session` — no `--mcp-config`, no call to
  `buildKiriMcpConfigJson`/`buildKiriMcpServerConfig` (`:227-244`) at all.
  `provider-runtime.ts:91-92` confirms the adapter is empty.
- No todo-state-driven "triggering" exists — no code path reads a task status
  change and fires a notification, spawns a follow-up, or wakes another agent.
  The only event that would carry this signal is `'tasksUpdated'`
  (`runtime-projection.ts:60-67`) and nothing subscribes to it beyond the DB
  write.

### Titles

- `db/sessions.ts:116` `insertSessionRow`: `const title = input.title?.trim()
  || \`Session ${nextPosition.position + 1}\`` — confirmed exact. No code path
  ever revisits this title after creation except an explicit
  `session.rename` call (`kiri-control.ts:400-404` `renameSessionEffect` →
  `db.ts:376-379` `renameSessionSummary` → `db/sessions.ts:213-224`
  `renameSessionRow`).
- The only *content-derived* title anywhere is `sessionTitle()`
  (`session-operations.ts:343-347`), used once at pi-session-file hydration
  time (`session-operations.ts:225` `createPersistedSessionAgent` call site)
  to title a persisted-but-untracked pi session from its `projection.preview`
  — it is never invoked for codex/claude/opencode sessions, and never
  re-invoked after the first hydration.
  ```ts
  function sessionTitle(preview: string | undefined, fallback: string) {
    const title = preview?.replace(/\s+/g, ' ').trim()
    if (!title) return fallback
    return title.length > 44 ? `${title.slice(0, 41)}...` : title
  }
  ```
- There is no MCP operation literally named `threads.preview`; the usable
  "what's running" proxy is the `preview` field already present on every
  session summary row (`SessionSummary.preview`, `kiri-control.ts:104`,
  populated from `threads.preview`/`t.preview` in `db/sessions.ts:37-65` SQL,
  and returned by `session.list`/`agent.detail`). This is the cheapest signal
  to synthesize an auto-title from, alongside `AgentTask` `inProgress` titles
  (`agentTaskSchema.status`, `contracts.ts:125-136`).
- No column distinguishes a user-set title from a default/auto one.
  `agent_slots` schema (`db/migrations.ts:18-33`) has `title TEXT NOT NULL`
  and nothing else title-related — no `title_set_manually` flag exists today.
  This blocks any safe auto-retitle: without it, an auto-titler cannot tell
  "still `Session 3`" apart from "user renamed it to something that happens to
  look plain."
- The rename nudge ("call `session.rename` when the title is stale") only
  exists in the claude (`terminal-launch.ts:284`) and codex
  (`terminal-launch.ts:371`) terminal system prompts. Pi (GUI mode, no
  terminal launch prompt) and opencode (`opencodeLaunch`,
  `terminal-launch.ts:433-451`, no prompt injection at all) get nothing —
  best-effort even where present, no verification that the model complies.
- Fork titles are mechanically suffixed: `createForkedSessionRow`
  (`session-operations.ts:62-159`) line `:132`:
  `` `${source.title} fork` `` — a session forked twice compounds to "X fork
  fork".

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Server tests | `pnpm exec vitest run tests/server/` | all pass |
| Board tests | `pnpm exec vitest run tests/kiri-board/` | all pass |
| Unit tests | `pnpm test:unit` | all pass |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope**:
- `src/server/db/migrations.ts` — new `title_set_manually` column on
  `agent_slots` (G5-2); optional `source_scratchpad_id` on `agent_slots` or a
  small history table for scratchpad trigger provenance (G1-2/G1-3, P3, may be
  deferred).
- `src/server/db/sessions.ts`, `db/session-operations.ts` — title read/write
  helpers, `sessionTitle()` reuse, fork-title de-duplication (G5-4).
- `src/server/scratchpad-trigger.ts`, `db/scratchpad.ts` — provenance/failure
  cleanup (G1-2/G1-3/G1-4).
- `src/components/kiri-board/scratchpad.tsx` — pass a derived title on trigger
  (G1-1).
- `src/server/db/knowledge.ts`, `db/timeline-writes.ts`,
  `db/agent-detail.ts` — new delete/update knowledge ops (G2-2), new
  `task.list` cross-session read (G3-4), and any read-model/query refinements
  needed to consume Claude task rows once plan 014's hook writer exists.
- `src/lib/contracts.ts` — new read/write operation names, `KnowledgeEntry`
  update input, `task.list` input/output, `title_set_manually`-aware rename
  semantics if surfaced to clients.
- `src/server/kiri-router.ts`, `kiri-control.ts` — wire new ops.
- New `src/components/kiri-board/knowledge-panel.tsx` (or similarly named,
  mirroring `scratchpad.tsx`) + wiring into the sidebar tabs (G2-1).
- `src/server/terminal-launch.ts` — `opencodeLaunch` MCP wiring (G3-3),
  rename-nudge prompt text for pi/opencode where a terminal prompt exists
  (G5-3, best-effort only — no hook infra changes here, that's plan 014).
- `tests/server/`, `tests/kiri-board/` — regression tests for each change.

**Out of scope** (do NOT touch):
- Claude hook handler, `kirictl claude-hook` subcommands, `agent.status.set` /
  `agent.tasks.replace` write operations, and actual hook registration/
  CLI-flag injection for Claude PostToolUse/Stop/SessionEnd — **plan 014**.
  This plan consumes those stable task/status signals and must not duplicate
  hook parsing or hook DB writers. Codex resume re-bind and PATH-shim wrappers
  are also plan 014.
- Embeddings/vector search infra choice (sqlite-vec vs. in-proc) — G2-3 is
  scoped to "design + keyword fallback stays authoritative"; do not commit to
  a vector library without a separate decision. Treat as optional/stretch.
- Automatic knowledge ingestion (G2-4) — optional/stretch, needs its own
  design for what counts as "worth remembering."
- TODO-state-driven triggering (G3-5) — optional/stretch, larger scope
  (notify/spawn/wake semantics), flag as follow-up if time-boxed out.
- Terminal PTY lifecycle, codex thread mapping, session state machine,
  browser resources, workspace hygiene — plans 012/013/015/016/018.

## Git workflow

- Branch: `advisor/017-todos-titles-scratchpad-knowledge`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.
- Because this plan spans four independent pillars, prefer one commit per
  numbered step (or per tight group of steps within a pillar) rather than one
  giant commit — this keeps `git bisect` and partial-revert useful if one
  pillar needs to be pulled back.

## Steps

Sub-features that can ship independently are marked **[independent]**. Within
a pillar, steps are ordered; across pillars, order doesn't matter.

### Titles

1. **[independent, P2/S, gates step 2] G5-2: add `title_set_manually` flag.**
   Add `title_set_manually INTEGER NOT NULL DEFAULT 0` to `agent_slots` via a
   migration step in `db/migrations.ts` (follow the existing `ALTER TABLE
   agent_slots ADD COLUMN` pattern at `:283-311`, guarded by a
   `PRAGMA table_info(agent_slots)` existence check like `:283-286`). Set it
   to `1` inside `renameSessionRow` (`db/sessions.ts:213-224`) whenever a
   caller explicitly renames (this is the only write path today — `db/sessions.ts:224`
   `UPDATE agent_slots SET title = ?` becomes `SET title = ?, title_set_manually = 1`).
   Leave `insertSessionRow` (`:106-149`) and `createForkedSessionRow`
   (`session-operations.ts:118-138`) writing `0` (or `1` only when the caller
   supplied an explicit non-empty `title`, e.g. scratchpad-trigger's derived
   title from step 4 should NOT set this flag — it's still an auto-title).
   **Verify**: `pnpm typecheck`; `pnpm exec vitest run tests/server/db-sessions.test.ts` → pass;
   add a test asserting `renameSessionRow` sets the flag and `insertSessionRow`
   does not.

2. **[independent, P1/M] G5-1: auto title derivation/refresh.**
   Add a small helper (e.g. `deriveSessionTitleFrom(preview: string, tasks:
   AgentTask[], fallback: string)`) reusing the truncation logic already in
   `sessionTitle()` (`session-operations.ts:343-347`) — prefer an
   `inProgress`-status task title (`agentTaskSchema`, `contracts.ts:125-136`)
   over the thread preview when one exists, since a todo title is usually more
   specific than a chat preview. Call this from the write path that records
   the first assistant turn for a thread: `recordRuntimeMessageRow`
   (`db/timeline-writes.ts:67-105`) and/or `recordPiLiveMessages`
   (`:283-356`) — guard with: (a) `agent_slots.title_set_manually = 0`
   (from step 1), (b) this is the thread's first assistant-role message (or
   title still equals the `Session N` default — belt-and-suspenders is fine
   since the flag is authoritative), then call `renameSessionRow` internally
   (NOT through the public rename op, to avoid setting
   `title_set_manually`). Do this as a plain synchronous DB call inside the
   existing transaction, not a new event type, to keep it inside
   `withTransaction` alongside the message insert.
   **Verify**: `pnpm typecheck`; new test in
   `tests/server/db-session-operations.test.ts` (or a new
   `tests/server/auto-title.test.ts`) asserting: a fresh `Session N` session
   auto-retitles on first assistant message using the preview/task title, and
   a manually-renamed session (flag set) does NOT get overwritten by a
   subsequent assistant message.

3. **[independent, P2/S] G5-3: extend the rename nudge to pi/opencode.**
   Pi runs GUI mode with no terminal launch prompt — skip it (there is no
   prompt injection point; G5-1's deterministic auto-title covers pi
   adequately). For opencode, once G3-3 (below) adds MCP wiring via
   `opencodeLaunch` (`terminal-launch.ts:433-451`), add a system-prompt
   equivalent if opencode supports prompt injection (check opencode CLI docs
   for an append-system-prompt-equivalent flag before implementing; if none
   exists, document the gap and rely on G5-1 alone for opencode).
   **Verify**: `pnpm typecheck`; manual check that the opencode launch args
   include the new prompt/MCP flags if opencode supports it, otherwise a
   one-line note in this plan's STOP/maintenance section.

4. **[independent, P3/S] G5-4: stop fork-title compounding.**
   In `createForkedSessionRow` (`session-operations.ts:132`), change
   `` `${source.title} fork` `` to strip a trailing `" fork"` (or `" fork
   (N)"`) before appending, e.g. `` `${source.title.replace(/ fork(\s+\(\d+\))?$/, '')} fork` ``,
   or switch to a numbered suffix `${base} fork (2)` when forking an already-forked
   session. Pick the numbered-suffix form if multiple forks of the same
   session are expected to coexist (check `nextPosition` query at `:103-105`
   for a per-project count you could reuse).
   **Verify**: `pnpm typecheck`; new test in `tests/server/db-session-operations.test.ts`
   asserting forking a fork does not produce `"X fork fork"`.

### Todos

5. **[blocked on 014, P1/S] G3-1: consume Claude TodoWrite tasks.**
   Plan 014 owns the Claude `PostToolUse`/`TodoWrite` hook writer:
   `src/server/claude-hook-handler.ts`, `kirictl claude-hook`, the
   `agent.tasks.replace` operation, and the payload-shape verification
   against a real Claude Code hook. Do **not** recreate that writer here.
   After 014 lands, verify this plan's cross-session task surfaces consume
   `agent_tasks` rows with `source='claude'` exactly like existing Pi/Codex
   tasks: `task.list`, `agent.detail`, timeline/task UI, and status filters
   must not assume only `pi`/`codex` sources. If consumption needs no code
   beyond the generic task query added in Step 6, record this as satisfied by
   014 plus Step 6 rather than adding another hook layer.
   **Verify**: `pnpm typecheck`; task-list/agent-detail tests seeded with
   `agent_tasks.source='claude'` assert the rows render/list without special
   casing. Reuse plan 014's `claude-hook-handler` tests as the writer proof.

6. **[independent, P2/M] G3-2: terminal-mode codex task sync.**
   Terminal-mode codex (`codexLaunch`, `terminal-launch.ts:302-338`) has no
   plan/task signal at all — only GUI-mode app-server codex gets
   `turn/plan/updated` (`codex-runtime.ts:572-594`). Check whether the codex
   CLI exposes a plan/task hook comparable to `SessionStart` (look at what
   hooks `codex --help`/`codex exec --help` documents, same discovery
   `codexHooksSupported` already does at `terminal-launch.ts:392-408`). If a
   hook exists, add a `kirictl codex-hook plan-updated`-style handler
   parallel to step 5. If not, fall back to parsing the codex session JSONL
   the same way pi does (`pi-jsonl.ts`) — locate the codex terminal session
   file path via `codex-terminal-session.ts` (already used for resume
   binding) and adapt the JSONL-scan pattern. Flag as needing empirical
   verification of what codex terminal mode actually emits before committing
   to either approach.
   **Verify**: `pnpm typecheck`; test asserting whichever path is chosen
   produces `agent_tasks` rows with `source = 'codex'` for a terminal-mode
   session.

7. **[independent, P2/M] G3-3: OpenCode MCP wiring.**
   `opencodeLaunch` (`terminal-launch.ts:433-451`) currently passes no
   `--mcp-config`. Check opencode's CLI docs for its MCP config flag/format
   (may differ from claude's `--mcp-config <json>`; opencode may use a config
   file instead). If supported, call `buildKiriMcpConfigJson(context)`
   (`:227-235`, already provider-agnostic) and pass it through however
   opencode expects. This unlocks `kiri_do "session.rename"` and (pending
   opencode exposing its own todo-equivalent tool) a future task-sync hook —
   scope this step to the MCP wiring only, do not invent an opencode-specific
   todo hook without confirming opencode has a TodoWrite-equivalent tool.
   **Verify**: `pnpm typecheck`; test/manual check that `opencodeLaunch`
   output includes the MCP config when opencode supports it.

8. **[independent, P2/M] G3-4: cross-session task.list read op.**
   Add `task.list` to `kiriReadOperations` (`contracts.ts:606-620`) with input
   `{ projectId?: string; includeArchived?: boolean }` (optional workspace-wide
   strip toggle). Add a DB function in `db/agent-detail.ts` (near
   `readAgentTasks`, `:165-193`) — e.g. `listActiveThreadTasks` — that unions
   `agent_tasks` across all `active = 1` threads (optionally filtered by
   `agent_slots.project_id`), returning `{ agentId, agentTitle, projectId,
   tasks: AgentTask[] }[]`. Wire `dispatchReadOperation`
   (`kiri-router.ts:260-296`) and `kiri-control.ts` (new `listTasks` effect
   alongside `agentDetailEffect`, `:384-388`) the same way `agent.events.list`
   is wired. Consider whether this should also live in
   `read-model-indexer.ts`'s existing `collectAgentTimelineCandidates`
   (`:188-251`, already computes `taskCount` per agent, `:213`) — reusing that
   candidate set (which already excludes archived via the `threads.active = 1`
   join) may be cheaper than a fresh query; evaluate at implementation time,
   don't duplicate the join logic if avoidable.
   **Verify**: `pnpm typecheck`; new test asserting `task.list` returns tasks
   from multiple active agents in one project and excludes archived-session
   tasks.

9. **[optional/larger, P2-P3/L, do only if time permits] G3-5: todo-state-driven
   triggering.** No path today reads a task status transition and fires a
   notification/spawn/wake. If pursued: extend the `'tasksUpdated'` event
   (`runtime-projection.ts:60-67`, `RuntimeProjectionEvent`) with a diff
   against the previous task set (requires reading existing tasks before the
   `DELETE` in `replaceAgentTasksForThread`, `db/timeline-writes.ts:588`) and
   emit a new projection event (e.g. `taskStatusChanged`) only for tasks whose
   `status` actually changed. Consumers (notification, follow-up spawn) are
   out of scope for this step — just get the diffed event flowing and log it;
   wiring an actual consumer is future work. Mark this step's completion as
   "event wired, no consumer" if time-boxed.
   **Verify**: `pnpm typecheck`; test asserting `replaceAgentTasksForThread`
   (or a wrapping caller) can report which task ids changed status between
   calls.

### Scratchpad

10. **[independent, P2/S] G1-1: derive triggered-session title from block body.**
    In `scratchpad.tsx` `handleTrigger` (`:164-188`), before calling
    `onTrigger(block, { runtime, interfaceMode })`, add a `title` to the
    overrides object derived from `block.body` — reuse the same truncation
    rule as `sessionTitle()` (`session-operations.ts:343-347`: strip/collapse
    whitespace, cap at 44 chars with `...`). Prefer doing the truncation
    client-side (cheap, and `board-scratchpad-actions.ts:89` already forwards
    `overrides?.title` through to the mutation) rather than adding new
    server-side derivation, since `scratchpad-trigger.ts`'s
    `TriggerScratchpadInput.title` (`:30`) and
    `triggerScratchpadSessionWithDeps` (`:157-219`) already plumb an
    explicit title straight to `startSessionAndGetId` with no fallback logic
    of their own. Do NOT set `title_set_manually` for this path — it's a
    derived title, not a user rename (matches step 1's guidance).
    **Verify**: `pnpm typecheck`; `pnpm exec vitest run
    tests/kiri-board/` (or wherever scratchpad component tests live —
    confirm path first); a triggered session's title should equal the
    truncated block body, not `Session N`.

11. **[P3/S] G1-2 + G1-3: trigger provenance + back-reference.**
    G1-2: `markScratchpadBlockTriggered` (`db/scratchpad.ts:65-81`) does a
    single-row UPDATE, losing history on re-trigger. If provenance history
    matters, add a `scratchpad_block_triggers` table (block_id, agent_id,
    triggered_at) written alongside (not instead of) the existing UPDATE, and
    a `listScratchpadBlockTriggers` read helper. G1-3: add
    `source_scratchpad_id TEXT` to `agent_slots` (nullable, no FK-cascade
    surprises needed since scratchpad blocks already `ON DELETE SET NULL` on
    their own `triggered_agent_id`, `db/migrations.ts:108`) set once at
    session creation in `insertSessionRow`
    (`db/sessions.ts:106-149`) when triggered from a scratchpad block, so a
    session can answer "what scratchpad block spawned me." Surface on
    `AgentCell`/`SessionSummary` if useful to the UI, otherwise keep it
    DB-only for now.
    **Verify**: `pnpm typecheck`; test asserting re-triggering a block twice
    preserves both trigger records (if history table added) and a
    triggered session's `source_scratchpad_id` matches the block.

12. **[P3/S] G1-4: failure cleanup hardening.**
    `scratchpad-trigger.ts:176-213` — the terminal-mode branch
    (`:187-197`) does not delete the session on
    `pasteAgentRuntimeTerminal` failure (only reports via
    `reportPromptFailure`), while the GUI-mode branch (`:198-213`) does
    attempt `deleteSessionSummary` in its catch. Decide on consistent
    behavior (most likely: also attempt cleanup in the terminal-mode failure
    path) and make the `markScratchpadBlockTriggered` / session-create /
    prompt-or-paste sequence best-effort-atomic: on any failure after marking
    triggered, always attempt session deletion so a scratchpad block never
    stays stuck showing "sent" against a phantom/dead session.
    **Verify**: `pnpm typecheck`; extend
    `tests/server/scratchpad-trigger-service.test.ts` /
    `scratchpad-trigger.test.ts` with a terminal-mode paste-failure case
    asserting the session is cleaned up and the block is not left
    incorrectly marked triggered (or is left marked but the UI can tell it
    failed — pick one and test it).

### Knowledge

13. **[independent, P1/M] G2-1: KnowledgePanel UI.**
    Add `src/components/kiri-board/knowledge-panel.tsx` mirroring
    `scratchpad.tsx`'s shape end-to-end: a header component (like
    `ScratchpadHeader`, `:64-79`), a panel component with a reducer for
    draft/pending/error/notice state (like `ScratchpadPanel`,
    `:81-104` + `scratchpadReducer`, `:36-62`), a capture form (title/problem/
    answer/tags instead of scratchpad's single `body`), and a list of entries
    grouped by project (reuse `groupBlocksByDay`-style grouping logic,
    adapted to project rather than day, or just group by project like
    scratchpad's project chips at `:229-266`). Wire equivalent
    `useBoardKnowledgeActions` hook mirroring
    `board-scratchpad-actions.ts:53-104` (capture → `knowledge.add`, delete →
    new op from step 14, list already available via
    `knowledgeSearchInputSchema`/`searchKnowledgeEntries` — note: search
    requires a non-empty `query`, `contracts.ts:585-589`, `min(1)`; a
    plain "list all for this project" may need a new op or a permissive
    empty-query allowance — check before deciding). Add the panel's sidebar
    tab entry next to wherever `ScratchpadPanel` is mounted (grep for
    `ScratchpadPanel` usage in the board component to find the sidebar tab
    switch).
    **Verify**: `pnpm typecheck`; `pnpm build`; new
    `tests/kiri-board/knowledge-panel.test.tsx` (mirror whatever test file
    covers `scratchpad.tsx`) asserting capture/list/delete render and call
    the right mutations.

14. **[independent, P2/S] G2-2: delete/update/list knowledge ops.**
    Add `deleteKnowledgeEntry(database, id)` and `updateKnowledgeEntry(database,
    input)` to `db/knowledge.ts` (mirror `requireKnowledgeEntry`,
    `:105-127`, and `markKnowledgeEntrySeen`'s update-then-refetch pattern,
    `:87-103`). Add a project-scoped "list all" (not search-filtered) helper
    if step 13 needs it. Add `knowledge.delete` and `knowledge.update` (and
    optionally `knowledge.list`) to `kiriWriteOperations`/`kiriReadOperations`
    (`contracts.ts:606-644`), corresponding input schemas near
    `knowledgeMarkSeenInputSchema` (`:601-604`), wire
    `dispatchWriteOperation`/`dispatchReadOperation`
    (`kiri-router.ts:260-296, 298-...`) and `kiri-control.ts` effects
    (mirror `markKnowledgeSeen`, `:667-...`).
    **Verify**: `pnpm typecheck`; extend `tests/server/db-knowledge.test.ts`
    with delete/update/list cases; confirm router/control wiring via an
    integration test calling the new operation names end-to-end.

15. **[optional/large, P2/L] G2-3: embeddings/RAG with keyword fallback.**
    Current `scoreEntry` (`db/knowledge.ts:149-160`) is pure substring
    keyword scoring; a differently-phrased query scores 0. If pursued: add an
    `embedding BLOB` (or separate `knowledge_embeddings` table) column,
    populate it on `addKnowledgeEntry`/`updateKnowledgeEntry` using an
    in-process embedding model or `sqlite-vec` if already a dependency
    (check `package.json`/`Cargo.toml` before adding a new dependency — this
    plan does not decide the embedding backend). Blend embedding similarity
    with the existing keyword score (don't replace it — keyword scoring is a
    fine tie-breaker/fallback when embeddings are unavailable or the
    dependency isn't present in a given build). Treat this as a stretch
    goal; do not block G2-1/G2-2 on it.
    **Verify**: `pnpm typecheck`; a differently-phrased query test finding an
    entry the current keyword scorer would miss, with a graceful fallback
    test when the embedding path is unavailable.

16. **[optional/large, P3/L] G2-4: automatic ingestion.**
    No automatic writer exists; the index only grows via explicit
    `knowledge.add`. If pursued, design what "worth remembering" means (e.g.
    codex/claude explicitly flags a learning, or a heuristic over
    completed-task summaries) before writing code — this is a product
    decision, not just plumbing. Out of scope to implement without that
    decision; flag as a follow-up plan if not resolved here.

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt doesn't match live code (drift) — especially
  `db/sessions.ts:106-149,213-224`, `provider-runtime.ts:89-92`,
  `terminal-launch.ts:279-288,340-349,433-451`, or the `agent_tasks`/
  `agent_slots` schema in `db/migrations.ts`.
- Claude Code's actual `PostToolUse` hook JSON payload shape (step 5) differs
  materially from a `TodoWrite`-tool-call-with-`todos`-array assumption —
  verify against real Claude Code hook documentation/output before writing
  the parser; do not guess the field names.
- Plan 014 has NOT yet wired the actual claude `--settings` hook registration
  when you reach step 5's integration testing — you can still land the
  handler + CLI subcommand + unit tests (feeding synthetic payloads), but
  cannot verify the live end-to-end path until 014 lands. Note this
  explicitly in the step's completion notes rather than fabricating an
  end-to-end pass.
- Any migration step in `db/migrations.ts` breaks an existing test that
  asserts current `agent_slots`/`knowledge_entries` column counts/shapes —
  fix forward with an additive `ALTER TABLE ADD COLUMN` guarded by
  `PRAGMA table_info`, never a destructive rebuild, unless explicitly
  instructed.
- Opencode's actual CLI does not support MCP config or system-prompt
  injection at all (step 3/7) — document the hard limitation in this plan's
  Current State rather than inventing a workaround; G5-1's deterministic
  auto-title still covers opencode's titles even without prompt injection.
- A knowledge "list all" query without a search term conflicts with
  `knowledgeSearchInputSchema`'s `query.min(1)` constraint (step 13) in a way
  that would require relaxing validation used elsewhere — add a distinct
  `knowledge.list` op instead of loosening `knowledge.search`'s contract.

## Maintenance notes

- Once plan 014 lands claude/codex hook registration, revisit this plan's
  step 5/6 handlers to confirm the actual hook payload shapes match what was
  implemented against synthetic fixtures, and delete any temporary
  synthetic-payload-only test scaffolding that's superseded by a real
  end-to-end test.
- `title_set_manually` (step 1) should be considered the long-term source of
  truth for "can the app auto-retitle this session" across all four future
  auto-title extensions (G5-1, G5-3, and any future runtime); do not
  reintroduce pattern-matching against `Session N` elsewhere.
