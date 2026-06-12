# Kiri Corner Peek Implementation Plan

## Decided

- No persistent sidebar.
- The selected project owns the full canvas.
- Each project has one ordered, movable resource list.
- Resource tabs are peers: agent sessions, shell terminals, scratchpad.
- New agents insert before scratchpad by default.
- Scratchpad defaults to the final resource tab, but is movable.
- All resources use one UI movement primitive: reorder, select, detach/attach affordances call the same client model.
- Corner Peek is the top-right orientation surface.
- Corner Peek shows projects vertically and resources horizontally.
- Up/down moves projects. Left/right moves resources inside the selected project.
- Holding Cmd pins/shows the map and alignment UI.
- The frontend remembers project/resource positions across restart through client shell layout state.
- Projects is an app-level full-screen Project Register, not a sidebar and not a resource tab.
- Hidden project management belongs inside the Project Register; Corner Peek only shows a compact hidden count/action.
- Settings is an app-level full-screen Control Surface, not a sidebar and not a resource tab.
- Projects and Settings open from Corner Peek/app actions, command actions, and existing triggers.

## Inputs

- how: current source inspection of `KiriBoard`, project manager dialog, settings screen, selected agent pane, keyboard navigation, storage, terminal workspace.
- architect: selected Corner Peek direction in `docs/kiri-corner-peek-zoned-design.html`.
- user decisions:
  - no sidebar
  - top-right Corner Peek
  - agents, terminals, scratchpad as movable tabs
  - scratchpad starts last but can move
  - every resource is movable
  - frontend remembers where everything is on restart
  - no SQLite/MCP/CLI/core changes for this shell pass
  - Projects and Settings are locked as app-level full-screen pages

## Out of scope

- SQLite migrations.
- MCP contract changes.
- CLI contract changes.
- Runtime/session/project/scratchpad persistence changes.
- Changes to how agents are launched, resumed, renamed, deleted, prompted, steered, or exposed to MCP.
- Terminal control-plane changes.
- `src/server/workspace-service.ts` resource-tab changes.
- `src/server/workspace.ts` resource-tab changes.
- `src/lib/contracts.ts` resource-tab changes.
- Project persistence changes beyond existing add/reorder/hide/unhide/delete operations.
- Settings persistence changes beyond existing preferences.
- Making Projects or Settings resource tabs.
- Making Projects or Settings sidebar panels.
- Promoting diffs into top-level movable resources.
- Project action run execution, scheduling, restart policy, or MCP/CLI operations.

## Contract changes

Client/UI-only contract. Do not put this in shared server/MCP contracts.

```ts
export type ResourceId =
  | `agent:${string}`
  | `terminal:${string}`
  | "scratchpad"

export type ResourceKind = "agent" | "terminal" | "scratchpad"

export type AgentResource = {
  readonly id: `agent:${string}`
  readonly kind: "agent"
  readonly agentId: string
}

export type TerminalResourcePurpose =
  | { readonly kind: "manual" }
  | {
      readonly kind: "project-action"
      readonly actionId: string
      readonly label: string
      readonly command: string
    }

export type TerminalResource = {
  readonly id: `terminal:${string}`
  readonly kind: "terminal"
  readonly terminalId: string
  readonly title: string
  readonly purpose: TerminalResourcePurpose
}

export type ScratchpadResource = {
  readonly id: "scratchpad"
  readonly kind: "scratchpad"
}

export type ProjectResource =
  | AgentResource
  | TerminalResource
  | ScratchpadResource

export type ProjectResourceLayout = {
  readonly activeResourceId: ResourceId | null
  readonly order: readonly ResourceId[]
  readonly terminals: readonly TerminalResource[]
  readonly activeTerminalResourceId?: `terminal:${string}`
}

export type ResourceShellLayout = {
  readonly activeProjectId: string | null
  readonly projects: Record<string, ProjectResourceLayout>
}
```

Core pure functions:

```ts
export function reconcileProjectResources(input: {
  readonly project: ProjectRow
  readonly layout: ProjectResourceLayout | undefined
}): {
  readonly resources: readonly ProjectResource[]
  readonly activeResourceId: ResourceId
  readonly layout: ProjectResourceLayout
}

export function moveProjectResource(input: {
  readonly layout: ProjectResourceLayout
  readonly resourceId: ResourceId
  readonly toIndex: number
}): ProjectResourceLayout

export function selectAdjacentResource(input: {
  readonly resources: readonly ProjectResource[]
  readonly activeResourceId: ResourceId
  readonly delta: 1 | -1
}): ResourceId

export function insertAgentResource(input: {
  readonly layout: ProjectResourceLayout
  readonly agentId: string
}): ProjectResourceLayout

export function ensureTerminalResource(input: {
  readonly layout: ProjectResourceLayout
  readonly terminalId?: string
  readonly title?: string
}): {
  readonly layout: ProjectResourceLayout
  readonly resourceId: `terminal:${string}`
}
```

Storage helpers:

```ts
export function readStoredResourceLayout(
  storage?: StorageLike,
): ResourceShellLayout

export function saveStoredResourceLayout(
  layout: ResourceShellLayout,
  storage?: StorageLike,
): ResourceShellLayout
```

## Boundaries

- entrypoint / caller:
  - `src/components/KiriBoard.tsx` owns app-level mode: board, Projects, Settings, command palette, launchers.
  - `CornerPeekShell` owns the no-sidebar board canvas.
  - `CornerPeek` exposes project/resource orientation and app actions.
- domain:
  - Existing projects, sessions, scratchpad blocks, terminal sessions remain the domain objects.
  - Resource tabs are a UI projection over those objects, plus UI-only terminal resource metadata.
- state / persistence:
  - Add `kiri:resource-layout:v1` in frontend storage.
  - Keep existing project order/hidden state persistence.
  - Keep existing session/read-model persistence.
  - Keep existing scratchpad persistence.
  - Keep existing `TerminalWorkspace` localStorage for pane layout.
- runtime / external:
  - No SQLite, MCP, CLI, daemon, or terminal control-plane changes.
  - Shell terminal resources bridge to existing terminal plumbing.
- tests:
  - Pure model/storage unit tests for reconciliation and restart behavior.
  - Navigation tests for resource left/right and project up/down.
  - Existing scratchpad/terminal tests for unchanged panel behavior.
  - E2E for no-sidebar shell, Projects page, Settings page, and reload restore.

## File / symbol plan

- `src/components/kiri-board/resource-tabs.ts`
  - Add UI-only resource types and pure reconciliation/move/selection/insertion helpers.
- `src/components/kiri-board/storage.ts`
  - Add `readStoredResourceLayout`, `saveStoredResourceLayout`, and defensive validation.
- `src/components/kiri-board/use-project-resources.ts`
  - Add hook that reads storage, reconciles against `WorkspaceSnapshot`, persists layout, and exposes resource actions.
- `src/components/kiri-board/corner-peek-shell.tsx`
  - Add no-sidebar board shell with tab strip, stage, and Corner Peek anchor.
- `src/components/kiri-board/resource-tab-strip.tsx`
  - Add movable project-local tabs for agents, terminals, and scratchpad.
- `src/components/kiri-board/resource-stage.tsx`
  - Render selected agent, terminal, or scratchpad resource using existing panel internals.
- `src/components/kiri-board/corner-peek.tsx`
  - Add top-right project/resource lens and app-level actions for Projects/Settings.
- `src/components/KiriBoard.tsx`
  - Replace `ProjectBoardPane + SelectedAgentPane` board composition with `CornerPeekShell`.
  - Keep command palette, session launcher, and confirm dialog behavior.
  - Open Projects and Settings as app-level full-screen surfaces.
- `src/components/kiri-board/selected-agent-pane.tsx`
  - Extract reusable content from sidebar chrome; preserve chat/diff/runtime terminal/scratchpad behavior.
- `src/components/kiri-board/project-manager-dialog.tsx`
  - Convert modal chrome into full-screen Project Register surface.
  - Preserve add, choose directory, reorder, hide/unhide, and delete behavior.
- `src/components/kiri-board/settings-screen.tsx`
  - Keep full-screen Control Surface shape.
  - Update visible keyboard labels from agent left/right to resource left/right.
- `src/components/kiri-board/board-keyboard-shortcuts.ts`
  - Keep up/down project navigation.
  - Change left/right to resource navigation.
  - Add Cmd-hold behavior for Corner Peek visibility/alignment.
- `src/components/kiri-board/navigation.ts`
  - Rename user-visible navigation labels to resource language.
  - Keep stored key action names initially if needed to avoid preference churn.
- `src/components/kiri-board/command-actions.ts`
  - Route chat/diffs/terminal/scratchpad commands to resource selection or inner agent view as appropriate.
- `src/styles/app/board-navigation.css`
  - Add no-sidebar shell, resource tab strip, and Corner Peek styling.
- `src/styles/app/board-chat-diff-terminal.css`
  - Preserve panel styling; remove only assumptions that block full-canvas rendering.
- `src/styles/app/dialogs-settings.css`
  - Add full-screen Project Register styling and polish Settings layout.
- `src/styles/app/forms-projects-sessions.css`
  - Keep project rows/forms compact and page-local.
- `src/styles/app/responsive.css`
  - Add mobile resource strip and Corner Peek behavior.
- `tests/kiri-board/resource-tabs.test.ts`
  - Add model coverage.
- `tests/kiri-board/storage.test.ts`
  - Add storage validation/rehydration coverage.
- `tests/kiri-board/navigation.test.ts`
  - Update project/resource navigation assertions.
- `tests/kiri-board/command-actions.test.ts`
  - Update command routing assertions if existing command tests cover these actions.
- `tests/e2e/kiri.spec.ts`
  - Add shell/page/restart assertions.

## State

- changes:
  - New frontend-only `ResourceShellLayout`.
  - Active project id remembered in client shell layout.
  - Active resource per project remembered in client shell layout.
  - Resource order per project remembered in client shell layout.
  - Moved scratchpad position remembered in client shell layout.
  - Manual terminal resource tabs and purpose metadata remembered in client shell layout.
- unchanged:
  - SQLite schema and project/session/scratchpad records.
  - MCP and CLI contracts.
  - Agent launch/resume/delete/prompt/steer behavior.
  - Scratchpad block storage and trigger behavior.
  - Terminal backend/control-plane behavior.
  - Existing project order/hidden persistence.
  - Existing terminal split/pane layout storage.

## Final call graph

Production:

```txt
KiriBoard mount
  load WorkspaceSnapshot                         // existing
  readStoredResourceLayout                       // new client storage
  useProjectResources.reconcile                  // new UI projection
  render CornerPeekShell                         // new shell
    ResourceTabStrip                             // select/move resources
    ResourceStage                                // render selected resource
      agent -> existing chat/diff/terminal views
      terminal -> existing terminal workspace/panel plumbing
      scratchpad -> existing ScratchpadPanel
    CornerPeek                                  // project/resource lens + app actions
```

```txt
InlineSessionLauncher
  handleStartSession                             // existing
  workspace refresh                              // existing
  insertAgentResource(projectId, agentId)        // new UI layout update
  selectResource(projectId, agent:<id>)          // new UI selection
```

```txt
ScratchpadPanel
  handleTriggerBlock                             // existing
  result.agentId                                 // existing
  insertAgentResource(projectId, agentId)        // new UI layout update
  selectResource(projectId, agent:<id>)          // new UI selection
```

```txt
command/key/button open scratchpad
  selectResource(projectId, scratchpad)
```

```txt
command/key/button open shell terminal
  ensureTerminalResource(projectId)
  selectResource(projectId, terminal:<id>)
```

```txt
CornerPeek or command app action
  open Projects -> Project Register
  open Settings -> Control Surface
  close page -> restore active project/resource shell state
```

Tests:

```txt
resource-tabs tests
  reconcileProjectResources / moveProjectResource / insertAgentResource / ensureTerminalResource

storage tests
  readStoredResourceLayout / saveStoredResourceLayout / malformed storage fallback

navigation tests
  project up/down / resource left/right / focused-input guards

e2e
  shell render / page entry-return / reload restore
```

## Implementation chunks

1. Pure model and client storage
   - files/symbols:
     - `src/components/kiri-board/resource-tabs.ts`
     - `src/components/kiri-board/storage.ts`
     - `tests/kiri-board/resource-tabs.test.ts`
     - `tests/kiri-board/storage.test.ts`
   - change:
     - Add resource layout model, reconciliation, movement, insertion, terminal creation, storage read/save.
   - verify:
     - `pnpm exec vitest run tests/kiri-board/resource-tabs.test.ts tests/kiri-board/storage.test.ts`
     - `pnpm typecheck`
   - risk:
     - Reconciliation must not reset moved scratchpad to default-last.

2. Resource hook
   - files/symbols:
     - `src/components/kiri-board/use-project-resources.ts`
     - `tests/kiri-board/resource-tabs.test.ts`
   - change:
     - Reconcile live workspace projects with stored resource layout and expose select/move/insert/ensure actions.
   - verify:
     - `pnpm exec vitest run tests/kiri-board/resource-tabs.test.ts`
     - `pnpm typecheck`
   - risk:
     - Keep `agentByProject` compatibility only as a bridge for existing code paths.

3. Extract selected-resource content
   - files/symbols:
     - `src/components/kiri-board/selected-agent-pane.tsx`
     - `src/components/kiri-board/resource-stage.tsx`
   - change:
     - Extract panel content from sidebar chrome and render it inside the new full-canvas stage.
   - verify:
     - `pnpm exec vitest run tests/kiri-board/scratchpad.test.ts tests/kiri-board/terminal-layout.test.ts`
     - `pnpm typecheck`
   - risk:
     - Avoid behavior changes inside `ChatPanel`, `DiffPanel`, `TerminalPanel`, `TerminalWorkspace`, `ScratchpadPanel`.

4. Build no-sidebar shell
   - files/symbols:
     - `src/components/kiri-board/corner-peek-shell.tsx`
     - `src/components/kiri-board/resource-tab-strip.tsx`
     - `src/components/kiri-board/corner-peek.tsx`
     - `src/components/KiriBoard.tsx`
     - `src/styles/app/board-navigation.css`
     - `src/styles/app/board-chat-diff-terminal.css`
     - `src/styles/app/responsive.css`
   - change:
     - Replace persistent sidebar composition with full-canvas stage, movable resource strip, and top-right Corner Peek.
   - verify:
     - `pnpm typecheck`
     - `pnpm exec vitest run tests/kiri-board/resource-tabs.test.ts`
   - risk:
     - Old `.sidebar-pane` CSS/tests will need deliberate updates, not accidental broad rewrites.

5. Keyboard and commands
   - files/symbols:
     - `src/components/kiri-board/board-keyboard-shortcuts.ts`
     - `src/components/kiri-board/navigation.ts`
     - `src/components/kiri-board/command-actions.ts`
     - `tests/kiri-board/navigation.test.ts`
     - `tests/kiri-board/command-actions.test.ts`
   - change:
     - Make left/right resource navigation, keep up/down project navigation, add Cmd-hold Corner Peek state.
   - verify:
     - `pnpm exec vitest run tests/kiri-board/navigation.test.ts tests/kiri-board/command-actions.test.ts`
     - `pnpm typecheck`
   - risk:
     - Do not steal keys from composer/input/terminal focus.

6. Projects and Settings surfaces
   - files/symbols:
     - `src/components/KiriBoard.tsx`
     - `src/components/kiri-board/project-manager-dialog.tsx`
     - `src/components/kiri-board/settings-screen.tsx`
     - `src/styles/app/dialogs-settings.css`
     - `src/styles/app/forms-projects-sessions.css`
     - `tests/e2e/kiri.spec.ts`
   - change:
     - Convert Projects into full-screen Project Register.
     - Keep Settings as full-screen Control Surface and update shell/navigation language.
   - verify:
     - `pnpm typecheck`
     - `pnpm exec vitest run tests/kiri-board/navigation.test.ts`
   - risk:
     - Preserve project operations exactly; this is presentation, not a project registry contract change.

7. Session/scratchpad/terminal flow glue
   - files/symbols:
     - `src/components/kiri-board/board-session-actions.ts`
     - `src/components/kiri-board/board-scratchpad-actions.ts`
     - `src/components/kiri-board/use-project-resources.ts`
   - change:
     - After existing session/scratchpad actions create an agent, insert/select the corresponding resource.
     - Shell terminal creation ensures/selects a manual terminal resource.
   - verify:
     - `pnpm exec vitest run tests/kiri-board/board-session-actions.test.ts tests/kiri-board/resource-tabs.test.ts`
     - `pnpm typecheck`
   - risk:
     - Session start/trigger remains core behavior plus UI-layout update.

8. E2E and build gate
   - files/symbols:
     - `tests/e2e/kiri.spec.ts`
   - change:
     - Assert no persistent sidebar, resource strip, scratchpad movement, terminal resource selection, Corner Peek, Projects page, Settings page, and reload restore.
   - verify:
     - `pnpm verify:e2e`
     - `pnpm build`
   - risk:
     - E2E selectors should target stable labels/roles introduced by the new shell, not old sidebar structure.

## Verification matrix

- unit:
  - `tests/kiri-board/resource-tabs.test.ts`
  - `tests/kiri-board/storage.test.ts`
  - `tests/kiri-board/navigation.test.ts`
  - `tests/kiri-board/command-actions.test.ts`
  - `tests/kiri-board/terminal-layout.test.ts`
- integration:
  - existing scratchpad/session action tests if present
  - existing terminal panel/workspace tests
- e2e:
  - `pnpm verify:e2e`
- build:
  - `pnpm typecheck`
  - `pnpm build`
- cleanup:
  - `pnpm verify:knip` after old sidebar-only components are removed or clearly still used.

## Open risks / blockers

- Shell terminal UI becomes a top-level movable resource before the backend has a project-owned terminal config API. Bridge through existing agent/project terminal plumbing for P1.
- Empty projects cannot create a terminal resource unless the existing terminal plumbing has a valid launch context. Disable or show "start an agent first" for P1.
- Diffs remain agent-internal. Promoting diffs to movable resources is a separate decision.
- Pointer drag can follow keyboard/menu movement. First implementation still needs accessible move controls.
- Projects and Settings are locked as app-level pages. Keep them outside resource tabs even if the shell component composition makes tabs tempting.
