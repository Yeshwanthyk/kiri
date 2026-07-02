# Plan 014: Agent hooks tightening (cmux-informed)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1fa5160..HEAD -- src/server/terminal-launch.ts src/server/codex-hook-handler.ts src/server/codex-terminal-session.ts src/server/codex-cli-sessions.ts src/server/terminal-env.ts src/server/runtime-binaries.ts src/server/provider-runtime.ts src/server/terminal-server.ts src/cli/kirictl.ts src/server/kiri-router.ts src/server/kiri-control.ts src/lib/contracts.ts src/server/db.ts`
> If any in-scope file changed since this plan was written, re-open it and
> compare against the "Current state" excerpts before proceeding; on a
> mismatch, treat it as a STOP condition — the exact line numbers below are
> the whole basis for several of these steps.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: soft on Plan 013 (Codex thread mapping correctness — not yet
  written; shares `codex-terminal-session.ts`, `codex-cli-sessions.ts`,
  `writtenAtMs`/staleness-guard territory with this plan's Steps 1 and 5).
  No hard dependency — this plan can land first or in parallel.
- **Category**: architecture/bugfix
- **Planned at**: commit `1fa5160`, 2026-07-01

## Why this matters

cmux (github.com/manaflow-ai/cmux) solves "make agent lifecycle observable
and controllable" with one primitive: a **PATH-shim wrapper**. It prepends a
shim directory to `PATH` in every terminal shell it manages; typing
`codex`/`claude` resolves to a wrapper script that injects hooks *for that one
invocation* (nothing written to `~/.codex` or `~/.claude`), then `exec`s the
real binary in place (same pid, same tty, replacing the shell's own process
image — not a child process). Every failure path falls through to `exec`ing
the unmodified real binary, so the wrapper can never break the command. This
means detection depends only on things cmux itself controls (the wrapper +
injected env + the child pid it execs), never on the agent cooperating or on
Kiri having spawned the process itself. It is why cmux catches hand-typed
invocations, `resume`, and re-exec, not just app-spawned launches.

Kiri's current state is much thinner (re-verified against the live source
for this plan, correcting the informal research pass):

- **Claude: zero hooks.** `claudeLaunch` (`src/server/terminal-launch.ts:180-225`)
  injects only `--dangerously-skip-permissions`, `--mcp-config`,
  `--append-system-prompt`, `--model`, and `--session-id`/`--resume`. Titles
  and TodoWrite tracking rely entirely on a system prompt
  (`claudeKiriTerminalPrompt`, :279-288) asking the model to *voluntarily*
  call MCP `session.rename` and keep `TodoWrite` current. This is soft,
  model-dependent, and non-deterministic — `provider-runtime.ts:89-90` even
  has `claude: {}` (empty adapter), and nothing in the codebase ever calls
  `replaceAgentTasksForThread`/`replaceAgentTasksRows`
  (`src/server/db/timeline-writes.ts:577-599`, `src/server/db.ts:603-610`)
  with `source: 'claude'` even though the schema already accepts it
  (`agentTaskSchema.source` is `runtimeKindSchema`,
  `src/lib/contracts.ts:129-136` — no migration needed).
- **Codex: exactly one hook, blocking, spawn-only.** `codexLaunch`
  (`terminal-launch.ts:302-338`) injects a single `hooks.SessionStart`
  config **only when Kiri itself spawns the process**
  (`codexSessionStartHookArgs`, :340-349 →
  `--enable hooks --dangerously-bypass-hook-trust --config
  hooks.SessionStart=[{hooks=[{type="command",command=<kirictl codex-hook
  session-start>,timeout=10}]}]`). The handler
  (`src/server/codex-hook-handler.ts`) runs synchronously: codex blocks the
  launch on this command until it exits (or the 10s timeout fires). There is
  no `UserPromptSubmit`/`Stop`/`SessionEnd`/`PreToolUse`/`PermissionRequest`
  wiring for codex at all.
- **No PATH-shim machinery anywhere.** `src/server/terminal-env.ts` is 15
  lines (`commonTerminalEnv`, `removeColorDisablingEnv`) — no PATH
  manipulation. The only PATH logic in the codebase is
  `runtimeProcessEnvWith` (`src/server/runtime-binaries.ts:111-127`), and it
  only *prepends* well-known desktop bin dirs (`/opt/homebrew/bin`, etc.,
  ahead of the inherited `PATH` — see `runtime-binaries.ts:121`) so Kiri can
  *find* an already-installed `codex`/`claude` binary to spawn — it never
  *shims* anything. A user who types `codex` or `claude` directly into
  a Kiri shell terminal (`shellTerminalEnv`, `terminal-launch.ts:472-479`,
  which only sets `KIRI_PROJECT_CWD`, no `KIRI_AGENT_ID`) gets **zero**
  hooks and is entirely invisible to Kiri.

The concrete failure modes this produces, and what fixes them:

1. **Codex resume gets no fresh SessionStart.** `codex resume <id>` does not
   re-fire the SessionStart hook (this is the cmux team's field-tested
   premise, not independently verified against a live codex binary here —
   treat as the working assumption a rebind must defend against regardless).
   Concretely in this codebase: `codex-hook-session.json`'s `writtenAtMs`
   (and, once added below, `pid`) never refresh across a resume, so anything
   that anchors "is this binding current for the process that's actually
   running" — the staleness guard in
   `codexHookSessionBindingMatchesLaunch` (`codex-terminal-session.ts:99-110`)
   when called *with* `launchedAtMs` (as `codexResumeIdFromState` in
   `codex-cli-sessions.ts:244-256` does, unlike the pre-spawn call site in
   `codexLaunch` which passes none) — sees stale data forever after the
   first resume. Step 5's pid-anchoring also needs a pid to anchor on, and
   there currently is none in the binding at all.
2. **Codex's one hook blocks the launch.** `timeout=10` plus a real
   Node/tsx/bun process spinup for every `kirictl codex-hook session-start`
   invocation adds visible launch latency and, per cmux's field report of
   ~35s hangs on a naively synchronous hook, real risk under load.
3. **No deterministic claude signal at all** — titles and todos are
   prompt-engineered wishes, not facts. This is the direct cause of "titles
   don't update" and "claude sessions never show tasks" reports and is what
   Plan 017 needs a solid foundation under.
4. **No shell-typed/resume mediation** — anyone who types `codex`/`claude`
   by hand, or re-execs/resumes outside Kiri's own spawn path, is invisible.
   cmux's shim is the only structural fix for this class of gap.
5. **Wrong-thread mapping** — the codex scan fallback
   (`findLatestCodexSessionForCwd`, `codex-cli-sessions.ts:56-102`) matches
   purely on cwd + closest timestamp, with no per-launch nonce and no pid
   confirmation, so two same-cwd launches within the fallback window can
   cross-bind (Area B, B6). cmux's fix is pid-anchored transcript resolution
   (confirm the candidate rollout is a file the known pid actually has open),
   not "newest/closest by mtime."

## Approach (decided)

Six changes, in priority order, each independently shippable:

1. **P1 — Codex resume re-bind.** Emit our own SessionStart-equivalent
   rebind (fresh pid + fresh `writtenAtMs`) right after `spawnPty` on a
   resume launch, instead of waiting on codex to fire one that (per cmux)
   never comes.
2. **P1 — Fire-and-forget the codex hook.** Rewrite the injected
   `hooks.SessionStart` command to capture stdin to a temp file, background
   the real `kirictl codex-hook session-start` work, and return `{}`
   instantly. Codex has no native async-hook flag (unlike Claude — see
   Step 3), so this must be hand-rolled in shell.
3. **P1 — Claude hook bundle via one `--settings <file>`.** Inject
   `SessionStart`/`UserPromptSubmit`/`Stop`/`SessionEnd`/`PreToolUse`
   (`AskUserQuestion|ExitPlanMode` matcher)/`PermissionRequest`/`PostToolUse`
   (`TodoWrite` matcher), each invoking new `kirictl claude-hook <event>`
   subcommands. This is the deterministic-signal foundation Plan 017 (titles
   + todos) builds on — 017 should not need to touch hook wiring again, only
   consume the DB state this step starts writing.
4. **P2 — PATH-shim wrappers.** `codex`/`claude` wrapper scripts, generated
   once and prepended to `PATH` only in `shellTerminalEnv`
   (`terminal-launch.ts:472-479`), so typed/re-exec/resume invocations in a
   plain Kiri shell terminal are mediated too — idempotent, no writes to
   `~/.codex`/`~/.claude`/shell rc files, always falls back to `exec`ing the
   real binary untouched.
5. **P2 — pid-anchored codex transcript resolution.** Replace "closest
   timestamp, same cwd" with "confirm the candidate rollout is a file the
   known PTY pid has open" (`lsof -p <pid>`) in the scan fallback, falling
   back to the existing heuristic only when pid confirmation is unavailable.
6. **P3 — Defensive parity.** `notify` slot non-clobber invariant (already
   true today — keep it true), unset `CLAUDECODE` for nested claude, resolve
   `CLAUDE_CONFIG_DIR` consistently with the `HOME` redirection Kiri already
   does, TTL the `codexHooksSupported` cache (= research item B7), and stop
   `codex-hook-handler.ts` from silently swallowing the "Kiri env absent"
   case.

Cross-refs: **Plan 013** (Codex thread mapping correctness, not yet written)
owns the *primary* hook-path subagent/thread-source filter (research B4) and
the fast-path `rememberCodexThread` gaps (B1/B2/B9) — this plan's Step 1
only fixes the resume-rebind timing/pid problem, it does not re-litigate
B4's subagent-clobber issue. **Plan 017** (Todos, titles, scratchpad &
knowledge, not yet written) owns smart auto-titling heuristics and
cross-session todo aggregation — this plan only delivers the deterministic
hook signal (status transitions, raw TodoWrite capture, a *conservative*
default-title guard) that 017 will refine.

## Current state

### Codex launch / hook path
- `src/server/terminal-launch.ts`
  - `codexLaunch` (302-338): builds `resume` via `readCodexTerminalResumeId`
    (308-312, **no `launchedAtMs` passed** — matches research B10, by
    design, not touched by this plan) then either `['resume', <id>]` or `[]`
    as the leading args (313-315), appends
    `codexKiriConfigArgs`/`codexSessionStartHookArgs` (316-319, only when
    `codexHooksSupported` at 317 returns true), appends
    `--dangerously-bypass-approvals-and-sandbox --no-alt-screen` (320).
  - `codexSessionStartHookArgs` (340-349): builds the single blocking
    `hooks.SessionStart=[{hooks=[{type="command",command=<...>,timeout=10}]}]`
    config string. `invocation` (the `kirictl codex-hook session-start`
    command+args) is passed in already fully resolved by
    `resolveKirictlInvocation(context, ['codex-hook', 'session-start'])`
    (line 318).
  - `codexHooksSupported` (392-408): `codexHookSupportByCommand` is a plain
    `Map<string, boolean>` module singleton (line 90) — cached forever per
    process per resolved binary path, only probed via `spawnSync(command,
    ['--help'])`. This is research item B7.
- `src/server/codex-hook-handler.ts`
  - `handleCodexSessionStartHook` (13-48): reads `KIRI_SESSION_DIR`/
    `KIRI_AGENT_ID` from env; **silently returns `{ ok: true }` with no log
    or reason** if either is absent (line 20 — research G4-4). Parses the
    hook JSON (`parseHookPayload`, 50-86: `session_id`, `source`, `cwd`,
    `transcript_path`, `model` — **no `thread_source` field parsed at all**,
    consistent with research B4). Writes both
    `codex-terminal-session-id` and the richer
    `codex-hook-session.json` binding with `writtenAtMs: Date.now()` (30-40).
- `src/server/codex-terminal-session.ts`
  - `CodexHookSessionBinding` (8-17): `{ agentId, sessionId, source?, cwd?,
    transcriptPath?, model?, hookEventName: 'SessionStart', writtenAtMs }` —
    **no `pid` field**.
  - `codexHookSessionBindingMatchesLaunch` (99-110): `agentId` must match;
    `writtenAtMs < launchedAtMs - 2000` rejects **only if `launchedAtMs` is
    passed**; cwd must match if present.
  - `readCodexTerminalResumeId` (68-84): tries hook binding, then the plain
    `codex-session-id` file (rejecting it if it equals a just-rejected hook
    binding's id via `rejectCodexSessionId`, 142-144), then
    `state.codexSessionId`, then `state.resume`.
- `src/server/codex-cli-sessions.ts`
  - `rememberCodexTerminalSession` (104-165): called from
    `getOrCreateTerminalSession` right after `spawnPty`
    (`src/server/terminal-server.ts:465-489`, specifically 483-488) **with
    `launchedAtMs` available** (the real post-spawn time). This is a
    *different* call site from `codexLaunch`'s pre-spawn one, and it *does*
    thread `launchedAtMs` through `codexResumeIdFromState` (244-256).
  - `findLatestCodexSessionForCwd` (56-102): recursively walks
    `~/.codex/sessions` (`walkCodexSessionFiles`, 184-201, depth≤5), reads
    only the **first line** of each `.jsonl` (`readFirstLine`, 203-216),
    filters `payload.cwd === cwd` and excludes `thread_source==='subagent'`
    (line 76 — this exclusion exists *only* here, not in the hook handler).
    Ranks by `closestToMs`/newest — **no pid confirmation, no per-launch
    nonce** (research B6).
- `src/server/terminal-server.ts`
  - `getOrCreateTerminalSession` (446-513): `spawnPty` at 465 (this is where
    `proc.pid` first exists); `rememberCodexTerminalSession` invoked at
    483-488 only `if (mode === 'runtime' && launch.label === 'codex')`.

### Claude launch path
- `src/server/terminal-launch.ts`
  - `claudeLaunch` (180-225): args built at 185-205 (no `--settings`
    anywhere); `env` built via `baseTerminalEnv` (207, →
    `runtimeBinaries.processEnv`, `runtime-binaries.ts:67-70,111-127`);
    `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_OAUTH_TOKEN`
    deleted unless `KIRI_CLAUDE_USE_EXTERNAL_API_KEY==='1'` (209-213);
    `env.HOME = homePath` set at 214 **only when `homePath` is truthy** —
    `CLAUDE_CONFIG_DIR` is never read, set, or deleted here, so an inherited
    ambient `CLAUDE_CONFIG_DIR` (e.g. from Kiri's own dev process having been
    launched from inside a claude session) silently overrides this `HOME`
    redirection, since claude resolves `CLAUDE_CONFIG_DIR` before `HOME`.
    `CLAUDECODE` is also never deleted.
  - `claudeSessionExists` (290-300): checks
    `join(homePath ?? context.homeDir, '.claude', 'projects', ...)` on disk
    — this is Kiri's own independent guess at where claude will look; it can
    diverge from claude's actual resolution exactly when `CLAUDE_CONFIG_DIR`
    is set ambiently (same root cause as above).
  - `claudeKiriTerminalPrompt` (279-288): the soft prompt-based nudge this
    plan's Step 3 makes deterministic.
- `src/server/provider-runtime.ts`
  - `claude: {}` (89-90) — confirmed empty adapter; `codex` (81-88) has
    `prompt`/`steer`/`interrupt`/`setThinkingLevel`/`reset`/`review` but no
    `answerQuestion` implementation anywhere (relevant to research D5, not
    this plan).

### kirictl / MCP surface
- `src/cli/kirictl.ts`: `codexHookCommand` (70-73) has one subcommand,
  `session-start` (58-68), which pipes `readFileSync(0, 'utf8')` (fd 0,
  synchronous stdin read) into `handleCodexSessionStartHook`.
  `runKiriOperationWithBackendFallback` (195-202) is the existing
  proxy-to-live-backend-or-run-locally pattern every other `kirictl`
  subcommand (`call`, `mcp`, `term *`) already uses — Step 3's new
  `claude-hook` subcommands should use the same pattern for any DB write
  (status/title/tasks), not reinvent it.
- `src/server/db.ts` already exports the three primitives Step 3 needs
  directly: `renameSession` (371-374, used today by the `session.rename`
  MCP op), `setAgentStatus` (573-575, currently only called from
  `codex-runtime.ts:804`, `pi-runtime.ts:193,230`,
  `runtime-projection.ts:31` — **never from an MCP-exposed operation**),
  `replaceAgentTasks` (603-610, wraps `replaceAgentTasksRows` →
  `db/timeline-writes.ts:577-599`).
- `src/server/kiri-router.ts`: `session.rename` case at 324-326; no
  `agent.status.set` / `agent.tasks.replace` operations exist yet.
- `src/lib/contracts.ts`: `kiriWriteOperations` (624-654) has `session.rename`
  but nothing for status/tasks; `agentTaskSchema.source` (129-135) is
  `runtimeKindSchema` — `'claude'` is already a legal value, no schema
  change needed.
- `src/server/runtime-binaries.ts`: `runtimeProcessEnvWith` (111-127) is the
  *only* PATH-building logic in the codebase; it prepends
  `desktopPathEntries` (74-83) ahead of the inherited `PATH`, but never
  prepends a shim dir. This is the function `shellTerminalEnv`'s `processEnv`
  call ultimately runs through.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint (server) | `pnpm lint:server` | exit 0 |
| Unit tests | `pnpm test:unit` | all pass |
| Targeted: launch/hooks | `pnpm exec vitest run tests/server/terminal-launch.test.ts tests/server/codex-hook-handler.test.ts tests/server/codex-cli-sessions.test.ts` | all pass |
| Targeted: new claude-hook tests | `pnpm exec vitest run tests/server/claude-hook-handler.test.ts` (new file) | pass |
| Build | `pnpm build` | exit 0 |
| CLI bundle | `pnpm build:cli` | exit 0, `dist/cli/kirictl.mjs` updated |
| E2E (chromium) | `pnpm verify:e2e` | all pass |
| Manual codex hook smoke | `codex --help \| grep dangerously-bypass-hook-trust` | confirms hook support probe still matches installed codex |
| Manual lsof check | `lsof -p <pid>` | confirms `lsof` availability assumption for Step 5 on the target platform |

## Scope

**In scope**:
- `src/server/terminal-launch.ts` — codex hook args (Steps 2, 6), claude
  `--settings` injection (Step 3), `CLAUDECODE`/`CLAUDE_CONFIG_DIR` handling
  (Step 6), `codexHooksSupported` TTL (Step 6), resume-rebind plumbing hook
  for Step 1 (exposing which launch is a codex resume + its resolved
  session id to the caller in `terminal-server.ts`).
- `src/server/codex-hook-handler.ts` — stdin-file support, non-silent
  env-absent logging (Step 6).
- `src/server/codex-terminal-session.ts` — add `pid` to
  `CodexHookSessionBinding` (Step 1), reader/writer updates.
- `src/server/codex-cli-sessions.ts` — pid-anchored resolution in
  `findLatestCodexSessionForCwd`/`waitForLatestCodexSessionForCwd` (Step 5).
- `src/server/terminal-server.ts` — post-`spawnPty` resume rebind call
  (Step 1), thread `proc.pid` into `rememberCodexTerminalSession` (Step 5).
- `src/server/terminal-env.ts` — new shim-PATH helper (Step 4).
- New `src/server/terminal-shim.ts` (or similar) — wrapper script templates
  + idempotent generation/install logic (Step 4).
- New `src/server/claude-hook-handler.ts` — mirrors
  `codex-hook-handler.ts`'s shape for the claude hook events (Step 3).
- `src/cli/kirictl.ts` — new `claude-hook <event>` subcommands (Step 3),
  `--stdin-file` option on `codex-hook session-start` (Step 2), new
  `term shim-args <runtime>`/`term shim-identity` subcommands if Step 4's
  wrapper needs them.
- `src/lib/contracts.ts`, `src/server/kiri-control.ts`,
  `src/server/kiri-router.ts` — new `agent.status.set` / `agent.tasks.replace`
  operations reusing existing `db.ts` exports (Step 3).
- `tests/server/*.test.ts` — regression tests for every step above.

**Out of scope** (do NOT touch):
- Renderer/UI (`src/components/**`) — no UI surfaces this plan.
- DB schema/migrations (`src/server/db/migrations.ts`) — no column/table
  changes needed anywhere in this plan; `agent_tasks.source` already accepts
  `'claude'`.
- Plan 013's territory: the *primary* hook-path `thread_source` subagent
  filter (B4), `rememberCodexThread` fast-path gaps (B1/B2/B9), generation-
  bump races (B9). Step 1 here only fixes resume rebind timing/pid; do not
  expand it into a general codex thread-mapping rewrite.
- Plan 017's territory: auto-title *heuristics* beyond a conservative
  "still the default title" guard, cross-session todo aggregation UI,
  `title_set_manually` flag (research G5-2) — Step 3 only writes the raw
  deterministic signal.
- Full session-minting for hand-typed shell invocations (making a bare
  `codex`/`claude` typed into a Kiri shell terminal show up as a first-class
  GUI session) — Step 4 delivers the *mediation mechanism* only; see Step 4's
  explicit limitation note.
- `answerQuestion`/`pendingQuestion` wiring (research D5) — unrelated to
  hooks, do not implement here.

## Git workflow

- Branch: `advisor/014-agent-hooks-tightening`
- Commit style: short imperative subject, no prefix. One commit per step is
  fine given the size of this plan; do not squash unrelated steps together.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Codex resume re-bind (P1)

Add a `pid` field to `CodexHookSessionBinding`
(`src/server/codex-terminal-session.ts:8-17`), threaded through
`readCodexHookSessionBinding`/`writeCodexHookSessionBinding` (optional field,
default `undefined` for backward-compat with existing on-disk files written
before this change).

In `terminal-launch.ts`, extend `TerminalProcessLaunch` (28-35) with an
optional `codexResumeSessionId?: string`, set only in `codexLaunch` (302-338)
when the `resume` branch is taken (313-315/322) — this is data the caller
already computed, just not currently surfaced.

In `terminal-server.ts`'s `getOrCreateTerminalSession` (446-513), immediately
after `spawnPty` succeeds (465) and `proc.pid` is known, if
`launch.label === 'codex' && launch.codexResumeSessionId`: call
`writeCodexHookSessionBinding` directly (not through the hook handler —
this is Kiri's own synchronous confirmation, not waiting on codex to
cooperate) with `agentId: config.id`, `sessionId:
launch.codexResumeSessionId`, `cwd: config.cwd`, `pid: proc.pid`,
`hookEventName: 'SessionStart'`, `writtenAtMs: Date.now()`. This must run
unconditionally on every codex resume, regardless of whether codex's own
hook later fires for that resume too — same `sessionId`, last-write-wins,
fully idempotent.

Do this *before* `rememberCodexTerminalSession` is invoked at 483-488 (or
make sure that call's `codexResumeIdFromState`/`freshCodexHookSessionBinding`
path reads the just-written binding, not a stale one) so the rest of the
existing scan-fallback machinery sees a fresh `writtenAtMs`/`pid` on the very
launch that created them.

**Verify**: `pnpm typecheck` → 0. Add a test in
`tests/server/codex-cli-sessions.test.ts` (or a new
`codex-terminal-session.test.ts`) asserting: given an existing (stale)
`codex-hook-session.json` with an old `writtenAtMs` and a resume launch,
after `getOrCreateTerminalSession` runs, `readCodexHookSessionBinding`
returns a binding with the new `pid` and a `writtenAtMs` newer than
`launchedAtMs`. `pnpm exec vitest run tests/server/codex-cli-sessions.test.ts tests/server/terminal-launch.test.ts` → pass.

### Step 2: Fire-and-forget the codex SessionStart hook (P1)

Rewrite `codexSessionStartHookArgs` (`terminal-launch.ts:340-349`) so the
injected `command` string is a small POSIX shell pipeline instead of the raw
`kirictl codex-hook session-start` invocation:

1. Capture stdin to a temp file (`f="$(mktemp -t kiri-codex-hook)"; cat > "$f"`).
2. Background the real work: `(<kirictl invocation> --stdin-file "$f" >/tmp/kiri-codex-hook.log 2>&1; rm -f "$f") &`
   — do **not** shell out to a `timeout` binary; macOS ships no
   `/usr/bin/timeout` by default. Instead give `kirictl codex-hook
   session-start` its own internal watchdog (a `setTimeout` in
   `codexHookSessionStartCommand`, `src/cli/kirictl.ts:58-68`, that
   force-exits the process after e.g. 5s if `handleCodexSessionStartHook`
   hasn't resolved) so an orphaned background process can't accumulate.
3. Return instantly: `printf '{}'` (codex's SessionStart hook contract
   expects a JSON object ack, mirroring cmux's `echo '{}'`).

Add `--stdin-file <path>` as a new `Options.text` on
`codexHookSessionStartCommand` (`kirictl.ts:58-68`); when present, read+unlink
that file instead of `readFileSync(0, 'utf8')` (keep the fd-0 path working
for direct/manual invocation and for the existing test in
`tests/server/codex-hook-handler.test.ts`, which pipes stdin directly).

Since the launch now returns in milliseconds regardless of kirictl's actual
spinup time, the outer `timeout=10` in the TOML hook config
(`codexSessionStartHookArgs`) becomes a pure safety net — keep it (or shrink
to `timeout=5`) but it should essentially never be hit after this change.

**Verify**: `pnpm typecheck` → 0. Update the existing "adds Codex
SessionStart hook args when hook support is enabled"
(`tests/server/terminal-launch.test.ts:207`) and "...when resuming" (:284)
tests to assert the new shell-pipeline shape (temp file capture + background
+ instant `{}`) instead of the direct invocation string. Add a
`codex-hook-handler.test.ts` case for `--stdin-file` (read + unlink). Manual
check: launch a real codex terminal session in the app and confirm no
visible pause on "Running SessionStart hook" (previously up to ~10s under
load).

### Step 3: Claude hook bundle via a single `--settings` (P1)

**Confirmed against the live Claude Code docs (code.claude.com/docs,
2026-06-30 snapshot) while writing this plan** — these facts change the
design from a naive port of cmux's approach and should not be re-litigated
without re-checking the docs for the CLI version Kiri ships:

- `--settings <file>` **merges per-key** with project/user settings files,
  it is not a replace. **Hooks specifically concatenate across scopes and
  are deduplicated by command string + args** — Kiri's injected hook bundle
  runs *alongside* anything already in the user's own `~/.claude/settings.json`,
  it never displaces it. This means Kiri does **not** need to read and
  deep-merge the user's settings file itself (unlike cmux, whose target
  behavior may have been an undocumented pure-replace) — write one small,
  Kiri-owned JSON file containing only Kiri's hooks, pass it as the single
  `--settings` flag, and let Claude Code do the rest. Still only ever emit
  **one** `--settings` flag from `claudeLaunch` — cmux's report of
  version-dependent "two `--settings` flags, one side silently lost" is
  exactly why this must never become two.
- Each hook entry supports a native **`"async": true`** flag. Unlike codex
  (Step 2, which needed a hand-rolled temp-file/background/instant-return
  shell trick because codex has no such flag), every claude hook injected
  here should just set `async: true` — Claude Code handles the
  fire-and-forget semantics natively.
- Matcher support: `SessionStart`/`SessionEnd` match on start-type/end-reason
  (use no matcher / empty, meaning "all"); `UserPromptSubmit`/`Stop` support
  **no** matcher (omit the field, do not set `"matcher": ""` and expect it to
  mean something — it's simply ignored); `PreToolUse`/`PostToolUse`/
  `PermissionRequest` match on tool name. `AskUserQuestion` and
  `ExitPlanMode` are confirmed literal tool names usable in a `PreToolUse`
  matcher.
- `PermissionRequest` fires "when the user is shown a permission dialog."
  Kiri's `claudeLaunch` always passes `--dangerously-skip-permissions`
  (line 186), which is documented as equivalent to `--permission-mode
  bypassPermissions` — by direct inference (not an explicit doc statement,
  flag as verify-at-implementation) **`PermissionRequest` will not fire**
  under Kiri's current launch config. Inject it anyway for forward
  compatibility (a future non-bypass launch profile), but the actual
  load-bearing needs-input signal today is the `PreToolUse` hook.
- The exact `tool_input` JSON shape for a `PostToolUse` hook matched on
  `TodoWrite` is **not documented** — dump the raw stdin payload to a file
  from a throwaway hook against a real `claude` binary before writing the
  parser, don't guess the shape.

Design:

- New `src/server/claude-hook-handler.ts`, mirroring
  `codex-hook-handler.ts`'s shape (gate on `KIRI_AGENT_ID`/`KIRI_SESSION_DIR`
  present, no-op with a *logged* reason if absent — see Step 6's G4-4 fix,
  apply the same non-silent logging here from the start).
  - `SessionStart` → write a `claude-hook-session.json` binding (mirrors
    `CodexHookSessionBinding` for symmetry/debuggability: agentId,
    sessionId, source, cwd, transcriptPath, model, writtenAtMs) and set
    status to `idle` via the new `agent.status.set` operation (self-healing
    if a prior crash left status `running`/`blocked`).
  - `UserPromptSubmit` → `agent.status.set` → `running`.
  - `Stop` → `agent.status.set` → `idle`, plus a **conservative** auto-title:
    only call `session.rename` if the current title still matches the
    default pattern (`Session N`) — do not implement smart heuristics here,
    that is Plan 017's job; this plan just ensures the default-title guard
    exists so 017 can safely build on it without a `title_set_manually` flag
    (research G5-2) existing yet.
  - `SessionEnd` → `agent.status.set` → `idle` (covers Ctrl+C, where `Stop`
    does not fire).
  - `PreToolUse` (matcher `AskUserQuestion|ExitPlanMode`) → `agent.status.set`
    → `blocked`. This must be **observe-only**: return no
    `permissionDecision`/`updatedInput` in the hook response, since Kiri runs
    claude interactively in a real PTY (not headless `-p` mode) — the tool's
    normal interactive prompt should render untouched in the terminal panel.
  - `PermissionRequest` (matcher: all tools) → same observe-only
    `blocked` set, wired for forward-compat even though it's expected inert
    under `--dangerously-skip-permissions` today.
  - `PostToolUse` (matcher `TodoWrite`) → parse the todos from the payload
    (shape confirmed empirically per the note above) and call the new
    `agent.tasks.replace` operation with `source: 'claude'` — this is
    research item G3-1's fix.
- New `kirictl claude-hook <event>` subcommands in `src/cli/kirictl.ts`
  (sibling to `codexHookCommand`, 70-73), one per event above, each reading
  stdin (fd 0, `async: true` means codex-style stdin-file plumbing is not
  needed — claude does not block waiting on this process either way) and
  calling `runKiriOperationWithBackendFallback` (195-202) with the
  appropriate operation, exactly like `callCommand`/`runTermOperation`
  already do — do not invent a second dispatch path.
- New operations `agent.status.set` and `agent.tasks.replace` in
  `src/lib/contracts.ts` (`kiriWriteOperations`, 624-654), wired in
  `kiri-router.ts` and `kiri-control.ts` the same way `session.rename` is
  (`kiri-router.ts:324-326`, `kiri-control.ts:181-184,400`), reusing
  `db.ts`'s existing `setAgentStatus` (573-575) and `replaceAgentTasks`
  (603-610) directly — no new DB-layer code needed.
- `claudeLaunch` (`terminal-launch.ts:180-225`): generate a small
  Kiri-owned settings JSON (written once per launch to the session dir,
  e.g. `join(config.sessionDir, 'claude-hooks-settings.json')`) containing
  only the `hooks` key described above, and append `'--settings', <path>`
  to `args` (185-191).

**Verify**: `pnpm typecheck` → 0. New `tests/server/claude-hook-handler.test.ts`
mirroring `codex-hook-handler.test.ts`'s structure (one test per event: env
absent → logged no-op; well-formed payload → correct DB effect via a fake/
injected control). Update `terminal-launch.test.ts`'s claude tests (68-189)
to assert `--settings <path>` is present and the file's `hooks` key contains
all seven events with the matchers/`async` flags described above.
`pnpm exec vitest run tests/server/terminal-launch.test.ts tests/server/claude-hook-handler.test.ts` → pass. Manual: launch a real claude
terminal session, submit a prompt, confirm agent status flips to `running`
then `idle` without the model ever being asked to call `session.rename`;
call `TodoWrite` and confirm `agent_tasks` rows appear with
`source='claude'`.

### Step 4: PATH-shim wrappers for typed/re-exec/resume agents (P2)

Reference design (cmux's, adapted): a POSIX shell script per runtime
(`codex`, `claude`), generated once into a stable directory (e.g.
`~/.kiri/shim/bin/`), that:

1. **Self/loop-guards**: bail immediately to a plain `exec "$REAL" "$@"` if a
   marker env var (e.g. `KIRI_SHIM_ACTIVE=1`, set by the wrapper itself
   before it execs) is already present — never resolve back to itself or
   double-wrap a nested invocation.
2. **Resolves the real binary** by searching `PATH` with the shim directory
   removed (never trust `which codex` naively, since that could recurse into
   the shim itself).
3. **Injects the same flags Kiri's own direct launch builds** — refactor
   `codexSessionStartHookArgs`/`codexKiriConfigArgs` (Step 2) and the claude
   `--settings` bundle (Step 3) into small pure functions callable from a new
   `kirictl term shim-args <runtime>` subcommand, so the *shell script* never
   duplicates flag-building logic — it just calls `kirictl term shim-args
   codex` (or `claude`) and splices the returned argv into `"$@"` before the
   final `exec`.
4. **Always falls through to `exec`ing the real binary untouched** if any of
   the above steps fail for any reason (kirictl unavailable, malformed argv,
   anything) — the wrapper must never be able to break a hand-typed command.
5. **Strips `KIRI_*`/`TERMINFO`** before the final `exec` *except* the
   specific `KIRI_AGENT_ID`/`KIRI_SESSION_DIR`/`KIRI_PROJECT_CWD`/
   `KIRI_RUNTIME`/`KIRI_MODEL` this exact invocation needs — the point is to
   stop stale identity from an *outer* Kiri-managed context bleeding into a
   *nested* invocation (e.g. a subshell spawned from inside an agent that
   then also types `codex`), not to strip the identity this invocation
   itself is establishing.
6. **Recognizes resume**: for `codex resume <id>` / claude's
   `--resume`/`--continue`, parse the id from argv the same way cmux does,
   so a hand-typed resume gets the same rebind treatment as Step 1's
   app-spawned one.

Wire the PATH prepend into `src/server/terminal-env.ts` (a new
`shimBinDir(context)`/exported helper) and call it **only** from
`shellTerminalEnv` (`terminal-launch.ts:472-479`). PATH-ordering caution:
`runtimeProcessEnvWith` (`runtime-binaries.ts:121`) already *prepends*
desktop bin dirs to the inherited `PATH` — the shim dir must land in front
of those desktop entries in the final assembled `PATH`, or `which codex`
resolves the real Homebrew binary first and the shim never runs. Leave `baseTerminalEnv`
(used for Kiri's own direct runtime-mode spawns) untouched, since Kiri
already injects hooks correctly there and shimming it too would be pure
redundancy. New `src/server/terminal-shim.ts` holds the wrapper script
templates + idempotent generation (hash-compare existing file contents,
only rewrite on change — do not regenerate on every terminal spawn).

**Explicit limitation — document, do not solve here**: `shellTerminalEnv`
today sets only `KIRI_PROJECT_CWD` (no `KIRI_AGENT_ID`/`KIRI_SESSION_DIR`,
since a shell terminal is project-scoped, not agent-scoped — research H8).
So a hand-typed `codex`/`claude` mediated by this shim, with no ambient
Kiri identity in the shell env, will have its injected hooks fire and
harmlessly no-op exactly as they do today (`codex-hook-handler.ts:20`'s
env-absent branch). This step delivers the *mediation mechanism* — safe,
idempotent, always-correct fallback — not full session-minting for
hand-typed invocations (making them show up as first-class Kiri GUI
sessions is a separate, larger feature: new agent_slot lifecycle semantics,
not a hooks change). Flag this clearly in the PR description so it isn't
mistaken for "typed codex now shows up in the sidebar."

**Verify**: `pnpm typecheck` → 0. New test coverage for
`terminal-shim.ts`'s generation logic (idempotent — second call with
unchanged template doesn't rewrite the file; changed template does) and for
`shim-args` argv construction. Manual: open a Kiri shell terminal, `echo
$PATH | tr : '\n' | head` and confirm the shim dir is prepended; run `which
codex` and confirm it resolves to the shim; run a real `codex "hello"` and
confirm it still works identically to running it outside Kiri (always-exec-
real fallback holds).

### Step 5: pid-anchored codex transcript resolution (P2)

Thread `proc.pid` from `getOrCreateTerminalSession`
(`terminal-server.ts:465`) into `rememberCodexTerminalSession`'s input
(`codex-cli-sessions.ts:104-165`, add `pid` to
`RememberCodexTerminalSessionInput`), and further into
`waitForLatestCodexSessionForCwd`/`findLatestCodexSessionForCwd`
(`CodexSessionDiscoveryInput`, add optional `pid`).

In `findLatestCodexSessionForCwd` (56-102), when a `pid` is supplied and a
candidate matches cwd: before falling back to the `closestToMs`/newest
heuristic, shell out to `lsof -p <pid>` (available by default on macOS — no
missing-binary risk like Step 2's `timeout` concern) and check whether the
candidate's resolved path appears among that pid's open files. A pid-open
match is treated as a confirmed unique match regardless of timestamp
proximity — this directly fixes the concurrent-same-cwd-launch cross-mapping
described in research B6. If `lsof` is unavailable, times out, or finds no
match for *any* candidate, fall back to the existing `closestToMs` heuristic
unchanged (never regress availability — this is a confidence upgrade, not a
replacement gate).

**Verify**: `pnpm typecheck` → 0. New test in
`tests/server/codex-cli-sessions.test.ts` with two synthetic same-cwd
session files and a fake `lsof` result confirming one pid — assert the
pid-confirmed candidate is chosen over the closest-timestamp one when they
disagree. `pnpm exec vitest run tests/server/codex-cli-sessions.test.ts` →
pass. Manual: open two codex sessions in the same project within a couple
seconds of each other and confirm each binds to its own rollout (check
`codex-hook-session.json`/`codex-session-id` per session dir differ and
each matches the session actually shown in that agent's terminal).

### Step 6: Defensive parity (P3)

- **`notify` slot non-clobber**: confirmed today that Kiri never touches
  `~/.codex/config.toml`'s `notify` key anywhere in the codebase (grep
  clean) — the invariant already holds. Add a one-line comment at
  `codexKiriConfigArgs`/`codexSessionStartHookArgs` (`terminal-launch.ts:
  340-365`) stating this must stay true: any future codex "notify"
  integration must use an ephemeral `--config` override (as everything else
  here does), never write `config.toml`.
- **Unset `CLAUDECODE` for nested claude**: in `claudeLaunch`
  (`terminal-launch.ts:207-214`), add `delete env.CLAUDECODE` alongside the
  existing `ANTHROPIC_*` deletions (209-213) — prevents a claude session
  Kiri launches from being misdetected as "nested" when Kiri's own backend
  process happens to have inherited `CLAUDECODE=1` from its own launch
  environment (a real scenario during development).
- **`CLAUDE_CONFIG_DIR` reconcile**: in `claudeLaunch`, when `homePath` is
  set (line 214's existing condition), also set `env.CLAUDE_CONFIG_DIR =
  join(homePath, '.claude')` so it can never diverge from the directory
  `claudeSessionExists` (290-300) already checked against; when `homePath`
  is *not* set, `delete env.CLAUDE_CONFIG_DIR` so an ambient override can't
  silently redirect claude away from the default `~/.claude` Kiri assumed.
- **`codexHooksSupported` TTL** (research B7): change
  `codexHookSupportByCommand` (`terminal-launch.ts:90`) from
  `Map<string, boolean>` to `Map<string, { supported: boolean; checkedAtMs:
  number }>`, add a TTL constant (e.g. 5 minutes) in `codexHooksSupported`
  (392-408) — re-probe via `--help` once the cached entry is stale, so a
  codex binary upgrade (adding hook support) is picked up without an app
  restart.
- **`codex-hook-handler.ts` silent no-op** (research G4-4): change the
  early return at line 20 from `return { ok: true }` to `return { ok: true,
  reason: 'KIRI_SESSION_DIR/KIRI_AGENT_ID not set; skipping' }`, and in
  `kirictl.ts`'s `codexHookSessionStartCommand` (58-68) log the reason
  whenever present, not only on `!result.ok` — an operator should be able to
  tell "hook fired but no-op'd" from "hook never fired" from "hook failed"
  in the log Step 2's backgrounded process already redirects to. Related:
  `codexHookSessionStartCommand` exits 0 even when the handler fails
  (`kirictl.ts:64`) — keep that (a hook failure must never block a codex
  launch, and after Step 2 codex isn't waiting anyway), but make sure the
  failure detail lands in the same log so fail-open isn't also fail-silent.

**Verify**: `pnpm typecheck` → 0. Extend `tests/server/terminal-launch.test.ts`
for `CLAUDECODE`/`CLAUDE_CONFIG_DIR` env assertions in the claude launch
tests, and add a TTL-expiry test for `codexHooksSupported` (fake clock,
assert re-probe after TTL). Extend `tests/server/codex-hook-handler.test.ts`
for the new `reason` field on the env-absent case. `pnpm exec vitest run
tests/server/terminal-launch.test.ts tests/server/codex-hook-handler.test.ts` → pass.

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt doesn't match live code (drift) — especially
  `codexLaunch`/`claudeLaunch`'s exact line ranges, `spawnPty`'s call site
  in `terminal-server.ts`, or `CodexHookSessionBinding`'s shape. Several
  steps depend on exact structure, not just approximate location.
- Live testing against a real `claude`/`codex` binary contradicts any of
  the "verify at implementation time" items flagged in Step 3 (hook event
  names, matcher support, `TodoWrite` payload shape, `PermissionRequest`
  behavior under `--dangerously-skip-permissions`, repeated-`--settings`
  behavior) — these were confirmed against live docs during planning but
  explicitly flagged as needing empirical confirmation against the pinned
  CLI version; do not silently work around a mismatch, escalate it.
  the PATH-shim (Step 4) can execute arbitrary flag injection into a
  hand-typed command; if the always-exec-real fallback path is ever bypassed
  by a bug, that is a correctness-and-safety issue, not a style nit.
- Step 5's `lsof` dependency is unavailable in a target deployment
  environment (e.g. a locked-down sandbox) — do not silently no-op the
  pid-anchoring; fall back to the existing heuristic explicitly and flag it,
  since B6 (concurrent same-cwd cross-mapping) would otherwise remain
  unfixed there.
- Steps 1/2/3/5/6 touch `src/server/codex-runtime.ts`, `codex-app-server.ts`,
  or `codex-retained-state.ts` in any way — those are Plan 013's territory
  (thread-id space, not terminal-session-id space); if a fix here seems to
  require changing one of those files, stop, that's scope creep into 013.

## Maintenance notes

- Step 2's fire-and-forget rewrite and Step 3's `async: true` hooks both
  reduce launch-latency risk to near zero; if a future codex/claude version
  adds a native async-hook mechanism for codex too, Step 2's shell-script
  workaround should be simplified/removed in favor of it — note that in
  whichever plan does the codex version bump.
- Step 4's shim mechanism is intentionally a no-op for hand-typed sessions
  until a follow-up gives shell terminals their own identity anchor
  (`KIRI_AGENT_ID` equivalent). If that follow-up plan is picked up, revisit
  the "strips `KIRI_*` except this invocation's own" logic in Step 4 —  it
  was designed against today's project-scoped-only shell env and may need
  adjusting once shells can carry a per-invocation identity.
- Plan 017 should treat Step 3's `agent.status.set`/`agent.tasks.replace`
  operations and the conservative default-title guard as a stable
  foundation — it should not need to touch `claude-hook-handler.ts`'s event
  wiring, only add smarter logic behind the existing hooks.
