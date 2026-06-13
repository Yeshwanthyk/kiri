# Diffs Feature Removal Plan

Status: implemented in `59088f1` (`refactor: remove persisted diffs feature`)
Base: branch `kyendamuri/corner-peek-shell` (current working tree, mid corner-peek refactor — do NOT plan against `main`)
Review sweep: checked against the live tree with `rg` for `diff_artifacts`,
`DiffArtifact`, `refreshTerminalDiffs`, `openDiffs`, `repoDiffRefreshedTurns`,
`diff.summary`, `kiri-git-diff-collector`, `DiffPanel`, and `@pierre/trees`.

## Goal

Remove the Diffs feature end to end: the Chat/Diffs tab toggle, `DiffPanel`, the manual
refresh path, the runtime diff-capture pipeline, the `diff_artifacts` table, the
`DiffArtifact` contract, the read-model diff entries, and the Rust `git-diff-collector`
binary. The terminal tab replaces the use case (run `git diff` there).

**Kept on purpose:** inline diff cards in the chat timeline that are synthesized from
patches embedded in tool messages (`inlinePatchDiffEntries` in
`src/components/kiri-board/timeline.ts`). These are chat content and do not depend on the
pipeline. They get a local type so the contract type can be deleted.

**Behavior changes (accepted):**
- The Diffs tab, `Shift+D` shortcut, and `+N` diff badge on agent cards disappear.
- Chat timeline `fileOperationCompleted` entries no longer upgrade to "Edited" with an
  inline preview via `DiffArtifact` path-matching; only tool-message-embedded patches
  render inline. Some previously diff-matched entries may now be filtered as noisy or
  render plain — that is fine.
- MCP read-model loses `diff.summary` entries and `totalDiffs`/`diffCount` summary fields.

## Hard data-migration requirement

Stored rows reference removed enum members. Reading them after enum removal throws zod
errors. A new idempotent migration step in `src/server/db/migrations.ts` `migrate()` must
run BEFORE anything reads events:

```sql
DROP TABLE IF EXISTS diff_artifacts;
DELETE FROM agent_events WHERE type = 'agent.diff.updated';
DELETE FROM read_model_entries WHERE kind = 'diff.summary';
```

Wrap as `function dropDiffArtifacts(database: DatabaseSync)` following the style of the
other repair functions in that file. Run it after `addAgentEventsTable()` and
`addReadModelEntriesTable()` have guaranteed those tables exist, but before
`repairAgentSlotReferences()` so that helper no longer tries to rebuild
`diff_artifacts`. Guard table existence inside the cleanup anyway; old dev DBs may be
partially migrated.

Note: the `read_model_entries` CHECK constraint on existing DBs still allows
`'diff.summary'` — harmless, do not rebuild the table. New DBs get the narrower CHECK
automatically because `readModelKindCheckValues` is derived from `readModelKinds`.
Keep `widenReadModelKindCheck()` as widen-only behavior: it should not rebuild an
existing table merely because an old enum member is still allowed.

## Types / contracts (target)

```ts
// src/components/kiri-board/board-types.ts
export type SidebarTab = 'chat' | 'terminal' | 'scratchpad'   // 'diffs' removed

// src/components/kiri-board/timeline.ts — NEW local type replacing contract DiffArtifact
export type TimelinePatch = {
  id: string
  title: string
  path: string
  patch: string
  updatedAt: string
}
// TimelineWorkEntry.diff?: TimelinePatch  (only populated by inlinePatchDiffEntries)

// src/lib/contracts.ts — DELETED: diffArtifactSchema, DiffArtifact,
//   refreshTerminalDiffsInputSchema, 'agent.diff.updated' from agentEventTypes,
//   agentCellSchema.diffCount, agentCellSchema.diffs,
//   diffs field on the agent-detail schema (find via typecheck)

// src/lib/ui-preferences.ts — 'openDiffs' removed from keymapActions, defaultKeymap,
//   keymap schema. zod object default mode strips the persisted 'openDiffs' key — safe.
//   Key 'd' becomes unbound.
```

## Implementation chunks

Work through in order; each chunk should typecheck (`pnpm typecheck`) before moving on.
Wholesale file deletions first, then let `tsc` drive the long tail — every list below is
verified against the current tree, but the typechecker is the source of truth.

### 1. Delete diff-only files

- `src/components/kiri-board/diff-panel.tsx`
- `src/server/git-diff.ts`
- `src/server/diff-refresh.ts`
- `tests/server/git-diff.test.ts`
- `tests/server/diff-refresh.test.ts`
- `tests/harness/diff-refresh-public-harness.ts`
- `tests/perf/run-client-render-perf.tsx` (DiffPanel SSR-only perf script; delete or
  replace with a chat-only perf script)
- `crates/git-diff-collector/` (entire crate; remove from workspace `Cargo.toml` members)

### 2. Frontend: tab toggle and wiring

- `src/components/kiri-board/board-types.ts` — narrow `SidebarTab` (see above).
- `src/components/kiri-board/selected-agent-pane.tsx` — remove Diffs tab button
  (`data-testid="tab-diffs"`, ~lines 246–302 tablist), the
  `tab === 'diffs' → <Suspense><DiffPanel/></Suspense>` branch (~357–364), the lazy
  import of `DiffPanel`, the `previousDiffRefreshRef` effect (~222–238), and the
  `onRefreshTerminalDiffs` prop end to end.
- `src/components/kiri-board/board-navigation.tsx` — remove its Diffs tab button
  (~83–89) and the `{agent.diffCount} diff` badge (~171).
- `src/components/kiri-board/project-lane.tsx` — remove the `diff-token` badge (~147–148).
- `src/components/kiri-board/corner-peek-shell.tsx` — `resolveStageTab` currently returns
  `agentTab === 'diffs' ? 'diffs' : 'chat'` (~199); the stage tab concept collapses to
  chat-only. Simplify: drop the diffs branch and any `'diffs'`-typed stage plumbing.
- `src/components/kiri-board/resource-tabs.ts` — no production diff resource exists here
  on this branch; keep it agent/terminal-only. Update fixtures/tests only because
  `AgentCell` loses `diffCount`/`diffs`.
- `src/components/kiri-board/board-keyboard-shortcuts.ts` — remove the `openDiffs`
  handler (`Shift+D → onOpenAgentResource(); setTab('diffs')`, ~170–174).
- `src/lib/ui-preferences.ts` — remove `'openDiffs'` (array entry, default `'d'`, schema
  field).
- `src/components/kiri-board/navigation.ts` — remove the `{ action: 'openDiffs', ... }`
  keymap settings row (~48).
- `src/components/KiriBoard.tsx` — remove `onRefreshTerminalDiffs` pass-through; `tab`
  state and `setTab('chat')` reset stay as-is.
- `src/components/kiri-board/board-server-actions.ts` — remove
  `refreshTerminalDiffsMutation` import/wiring (~19, 60, 90, 105).
- `src/components/kiri-board/board-session-actions.ts` — remove the
  `refreshTerminalDiffs` mutation member (~26) and `handleRefreshTerminalDiffs`
  (~144–149, 255).

### 3. Frontend: timeline retype (keep tool-message patches)

In `src/components/kiri-board/timeline.ts`:
- Add `TimelinePatch` (above); change `TimelineWorkEntry.diff?: TimelinePatch`.
- Remove: `DiffArtifact` import, `createDiffPathMap`, `diffByPath` params on
  `eventToWorkEntry` / `toolMessageToWorkEntry`, `appendUnmatchedDiffEntries`,
  `diffArtifactToWorkEntry`, the `agent.diffs` read, `usedDiffIds`.
- Keep: `inlinePatchDiffEntries` (it constructs the `diff` object from tool-message patch
  text — retype its literal as `TimelinePatch`), `diffLineStats`, `normalizeDiffPath`,
  `normalizeTimelinePath`.
- `isNoisyFileOperationEvent` / `isNoisyToolMessage` / `runtimeEventLabel`: drop the
  `diff` parameter where it only came from path-matching; entries from
  `inlinePatchDiffEntries` still carry `entry.diff`.

In `src/components/kiri-board/message-timeline.tsx`:
- Swap `DiffArtifact` import (from `~/lib/contracts`) for `TimelinePatch` (from
  `./timeline`). `InlineDiffPreview` and the `@pierre/diffs` `PatchDiff` usage stay.

In `src/components/kiri-board/agent-detail.ts` — remove `diffs: detail.diffs` (~15).

Dependencies: keep `@pierre/diffs`; remove `@pierre/trees` from `package.json` and
`pnpm-lock.yaml` (it was only used by `diff-panel.tsx`'s `FileTree` — confirm with
`rg '@pierre/trees' src tests package.json pnpm-lock.yaml`).

### 4. Contracts

`src/lib/contracts.ts`: delete `diffArtifactSchema` + `DiffArtifact` (~102–109),
`diffCount` (~169) and `diffs` (~177) from `agentCellSchema`, `'agent.diff.updated'`
(~218) from `agentEventTypes`, `refreshTerminalDiffsInputSchema` (~516–519), and the
`diffs` field on the agent-detail response schema.

### 5. Server: refresh path and workspace service

- `src/server/workspace.ts` — remove `refreshTerminalDiffsMutation` (~135–137) + imports.
- `src/server/workspace-service.ts` — remove the `refreshTerminalDiffs` method from
  `WorkspaceServiceApi` and all wiring (~23, 52, 86, 127, 199, 241, 415–417).

### 6. Server: runtime capture pipeline

- `src/server/runtime-lifecycle.ts` — remove the `diffsUpdated` variant from
  `RuntimeProjectionEvent` (~43–47) and `captureRuntimeDiffs` (~196–219).
- `src/server/runtime-projection.ts` — remove the `diffsUpdated` branch (~62–66).
- `src/server/pi-runtime.ts` — remove both `captureRuntimeDiffs(...collectGitDiffArtifacts...)`
  call sites (~229, ~259) + imports.
- `src/server/codex-runtime.ts` — remove `captureCodexGitDiffArtifacts` (~301–303) and
  its 3 call sites (~357, ~412, ~679–684), the `turn/diff/updated` message branch
  (~582–593; just stop handling the frame — the dispatch must still tolerate the message
  arriving), `rememberRepoDiffRefreshedTurn` usage (~820–821), + imports.
- `src/server/codex-app-protocol.ts` — remove `TurnDiffUpdatedParamsSchema` (~74–77).
- `src/server/codex-retained-state.ts` — remove the `repoDiffRefreshedTurns` set, its
  summary field, and `hasRepoDiffRefreshedTurn` / `rememberRepoDiffRefreshedTurn`.

### 7. Database layer

- `src/server/db/migrations.ts` — remove the `diff_artifacts` DDL + index from the
  initial block (~94–104); in `repairAgentSlotReferences`, drop `'diff_artifacts'` from
  the table-name check (~476) and delete the `diff_artifacts` rebuild block (~504–516);
  ADD the `dropDiffArtifacts` cleanup step (see "Hard data-migration requirement").
  `repairAgentSlotReferences` should only repair `threads` after this change.
- `src/server/db/schema.ts` — remove `diffDbRowSchema` (~106–113) and `diffCount` from
  the agent row schema (~40).
- `src/server/db/timeline-writes.ts` — remove `replaceAgentDiffArtifactsRows` (~428–481).
- `src/server/db/agent-detail.ts` — remove `diffLimit` input (~23–24), the `diffCount`
  sub-select (~49–53), the `readDiffs` call (~168) and function (~173–186).
- `src/server/db/workspace-snapshot.ts` — remove the `diffCount` sub-select (~74–78), the
  `diffs: []` default (~141), and the `diff_artifacts` fingerprint row in
  `readWorkspaceRevision` (~250–255).
- `src/server/db/session-operations.ts` — remove `DELETE FROM diff_artifacts ...` (~51).
- `src/server/db.ts` — remove `agentDetailDiffLimit` (~226), `diffLimit`/`diffs` assembly
  in `getAgentDetail` (~242, 259, 272–278), `replaceAgentDiffArtifacts` (~683–688).
- `src/server/claude-projection.ts` — remove the `diffCount` sub-select (~68–70).

### 8. Read model

- `src/server/read-model-contract.ts` — remove `'diff.summary'` from `readModelKinds`
  (~6), `totalDiffs`/`diffCount` from summary payload schemas (~26, 36),
  `diffSummaryPayloadSchema` (~40–45), the `diff.summary` variant of
  `readModelEntrySchema` (~58–62).
- `src/server/read-model-indexer.ts` — remove `totalDiffs` (~161, 171, 186), the
  `diff_counts` CTE + `diffCount` in agent timeline summaries (~205–258), and
  `collectDiffSummaryCandidates` (~266–295).
- `crates/read-model-indexer/src/main.rs` — the `"diffCount": 3` in a test fixture
  (~198) is opaque payload JSON; update the fixture for consistency, no logic change.
- `docs/read-model-api-contract.md` — remove `diff.summary` and `diff_artifacts` from the
  public read-model contract doc.

### 9. Rust binary + packaging

- Root `Cargo.toml` — remove `crates/git-diff-collector` from workspace members.
- `Cargo.lock` — regenerated by the Rust build/check after the crate is removed.
- `scripts/build-rust-bins.mjs` — remove `'kiri-git-diff-collector'` from `binaries` (~9).
- `package.json` — remove the `extraResources` entry `dist/bin/kiri-git-diff-collector`
  (~109–110); remove `@pierre/trees` dependency.
- `pnpm-lock.yaml` — remove the `@pierre/trees` importer/package snapshots via install.
- `knip.jsonc` — remove the deleted `tests/harness/diff-refresh-public-harness.ts` entry.
- `tests/server/desktop-package-contract.test.ts` — remove the collector expectations
  (~34–35, 68–69).
- Sweep env vars: `rg 'KIRI_GIT_DIFF_COLLECTOR'` — should only have hits in deleted
  files; remove any docs/scripts stragglers.

### 10. Tests

- `tests/kiri-board/timeline.test.ts` — drop cases covering `DiffArtifact` fixtures /
  artifact-to-entry attachment / unmatched-diff appendix; keep `inlinePatchDiffEntries`
  and `diffLineStats` coverage (retyped to `TimelinePatch`).
- `tests/server/workspace-service.test.ts` — remove `refreshTerminalDiffs` coverage.
- `tests/server/db-migrations.test.ts` — rewrite the legacy migration case: after
  `migrate()`, `diff_artifacts` should not exist, `agent.diff.updated` rows should be
  deleted, `read_model_entries` should have no `diff.summary` rows, `listAgentEvents`
  should parse remaining events, and new DB read-model CHECK text should not include
  `diff.summary`.
- `tests/server/db-timeline-writes.test.ts` — remove `replaceAgentDiffArtifactsRows`
  coverage.
- `tests/server/db-session-operations.test.ts` — drop diff cleanup assertions; reset now
  clears messages/events/tasks/context/runtime state but has no diff table.
- `tests/server/db-workspace-snapshot.test.ts` — remove diff row seeds, `diffCount`
  assertions, and revision changes based only on `diff_artifacts`.
- `tests/server/read-model-indexer.test.ts` — remove diff summary generation and
  `diffCount` payload expectations.
- `tests/server/runtime-lifecycle.test.ts` — remove `captureRuntimeDiffs` projection tests.
- `tests/server/codex-retained-state.test.ts`, `tests/server/runtime-retention.test.ts`,
  `tests/harness/scratchpad-trigger-harness.ts` — remove `repoDiffRefreshedTurns`
  assertions and guard-bound tests.
- `tests/harness/kiri-agent-detail-history-harness.ts` and `tests/perf/run-perf.ts` —
  remove `diff_artifacts` seed data and detail-payload diff counters.
- `tests/perf/run-workspace-dedupe-perf.ts` — remove `diffCount`, `diffs: []`, and
  `openDiffs` from snapshot/keymap fixtures.
- `tests/harness/fake-codex-app-server.mjs` — delete `turn/diff/updated` emissions unless
  a dedicated unknown-frame tolerance test still needs them.
- Fixture-only type fallout: remove `diffCount`, `diffs: []`, and `openDiffs` from board
  and server fixtures (`board-session-actions`, `slash-commands`, `detail-merge`,
  `resource-tabs`, `navigation`, `workspace-fingerprint`, `board-selection`,
  `command-actions`, `kiri-control-service`, and any typecheck-reported peers).
- `tests/e2e/kiri.spec.ts`:
  - remove `'diff_artifacts'` from the table list (~77)
  - remove the `keymap-openDiffs` assertion (~225)
  - remove/re-scope: "resource tabs switch between agent, diffs, and terminal" (~721) →
    agent + terminal only; "codex terminal interface resumes after the PTY exits and
    keeps diffs available" (~905) → keep the PTY-resume half, drop diff assertions;
    "selected agent detail loads chat, diffs, and local drafts" (~958) → drop diff half;
    "large chat and diff render within browser budget" (~996) → re-scope to chat-only
    budget; remove the `diffPathsForSessionTitle` / `renderedDiffBodyLineCount` helpers
    and the `diffCount: 60` seed input (~1005).
  - the seed/fixture helpers these tests use (anything writing `diff_artifacts`) go too.
- Other modified-on-branch tests (`storage.test.ts`, `preferences.test.ts`, etc.): let
  `pnpm typecheck` + `pnpm test:unit` surface stragglers.

### 11. CSS

`src/styles/app/board-chat-diff-terminal.css` — remove DiffPanel-only blocks:
`.diff-header`, `.diff-toolbar`, `.diff-view-toggle`, `.diff-body`, `.diff-tree-pane`,
`.diff-tree-header`, `.pierre-host` full-tab layout (~2067–2211),
`.diff-panel.fullscreen` (~2426–2447), `.diff-panel` layout (~864–872, ~511–518),
`.diff-token` badge (~386–389).
`src/styles/app/responsive.css` — remove the responsive `.diff-panel` rule (~334).
KEEP the chat-inline blocks: `.work-entry.has-diff`, `.work-diff-stats`,
`.inline-diff-counts`, `.inline-diff-card`, `.inline-diff-summary`, `.inline-diff-path`,
`.inline-pierre-host` (~1589–1821) — these serve the retained tool-message patches.
Optionally rename the file `board-chat-terminal.css` (update the import).

### 12. Public copy and docs

- `README.md`, `src/routes/landing.tsx`, `src/site/main.tsx`, `site/index.html` — remove
  product claims that Kiri has a Diffs pane/tab. Keep wording about terminal and chat.
- `docs/perf-baseline.md` — remove DiffPanel/Rust collector baselines or mark them
  historical in a separate archive note.
- Leave historical planning docs alone unless they are linked as current product docs
  (`docs/effect-migration-tracker.md`, corner-peek design docs, old explainers).

## Final call graphs

Production (after removal):
```
turn completes (pi/codex)            — no diff capture, nothing emitted
codex ws 'turn/diff/updated' frame   -> ignored by dispatch
chat timeline render
  -> buildTimeline(agent)            — agent has no .diffs
    -> inlinePatchDiffEntries(entry) — from tool-message patch text only
      -> <InlineDiffPreview> -> @pierre/diffs PatchDiff
```

Tests:
```
timeline.test.ts
  -> buildTimeline(fixture without diffs)
    -> inlinePatchDiffEntries -> TimelinePatch assertions
migrations test path
  -> migrate(db with legacy diff_artifacts + 'agent.diff.updated' events)
    -> dropDiffArtifacts -> listAgentEvents parses cleanly
```

## Verification (run in order)

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm test:unit`
4. `pnpm knip:report` — deleted exports should not appear as new unused symbols
5. `pnpm verify:e2e` (chromium)
6. `pnpm exec vitest run tests/server/db-migrations.test.ts tests/server/read-model-indexer.test.ts tests/server/db-workspace-snapshot.test.ts tests/kiri-board/timeline.test.ts`
7. `rg -n "DiffPanel|diff-panel|tab-diffs|openDiffs|refreshTerminalDiffs|diff_artifacts|agent\\.diff\\.updated|diff\\.summary|DiffArtifact|repoDiffRefreshedTurns|kiri-git-diff-collector|@pierre/trees" src tests scripts package.json pnpm-lock.yaml Cargo.toml knip.jsonc README.md site docs/read-model-api-contract.md docs/perf-baseline.md`
   should return no hits. Run broader docs sweeps separately and decide whether historical
   docs should be left alone.
8. Manual/migration check: open an existing dev DB that has diff artifacts and
   `agent.diff.updated` events; app must boot and agent history must load (this is the
   zod-enum regression the migration step exists to prevent).
9. `cargo build --workspace` (or `pnpm build:rust`) — confirms the crate removal is clean.

## Discussion points (resolved assumptions — flag if wrong)

- Inline tool-message patch rendering in chat is KEPT. If full removal of all inline
  diffs is wanted instead, also delete `inlinePatchDiffEntries`, `InlineDiffPreview`,
  `diffLineStats`, the inline-diff CSS, and the `@pierre/diffs` dependency.
- Keymap key `'d'` is left unbound rather than reassigned.
- `read_model_entries` CHECK is not rebuilt on existing DBs (stale `'diff.summary'`
  allowance is harmless).
