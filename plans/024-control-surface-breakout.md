# Plan 024: Control-surface break-out (hook micro-entrypoints, package boundary, protocol version)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e464651..HEAD -- src/cli/kirictl.ts scripts/build-cli.mjs package.json src/server/terminal-launch.ts src/server/terminal-shim.ts resources/bin/kiri-mcp scripts/kiri-desktop-backend.mjs tests/server/desktop-package-contract.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2 (step 1 is the payoff; steps 2–3 are groundwork you do
  when touching the area anyway)
- **Effort**: L
- **Risk**: MED
- **Depends on**: 021 (fallback semantics settle what the "client" half
  even is); 022 step 1 (hook wiring table decides what the micro-entrypoint
  must support). Do **not** externalize before step 3.
- **Category**: architecture / packaging
- **Planned at**: commit `e464651`, 2026-07-04
- **Status**: TODO

## Why this matters

Answer to "do we need to break kirictl/MCP out?": **yes internally, no
externally (yet)**. Evidence from a 2026-07-03 packaging audit:

- The bundled CLI is **5,442,699 bytes / 1,379 module inputs** (605
  Effect, 137 zod, MCP SDK, `node:sqlite`, `ws`, `node-pty` external,
  `@xterm/headless`) because `kirictl.ts` statically imports the entire
  server (`src/cli/kirictl.ts:7-33` → `kiri-control.ts:42` → terminal
  server → xterm/pty). **Every Claude hook event pays this graph**; a
  hook-only esbuild bundle measures **~8.6 KB with zero node_modules**
  (`claude-hook-handler.ts` + helpers). Measured cold start of the full
  bundle for a hook no-op: ~0.23s — and the dev fallback path runs `pnpm
  exec tsx` (`terminal-launch.ts:309-312`), which is worse.
- There is no enforced boundary: `~/*` maps to all of `src/`
  (`tsconfig.json:21`), so CLI↔server↔UI imports are only convention (the
  bundle already pulls `src/theme/kiri-themes.ts` via
  `src/lib/ui-preferences.ts`).
- `/.well-known/kiri/control` is **unversioned** — request
  `{operation,params,options}`, response `{ok,operation,result|error}`
  (`src/lib/contracts.ts:725`); the terminal WS protocol has explicit v2
  docs but control does not. Shipping a standalone kirictl/MCP binary now
  would create CLI↔backend skew with no detection.
- Rust direction is settled for the terminal core (`crates/kiri-termd`
  replaces the TS daemon per `plans/rust-terminal-core/00-overview.md:89`)
  — do not invest in the TS daemon; this plan is about the *control plane*,
  which stays Node.

## Steps

### 1. Hook micro-entrypoints (the real win — can ship alone)

- New entry `src/cli/kiri-hook.ts` importing **only**
  `claude-hook-handler.ts` / `codex-hook-handler.ts` and a minimal
  backend-control POST client (extract `tryRunBackendOperation` +
  `readBackendControlInfo` from `kirictl.ts` into a dependency-free
  `src/lib/backend-control-client.ts` — no Effect, no zod; hand-rolled
  fetch + the 021 liveness check).
- Hook path has **no local-DB fallback**: if the backend is down, hooks
  drop their event after logging (status/presence is reconstructible;
  holding a hook process open to run migrations against SQLite is exactly
  the dual-writer hazard 021 guards against). TodoWrite payloads may write
  a spool file next to the session dir for the backend to pick up later —
  optional, only if cheap.
- `scripts/build-cli.mjs` gains a second esbuild target →
  `dist/cli/kiri-hook.mjs` (target: <50 KB, no externals). Wire
  `terminal-launch.ts` / `terminal-shim.ts` hook invocations
  (`resolveKirictlInvocation`, `terminal-launch.ts:283-314`) to prefer it;
  `kirictl claude-hook` stays as a thin alias for compatibility.
- Verify: `time node dist/cli/kiri-hook.mjs claude-hook pre-tool-use < payload.json`
  well under 50ms; no `node:sqlite` warning in output.

### 2. Workspace package boundary (in-repo split)

- Create `packages/kiri-control/` (pnpm workspace member) owning:
  contracts (operation schemas), the backend-control client, kirictl
  command definitions, MCP server. It must **not** import `src/server`
  implementation — the CLI becomes protocol-client-first; the local
  execution fallback moves behind a dynamic `import()` that only resolves
  inside the app/dev checkout.
- Enforce the boundary: eslint `no-restricted-imports` (or knip workspace
  config) forbidding `~/server/*` from the package except the dynamic
  fallback module; narrow the `~/*` alias usage inside the package.
- `resources/bin/kiri-mcp` and the desktop backend's dynamic CLI import
  (`scripts/kiri-desktop-backend.mjs:697`) keep working — they consume the
  built artifact, so only `build:cli` input paths change. Run
  `tests/server/desktop-package-contract.test.ts` to confirm.

### 3. Control protocol version (gate for any external distribution)

- Add `controlProtocolVersion: 1` to `backend-control.json` (writer:
  `scripts/kiri-desktop-backend.mjs:~36`) and to the
  `/.well-known/kiri/environment` payload; `operations.list` result gains
  `protocol: { version, appVersion }`.
- Client (kirictl/MCP) sends `x-kiri-control-version`; on mismatch the
  backend still answers but includes a `warning` field; the client logs it.
  Hard-fail only on a future major bump.
- Only after this lands may kirictl/MCP ship as a separate binary/npm
  package — explicitly out of scope here.

### 4. Verification

- `pnpm typecheck && pnpm lint && pnpm vitest run tests/server`
- `pnpm build:cli` → assert `dist/cli/kiri-hook.mjs` < 50 KB and
  `dist/cli/kirictl.mjs` still passes
  `tests/server/desktop-package-contract.test.ts` /
  `desktop-backend-script.test.ts`.
- Packaged smoke (if practical): `pnpm verify:desktop:package` or the
  repo's equivalent gate, since `extraResources`/asar contents change.

## STOP conditions

- If extracting the backend-control client from Effect-based kirictl
  requires reimplementing retry/auth logic divergently, stop — two
  implementations of the control client is worse than a slow hook; consider
  making the shared client the *only* implementation first.
- If the workspace split (step 2) forces moving `contracts.ts` and that
  ripples into the UI import graph (>30 files), stop and split the plan:
  contracts move as its own change.
- Step 1's "drop events when backend is down" weakens 022's reliability
  goals if 021's liveness fallback hasn't landed — do not ship step 1
  before 021 step 1.
- Do not delete the TS kiriterm daemon here; that belongs to the
  rust-terminal-core / plan 020 track.
