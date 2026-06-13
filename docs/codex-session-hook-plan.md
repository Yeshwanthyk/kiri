# Codex Session Tracking via SessionStart Hook — Implementation Plan

## Problem

Kiri cannot tell Codex which session id to use (Codex has no `--session-id` equivalent),
so today it *guesses*: after launching `codex`, `rememberCodexTerminalSession`
(`src/server/codex-cli-sessions.ts`) polls `~/.codex/sessions/**/*.jsonl` for up to 60s
and latches the session whose first-line `session_meta.payload.cwd` matches the agent cwd
and whose timestamp is closest to launch. The guessed id is written to
`<sessionDir>/codex-session-id` and to agent runtime state (`codexSessionId`), and every
future launch runs `codex resume <id>`.

The heuristic mis-latches in practice:

1. `~/.codex/sessions` is shared by every Codex frontend on the machine (verified on this
   machine: originators `Codex Desktop`, `claw`, `codex-tui`, `Litter`, VS Code extensions —
   several in the same cwds Kiri uses). Any of them creating/touching a session in the same
   cwd inside the polling window can win "closest to launch".
2. The freshness filter uses **mtime** (`codex-cli-sessions.ts:59`), so an *old* session
   being appended to by another tool passes `newerThanMs`.
3. Codex multi-agent **subagent rollouts** (`payload.thread_source: "subagent"`) live in the
   same dir with the same cwd and near-identical timestamps — latching one yields the
   "resumed an empty session" symptom.
4. Multiple Kiri agents launched in the same cwd within seconds are indistinguishable.
5. A wrong id is sticky: once persisted, every relaunch resumes the wrong session.

## Fix (decided): SessionStart hook

Codex CLI ≥ ~0.124 ships a lifecycle-hooks system (feature flag `hooks`, **stable**, off by
default — confirmed via `codex features list` on codex-cli 0.139). A `SessionStart` command
hook receives JSON on **stdin**:

```json
{
  "session_id": "019e...",
  "hook_event_name": "SessionStart",
  "source": "startup | resume | clear | compact",
  "cwd": "/abs/path",
  "transcript_path": "/Users/x/.codex/sessions/2026/06/12/rollout-...jsonl",
  "model": "gpt-5.5",
  "permission_mode": "default"
}
```

Hook processes **inherit the full codex process environment** (no `env_clear` in
`codex-rs/hooks/src/engine/command_runner.rs`). Kiri already sets `KIRI_AGENT_ID` and
`KIRI_SESSION_DIR` in the codex env (`baseTerminalEnv`, `src/server/terminal-launch.ts:380`).
So the hook can write the binding `agentId → session_id` with zero IPC: it writes into
`$KIRI_SESSION_DIR`, which is exactly where the launcher already reads
`codex-session-id` from (`src/server/codex-terminal-session.ts`).

Push-based, exact, per-terminal: codex reports its own id, keyed by our env. It fires on
every session start *including* `source: "resume"` and `source: "clear"`, so the binding
self-heals if codex forks ids on resume or the user `/clear`s into a new session.

Trust: hooks normally require interactive approval (`trusted_hash` persisted in user
config). `--dangerously-bypass-hook-trust` (present in 0.139; applies to `codex`, `resume`,
`fork`, `exec`) skips trust per-invocation. Kiri already passes
`--dangerously-bypass-approvals-and-sandbox`, so this is consistent with the existing
posture.

### Verified facts the implementer can rely on (codex-cli 0.139, checked locally + upstream source)

- Local recheck on this machine: `codex --version` → `codex-cli 0.139.0`;
  `codex features list` → `hooks  stable  false`; `codex --help`, `codex resume --help`,
  and `codex exec --help` all expose `--dangerously-bypass-hook-trust`.
- Enable per-launch with `--enable hooks` (equivalent to `-c features.hooks=true`).
  **Spike step 0 must still confirm the exact feature key** — upstream docs have also
  referred to `features.codex_hooks`; trust the local `codex features list` output over docs.
- Hook config sources (precedence low→high): `$CODEX_HOME/hooks.json`, inline `[hooks]`
  tables in `config.toml`, trusted `<repo>/.codex/hooks.json`, plugin
  `<plugin_root>/hooks/hooks.json`.
- `-c key=value` overrides parse the value as TOML and land in a "session flags" config
  layer. The hooks engine reads hooks from config layers, so per-launch
  `-c 'hooks.SessionStart=[...]'` *should* work — this is the preferred injection path and
  **spike step 0 must confirm it**; fallback is documented below.
- hooks.json / TOML hook shape (event key → matcher groups → handlers):

  ```json
  {
    "hooks": {
      "SessionStart": [
        { "hooks": [ { "type": "command", "command": "<shell string>", "timeout": 10 } ] }
      ]
    }
  }
  ```

  TOML equivalent (what a `-c` override expresses):

  ```toml
  [[hooks.SessionStart]]
  [[hooks.SessionStart.hooks]]
  type = "command"
  command = "/path/to/handler"
  timeout = 10
  ```

  `matcher` omitted/empty = match all sources. `timeout` is **seconds** (default 600).
  `async` is parsed but a no-op. Handler runs via shell with cwd = session cwd.
- Hook stdout is interpreted: plain-text stdout becomes `additionalContext` injected into
  the model; JSON stdout must match the output schema. **The handler must print nothing to
  stdout** and always exit 0 (exit 2 has blocking semantics on some events).
- Hooks are not supported on Windows (irrelevant for Kiri's mac/linux targets, but gate
  anyway).

## Architecture

```
codex launch (terminal-launch.ts codexLaunch)
  args += hook flags + -c hook config (gated on codex version/feature support)
  env already has KIRI_AGENT_ID, KIRI_SESSION_DIR
        │
        ▼  codex starts/resumes a thread, fires SessionStart hook
kiri codex hook handler  (new kirictl subcommand, runs inside codex env)
  reads stdin JSON  ──►  writes atomically:
                          $KIRI_SESSION_DIR/codex-session-id          (existing format, id only)
                          $KIRI_SESSION_DIR/codex-hook-session.json   (rich binding, see below)
        │
        ▼
rememberCodexTerminalSession (codex-cli-sessions.ts, runs in app or daemon-client process)
  resolution ladder:
    1. runtime state resume id (existing short-circuit)
    2. poll for hook binding (fast: file watch/poll ~15s)        ◄── NEW primary
    3. legacy JSONL scan (hardened, never overwrites a hook binding) ◄── fallback only
  on success: sync codexSessionId into agent runtime state (db) as today
        │
        ▼
next launch: codexLaunch resume precedence
    state.resume  ??  hook binding / codex-session-id file  ??  state.codexSessionId
  (file moves ABOVE state.codexSessionId — the hook rewrites it on every session start,
   so it is strictly fresher than db state)
```

### Binding file format — `codex-hook-session.json`

Written atomically (unique tmp + rename) next to `codex-session-id`, mode 0600:

```json
{
  "version": 1,
  "agentId": "<KIRI_AGENT_ID>",
  "sessionId": "<payload.session_id>",
  "source": "startup",
  "cwd": "<payload.cwd>",
  "transcriptPath": "<payload.transcript_path>",
  "model": "<payload.model>",
  "hookEventName": "SessionStart",
  "writtenAtMs": 1760000000000
}
```

`codex-session-id` (plain id + newline) stays the resume key so all existing readers keep
working; the JSON file is for freshness checks, debugging, and future use (transcript path
projection). `writtenAtMs` lets `rememberCodexTerminalSession` distinguish a binding from
*this* launch (`writtenAtMs >= launchedAtMs - 2000`) from a stale one left by a previous
run.

## Implementation phases

### Phase 0 — Spike (do this first; it pins two open questions)

Write a throwaway script (do not commit) that:

1. Confirms the feature key: run
   `codex --enable hooks --dangerously-bypass-hook-trust -c 'hooks.SessionStart=[{hooks=[{type="command",command="touch /tmp/kiri-hook-fired"}]}]' exec 'say hi'`
   (or the TUI with a scripted prompt) and check `/tmp/kiri-hook-fired` appears.
   - If `--enable hooks` is rejected, try `-c features.hooks=true`, then
     `-c features.codex_hooks=true`. Record the working incantation.
2. Confirms the `-c` inline-hooks path works (hook fires without any `hooks.json` on disk).
   - **If it does not**: fallback injection is a Kiri-managed entry in the launched Codex
     process's effective `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`; respect
     `KIRI_CODEX_HOME` when Kiri sets `CODEX_HOME`). Create the file if absent, preserve
     unknown keys, and key the Kiri entry by the exact handler command string so the merge is
     idempotent and removable. Keep the merge logic in one module with tests.
3. Confirms the stdin payload fields (`session_id`, `source`, `transcript_path`) and that
   `KIRI_AGENT_ID` is visible in the hook env: point the hook at
   `sh -c 'cat > /tmp/kiri-hook-payload.json; env | grep KIRI_ > /tmp/kiri-hook-env'`.
4. Confirms `codex resume --enable hooks --dangerously-bypass-hook-trust -c ... <id>`
   accepts the same flags and fires with `source: "resume"`.
5. Record the minimum codex version that supports all of the above (hooks landed around
   0.124 per upstream issue #19199; `--dangerously-bypass-hook-trust` may be newer —
   `codex --help | grep bypass-hook-trust` against old binaries if available, otherwise
   gate on the version you verified, 0.139).

Document the results at the top of the PR description and in a short
`docs/codex-session-hook-spike.md`.

### Phase 1 — Hook handler (new kirictl subcommand)

**New file: `src/server/codex-hook-handler.ts`**

- `export async function handleCodexSessionStartHook(input: { stdin: string; env: NodeJS.ProcessEnv })`
  — pure-ish core, returns `{ ok: boolean; reason?: string }` for testability:
  - Parse stdin JSON; require `hook_event_name === 'SessionStart'` and a non-empty
    `session_id` (reuse `normalizeCodexSessionId`).
  - Require `env.KIRI_SESSION_DIR` (absolute path) and `env.KIRI_AGENT_ID`; if either is
    missing this codex run was not launched by Kiri → no-op success (the hook config may
    leak to user-launched codex if the fallback `hooks.json` merge path is used; a no-op
    keeps that harmless).
  - Write `codex-session-id` via `writeCodexTerminalSessionId` (existing,
    `src/server/codex-terminal-session.ts`) **but make the write atomic**: extend
    `writeCodexTerminalSessionId` to write a unique temp file beside the destination
    (`<file>.<pid>.<random>.tmp`, mode 0600) then `renameSync`. Do not use a fixed
    `<file>.tmp`: two writers can race, and one rename can steal the other's temp file.
  - Write `codex-hook-session.json` through the same unique-temp + rename helper, shape above.
  - Never throw to the caller; map all failures to `{ ok: false, reason }`.
- Add reader: `readCodexHookSessionBinding(sessionDir): { agentId, sessionId, writtenAtMs, source, transcriptPath } | undefined`
  (tolerant: missing file / bad JSON / wrong version → undefined). Put it in
  `codex-terminal-session.ts` next to the existing readers.

**`src/cli/kirictl.ts`** — add a hidden-ish subcommand:

```
kirictl codex-hook session-start
```

- Reads stdin fully (codex closes it after writing the payload), calls the handler,
  **writes nothing to stdout**, logs failures to stderr, always exits 0.
- Follow the existing `@effect/cli` Command pattern (`Command.make` + `withSubcommands`);
  it does NOT need `KiriControl`/db — keep it dependency-free so it starts fast (hook
  runtime budget is small; set hook `timeout` to 10s; the `pnpm exec tsx` dev path is slow
  to boot, which is why the timeout is generous).

### Phase 2 — Launch flags (`src/server/terminal-launch.ts`)

In `codexLaunch`:

1. Resolve the hook handler command string with the same ladder as
   `buildKiriMcpServerConfig` (`terminal-launch.ts:229`): packaged helper wrapper →
   `dist/cli/kirictl.mjs` via `execPath` → `pnpm exec tsx src/cli/kirictl.ts`. Factor the
   ladder into a shared helper
   (`resolveKirictlInvocation(context, args): { command: string; args: string[] }`) used by
   both the MCP config and the hook command, then render the hook command as a single
   shell-quoted string.
   - Packaged caveat: `resources/bin/kiri-mcp` currently hardcodes `kirictl mcp`. Either
     change that wrapper to default to `mcp` when no args are provided and forward explicit
     args otherwise, or add a second packaged `kirictl` wrapper. The hook path must execute
     `kirictl codex-hook session-start`, not `kirictl mcp codex-hook session-start`.
   - Add a proper shell-quoting helper (single-quote wrapping with `'\''` escaping) and quote
     every command/arg part before joining. `tomlString` is JSON-escaping for TOML, not shell.
2. Append, for **both** fresh launch and resume paths (gated, see 3):
   - `--enable hooks` (or the spike-confirmed equivalent)
   - `--dangerously-bypass-hook-trust`
   - `--config 'hooks.SessionStart=[{hooks=[{type="command",command=<quoted>,timeout=10}]}]'`
     — build the TOML value with the existing `tomlString` helper for the command string.
     Note `--config` is the long form already used for the MCP args; keep consistent.
3. **Version gate**: old codex builds reject unknown flags and the launch would die.
   - Add `KIRI_CODEX_HOOKS=0|1` env override (preferences plumbing optional, env is enough
     for v1; default on).
   - Detect support once per binary path: run `codex --help` (or `codex features list`)
     at first codex launch, grep for `dangerously-bypass-hook-trust`, cache the result in
     a module-level map keyed by resolved binary path. This runs in the daemon/app process
     before spawn — synchronous `spawnSync` with a 5s timeout is acceptable here, but keep
     it cached. If unsupported → skip all hook flags (legacy scan still works).
4. Resume precedence change (the sticky-wrong-id fix):

   ```ts
   const resume = stringValue(state.resume)
     ?? readCodexTerminalSessionId(config.sessionDir)   // hook keeps this fresh
     ?? stringValue(state.codexSessionId)
   ```

   `state.resume` stays first (explicit user/server intent). The file moves above db state
   because the hook rewrites it on every session start. Update
   `codexResumeIdFromState` usage in `codex-cli-sessions.ts:107` to match the same order
   (it takes `sessionDir` as an extra parameter).

### Phase 3 — Discovery ladder (`src/server/codex-cli-sessions.ts`)

Rework `rememberCodexTerminalSession`:

1. Keep the existing short-circuit on an already-known resume id (now including the
   hook-binding file per the Phase 2 precedence). If the short-circuit uses a hook binding,
   require `binding.agentId === config.id`; stale or mismatched bindings are ignored.
2. **New primary wait**: poll `readCodexHookSessionBinding(config.sessionDir)` every 250ms
   for up to `hookWaitMs` (default 15_000), accepting only bindings with
   `binding.agentId === config.id` and `writtenAtMs >= input.launchedAtMs - 2000`. On hit:
   ensure `codex-session-id` matches (the hook already wrote it),
   `setAgentRuntimeState(... codexSessionId)`, respect the existing
   `latestLaunchTokenByAgentId` guard, return true.
3. **Fallback** (only after the hook wait expires — covers gated-off hooks and old codex):
   run the existing JSONL scan with three hardenings:
   - skip candidates whose `session_meta.payload.thread_source === 'subagent'`;
   - filter on `statSync(...).birthtimeMs` (fall back to `mtimeMs` when birthtime is 0,
     which happens on some Linux filesystems) instead of `mtimeMs`;
   - before persisting, re-check the hook binding; if one appeared meanwhile, prefer it
     and discard the scan result.
4. Total wall-clock should not grow beyond today's default 60s scan window. Treat
   `attempts * intervalMs` as the overall discovery budget; the hook wait consumes the first
   slice (up to `hookWaitMs`), and the legacy scan gets the remaining attempts/deadline.
   Keep `attempts`/`intervalMs` knobs and add `hookWaitMs` to
   `RememberCodexTerminalSessionInput` for tests.

The daemon path needs no protocol change: `rememberCodexTerminalSession` already runs on
the client side fed by `codexLaunches` from `POST /api/agents/spawn`
(`kiriterm-daemon-client.ts:89`), and the hook writes to `config.sessionDir`, visible to
both processes. Verify `launchedAtMs` recorded by the daemon (`terminal-server.ts:463`) is
what flows through — it is.

### Phase 4 — Tests

Follow the existing test layout (`tests/server/*.test.ts`, plain `vitest` with temp dirs —
see `tests/server/codex-cli-session-memory.test.ts` for the current scan tests).

1. **`tests/server/codex-hook-handler.test.ts`** (new):
   - valid payload + env → both files written, atomic content correct, id normalized;
   - missing `KIRI_SESSION_DIR`/`KIRI_AGENT_ID` → ok-noop, nothing written;
   - malformed JSON / wrong `hook_event_name` / empty `session_id` → ok:false, nothing written;
   - overwrite: second SessionStart (e.g. `source: "clear"` with new id) replaces both files.
2. **`tests/server/codex-cli-session-memory.test.ts`** (extend):
   - hook binding appears mid-poll → returned id is the binding, db state synced, scan never
     latches a competing JSONL;
   - stale binding (`writtenAtMs` older than launch) is ignored, scan fallback used;
   - mismatched binding (`agentId !== config.id`) is ignored;
   - scan skips `thread_source: "subagent"` first lines;
   - scan uses birthtime: a file created *before* launch but appended *after* launch is
     rejected;
   - scan result does not overwrite a binding that appeared during the scan;
   - launchToken guard still respected on the hook path (relaunch while polling).
3. **`tests/server/terminal-launch.test.ts`** (extend):
   - codex args contain `--enable hooks`, `--dangerously-bypass-hook-trust`, and a
     `--config hooks.SessionStart=...` entry whose command string is shell-quoted and ends
     with `codex-hook session-start` (assert for both fresh and resume launches);
   - flags absent when support-detection reports unsupported or `KIRI_CODEX_HOOKS=0`;
   - resume precedence: file beats `state.codexSessionId`; `state.resume` beats file.
   - packaged helper/wrapper invocation forwards `codex-hook session-start` correctly instead
     of hardcoding `mcp`.
4. **Manual verification** (document commands in the PR):
   - launch a Kiri codex terminal, confirm `codex-hook-session.json` appears within ~2s and
     matches the id in the codex TUI (`/status` shows the session id);
   - run two Kiri codex agents in the same cwd simultaneously → distinct, correct ids;
   - `/clear` inside codex → binding rewritten with the new id; relaunch resumes the
     post-clear session;
   - kill and relaunch the agent → `codex resume <id>` lands in the same conversation.

### Phase 5 — Cleanup / docs

- Note the new files (`codex-hook-session.json`) in whatever session-dir documentation
  exists; bump nothing persistent (db schema untouched — `codexSessionId` runtime-state key
  unchanged).
- Keep the legacy scan code; it is the only path for codex < hook-support and when the
  user disables hooks. Do **not** delete `findLatestCodexSessionForCwd`.
- Out of scope (explicitly): UserPromptSubmit/Stop hooks, transcript projection from
  `transcriptPath`, originator tagging (`CODEX_INTERNAL_ORIGINATOR_OVERRIDE`) — a separate
  cheap hardening that can layer on later.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `-c` inline hooks not honored from session-flags layer | Spike step 0.2; fallback = idempotent marked merge into the launched process's effective `$CODEX_HOME/hooks.json` |
| Old codex rejects new flags → launch fails | Per-binary support detection + `KIRI_CODEX_HOOKS=0` escape hatch |
| Hook stdout pollutes model context | Handler writes nothing to stdout, ever (test asserts this) |
| Slow `tsx` boot in dev exceeds hook patience | hook `timeout=10` (seconds); handler is dependency-free |
| Two writers race on `codex-session-id` (hook vs scan) | Atomic unique-temp + rename writes; scan re-checks binding before persisting; hook wait runs *before* scan |
| Hook config leaks to non-Kiri codex runs (hooks.json fallback only) | Handler no-ops without `KIRI_SESSION_DIR`/`KIRI_AGENT_ID` |
| Feature flag name drift (`hooks` vs `codex_hooks`) upstream | Spike pins it; support detection greps `--help` output rather than assuming |
| Packaged wrapper runs the wrong subcommand | Make `resources/bin/kiri-mcp` default to `mcp` only when no args are passed, or ship a separate `kirictl` wrapper; test the hook invocation path |

## Key existing code references

- `src/server/codex-cli-sessions.ts` — discovery/persist logic to rework
- `src/server/codex-terminal-session.ts` — `codex-session-id` read/write (add binding reader, atomic writes)
- `src/server/terminal-launch.ts:273` (`codexLaunch`), `:229` (`buildKiriMcpServerConfig` resolution ladder), `:380` (`baseTerminalEnv` — already sets `KIRI_AGENT_ID`/`KIRI_SESSION_DIR`)
- `src/server/terminal-server.ts:463` — `launchedAtMs`/`launchToken` capture
- `src/server/kiriterm-daemon-client.ts:89` — daemon-side codex launch relay
- `src/cli/kirictl.ts` — CLI to extend
- `tests/server/codex-cli-session-memory.test.ts`, `tests/server/terminal-launch.test.ts` — test homes
