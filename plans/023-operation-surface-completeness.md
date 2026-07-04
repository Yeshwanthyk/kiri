# Plan 023: Operation surface completeness & discovery

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e464651..HEAD -- src/lib/contracts.ts src/server/kiri-router.ts src/server/kiri-control.ts src/server/workspace.ts src/server/db/sessions.ts .agents/skills/kiri-control/SKILL.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED
- **Depends on**: 021 (classification/option cleanup lands first so this
  plan doesn't build on a moving enum)
- **Category**: feature / API completeness
- **Planned at**: commit `e464651`, 2026-07-04
- **Status**: TODO

## Why this matters

A 2026-07-03 parity audit found every *declared* operation routed and
implemented, but the declared set is missing capabilities the UI has — and
agents orchestrating other agents hit exactly these walls:

1. **No way to stop an agent.** The UI can interrupt/stop a running turn
   (`src/server/workspace.ts:94`, `src/server/runtime.ts:217`), but the
   operation surface has nothing between "send another prompt" and
   "archive the session". An agent that `session.spawn`s a runaway worker
   cannot stop it (terminal sessions have `terminal.kill`; GUI sessions
   have nothing).
2. **Hard delete exists but is invisible.** `hardDeleteSession` landed in
   plan 015 (`src/server/db.ts:378`, `src/server/db/sessions.ts:238`) but
   only archive/restore are exposed (`src/lib/contracts.ts:681`).
3. **`operations.list` is not real discovery.** It returns names plus
   hand-written recipes (`src/server/kiri-router.ts:253-258`); params are
   `z.record(unknown)` at the MCP layer, so agents learn schemas by failing
   `VALIDATION` one field at a time.
4. **Docs drift** (`.agents/skills/kiri-control/SKILL.md`): omits
   `knowledge.list`, `agent.status.set`, `agent.tasks.replace`,
   `knowledge.update`, `knowledge.delete`; says `pnpm kiricli mcp` (actual:
   `kirictl mcp`, `src/cli/kirictl.ts:62`); documents `terminal.keys` →
   `queued===true` and `wait-for` → `snippet`, but actual returns are
   `{ok:true}` and `match`/`generation`/`elapsedMs`
   (`src/server/terminal-control.ts:224,257`).

Deliberately **not** in scope (parity findings assessed as not worth an
agent-facing op now): preferences/theme ops, project reorder/selection,
browser/resource controls, workspace snapshot/revision. Record in README's
rejected-findings section if they resurface.

## Steps

### 1. `agent.interrupt`

New write op: `{ agentId }` → stops the in-flight turn for GUI runtimes via
the same path the UI uses (`workspace.ts:94`); for terminal sessions,
return a typed error pointing at `terminal.keys` (`c-c`) / `terminal.kill`
rather than overloading one op with two semantics. Add contracts schema,
router case, control method, tests (interrupt a mocked in-flight turn;
interrupt an idle agent is a no-op `{interrupted:false}`).

### 2. `session.delete`

New write op wrapping `hardDeleteSession`, **archived-sessions-only** as a
guard (delete of a live session must first archive — mirrors the UI flow
and keeps the blast radius of plan 015's delete semantics). Include
`confirm: true` required param so an agent cannot fat-finger it. Tests:
delete archived (rows + session dir gone), refuse non-archived, refuse
without `confirm`.

### 3. Schema-backed `operations.list`

Emit per-operation param descriptors generated from the actual zod schemas
(zod v4 has native JSON-schema export — `z.toJSONSchema`; contracts import
`zod/v4` in `src/server/kiri-mcp.ts:3`, verify `src/lib/contracts.ts` uses
the same). Response shape: existing `read`/`write`/`recipes` plus
`schemas: { [operation]: jsonSchema }`. Keep the recipes — they encode
intent routing the schemas can't. Cache the generated schemas at module
level (generation is not free). Update the MCP tool descriptions to say
schemas are available via `operations.list`.

### 4. Fix the skill doc

Regenerate `.agents/skills/kiri-control/SKILL.md` op list and return-shape
examples from the live contracts (manually is fine, but add a test that
asserts every op in `kiriReadOperations`/`kiriWriteOperations` appears in
the skill doc so it can't silently drift again).

### 5. Verification

- `pnpm typecheck && pnpm lint`
- Focused: `pnpm vitest run tests/server/kiri-router.test.ts tests/server/kiri-mcp.test.ts tests/server/runtime-session-flows.test.ts` (adjust to actual files)
- Manual: `pnpm kiri:ctl call '{"operation":"operations.list"}' | jq '.result.schemas["session.spawn"]'` returns a JSON schema.

## STOP conditions

- If the UI interrupt path is not cleanly callable from `KiriControl`
  (e.g. it lives in renderer-side state), stop and report — `agent.interrupt`
  may need a backend refactor first, which is bigger than this plan.
- If `z.toJSONSchema` fails on any contract schema (custom refinements),
  stop and choose: skip those ops' schemas with a note, or hand-write
  descriptors — do not block the whole step.
- Hard-delete semantics were set by plan 015; if its guards differ from
  "archived-only" (re-read `src/server/db/sessions.ts:238` first), follow
  015's semantics and note the difference.
