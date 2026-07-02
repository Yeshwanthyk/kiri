# Plan 018: Workspace hygiene — project delete/hide/switch bugs (not a session-move feature)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1fa5160..HEAD -- src/server/runtime-cleanup.ts src/server/terminal-registry.ts src/server/terminal-server.ts src/server/terminal-control.ts src/server/db/workspace-snapshot.ts src/server/db/projects.ts src/server/workspace-service.ts src/server/kiri-control.ts src/components/kiri-board/board-project-actions.ts src/components/kiri-board/board-selection.ts src/components/kiri-board/use-project-resources.ts src/lib/ui-preferences.ts`
> If any in-scope file changed since this plan was written, re-read the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition (especially for the H7 step — it
> overlaps plan 015's D12 and may already be fixed).

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (independent P2 hygiene); coordinate with 012
  (A-KILL, idle-kill ownership), 015 (D12, delete-ordering — same function
  as this plan's Step 4), 016 (E1.1, browser destroy-on-switch)
- **Category**: bugfix
- **Planned at**: commit `1fa5160`, 2026-07-01

## Why this matters

The user-facing complaint that motivated this plan was "sessions/projects
respawn when I move between projects or switch away." That complaint has
**three different root causes**, only one of which belongs here:

1. Runtime PTYs get SIGKILLed 5 minutes after you switch away from a session
   (idle-kill fires once the last socket detaches). **Owned by plan 012,
   A-KILL.**
2. The browser `WebContentsView` is destroyed and recreated on every project
   switch (all nav/scroll/form state lost). **Owned by plan 016, E1.1.**
3. **"Move a session from project A to project B" does not exist as a
   feature at all.** There is no op anywhere in `db/`, `workspace-service.ts`,
   `kiri-control.ts`, or the MCP router that reassigns a session's
   `project_id`. See H0 below — it is scoped as a future appendix, not a
   required step, because building it is a schema-level decision (id re-mint
   across 6+ tables/keys), not a bugfix.

What *is* a bugfix-sized, real problem in this area is workspace hygiene
around project delete/hide/reorder/restart — a shell PTY leak on delete, a
purely-positional "selected project" that silently drifts when you reorder or
delete, hidden projects losing their terminal/browser tab layout, a
delete-then-cleanup ordering race, and a project-scoped (not session-scoped)
shell terminal MCP surface. Those are this plan's actual scope.

## Approach (decided)

- Fix H3, H4, H5 as real code changes (each is S–M effort, each has a
  concrete, narrow fix identified below).
- H7 shares one function (`deleteProjectAndCleanupRuntimes` in
  `runtime-cleanup.ts`) with plan 015's D12. Fix it **once**, here, since this
  plan already has to touch that file for H3; do not let 015 duplicate the
  diff. Cross-reference plan 015's README/status when done.
- H8 is a design decision, not an obvious bug (project-scoped shared shell
  may be intentional — one shell per project by design, mirroring the
  `${projectId}:shell` session key). Step 5 documents the decision in code
  and, only if the decision is "this is a bug," proposes the schema-affecting
  fix as a follow-up rather than doing it inline (it changes a persisted key
  format used by MCP shell targeting).
- H6 (restart never reattaches a live PTY in embedded mode) is fix-or-document
  by design: the real fix is L-effort (durable cross-restart reattach) and
  out of proportion for an M-effort plan. Step 6 documents the actual restart
  semantics inline (code comment + this plan's record) rather than
  implementing reattach. The `KIRI_TERMINAL_DAEMON=1` daemon path already
  survives restarts — Step 6 makes that trade-off explicit, it does not
  change it.
- H0 (real cross-project session move) is **not a step**. It's an appendix
  describing what it would take, so a future planner doesn't have to
  rediscover the id-immutability constraint.

## Current state

All line numbers verified against the live tree at commit `1fa5160`.

### H3 — project delete never closes its `${projectId}:shell` PTY

- `src/server/terminal-registry.ts:109-114` `sessionKey(config, mode, termId)`:
  for `mode === 'shell'` the key is `` `${config.projectId}:shell` `` (main
  terminal) or `` `${config.projectId}:shell:${termId}` `` (secondary shell
  tabs). Only non-shell modes key off `config.id` (`` `${config.id}:runtime` ``,
  line 110).
- `src/server/terminal-registry.ts:431-434` `closeAgentRuntime(agentId)` only
  ever looks up `` sessions.get(`${agentId}:runtime`) `` — it has no notion of
  the project-scoped shell key at all.
- `src/server/terminal-server.ts:64,186-189,205-207` expose exactly that one
  op (`closeAgentRuntime` / `closeAgentRuntimeTerminal`) on `TerminalServerApi`
  — there is no `closeProjectShell`-shaped op anywhere in the public surface.
- `src/server/runtime-cleanup.ts:37-45` `cleanupRuntimeSessions` iterates the
  **agent-id** sessions captured before delete and calls
  `dependencies.closeTerminal(session.id)` (→ `closeAgentRuntimeTerminal`,
  agent-keyed) for each. It never derives or closes the project's shell key.
- `src/server/runtime-cleanup.ts:91-99` `deleteProjectAndCleanupRuntimes`
  captures `listSessions(id)` (agent rows only, via
  `listSessionSummaries({projectId, includeArchived: true})`), deletes the
  project, then cleans up only those agent-keyed runtimes. The
  `${id}:shell` PTY (and any `${id}:shell:${termId}` secondary shells) is
  never targeted — it survives the project delete and runs until the 5-min
  idle-kill (plan 012 territory) or app quit.
- There is already a generic, key-based kill route:
  `src/server/terminal-control.ts:261-266` `POST /api/sessions/kill` takes
  `{ key }` and calls `registry.kill(session)` — this works against whichever
  server owns the session (embedded or kiriterm daemon), since
  `terminalControlRequest` (`terminal-server.ts:610`) posts over HTTP to
  whichever is `ensure()`d. `kiri-control.ts:635` already reuses this route
  for the MCP `terminal.kill` op. There is no equivalent **prefix**-kill route
  (needed to also catch numbered secondary shell tabs whose exact `termId` the
  server doesn't track anywhere durable).

### H4 — selected project/session resolves positionally, drifts on reorder/delete/hide

- `src/server/db/workspace-snapshot.ts:167-170`:
  ```ts
  const snapshotProjects = snapshotProjectRows.filter((project) => !project.hiddenAt)
  const hiddenProjects = snapshotProjectRows.filter((project) => project.hiddenAt)
  const selectedProject = snapshotProjects[0]
  const selectedAgent = selectedProject?.agents[0]
  ```
  `selected` is always position-0 of the currently-visible project list —
  there is no persisted "last selected" concept server-side at all.
- `src/components/kiri-board/board-project-actions.ts:56-63`
  (`handleDeleteProject`) and `:79-91` (`handleHideProject`) both call
  `activateProject(next.selected.projectId)` /
  `activateProjectIfCurrent(projectId, next.selected.projectId)` — i.e. they
  trust the server's positional `selected.projectId` as "the project to
  switch to after this mutation," which is only ever position-0.
- `src/server/kiri-control.ts:794-802` `contextFromSnapshot` and `:837-846`
  `resolveProjectId` both derive "the current project" the same way
  (`snapshot.projects.find(id === selected.projectId) ?? snapshot.projects[0]`)
  — used as the default target for MCP ops like `knowledge.search`/`add` with
  no explicit `projectId`. A pure client-side reorder (drag-to-reorder,
  `reorderVisibleProjectRows` in `db/projects.ts:120-155`) changes
  `position` server-side and silently retargets what "the current project"
  means for both the board's post-mutation activation and MCP's implicit
  default.
- The client already has a working precedent for *session*-level persisted
  selection: `src/components/kiri-board/board-selection.ts:57-62`
  (`selectAgent`) persists `agentByProject[projectId] = agentId` via
  `saveAgentByProject` → `persistAgentByProject` (server-side
  `UiPreferences.agentByProject`, `src/lib/ui-preferences.ts:187,193`, wired
  through `setAgentByProjectPreference` in
  `src/server/workspace-service.ts:113-115,185-187,228,309-314`
  `persistSelectedSession`). There is no equivalent preference for the
  **project** dimension.

### H5 — hiding a project drops its resource-tab (terminal/browser) layout

- `src/components/kiri-board/use-project-resources.ts:57-66`:
  ```ts
  const reconciled = React.useMemo(() => {
    const projects: Record<string, ReturnType<typeof reconcileProjectResources>> = {}
    for (const project of workspace.projects) {
      projects[project.id] = reconcileProjectResources({
        project,
        layout: storedLayout.projects[project.id],
      })
    }
    return projects
  }, [storedLayout.projects, workspace.projects])
  ```
  only iterates `workspace.projects`, which is the server's already-filtered
  **visible-only** list (`workspace-snapshot.ts:167`, `!project.hiddenAt`).
  Hidden projects never get reconciled.
- `use-project-resources.ts:68-96` (`layout` memo) then rebuilds the entire
  persisted `projects` map **from `reconciled` alone**
  (`Object.entries(reconciled).map(...)`, lines 81-86) — any project id that
  was in `storedLayout.projects` but isn't in `reconciled` (i.e. every hidden
  project) is silently dropped from the new `layout` value.
- `use-project-resources.ts:97-100` then persists that pruned `layout` to
  localStorage on every render where it changes
  (`saveStoredResourceLayout(layout)`), permanently overwriting the hidden
  project's stored tab layout with nothing. Unhiding later reconciles against
  `layout: undefined` → empty tabs, contradicting the intended "hide keeps
  everything, just off-screen" semantics.
- The fix is data already available: `WorkspaceSnapshot.hiddenProjects` is the
  same `projectRowSchema` shape as `.projects` (`src/lib/contracts.ts:290-294`
  `hiddenProjects: z.array(projectRowSchema)`), full `agents` included. The
  reconciliation source just needs to include both arrays so hidden projects
  keep getting reconciled (and thus keep their stored layout) instead of only
  the visible ones; a project's entry should be pruned only when it's absent
  from *both* `workspace.projects` and `workspace.hiddenProjects` (i.e.
  actually deleted).

### H7 — delete-order race (coordinate with plan 015 D12)

- `src/server/runtime-cleanup.ts:91-99`:
  ```ts
  function deleteProjectAndCleanupRuntimes<Result>(id, dependencies) {
    const sessions = dependencies.listSessions(id)
    const result = dependencies.deleteProject(id)      // DB delete happens...
    cleanupRuntimeSessions(sessions, dependencies)      // ...before runtime cleanup
    return result
  }
  ```
  and `cleanupRuntimeSessions` (`:37-45`) calls `dependencies.forgetRuntime`
  per session with **no try/catch** — a throwing `forgetRuntime` (which
  `provider-runtime.ts`'s `forgetProviderRuntimeAgent` can do; it re-throws,
  per the plan-015 research note) aborts the loop, leaving any remaining
  sessions' runtime/terminal state orphaned after the DB row is already gone.
  There is also a window between the DB delete and the runtime cleanup where
  a concurrent snapshot read or MCP call can observe "project gone, PTY
  still alive."
- This is the exact same function plan 015 tracks as D12. Fix it once, here
  (this plan already touches `runtime-cleanup.ts` for H3), and note in
  `plans/README.md` that 015's D12 is satisfied by this plan's Step 4 so it
  isn't re-implemented.

### H8 — shell terminal MCP ops are project-scoped, not session-scoped

- `src/server/kiri-control.ts:494-497`:
  ```ts
  const terminalSessionKey = (target: TerminalTarget) =>
    target.mode === 'runtime'
      ? `${target.agentId}:runtime`
      : `${dependencies.getAgentLaunchConfig(target.agentId).projectId}:shell`
  ```
  Every `terminal.read` / `terminal.keys` / `terminal.waitFor` / `terminal.kill`
  MCP call for `mode: 'shell'` resolves to the **project's** shared shell key
  regardless of which session's `agentId` was passed in. Any session in a
  project can read, type into, or kill any other session's shared shell.
  This mirrors the intentional "one shell per project" design
  (`ensureBrowserResource`/shell-tab semantics elsewhere), so it may be
  working as designed — but it is undocumented as a deliberate choice and
  worth flagging explicitly rather than leaving implicit.

### H6 — restart never reattaches a live PTY/provider process (embedded mode)

- `src/server/terminal-server.ts:140-180` `makeTerminalServerFacade` /
  `choose()`: the kiriterm daemon path (session survival across
  backend/UI restarts) is opt-in via `process.env.KIRI_TERMINAL_DAEMON === '1'`
  (line 160); the default is the embedded, in-process `TerminalRegistry`
  (`embeddedService()`, line 151-154), whose `sessions` map
  (`terminal-registry.ts:98`) and the `provider-runtime.ts` runtime registry
  are both plain in-memory state that starts empty on every process restart.
- `src/server/db.ts:187-195` (`getWorkspaceSnapshot`) and `:224-230`
  (`getAgentDetail`) only rehydrate **DB-persisted history** via
  `hydratePersistedPiSessions` — they never touch `terminal-registry` or
  `provider-runtime` state, because on a cold process there is nothing there
  to touch.
- Net effect (default/embedded mode): reopening a runtime session after a
  restart cold-spawns a fresh provider process (resume-by-id where the
  provider supports it, otherwise a new thread) — any turn that was in
  flight at restart is lost. This is true by construction, not a
  regression; Step 6 documents it rather than building genuine reattach.

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
- `src/server/runtime-cleanup.ts` — H3 (close project shell PTYs on delete),
  H7 (delete-order + catch-and-continue).
- `src/server/terminal-registry.ts` / `terminal-server.ts` /
  `terminal-control.ts` — only the minimal surface needed for H3 (a
  project-shell-close op or prefix-kill route); no other registry behavior
  changes.
- `src/server/db/workspace-snapshot.ts`, `src/lib/ui-preferences.ts`,
  `src/server/workspace-service.ts` — H4 (persisted last-selected project
  preference).
- `src/components/kiri-board/board-project-actions.ts`,
  `board-selection.ts` — H4 (client wiring for the new preference).
- `src/components/kiri-board/use-project-resources.ts` — H5 (reconcile
  against visible + hidden projects).
- `src/server/kiri-control.ts` — H8 (document the design decision; code
  comment only unless the decision is "fix it," in which case scope the fix
  as a follow-up, not inline here).
- `tests/server/`, `tests/kiri-board/` — regression tests for H3/H4/H5/H7.

**Out of scope** (do NOT touch):
- Real cross-project session move (H0) — appendix only, no code.
- Runtime idle-kill defaults / liveness-vs-socket-count — plan 012's A-KILL.
- Browser view destroy-on-switch/dialog-open — plan 016's E1.1/E1.2.
- Codex/Claude thread-mapping, hooks, resume semantics — plans 013/014.
- `deleteSessionAndCleanupRuntime` (session-level delete, not project-level) —
  unaffected by H7's fix; do not refactor it as part of this plan.
- Building genuine cross-restart PTY/provider reattach (H6's real fix) —
  document only.

## Git workflow

- Branch: `advisor/018-workspace-project-switch-move`
- Commit style: short imperative subject, no prefix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (H3): Close the project's shell PTY(s) on project delete

Add a way to kill every session keyed under a project's shell prefix
(`${id}:shell` and `${id}:shell:${termId}`), then call it from
`deleteProjectAndCleanupRuntimes`.

1. In `terminal-control.ts`, add a prefix-kill route alongside the existing
   single-key one (`:261-266`):
   ```ts
   if (route === 'POST /api/sessions/kill-prefix') {
     const input = sessionKeyPrefixSchema.parse(body) // { prefix: string }
     const matches = Array.from(registry.sessions.values())
       .filter((session) => session.key === input.prefix || session.key.startsWith(`${input.prefix}:`))
     for (const session of matches) registry.kill(session)
     return { status: 200, body: { ok: true, killed: matches.length } }
   }
   ```
   This kills both the bare `${id}:shell` main terminal and any
   `${id}:shell:${termId}` secondary tabs in one call, without needing to
   track live `termId`s anywhere durable. Reuses `registry.sessions` (already
   exposed, `terminal-registry.ts:444`) and `registry.kill`
   (`terminal-registry.ts:231-241`, already idempotent/exit-safe).
2. Export a thin wrapper in `terminal-server.ts` next to
   `closeAgentRuntimeTerminal` (`:205-207`):
   ```ts
   export function closeProjectShellTerminals(projectId: string) {
     void terminalControlRequest('sessions/kill-prefix', { prefix: `${projectId}:shell` }).catch(() => {})
   }
   ```
   This goes through the same `terminalControlRequest` facade
   (`terminal-server.ts:610`) that already routes to whichever server is
   `ensure()`d (embedded or kiriterm daemon) — do not bypass it.
3. In `runtime-cleanup.ts`, extend `ProjectRuntimeCleanupDependencies` with a
   `closeProjectShell: (projectId: string) => void` and wire it into
   `liveCleanupDependencies`'s call sites (`deleteProjectWithRuntimeCleanup`,
   `deleteProjectSummaryWithRuntimeCleanup`, both around `:47-67`), then call
   it once in `deleteProjectAndCleanupRuntimes` after the existing
   `cleanupRuntimeSessions(sessions, dependencies)` call (`:91-99`).
4. Do NOT add a shell-close call to `deleteSessionAndCleanupRuntime`
   (`:101-111`, session-level delete) — a session-level delete must not kill
   the project's shared shell out from under sibling sessions still open in
   the same project.

**Verify**: `pnpm typecheck` → 0. Write a `tests/server/` test asserting that
after `deleteProjectWithRuntimeCleanup`/`deleteProjectAndCleanupRuntimes`
runs, a fake registry's session keyed `${id}:shell` (and one keyed
`${id}:shell:2`) are both killed alongside the agent-keyed runtime sessions.
`pnpm exec vitest run tests/server/` → pass.

### Step 2 (H4): Persist an explicit "last selected project" instead of position-0

1. Add `lastSelectedProjectId: z.string().nullable().default(null)` to
   `uiPreferencesSchema` in `src/lib/ui-preferences.ts` (`:189-194`), mirroring
   the existing `agentByProject` field shape/pattern.
2. Add `setLastSelectedProjectPreference` to `UiPreferencesApi` (wherever
   `setAgentByProject` is defined in the preferences service) and thread it
   through `WorkspaceServiceApi`/`WorkspaceServiceDependencies` in
   `workspace-service.ts` exactly like `setAgentByProjectPreference`
   (`:113-115`, `:185-187`, `:228`).
3. In `workspace-snapshot.ts`, change `readWorkspaceSnapshot`'s input to also
   accept the preference and use it before falling back to position-0
   (`:169-170`):
   ```ts
   const selectedProject =
     snapshotProjects.find((project) => project.id === input.preferences.lastSelectedProjectId) ??
     snapshotProjects[0]
   const selectedAgent = selectedProject?.agents[0]
   ```
   (Session-level selection within a project is already handled by
   `agentByProject`/`board-selection.ts` — this step only fixes the
   project dimension.)
4. In `board-selection.ts`'s `selectProject`/`activateProject`/
   `activateProjectIfCurrent` (`:64-82`), persist the new preference the same
   way `selectAgent` persists `agentByProject` (`:57-62`) — call the new
   `persistLastSelectedProject` mutation whenever the active project
   actually changes.
5. In `board-project-actions.ts`, `handleDeleteProject` (`:56-63`) and
   `handleHideProject` (`:79-91`) keep calling `activateProject`/
   `activateProjectIfCurrent(projectId, next.selected.projectId)` — no change
   needed there, since `next.selected.projectId` now reflects the persisted
   preference (falling back to position-0 only when the preference points at
   a project that no longer exists/is hidden, which is the correct fallback).
6. In `kiri-control.ts`, `contextFromSnapshot` (`:794-802`) and
   `resolveProjectId` (`:837-846`) need no changes — they already read
   `snapshot.selected.projectId`, which now carries the persisted value.
7. **Reconcile with the client's own persisted selection.** The renderer
   already restores an active project from localStorage:
   `use-project-resources.ts:68-80` computes `layout.activeProjectId` from
   the stored resource layout, and `KiriBoard.tsx:162-173` has an effect
   that calls `selectProject(storedProjectId)` once hydrated. With the
   server preference added, these are two competing sources of truth and
   will flicker/override each other after hydration. Pick one owner —
   recommended: the server preference wins; on first load after this change,
   migrate the localStorage value into the preference (write-through from
   `selectProject`), and make the `KiriBoard.tsx:162-173` restore effect a
   fallback that only fires when no server preference exists.

**Verify**: `pnpm typecheck` → 0. Add a `tests/server/` test: set
`lastSelectedProjectId` to a non-position-0 project, reorder projects (or
delete a different, unrelated project), and assert
`getWorkspaceSnapshot().selected.projectId` still resolves to the
preference-pointed project, not position-0. `pnpm exec vitest run
tests/server/ tests/kiri-board/` → pass.

### Step 3 (H5): Keep hidden projects' resource-tab layout

In `use-project-resources.ts`:

1. Change the `reconciled` memo (`:57-66`) to iterate over both visible and
   hidden projects:
   ```ts
   const reconciled = React.useMemo(() => {
     const projects: Record<string, ReturnType<typeof reconcileProjectResources>> = {}
     for (const project of [...workspace.projects, ...workspace.hiddenProjects]) {
       projects[project.id] = reconcileProjectResources({
         project,
         layout: storedLayout.projects[project.id],
       })
     }
     return projects
   }, [storedLayout.projects, workspace.projects, workspace.hiddenProjects])
   ```
2. `layout`'s `projects` rebuild (`:81-86`) then naturally includes hidden
   projects' reconciled entries too, so `saveStoredResourceLayout` (`:97-100`)
   stops dropping them.
3. `activeProjectResources = reconciled[activeProjectId]` (`:263`) is
   unaffected — a hidden project is never the `activeProjectId` in the board
   UI, so this doesn't resurrect hidden tabs anywhere visible; it only keeps
   their layout alive in storage for when they're unhidden.
   Note: plan 016's E1.1 (keep `BrowserPanel` mounted across switches)
   sources its mount set from this same reconciliation via
   `resourcesByProject` — landing this step is what extends 016's fix to
   the project-*hide* case. If 016 lands first, re-run its Step 1 manual
   check after this step. One caution: 016's prune effect will then keep
   hidden projects' browser views alive too — that is the intended
   hide-keeps-everything semantics, but confirm hidden-project views stay
   bounds-null (they will, since a hidden project is never active).
4. Do not change `reconcileProjectResources`/`resource-tabs.ts` itself — the
   bug is purely in which projects get fed into the existing reconciliation,
   not in the reconciliation logic.

**Verify**: `pnpm typecheck` → 0. Add/extend a `tests/kiri-board/` test (or
a `use-project-resources` unit test if one exists) that: opens two terminal
tabs on project A, hides project A, asserts the stored layout for project A's
tabs survives (still present in the persisted layout object), then unhides
and asserts the tabs reappear. `pnpm exec vitest run tests/kiri-board/` →
pass.

### Step 4 (H7, coordinate with plan 015 D12): Fix delete-order + partial-failure in `deleteProjectAndCleanupRuntimes`

Before starting, check plan 015's status for D12 — if it has already
modified `runtime-cleanup.ts:91-99`, treat this as drift (see STOP
conditions) and re-read before proceeding; do not stack a second fix on top.

1. Swap the order so runtime cleanup happens **before** the DB row is
   deleted (so a crash mid-cleanup still leaves the project resolvable), or —
   if the DB delete must stay first for FK/cascade reasons — wrap both in one
   critical section so no snapshot/MCP read can observe the gap. Prefer the
   reorder (simpler, matches "clean up what's live before removing the
   record of it"):
   ```ts
   function deleteProjectAndCleanupRuntimes<Result>(id, dependencies) {
     const sessions = dependencies.listSessions(id)
     cleanupRuntimeSessions(sessions, dependencies)
     return dependencies.deleteProject(id)
   }
   ```
2. Make `cleanupRuntimeSessions` (`:37-45`) tolerate a throwing
   `forgetRuntime`/`closeTerminal` per session instead of aborting the loop:
   ```ts
   function cleanupRuntimeSessions(sessions, dependencies = liveCleanupDependencies) {
     const errors: unknown[] = []
     for (const session of sessions) {
       try { dependencies.forgetRuntime(session.runtime, session.id) } catch (error) { errors.push(error) }
       try { dependencies.closeTerminal(session.id) } catch (error) { errors.push(error) }
     }
     if (errors.length) console.error(`cleanupRuntimeSessions: ${errors.length} error(s)`, errors)
   }
   ```
   This also protects Step 1's new `closeProjectShell` call — call it inside
   its own try/catch too, same pattern.
3. Note in `plans/README.md` (both the 015 row and 018 row) that this
   satisfies plan 015's D12.

**Verify**: `pnpm typecheck` → 0. Add a `tests/server/` test where a fake
`forgetRuntime` throws for one session in a multi-session project delete and
assert (a) the remaining sessions' `forgetRuntime`/`closeTerminal` still run,
(b) the project is still deleted, (c) no exception propagates out of
`deleteProjectAndCleanupRuntimes`. `pnpm exec vitest run tests/server/` →
pass.

### Step 5 (H8): Decide and document project-scoped vs session-scoped shell

1. Read `kiri-control.ts:494-497` (`terminalSessionKey`) alongside how shell
   sessions are actually created/targeted elsewhere (`terminal-registry.ts`
   `sessionKey`, `:109-114`; any UI affordance for "multiple shell tabs per
   project"). Confirm whether "one shared shell per project, any session in
   that project can drive it" is the intended design (it appears to be,
   given the key format itself is project-scoped, not session-scoped, by
   construction).
2. If confirmed intentional: add a code comment at
   `kiri-control.ts:494-497` stating explicitly that shell MCP ops are
   project-scoped by design (any session in the project shares and can
   control the one shell), so a future reader doesn't mistake it for a bug.
   No behavior change.
3. If NOT intentional (session isolation is actually assumed by some other
   part of the system — check for this before assuming): do not fix inline
   here. Record a follow-up note (in this plan's file, appended under this
   step) describing that session-scoped shells require a persisted key
   format change (`${agentId}:shell` instead of `${projectId}:shell`) and
   touches `terminal-registry.ts` `sessionKey`, every terminal-panel shell
   attach, and any persisted daemon snapshot keyed by the old format — too
   large for this plan, scope as its own follow-up plan.

**Verify**: no test required if documentation-only; `pnpm typecheck` → 0 to
confirm the comment-only edit didn't break anything.

### Step 6 (H6, fix-or-document): Document that embedded-mode restart doesn't reattach live PTYs

1. Extend the existing comment at `terminal-server.ts:140-143` (it already
   documents the daemon-vs-embedded survival choice) to also state the
   consequence the current comment omits: in default embedded mode a restart
   cold-spawns fresh provider processes (registry + provider-runtime state
   is process-memory only) and **any in-flight turn at restart is lost**;
   `KIRI_TERMINAL_DAEMON=1` is the only path that survives a backend/UI
   restart today.
2. If there is a user-facing "restore" / "reattach" affordance or doc string
   that implies otherwise (check `db.ts:187-230` callers and any onboarding/
   help copy), correct it to match reality rather than promising reattach
   that doesn't happen.
3. Do not implement genuine reattach (spawning a fresh registry/provider
   registry from a live PTY table) — that's L-effort and belongs in its own
   plan if prioritized later.

**Verify**: `pnpm typecheck` → 0 (comment/doc-only change, no test needed).

## Future: real session-move (out of scope)

**"Move a session from project A to project B" does not exist and is not a
required step of this plan.** Recording what it would take so a future
planner doesn't have to re-derive it:

- The session id is minted as `` `${projectId}-${slot}` `` and treated as
  immutable everywhere it's used:
  - `db/session-operations.ts:108` (fork), `:193` (persisted-session
    hydration id) — id format baked in at creation.
  - `` `thread-${id}` `` thread id (`session-operations.ts:142,146`).
  - `session_dir`/`session_file` are filesystem paths rooted under the
    *current* project's directory on disk.
  - `agent_context_usage` primary key is the agent id.
  - Any FK referencing `agent_id` (e.g. workflow/task tables) assumes the id
    never changes owner.
  - Runtime/terminal keys: `` `${agentId}:runtime` `` and
    `` `${projectId}:shell}` `` (`terminal-registry.ts:109-113`) — moving
    projects changes the shell key namespace entirely, and the runtime key
    embeds the (immutable) agent id.
  - Client-side persisted state keyed by the old id/project pairing:
    `agentByProject` preference (`board-selection.ts`), any chat-draft
    cache, resource-tab layout keyed `agent:${agentId}` under the old
    project's layout entry (`resource-tabs.ts`/`use-project-resources.ts`).
- A real "move" implementation would need one of:
  1. **Re-mint the id** on move: allocate a fresh `${newProjectId}-${slot}`
     id, physically move the on-disk session directory, rewrite every
     referencing table row (thread id, context usage, tasks, FKs) inside one
     transaction, re-key the in-memory terminal-registry/provider-runtime
     entries (or force-close and re-spawn under the new key), and migrate/
     drop the client-side entries keyed by the old id. This is a
     multi-table, on-disk, and in-memory-state-touching change — realistically
     L-XL effort and needs its own plan with its own migration/rollback story.
  2. **Decouple `project_id` from the id format** (schema change): stop
     deriving identity from `${projectId}-${slot}`, make `project_id` a
     mutable FK column with its own reassignment op, and separately migrate
     every non-DB thing that currently assumes the id encodes the project
     (session dir layout, runtime/shell keys, client caches). This avoids the
     re-mint-on-every-move cost but is a bigger up-front schema decision.
- Either path is a **product decision** (is "move" actually wanted, and is it
  worth the schema/migration cost) more than a bugfix — do not build it as
  part of this plan or as a "while I'm in here" addition to Steps 1-6.

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt doesn't match live code (drift) — especially
  `deleteProjectAndCleanupRuntimes`/`cleanupRuntimeSessions`
  (`runtime-cleanup.ts`), since plan 015's D12 targets the exact same
  function and may have already landed a fix.
- Adding the new UI preference (`lastSelectedProjectId`) turns out to require
  a schema/migration mechanism this codebase doesn't already have for
  `UiPreferences` (check how `agentByProject` is stored/migrated before
  assuming a simple schema-default addition is safe).
- The `sessions/kill-prefix` route (Step 1) would need to reach across the
  kiriterm daemon boundary in a way `terminalControlRequest` doesn't already
  support — if the daemon's own HTTP handler doesn't share
  `handleSessionControlRoute`, escalate rather than duplicating the route
  logic in two places.
- Step 3's hidden-project reconciliation causes hidden project resources
  (terminals/browsers) to actually mount/render anywhere in the UI — the fix
  must only keep the *stored layout* alive, never make a hidden project's
  resources live.
- Any step requires touching the session id format, on-disk session
  directory layout, or terminal/shell key format — that's H0 (or H8's
  deferred fix) territory, out of scope, stop and flag instead of expanding
  scope.
