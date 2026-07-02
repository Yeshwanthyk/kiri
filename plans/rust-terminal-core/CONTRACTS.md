# Kiriterm Replacement — Exact Contract Spec

> Authoritative reference for the P1/P2 implementer. Every route/frame/
> marker below is a **behavior `kiri-termd` must reproduce** (the wire
> format itself may change once the native patch client lands — see
> `00-overview.md` D3/D4). Extracted from source at HEAD=48acb9f.


## 1. Working Flows Inventory

| Flow | Entry point | Terminal contract used |
|---|---|---|
| Interactive shell panes/tabs/splits | `TerminalWorkspace` persists per-project layout in `localStorage` and renders one `TerminalPanel` per pane with `mode="shell"` + `termId` (`src/components/kiri-board/terminal-workspace.tsx:26`, `:30`, `:249`) | `terminalConfigQuery` GET, then WS `/terminal?agentId&mode=shell&cols&rows&token&termId`; shell key is `${projectId}:shell` or `${projectId}:shell:${termId}` (`src/components/kiri-board/terminal-panel.tsx:393`, `:659`; `src/server/terminal-registry.ts:139`) |
| Agent runtime terminal pane | `TerminalPanel` for selected terminal-mode agent (`src/components/kiri-board/terminal-panel.tsx:44`) | `terminalConfigQuery` GET `{agentId, mode}`; backend calls `prepareAgent`, daemon may spawn runtime before WS; runtime key `${agentId}:runtime` (`src/server/workspace.ts:141`; `src/server/workspace-service.ts:418`; `src/server/terminal-registry.ts:139`) |
| WS attach/stream/steer | `TerminalPanel.openSocket` (`src/components/kiri-board/terminal-panel.tsx:333`) | Sends WS `resize`, `input`, `ack`; receives `snapshot`, `data`, `replaced`, `exit` (`src/components/kiri-board/terminal-panel.tsx:233`, `:341`, `:466`, `:226`) |
| Runtime launch: codex/claude/pi/opencode | `TerminalServerApi.prepareAgent/spawnAgentRuntime` (`src/server/terminal-server.ts:62`, `:66`) | Embedded resolves DB directly; daemon requires `/api/agents/upsert` then `/api/agents/spawn` (`src/server/kiriterm-daemon-client.ts:124`, `:139`, `:146`) |
| MCP `kiri_get/kiri_do` terminal ops | MCP tools call `runKiriOperation` (`src/server/kiri-mcp.ts:34`, `:48`) | Router maps `terminal.read/list/input/keys/wait-for/spawn/kill` to `KiriControl`, which calls `terminalControlRequest` or `pasteAgentRuntimeTerminal` (`src/server/kiri-router.ts:290`, `:349`; `src/server/kiri-control.ts:569`, `:589`, `:603`, `:620`, `:705`) |
| CLI `kirictl term *` | `kirictl term ls/read/input/keys/wait-for/stop` (`src/cli/kirictl.ts:155`, `:159`, `:165`, `:178`, `:188`, `:130`) | Uses Kiri operation surface for terminal ops; `term stop` directly POSTs daemon `/api/shutdown` (`src/cli/kirictl.ts:215`, `:137`) |
| Workflow orchestration | `workflow.await` in `KiriControl.workflowAwait` (`src/server/kiri-control.ts:634`) | Return mode calls `/api/sessions/wait-any`; wake mode calls `/api/sessions/subscribe` (`src/server/kiri-control.ts:670`, `:693`) |
| Workflow dispatch terminal delivery | `deliverWorkflowPrompt` queues terminal paste (`src/server/workflow-orchestration.ts:249`) | Queue DB input, optionally `pasteAgentRuntimeTerminal` when `KIRI_WORKFLOW_SPAWN_TERMINALS=1` (`src/server/workflow-orchestration.ts:260`) |
| Scratchpad trigger | `triggerScratchpadSessionWithDeps` (`src/server/scratchpad-trigger.ts:159`) | Terminal-mode creates session, queues block body, optionally spawns via `pasteAgentRuntimeTerminal` (`src/server/scratchpad-trigger.ts:180`) |
| Runtime cleanup | Archive/delete cleanup (`src/server/runtime-cleanup.ts:33`) | Closes runtime via `/api/agents/close-runtime`; project delete kills shell prefix via `/api/sessions/kill-prefix` (`src/server/terminal-server.ts:220`, `:224`) |
| Agent CLI/history harnesses/tests | Harnesses call MCP/CLI ops and daemon HTTP directly (`tests/server/terminal-mcp-roundtrip.test.ts:147`, `tests/server/runtime-session-flows.test.ts:95`, `tests/server/kiriterm-daemon.test.ts:175`) | Must preserve the operation surface and direct daemon `/api/*` behavior |

## 2. HTTP `/api/*` Exact Contracts

All control HTTP requires `Authorization: Bearer <token>`; unauthorized returns `401 {"error":"Unauthorized"}` (`src/server/terminal-control.ts:306`; `src/server/kiriterm-daemon.ts:402`). JSON bodies are parsed up to 10 MB; empty body is `{}` (`src/server/terminal-control.ts:314`).

### Shared session routes

Implemented by `handleSessionControlRoute` and served by both embedded server and daemon (`src/server/terminal-control.ts:177`; `src/server/terminal-server.ts:694`; `src/server/kiriterm-daemon.ts:410`).

- `GET /api/sessions`
  - Body: none.
  - Response: `{ sessions: [{ key, mode, label, cwd, generation, cols, rows, attachedClients, exited }] }` (`src/server/terminal-control.ts:182`).

- `POST /api/sessions/read`
  - Schema: `z.object({ key: z.string().min(1), cursor: z.string().min(1).optional() })` (`src/server/terminal-control.ts:18`).
  - Response: `{ screen, generation, cursor, output }` (`src/server/terminal-control.ts:197`).
  - `screen`: `{ lines: string[], cursorX, cursorY, cols, rows, bufferType: "normal"|"alternate" }` (`src/server/terminal-registry.ts:363`).
  - `cursor`: `${generation}:${outputSeq}` (`src/server/terminal-registry.ts:379`).
  - `output`: raw recent output since cursor. If cursor absent: `""`; malformed or generation mismatch: all retained recent output; same generation: chunks after seq (`src/server/terminal-registry.ts:383`).

- `POST /api/sessions/snapshot`
  - Schema: `{ key: string }` (`src/server/terminal-control.ts:18`).
  - Response: `{ snapshot: string, generation: number }` (`src/server/terminal-control.ts:213`).

- `POST /api/sessions/input`
  - Schema: `{ key: string, data?: string, keys?: string[] }` (`src/server/terminal-control.ts:24`).
  - Response: `{ ok: true }`; writes `data + encodeTerminalKeys(keys)` (`src/server/terminal-control.ts:224`).
  - Key bytes: enter `\r`, tab `\t`, esc `\x1b`, arrows `\x1b[A/B/C/D`, ctrl chords `charCode % 32`, etc. (`src/lib/terminal-keys.ts:5`).

- `POST /api/sessions/resize`
  - Schema: `{ key: string, cols: positive int, rows: positive int }` (`src/server/terminal-control.ts:30`).
  - Response: `{ ok: true }` (`src/server/terminal-control.ts:235`).

- `POST /api/sessions/wait-for`
  - Schema: `{ key, pattern, flags=/^[gimsuy]*$/ default "", timeoutMs positive <=600000 default 30000, scope "screen"|"output" default "screen", followReplacement boolean default true }` (`src/server/terminal-control.ts:36`).
  - Response on match: `{ matched:true, match:string, generation:number, elapsedMs:number }`; on timeout/error: `{ matched:false, elapsedMs:number }` (`src/server/terminal-control.ts:245`).

- `POST /api/sessions/wait-any`
  - Schema: `{ targets: waitTarget[1..32], timeoutMs positive <=600000 default 60000, quorum:"any"|"all" default "any" }` (`src/server/terminal-control.ts:58`).
  - `waitTarget`: `{ key, label?: string<=200, pattern?: string<=2000, flags default "", scope default "screen", idleMs?: int 250..600000 }`, refined to require `pattern || idleMs` (`src/server/terminal-control.ts:45`).
  - Response: `{ matched:boolean, matches:[{ key,label?,match?,idle?,tail:string[] }], missing:string[], elapsedMs:number }` (`src/server/terminal-control.ts:72`, `:276`).

- `POST /api/sessions/kill`
  - Schema: `{ key: string }`.
  - Response: `{ ok: true }` (`src/server/terminal-control.ts:285`).

- `POST /api/sessions/kill-prefix`
  - Schema: `{ keyPrefix: string }` (`src/server/terminal-control.ts:22`).
  - Response: `{ ok: true, killed: number }`; matches exact key or `${keyPrefix}:*` (`src/server/terminal-control.ts:292`).

### Subscription routes

Implemented in `terminal-subscriptions.ts` (`src/server/terminal-subscriptions.ts:296`).

- `POST /api/sessions/subscribe`
  - Schema: `{ targets: waitTarget[1..32], timeoutMs default 60000, quorum default "any", deliver:{ agentId:string, note?: string<=2000, title?: string<=200 } }` (`src/server/terminal-subscriptions.ts:15`).
  - Response: `{ ok:true, id:string }` (`src/server/terminal-subscriptions.ts:301`).
  - Delivery writes wake text to `${deliver.agentId}:runtime`, then after 150 ms writes `\r`; batches same receiver for 25 ms (`src/server/terminal-subscriptions.ts:84`, `:187`, `:214`, `:237`).

- `GET /api/subscriptions`
  - Response: `{ subscriptions:[{ id, status:"pending"|"delivered"|"failed", deliverAgentId, targets:number, outcome:string|null }] }` (`src/server/terminal-subscriptions.ts:113`, `:305`).

### Daemon-only routes

Implemented in `kiriterm-daemon.ts` (`src/server/kiriterm-daemon.ts:381`).

- `GET /api/health`
  - Response: `{ ok:true, pid, version, sessions }` (`src/server/kiriterm-daemon.ts:426`).

- `POST /api/agents/upsert`
  - Schema: `{ config: { id, projectId, runtime:"claude"|"codex"|"opencode"|"pi", sessionDir, sessionFile:string|null, model, cwd, runtimeStateJson?:string|null }, pendingInputs?: [{ text, submit, createdAt }] }` (`src/server/kiriterm-daemon.ts:53`, `:64`, `:75`).
  - Response: `{ ok:true }`; daemon stores config and appends pending inputs (`src/server/kiriterm-daemon.ts:436`).

- `POST /api/agents/spawn`
  - Schema: `{ agentId, cols?: positive int, rows?: positive int }` (`src/server/kiriterm-daemon.ts:80`).
  - Response: `{ ok:true, codexLaunches: [{ agentId, codexHome:string|null, launchedAtMs:number, launchToken:string }] }` (`src/server/kiriterm-daemon.ts:451`).

- `POST /api/agents/close-runtime`
  - Schema: `{ agentId }` (`src/server/kiriterm-daemon.ts:86`).
  - Response: `{ ok:true }`; kills `${agentId}:runtime` and deletes persisted runtime snapshot (`src/server/kiriterm-daemon.ts:458`).

- `POST /api/agents/input`
  - Schema: `{ agentId, text:min(1), submit:boolean default true }` (`src/server/kiriterm-daemon.ts:88`).
  - Response if live: `{ ok:true, delivered:true }`; if known but not live: `{ ok:true, delivered:false, queued:true }`; if unknown: `404 { error }` (`src/server/kiriterm-daemon.ts:469`).

- `POST /api/shutdown`
  - Response: `{ ok:true }`, then closes daemon (`src/server/kiriterm-daemon.ts:492`).

## 3. WS Frame Contract

Canonical schemas are in `contracts.ts`:

```ts
terminalClientFrameSchema =
  | { type: "input", data: string }
  | { type: "resize", cols: positive int, rows: positive int }
  | { type: "ack", bytes: positive int }

terminalServerFrameSchema =
  | { type: "snapshot", data: string, cols: positive int, rows: positive int, generation?: nonnegative int }
  | { type: "data", data: string }
  | { type: "replaced", generation: nonnegative int }
  | { type: "exit", message: string }
```

Refs: `src/lib/contracts.ts:444`.

Connection URL: `/terminal?agentId=<id>&mode=<runtime|shell>&cols=<n>&rows=<n>&token=<token>[&termId=<id>]` (`src/components/kiri-board/terminal-panel.tsx:659`; `src/server/terminal-server.ts:460`). Invalid token/missing agent closes after an `exit` frame with error text (`src/server/terminal-server.ts:466`, `:767`).

Attach behavior: server flushes headless xterm, sends `snapshot`, then buffers/replays live output in order (`src/server/terminal-registry.ts:222`). Client resets xterm on every snapshot and writes snapshot data (`src/components/kiri-board/terminal-panel.tsx:233`).

Ack/flow control: client counts `data` bytes, sends `{type:"ack",bytes}` after xterm write callback; server tracks outstanding bytes, pauses PTY above 256 KB and resumes below 64 KB (`src/components/kiri-board/terminal-panel.tsx:206`; `src/server/terminal-registry.ts:575`).

Replacement: registry generation increments per logical key; on replacement server sends `replaced` then fresh `snapshot`; client keeps socket, logs replacement, then applies snapshot (`src/server/terminal-registry.ts:176`, `:672`; `src/components/kiri-board/terminal-panel.tsx:252`).

Exit/reconnect: on `exit`, client sets Offline, writes message, and only runtime terminals reconnect. If runtime crashes within 2 s before user input, reconnect is delayed to the 2 s window (`src/components/kiri-board/terminal-panel.tsx:257`, `:263`).

## 4. Presence Marker Format

Only OSC 3008 is recognized. No APC parser exists in current code.

Emitter command:

```sh
printf '\033]3008;${payload};pid=%d\033\\' "$PPID" > /dev/tty 2>/dev/null || true
```

Ref: `src/server/agent-presence.ts:71`.

Byte format:

- Prefix: `ESC ] 3008 ;`
- Payload: semicolon-separated `key=value`
- Suffix used by Kiri hooks: `ESC \` (ST)
- Example: `\x1b]3008;start=claude;event=busy;pid=123\x1b\\`

Parser registration: xterm OSC handler id `3008`; callback receives payload only (`src/server/terminal-registry.ts:612`).

Payload grammar:
- Max payload bytes: 8192 (`src/server/agent-presence.ts:28`)
- Fields split on `;`, trimmed, require nonempty `key=value` (`src/server/agent-presence.ts:89`)
- Agent from `start` or `end`; allowed: `claude`, `codex`, `opencode`, `pi` (`src/server/agent-presence.ts:32`, `:46`)
- Status events: `session_start`, `busy`, `awaiting_input`, `idle`, `session_end` (`src/server/agent-presence.ts:6`, `:33`)
- If `end` is present, event must be `session_end` (`src/server/agent-presence.ts:60`)
- `pid` optional, regex `/^[1-9]\d{0,15}$/`, safe integer (`src/server/agent-presence.ts:118`)
- Notify payload: `kind=notify`, no `end`, `title` and `body` base64, encoded/decoded <=4096 bytes (`src/server/agent-presence.ts:49`, `:125`)

Emitted state behavior:
- Status events stored as current presence except `session_end`, which clears it (`src/server/terminal-registry.ts:629`)
- Runtime presence maps to DB status: `busy -> running`, `awaiting_input -> blocked`, `session_start|idle|session_end -> idle` (`src/server/terminal-server.ts:361`)
- Killing/exiting a present session emits synthetic `session_end` (`src/server/terminal-registry.ts:639`)

## 5. Child Process Env / Shim Contract

Common env for every terminal child: `TERM=xterm-256color`, `COLORTERM=truecolor`, `FORCE_COLOR=3`, `CLICOLOR=1`, `CLICOLOR_FORCE=1`; remove `NO_COLOR` and `NODE_DISABLE_COLORS` (`src/server/terminal-env.ts:8`, `:18`).

Runtime env injected by `baseTerminalEnv`: `KIRI_AGENT_ID`, `KIRI_PROJECT_CWD`, `KIRI_RUNTIME`, `KIRI_MODEL`, `KIRI_SESSION_DIR`, optional `KIRI_SESSION_FILE` (`src/server/terminal-launch.ts:449`). Shell env only sets `KIRI_PROJECT_CWD` and prepends shim PATH (`src/server/terminal-launch.ts:468`).

Runtime-specific launch:
- Claude: command `claude`, args `--dangerously-skip-permissions --mcp-config <json> --settings <sessionDir/claude-hooks-settings.json> --append-system-prompt <prompt>`, model, resume/session-id; writes hook settings; may set `HOME`, `CLAUDE_CONFIG_DIR`, `KIRI_CLAUDE_SESSION_ID`; strips Anthropic tokens unless `KIRI_CLAUDE_USE_EXTERNAL_API_KEY=1` (`src/server/terminal-launch.ts:183`, `:238`).
- Codex: command `codex`, optional `resume`, ephemeral `--config developer_instructions=...`, `mcp_servers.kiri.*`, optional SessionStart hook config, `--dangerously-bypass-approvals-and-sandbox --no-alt-screen`, model, resume id or initial prompt; optional `CODEX_HOME` (`src/server/terminal-launch.ts:339`).
- Pi: `pi --session-dir <dir> [--session file] [--model model]`; strips Anthropic OAuth unless `KIRI_PI_ALLOW_ANTHROPIC_OAUTH=1` (`src/server/terminal-launch.ts:406`).
- Opencode: `opencode <cwd> [--model model] [--session resume]`; optional `HOME` from `KIRI_OPENCODE_HOME` or state (`src/server/terminal-launch.ts:429`).

Shim files:
- Installed under `$HOME/.kiri/shim/bin/{codex,claude}` (`src/server/terminal-shim.ts:24`, `:50`).
- Shim removes its own dir from PATH, resolves real runtime, unsets all `KIRI_*` except `KIRI_PROJECT_CWD`, unsets `TERMINFO`, sets `KIRI_SHIM_ACTIVE`, `KIRI_SHIM_STATE_DIR`, `KIRI_SHIM_BASE_INVOCATION`, `KIRI_SHIM_MCP_CONFIG`, then evals `kirictl term shim-args <runtime>` (`src/server/terminal-shim.ts:204`).
- Codex shim args inject Kiri MCP config and SessionStart hook (`src/server/terminal-shim.ts:88`).
- Claude shim args write `$HOME/.kiri/shim/claude-hooks-settings.json` and pass `--settings` (`src/server/terminal-shim.ts:98`).

Codex session files:
- `codex-session-id` and `codex-hook-session.json` live in `sessionDir` (`src/server/codex-terminal-session.ts:5`).
- `codex-hook-session.json` shape includes `{version:1, agentId, sessionId, source?, cwd?, transcriptPath?, model?, pid?, hookEventName:"SessionStart", writtenAtMs}` (`src/server/codex-terminal-session.ts:114`).

## 6. Daemon Consumers / Rewire Points

Direct `kiriterm-daemon-client.ts` consumers:
- `terminal-server.ts` dynamically imports `makeKiritermDaemonClient` when `KIRI_TERMINAL_DAEMON=1` (`src/server/terminal-server.ts:175`).
- Tests import it directly (`tests/server/kiriterm-daemon.test.ts:15`).

Control API consumers:
- `terminalControlRequest` is the backend abstraction for shared `/api/sessions/*` routes (`src/server/terminal-server.ts:745`).
- `KiriControl` maps:
  - `terminal.read -> sessions/read` (`src/server/kiri-control.ts:569`)
  - `terminal.list -> sessions` (`:582`)
  - `terminal.keys -> sessions/input` (`:589`)
  - `terminal.wait-for -> sessions/wait-for` (`:603`)
  - `workflow.await wake -> sessions/subscribe` (`:670`)
  - `workflow.await return -> sessions/wait-any` (`:693`)
  - `terminal.kill -> sessions/kill` (`:705`)
- `closeProjectShellTerminals -> sessions/kill-prefix` (`src/server/terminal-server.ts:224`).
- Daemon client maps:
  - `prepareAgent -> agents/upsert`, then runtime `agents/spawn` (`src/server/kiriterm-daemon-client.ts:139`)
  - `spawnAgentRuntime -> agents/upsert + agents/spawn` (`:146`)
  - `closeAgentRuntime -> agents/close-runtime` (`:157`)
- CLI:
  - `kirictl term *` routes through Kiri operations (`src/cli/kirictl.ts:155`)
  - `kirictl term stop -> /api/shutdown` (`src/cli/kirictl.ts:130`)
  - backend fallback posts Kiri operations to `/.well-known/kiri/control` before local execution (`src/cli/kirictl.ts:339`)
- MCP:
  - `kiri_get` / `kiri_do` expose the same operation surface (`src/server/kiri-mcp.ts:34`, `:48`)
- UI:
  - `terminalConfigQuery` GET gives `{host,port,path,proxyPath?,token,mode,runtime,model}` (`src/lib/contracts.ts:519`; `src/server/workspace.ts:141`)
  - `TerminalPanel` opens WS directly/proxied; does not call `/api/sessions/*` from browser (`src/components/kiri-board/terminal-panel.tsx:659`)
- Workflow/scratchpad:
  - Workflow terminal prompts queue DB input and optionally spawn (`src/server/workflow-orchestration.ts:260`)
  - Scratchpad terminal trigger queues block body and spawns (`src/server/scratchpad-trigger.ts:180`)
- Tests/harnesses:
  - `tests/server/terminal-control.test.ts`, `terminal-subscriptions.test.ts`, `terminal-server.test.ts`, `kiriterm-daemon.test.ts`, `terminal-mcp-roundtrip.test.ts`, `runtime-session-flows.test.ts`, `workflow-mcp-orchestration.test.ts`, plus `tests/harness/terminal-harness.ts`.


