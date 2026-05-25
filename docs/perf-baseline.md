# Performance Baseline + Trace Map

Captured on the local development machine before the Rust/perf lanes were made permanent.

## Baseline

- Server `getWorkspaceSnapshot`: ~3-5 ms.
- Server `getAgentDetail(limit=500)`: ~72-75 ms.
- Detail payload: ~1.08 MB.
- Server perf gate: `rssDeltaMb` ~110-114 MB versus the 72 MB budget. This was already red on main before the Rust collector and polling changes.
- Client SSR `ChatPanel`: ~125 ms for 500 rows.
- Client SSR `DiffPanel`: ~82 ms for one 192-line patch.
- Client gates have roughly 10x headroom against the current budgets.

## Ranked Native/Perf Candidates

1. `src/server/git-diff.ts`: git diff invocation and patch parsing. The TypeScript path shells once per untracked file, uses a 20 MB stdout buffer, and regex-splits large patch strings. This is now backed by `crates/git-diff-collector` and used automatically when the binary is available.
2. `src/server/db/agent-detail.ts` and `src/server/db.ts`: agent detail row decode and Zod parsing. The hot path still does repeated JSON parse and validation work across large refreshes.
3. `src/server/db/agent-events.ts`: sequence allocation currently uses `MAX(sequence) + 1`, which serializes timeline writes, diff refresh, and projection hydration.

## Tier 2

- Shiki highlight cost on large diffs.
- JSONL projection parse for transcript-derived read models.

## Tier 3: Keep In TypeScript/SQL

- Workspace snapshot read optimizations. Fix query shape and polling contracts first, rather than moving the snapshot to Rust.
- Per-message `COUNT(*)` for thread summary.
- Dead-wired `preloadedDiffHtmlById` prop.
- Snapshot caching by revision.
- Timeline virtualization.

## Permanent Fixes Landed

- Background polling now checks a cheap server-side workspace revision before asking for the full snapshot.
- The Rust git diff collector is the default fast path when a packaged or locally built binary exists.
- Desktop packaging builds and ships `kiri-git-diff-collector` next to the app resources.

## Gaps Before More Rust ROI Calls

- Cold-start harness.
- Diff refresh end-to-end harness.
- Polling fan-out harness.
- Timeline-write throughput harness.
- Browser reconciliation/render-churn harness.

## Refresh Commands

```sh
pnpm test:perf
pnpm perf:workspace-dedupe
pnpm exec vitest run tests/server/git-diff.test.ts tests/server/db-workspace-snapshot.test.ts tests/kiri-board/workspace-fingerprint.test.ts
```

If `pnpm test:perf` turns red again on RSS, treat it as the existing server allocation gate: either reduce allocations in the detail hydration path or intentionally revise the budget with a fresh baseline.
