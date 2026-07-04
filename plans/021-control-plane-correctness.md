# Plan 021: kirictl/MCP control-plane correctness

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e464651..HEAD -- src/cli/kirictl.ts src/server/kiri-mcp.ts src/server/kiri-mcp-runtime.ts src/server/kiri-router.ts src/lib/contracts.ts scripts/kiri-desktop-backend.mjs tests/server/kiri-control-cli.test.ts tests/server/kiri-mcp.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: —
- **Category**: bugfix / correctness
- **Planned at**: commit `e464651`, 2026-07-04
- **Status**: DONE — fallback/guard, MCP envelope metadata, timeout coherence, read/write cleanup, and focused gates pass; full lint has pre-existing unrelated blockers

## Why this matters

The control plane (kirictl + MCP + backend control endpoint) is the entire
agent-facing API, and it has four correctness leaks:

1. **The backend "fallback" is fail-closed.** `tryRunBackendOperation`
   returns `kind:'handled'` with an error for *any* HTTP failure —
   unreachable, timeout, 500 (`src/cli/kirictl.ts:339-398`). Local execution
   happens only when `backend-control.json` is *absent*
   (`src/cli/kirictl.ts:262-264`). A backend killed with `kill -9` leaves a
   stale control file (cleanup is pid-gated and only on graceful shutdown,
   `scripts/kiri-desktop-backend.mjs:719-730`), after which **every**
   kirictl/MCP call fails until manual file removal. The file already
   contains `pid`/`createdAt`, but `readBackendControlInfo`
   (`src/cli/kirictl.ts:465-479`) ignores them. Conversely, when the file is
   missing while a backend *is* running (or `KIRI_DISABLE_BACKEND_PROXY=1`),
   kirictl silently opens the same SQLite DB in-process — WAL protects
   storage but not the backend's process-local runtime state (adapters,
   queues: `src/server/runtime-lifecycle.ts:114`, `src/server/pi-runtime.ts:33`).
2. **MCP errors look like successes.** `toolResult`
   (`src/server/kiri-mcp.ts:64-74`) never sets `isError: true`, so a generic
   MCP client treats `{ok:false}` envelopes as successful tool calls. It also
   always returns `structuredContent` while registering no `outputSchema`
   (spec expects structuredContent only with a declared output schema), and
   `kiri_do` carries no `destructiveHint`/`idempotentHint` despite spanning
   `project.delete` / `terminal.kill`.
3. **The proxy timeout (15s default, `src/cli/kirictl.ts:405-408`) is
   shorter than `terminal.wait-for`'s own default (30s,
   `src/cli/kirictl.ts:194`)**, so proxied waits abort at 15s while the
   backend keeps the wait alive (`scripts/kiri-desktop-backend.mjs:697` does
   not cancel).
4. **Dead/drifted surface**: `options.compact` is declared with default
   `true` (`src/lib/contracts.ts:718`) and advertised in both MCP tool
   descriptions, but nothing reads it (`shapeResult` handles only
   `limit`/`fields`, `src/server/kiri-router.ts:436-440`).
   `src/server/kiri-mcp-runtime.ts` is imported only by its own test.
   `terminal.wait-for` and `workflow.validate` are pure reads classified as
   writes (`src/lib/contracts.ts:686,698`), making them unavailable through
   `kiri_get`. Versions are hardcoded `0.1.0` (`src/server/kiri-mcp.ts:11`,
   `src/cli/kirictl.ts:35`) vs package `0.1.14`.

## Steps

### 1. Liveness-checked backend proxy with true local fallback

In `src/cli/kirictl.ts`:

- Parse `pid` from `backend-control.json`; if the pid is not alive
  (`process.kill(pid, 0)` throwing `ESRCH`), treat the file as stale: fall
  through to local execution and (best-effort) unlink the stale file.
- On `BACKEND_CONTROL_UNREACHABLE` (connection refused / DNS), also fall
  back to local execution instead of returning the error — but see the
  write-guard below. Keep timeout (`BACKEND_CONTROL_TIMEOUT`) and HTTP
  4xx/5xx as `handled` errors: those mean a live backend answered (or may
  still be executing), where local re-execution risks duplicate effects.
- Add the inverse guard: before local **write** execution
  (`kiriWriteOperations`), if a control file exists with a live pid but the
  endpoint was unreachable, return a `BACKEND_ALIVE_LOCAL_WRITE_REFUSED`
  error instead of opening the DB — a live backend with a broken endpoint
  is a bug to surface, not to write around. Local reads may proceed.

Tests: extend `tests/server/kiri-control-cli.test.ts` (stale-pid fallback,
live-pid-unreachable write refusal, timeout still handled). The existing
fail-closed assertions at `:258`/`:289` change deliberately — update them to
the new contract.

### 2. Honest MCP results

In `src/server/kiri-mcp.ts`:

- Set `isError: true` on the tool result whenever the operation response has
  `ok: false`.
- Register an `outputSchema` matching the operation-response envelope
  (`ok`/`operation`/`result`/`error` — reuse
  `kiriOperationResponseSchema` shape from contracts), keeping
  `structuredContent`.
- Add `annotations: { destructiveHint: true, idempotentHint: false }` to
  `kiri_do`.
- Derive `version` for both the MCP server and kirictl from one constant
  sourced at build time (simplest: import package.json version via the
  esbuild `json` loader; verify `scripts/build-cli.mjs` supports it).

Tests: `tests/server/kiri-mcp.test.ts` — assert `isError` on a failing op,
assert advertised `outputSchema`/annotations via `tools/list`.

### 3. Timeout coherence for long operations

Per-operation proxy timeout: when the request is `terminal.wait-for` (or
`workflow.await`), compute the proxy timeout as `params.timeoutMs + 5s`
grace instead of the flat default (`src/cli/kirictl.ts:342,405`). Keep
`KIRI_BACKEND_CONTROL_TIMEOUT_MS` as an override.

### 4. Surface hygiene

- Move `terminal.wait-for` and `workflow.validate` from
  `kiriWriteOperations` to `kiriReadOperations` (`src/lib/contracts.ts:653+`).
  Grep tests/docs for classification assumptions
  (`tests/server/kiri-mcp.test.ts`, `.agents/skills/kiri-control/SKILL.md`).
  Note `workflow.await` stays a write: `deliver:"wake"` registers delivery
  state (`src/server/kiri-control.ts:663`).
- Either implement `compact` (drop `null`/empty fields from results) or
  delete it from `kiriOperationOptionsSchema` and both MCP descriptions.
  Deleting is acceptable; silently ignoring it is not.
- Delete `src/server/kiri-mcp-runtime.ts` and its test (confirm zero
  imports first: `rg -l "kiri-mcp-runtime" src/`).

### 5. Verification

- `pnpm typecheck && pnpm lint`
- Focused: `pnpm vitest run tests/server/kiri-control-cli.test.ts tests/server/kiri-mcp.test.ts tests/server/desktop-backend-script.test.ts`
- Manual smoke: start the desktop backend, `kill -9` it, run
  `pnpm kiri:ctl call '{"operation":"operations.list"}'` → expect a local
  successful response (stale file detected), not
  `BACKEND_CONTROL_UNREACHABLE`.

## STOP conditions

- If the write-guard (step 1) conflicts with an existing flow that
  *depends* on local writes while a backend runs (search tests for
  `KIRI_DISABLE_BACKEND_PROXY`), stop and report — the guard may need an
  explicit opt-out env var instead of a hard refusal.
- If registering `outputSchema` makes the installed
  `@modelcontextprotocol/sdk@1.29.0` server validate/reject existing
  responses in tests, stop and check whether the envelope schema needs
  `.passthrough()`.
- `terminal.wait-for` reclassification changes MCP tool membership
  (`kiri_get` enum); if any client config pins operation lists, stop.
