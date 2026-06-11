# Kiriterm Implementation Plan

> An AI-first terminal for Kiri: Ghostty-class rendering inside the existing Electron app, a
> detachable session daemon ("modern tmux"), and a deep MCP/CLI control plane so agents can read
> and drive terminals. This document is written so an AI agent can implement it phase by phase
> without additional context.

---

## 0. Background & Decision Record

### 0.1 What exists today (verified against source, June 2026)

| Piece | Location | Facts |
|---|---|---|
| Terminal UI | `src/components/kiri-board/terminal-panel.tsx` | xterm.js 6 (`@xterm/xterm ^6.0.0`), `@xterm/addon-fit` only. DOM renderer (slowest path). Hard-coded dark theme in `terminalTheme()` (~line 460). `convertEol: true`, `scrollback: 10_000`, rAF-batched writes (`enqueueWrite`). |
| WS server | `src/server/terminal-server.ts` | HTTP+`ws` server on `127.0.0.1:<random port>` path `/terminal`. Token auth via query param. Client→server JSON `{type:'input',data}` / `{type:'resize',cols,rows}`; server→client **raw PTY strings, no framing**. |
| Session registry | `src/server/terminal-registry.ts` | In-memory sessions keyed `${agentId}:runtime` / `${projectId}:shell`. Replay = raw byte ring buffer (`maxReplayBytes = 1_000_000`). Idle kill 5 min after last socket detaches (`idleKillMs`). `register/attach/detach/append/broadcast/exit/kill`. |
| PTY spawn | `src/server/terminal-server.ts` `getOrCreateTerminalSession()` | `node-pty 1.2.0-beta.12`, `pty.spawn(cmd, args, { name:'xterm-256color', cols, rows, cwd, env })`. |
| Launch config | `src/server/terminal-launch.ts` | Per-runtime launchers: `claudeLaunch` (uses `--resume`/`--session-id`, injects kiri MCP config + system prompt), `codexLaunch` (`codex resume`), `opencodeLaunch`, `piLaunch`. |
| Control plane | `src/server/kiri-control.ts` (`terminalInput`, ~line 363), `src/server/kiri-router.ts` (case `'terminal.input'`, line 187), `src/server/kiri-mcp.ts` (`kiri_get`/`kiri_do`) | `terminal.input` queues text into the agent PTY (spawning it headless via `pasteAgentRuntimeTerminal` → `spawnAgentRuntime` if needed). No read/screen-state operation exists. |
| Headless spawn | `terminal-server.ts` `spawnAgentRuntime` + `scheduleHeadlessIdleKill` (line 521) | Agents can run with no UI attached, but get idle-killed after 5 min. |
| Frontend config | `terminalConfigQuery` in `src/server/workspace.ts` | TanStack server fn returning `{host, port, path, token, mode, runtime, model}`. |
| Tests | `tests/kiri-board/terminal-panel.test.ts`, `tests/server/*` (vitest) | `pnpm test:unit`, full gate `pnpm verify`. |

### 0.2 Research conclusions (why this architecture)

Full research notes: source clones in `~/code/research/terminals/{ghostty,wezterm,waveterm,rio,SwiftTerm,xterm.js}`.

1. **Ghostty / libghostty is not embeddable in Electron.** Its renderer is Metal/OpenGL behind a
   C API designed for native hosts (the macOS app is Swift calling `ghostty_surface_*`). The only
   stable library extraction is `libghostty-vt` (VT state machine, no renderer). Adopting it means
   leaving Electron. **Rejected**; revisit only if Kiri goes native.
2. **WezTerm** (`wezterm/term`, `termwiz`, `mux/`, `codec/` crates) is the best *design* reference
   for a mux: server owns PTYs + canonical state; thin clients attach over a socket;
   `wezterm cli send-text|get-text|spawn|list` is the prior art for our MCP surface. Binding the
   Rust crates via NAPI was rejected (months of work, single-maintainer upstream, still need a JS
   renderer).
3. **xterm.js 6 already ships the "Ghostty feel" — Kiri just doesn't use it** (verified in the
   clone, commits current to 2026-06):
   - `@xterm/addon-webgl` 0.19: WebGL2 texture-atlas renderer, actively maintained, not deprecated.
   - `@xterm/addon-ligatures` 0.10: parses real font ligature tables (opentype.js); needs
     Node/Electron APIs or the Font Access API — **we are Electron, so it works**; and it **works
     with the WebGL renderer** (renderer consumes the character-joiner service —
     `addons/addon-webgl/src/WebglRenderer.ts` lines ~75/475).
   - `@xterm/headless` 6.0: full VT emulator + scrollback in Node, no DOM. Buffer read API:
     `terminal.buffer.active.getLine(y).getCell(x)` → chars/colors/flags.
   - `@xterm/addon-serialize` 0.14: snapshots the *entire* terminal state (scrollback, cursor, SGR,
     alt-buffer) as a replayable escape-sequence string; works with headless.
   - There is **no canvas addon** in v6 (DOM is the only fallback) and no WebGPU work.
4. **Wave Terminal** (Electron + xterm.js + Go daemon) proves the "UI is disposable, daemon owns
   PTYs and persists scrollback to disk" model in production. We replicate this in TypeScript.
5. **Solo** (soloterm.com, Tauri) validates the product idea: expose process/log state to agents
   via MCP. Kiri's MCP surface will be a superset.
6. **tmux control mode** as a backend was rejected: proven (iTerm2) but adds a parsing layer,
   config/escaping baggage, and an external dependency, while `@xterm/headless` gives us a fully
   programmable equivalent in-process.

**Consensus: keep xterm.js as the renderer and emulator; build kiriterm as (a) a souped-up client
pane, (b) a detachable session daemon with headless-xterm canonical state, (c) an MCP/CLI control
plane, (d) tabs/splits as pure React layout.**

### 0.3 Architecture target

```
┌────────────────────────── Electron UI (React) ──────────────────────────┐
│  KiriTermPane (xterm.js + webgl + ligatures + theme)                    │
│  TerminalTabs / SplitLayout (pure React; layout is a client concern)    │
└───────────────▲──────────────────────────────────────────────────────--─┘
                │ WS proto v2 (framed JSON + snapshot-on-attach)
┌───────────────┴───────────── kiriterm daemon ───────────────────────────┐
│  outlives the UI/backend · ~/.kiri/kiriterm/daemon.json (port+token)    │
│  per session: node-pty ◀──▶ @xterm/headless (canonical screen state)    │
│               + @xterm/addon-serialize snapshots (attach + disk)        │
│  HTTP control API: list/read/input/keys/wait-for/spawn/kill/resize      │
└───────────────▲──────────────────────────────────────────────────────--─┘
                │ HTTP (localhost, token)
┌───────────────┴───────────── kiri backend ──────────────────────────────┐
│  kiri-control.ts → daemon client · kiri-mcp.ts (kiri_get/kiri_do)       │
│  kirictl term <subcommand>                                              │
└──────────────────────────────────────────────────────────────────────-──┘
```

---

## Phase 1 — Client renderer upgrade (Ghostty-feel pane)

*Scope: `terminal-panel.tsx` + deps + theme. No protocol/server changes. Ship independently.*

### 1.1 Dependencies

```bash
pnpm add @xterm/addon-webgl @xterm/addon-ligatures @xterm/addon-unicode11 @xterm/addon-search
```

(Pin to the versions current at implementation time; as of research: webgl 0.19.x, ligatures
0.10.x, unicode11 0.9.x. All are lazy-`import()`-ed like the existing `@xterm/xterm` import at
`terminal-panel.tsx:198`.)

### 1.2 WebGL renderer

In `connect()` (`terminal-panel.tsx`, after `term.open(host)` at ~line 218):

```ts
const { WebglAddon } = await import('@xterm/addon-webgl')
try {
  const webgl = new WebglAddon()
  webgl.onContextLoss(() => {
    webgl.dispose() // falls back to DOM renderer automatically
  })
  term.loadAddon(webgl)
  terminalDisposables.push(webgl)
} catch {
  // WebGL2 unavailable (old GPU blocklist) — DOM renderer remains active. Non-fatal.
}
```

Rules:
- Must be loaded **after** `term.open()` (addon requires an attached terminal).
- `onContextLoss` → dispose addon; xterm reverts to the DOM renderer. Do not retry in a loop.
- Dispose the addon in the existing cleanup block (~line 295) via `terminalDisposables`.

### 1.3 Ligatures

```ts
const { LigaturesAddon } = await import('@xterm/addon-ligatures')
try {
  await document.fonts.ready              // ensure the mono font is loaded before parsing
  const ligatures = new LigaturesAddon()
  term.loadAddon(ligatures)
  terminalDisposables.push(ligatures)
} catch {
  // Font Access API denied / font not parseable — addon falls back to a static
  // ligature list internally; a hard throw here just means no ligatures. Non-fatal.
}
```

Notes:
- Works in Electron (Chromium Font Access API / Node `font-finder` path). In a plain browser
  deployment of kiri-web it degrades to the addon's built-in ~50-ligature fallback list.
- Load **after** the WebGL addon so the character joiner registers against the active renderer.
- Ligatures only render if the user's `monoFonts[...]` stack (see
  `src/components/kiri-board/storage.ts`) resolves to a font that has them (e.g. JetBrains Mono,
  Fira Code). Consider adding one such font to the default stacks if absent.

### 1.4 Theme from Kiri CSS variables (fix the hard-coded palette)

Today `terminalTheme()` (`terminal-panel.tsx:460`) ignores `themeMode`. Replace with:

1. New module `src/components/kiri-board/terminal-theme.ts`:
   ```ts
   import type { ThemeMode } from '~/theme/kiri-themes'

   // Read kiri CSS custom properties off the document root; fall back to the
   // existing palette values when a variable is missing.
   export function buildTerminalTheme(themeMode: ThemeMode): ITheme { ... }
   ```
   Map: `background`/`foreground`/`cursor`/`selectionBackground` from the kiri theme tokens
   (inspect `src/theme/kiri-themes.ts` / `applyKiriTheme` for the variable names — they are CSS
   custom properties set on `:root`), and define 16 ANSI colors per theme (add them as new theme
   tokens, e.g. `--kiri-term-ansi-red`, so terminal palettes become themeable like everything
   else). Use `getComputedStyle(document.documentElement).getPropertyValue(...)` with the current
   hard-coded hex values from `terminalTheme()` as fallbacks.
2. Apply on mount: `theme: buildTerminalTheme(themeModeRef.current)` in the `new Terminal({...})`
   options (~line 206).
3. Apply on change: in the existing `themeMode` effect (~line 82), add
   `if (terminalRef.current) terminalRef.current.options.theme = buildTerminalTheme(themeMode)`.
   (xterm v6 supports live `options.theme` assignment.)
4. Unit-test `buildTerminalTheme` fallback behavior in `tests/kiri-board/terminal-panel.test.ts`
   (jsdom: no CSS vars set → returns fallback palette).

### 1.5 Unicode + search

- `@xterm/addon-unicode11`: load, then `term.unicode.activeVersion = '11'`. Fixes emoji/CJK width
  drift between client and the (Phase 2) server-side headless instance — **both sides must use the
  same unicode version**.
- `@xterm/addon-search` (optional, cheap): wire to a small find UI in the terminal header later;
  loading the addon now costs nothing.

### 1.6 Acceptance criteria (Phase 1)

- `nvim` + a ligature font shows `=>`, `!=` fused glyphs; smooth scroll through a large file
  (visually compare against the DOM renderer with `kiri:terminal-debug` localStorage flag).
- Theme follows light/dark switch live.
- WebGL context loss (simulate: `term._core` dev tools → lose context, or just rely on the unit
  path) degrades to DOM renderer without a blank pane.
- `pnpm verify` green.

---

## Phase 2 — Server-side canonical screen state (headless xterm)

*Scope: `terminal-registry.ts`, `terminal-server.ts`, `terminal-panel.tsx` (protocol), contracts.
This is the foundation for clean reattach (Phase 3) and `terminal.read`/`wait-for` (Phase 4).*

### 2.1 Why

The current replay is a raw 1MB byte ring (`terminal-registry.ts:130-136,185-197`). Problems:
- Trimming can split escape sequences → corrupted replay on reattach.
- Replay grows with output volume, not with screen size.
- Nothing can *read* the screen (MCP `terminal.read` is impossible without re-parsing ANSI).

`@xterm/headless` per session fixes all three: the daemon holds the same VT state the client
renders, and `@xterm/addon-serialize` emits a minimal, always-valid snapshot.

### 2.2 Dependencies

```bash
pnpm add @xterm/headless @xterm/addon-serialize
```

### 2.3 Registry changes (`src/server/terminal-registry.ts`)

Extend `TerminalRegistrySession`:

```ts
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'

export type TerminalRegistrySession = {
  // ...existing fields...
  readonly headless: HeadlessTerminal
  readonly serializer: SerializeAddon
  cols: number
  rows: number
}
```

- `register()` creates:
  ```ts
  const headless = new HeadlessTerminal({
    cols, rows,                       // thread cols/rows through register()'s input
    scrollback: 10_000,               // match client terminalScrollbackRows (terminal-panel.tsx:22)
    allowProposedApi: true,
  })
  const serializer = new SerializeAddon()
  headless.loadAddon(serializer)
  ```
- `append(session, data)` additionally calls `session.headless.write(data)`. Keep the existing raw
  ring buffer **only** as the live-stream tail is no longer needed — delete `replayChunks`,
  `buffer`, `replayBytes`, `trimReplay` once snapshot attach (2.5) lands. (Do it in the same PR;
  don't maintain both.)
- Resizes must hit both PTY and headless. Wrap in the registry:
  ```ts
  function resize(session, cols, rows) {
    session.cols = cols; session.rows = rows
    session.proc.resize(cols, rows)
    session.headless.resize(cols, rows)
  }
  ```
  Update callers: `getReusable()` (line 67) and the WS `resize` message handler
  (`terminal-server.ts:306`).
- `kill()`/`exit()` must `session.headless.dispose()`.
- New read API (used by Phase 4):
  ```ts
  function snapshot(session, scrollbackLines?: number): string   // serializer.serialize({ scrollback })
  function readScreen(session): { lines: string[]; cursorX: number; cursorY: number;
                                  cols: number; rows: number; bufferType: 'normal'|'alternate' }
  ```
  `readScreen` implementation: iterate `headless.buffer.active`, rows
  `buffer.baseY .. buffer.baseY + rows - 1`, `getLine(y)?.translateToString(true)`.

Important details:
- **Unicode version parity**: also load `@xterm/addon-unicode11` into the headless terminal and set
  `unicode.activeVersion = '11'` iff the client does (1.5). Width mismatches otherwise corrupt
  reattach cursor positions.
- **Memory**: a headless terminal with 10k scrollback ≈ low single-digit MB per session. With tens
  of sessions this is fine; do not raise scrollback without re-measuring.
- `convertEol`: leave **off** on the headless side (PTY output is already CRLF; the client's
  `convertEol:true` exists for the client-side banner writes only).

### 2.4 WebSocket protocol v2 (framed)

Today server→client is unframed raw text, which makes a snapshot indistinguishable from live
output. Replace with JSON frames both directions (the app ships client+server together; no
back-compat shim needed, but bump a `proto=2` query param and reject mismatches loudly):

```ts
// server → client
type ServerFrame =
  | { type: 'snapshot'; data: string; cols: number; rows: number } // serialize() output
  | { type: 'data'; data: string }                                 // live PTY output
  | { type: 'exit'; message: string }
// client → server (unchanged shape, now exhaustive)
type ClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
```

- Define schemas in `src/lib/contracts.ts` next to `terminalInputSchema` (line 361) with zod;
  share between `terminal-server.ts` and `terminal-panel.tsx`.
- Server: `attach()` (`terminal-registry.ts:101`) sends
  `{type:'snapshot', data: serializer.serialize(), cols, rows}` instead of `socket.send(session.buffer)`;
  `broadcast()` wraps chunks in `{type:'data'}`. The exit message in `exit()` (line 144) becomes
  `{type:'exit'}`.
- Client (`terminal-panel.tsx` `socket.onmessage`, line 256): parse frame;
  - `snapshot`: `term.reset()`, then `term.resize(cols, rows)` if they differ, then
    `enqueueWrite(frame.data)`. (Snapshot is written into a *reset* terminal — serialize output
    assumes a fresh state.)
  - `data`: `enqueueWrite(frame.data)`.
  - `exit`: write message, set status `Closed`.
- The client banner write (lines 250-254) stays client-side and unframed (it's a local write).

### 2.5 Flow control (backpressure)

Currently `enqueueWrite` grows `pendingWrite` unboundedly and the server broadcasts blindly; a
`yes`-style flood will balloon memory. Implement the watermark pattern xterm.js documents:

- Server: count bytes sent per socket since last ack; when > `HIGH_WATERMARK` (e.g. 256 KiB),
  `session.proc.pause()` (node-pty `IPty.pause()/resume()`); client sends `{type:'ack', bytes}`
  after its `term.write(chunk, callback)` callbacks fire; when outstanding < `LOW_WATERMARK`
  (e.g. 64 KiB), `proc.resume()`.
- Add `{ type: 'ack'; bytes: number }` to `ClientFrame`.
- The headless `write()` on the server is async-queued internally; it needs no separate throttle
  (it consumes the same paused PTY stream).
- Gate: with one attached client running `cat /dev/urandom | base64`, RSS of backend and renderer
  stay bounded; Ctrl-C remains responsive (<200 ms) because the PTY pause keeps the input path free.

### 2.6 Tests (Phase 2)

- `tests/server/terminal-registry.test.ts` (extend existing server tests pattern):
  - write ANSI-heavy fixture into a session → `readScreen()` returns expected text/cursor.
  - attach after writes → first frame is `snapshot`, replaying it into a fresh
    `@xterm/headless` instance yields an identical `readScreen()` (this is the
    snapshot-correctness property test — it replaces the old "raw replay" semantics).
  - trim/oversize: write >10k lines → snapshot stays bounded; no escape-sequence corruption
    (assert snapshot round-trips).
  - resize propagates to both proc (spy) and headless (`headless.cols`).
- `tests/kiri-board/terminal-panel.test.ts`: frame parsing — snapshot triggers reset+resize+write;
  unknown frame types ignored.

---

## Phase 3 — The kiriterm daemon (sessions survive UI/backend restarts)

*Scope: new daemon entrypoint, backend becomes a daemon client, lifecycle + state dir, policy
changes. This is the "modern tmux" detach/reattach core.*

### 3.1 Current lifetime problem

The terminal server lives inside the kiri backend process (spawned by Electron main —
`src/desktop/main.mjs` → `scripts/kiri-desktop-backend.mjs`). Quit the app (or the backend
crashes/updates) → every PTY dies, including long-running agents. Wave Terminal solves this with a
separate daemon; we do the same.

### 3.2 Daemon process

New entrypoint `src/server/kiriterm-daemon.ts` + CLI wiring in `src/cli/kirictl.ts`
(`kirictl term daemon` subcommand; follow the existing `mcp` subcommand pattern — see
`buildKiriMcpServerConfig` fallbacks in `terminal-launch.ts:221-240` for how packaged/dev binaries
are resolved; mirror that for the daemon binary, and add it to `scripts/build-cli.mjs` outputs and
electron-builder resources like `resources/bin/kiri-mcp`).

The daemon process hosts exactly what `makeTerminalServerService()` hosts today (WS server +
registry + PTY spawning), plus an HTTP control API (3.5). **Move** `terminal-server.ts`,
`terminal-registry.ts`, `terminal-launch.ts` (and their deps `terminal-env.ts`,
`claude-session-path.ts`, `runtime-binaries.ts`) behind the daemon; the backend keeps thin client
stubs. Two pieces of today's server reach into the backend DB
(`takeAgentTerminalInputs`/`requeueAgentTerminalInputs`/`getAgentLaunchConfig`,
`rememberCodexTerminalSession` — `terminal-server.ts:11-20`):

- **Invert the dependency.** The daemon must not open the backend's SQLite. Instead:
  - `getAgentLaunchConfig` → the backend passes the full `TerminalAgentLaunchConfig` in the
    spawn/ensure HTTP call (it's a plain serializable object, `terminal-launch.ts:14-23`).
  - pending terminal inputs → backend includes `pendingInputs: TerminalLaunchInitialInput[]` in
    the spawn call and the daemon writes them post-spawn (replaces
    `writePendingTerminalInputs`/`takeAgentTerminalInputs`); on later `terminal.input` calls the
    backend hits the daemon `/input` endpoint directly (no queue needed when the daemon is
    always-on — keep the DB queue only as the offline fallback when the daemon is unreachable).
  - `rememberCodexTerminalSession` → daemon POSTs a callback to the backend, or simpler: the
    backend computes it at spawn-request time (it already knows launch env + token). Prefer the
    latter; check `src/server/codex-cli-sessions.ts` for what it records.

### 3.3 State dir & discovery

```
~/.kiri/kiriterm/
  daemon.json        # { pid, host, port, token, startedAt, version } — chmod 0600
  daemon.lock        # advisory lock to prevent double-start
  sessions/<key>.snapshot   # periodic serialize() dumps (3.6)
```

- Token: keep the `randomBytes(32).toString('base64url')` scheme (`terminal-server.ts:131`), but
  persist it in `daemon.json` so backend restarts can re-authenticate to the *same* daemon.
- Discovery in the backend: read `daemon.json` → `GET /health` (must return matching `version`) →
  reuse; else spawn `kirictl term daemon` with `{ detached: true, stdio: 'ignore' }` +
  `child.unref()` and poll `/health` (≤2 s). Handle the stale-file race with the lock file.
- Version skew: if `daemon.json.version !== app version`, ask the daemon to drain
  (`POST /shutdown?when=idle`) and start a new one on a new port — old sessions keep running under
  the old daemon until they exit; new sessions go to the new daemon. (Simple, correct, no proto
  negotiation. Document that an app update doesn't kill running agents.)

### 3.4 Backend integration

- `terminalConfigQuery` (`src/server/workspace.ts`) now returns the **daemon's** host/port/token.
  The UI's WS code path (`terminalWebSocketUrl`, `terminal-panel.tsx:438`) is unchanged.
- `pasteAgentRuntimeTerminal` / `spawnAgentRuntime` / `closeAgentRuntime` in
  `src/server/kiri-control.ts`, `workflow-orchestration.ts:194`, `scratchpad-trigger.ts:190`
  become HTTP calls to the daemon. Keep the exported function signatures identical so call sites
  don't change; swap the implementation inside `terminal-server.ts`'s public wrappers
  (lines 105-121) to a `KiritermDaemonClient`.
- Electron `before-quit` must **not** kill the daemon (audit `src/desktop/main.mjs` for tree-kill
  behavior of the backend subprocess; the daemon being `detached` + `unref`ed and a child of the
  *backend* — make sure the backend doesn't kill its children on exit, or spawn the daemon via
  `setsid`-style double-fork: spawn `kirictl term daemon --orphan` which re-spawns itself detached
  and exits).

### 3.5 Daemon HTTP control API (used by backend + Phase 4 MCP/CLI)

All endpoints require `Authorization: Bearer <token>`. Bind `127.0.0.1` only.

```
GET  /health                          → { ok, version, pid, sessions: number }
GET  /sessions                        → [{ key, mode, label, cwd, cols, rows, attachedClients,
                                          exited, startedAt, lastOutputAt }]
POST /sessions                        → spawn; body: { key?, mode, launch: TerminalProcessLaunch
                                          | { config: TerminalAgentLaunchConfig, mode },
                                          cols, rows, pendingInputs? }
GET  /sessions/:key/read?lines=&mode= → readScreen() output (Phase 2.3) + optional scrollback tail
GET  /sessions/:key/snapshot          → { data: serialize(), cols, rows }
POST /sessions/:key/input             → { data?: string, keys?: NamedKey[] }   (4.3)
POST /sessions/:key/resize            → { cols, rows }
POST /sessions/:key/wait-for          → { pattern, flags?, timeoutMs?, scope: 'screen'|'output' }
                                        → long-poll; resolves { matched, match?, elapsedMs }
DELETE /sessions/:key                 → kill
POST /shutdown?when=idle|now
```

`wait-for` implementation: subscribe to the session's data events; after each headless write
flush, test the regex against `readScreen().lines.join('\n')` (scope `screen`) or against a rolling
last-64KiB raw output window (scope `output`). Resolve once or time out (default 30 s, max 10 min).
This is the primitive that makes agent-drives-terminal reliable (tmux's `wait-for` + `send-keys`
equivalent).

### 3.6 Persistence & lifetime policy

- **Idle-kill policy change**: runtime (agent) sessions are **never idle-killed** — delete
  `scheduleHeadlessIdleKill` (`terminal-server.ts:521`) and skip the detach timer
  (`terminal-registry.ts:110-117`) for `mode === 'runtime'`. Shell sessions keep the 5-min idle
  kill (make both configurable via daemon config, env `KIRI_TERM_IDLE_KILL_MS`).
- **Scrollback persistence across daemon restarts**: every 30 s (and on PTY exit), if the session
  produced output since last dump, write `serialize({ scrollback: 10_000 })` to
  `sessions/<key>.snapshot` (atomic tmp+rename). On daemon start, load snapshots into *dead*
  session records (`exited: true`) so a reattaching client still sees history with a
  `[kiri terminal: process not running — restored scrollback]` banner. PTYs themselves cannot
  survive a daemon restart; agent *conversations* survive via each runtime's own resume flags
  (`claudeLaunch` `--resume`, `codexLaunch` `resume`, `opencode --session` —
  `terminal-launch.ts:164-331`), so "continue conversation" = spawn a fresh session for the same
  agentId; the existing launch code already handles this. Surface a "Restart agent" affordance in
  the UI when attached to a dead restored session.
- Cap `sessions/` at e.g. 200 MB with LRU eviction of dead-session snapshots.

### 3.7 Tests (Phase 3)

- Daemon client/server contract test (vitest, spawn the daemon in-process or as a child):
  spawn shell session → write → kill backend-side client → reconnect with token from
  `daemon.json` → snapshot matches.
- Lifecycle: start twice → second start reuses (lock file); stale `daemon.json` with dead pid →
  cleaned and respawned.
- Policy: runtime session not killed after idle window (fake timers — registry already supports
  injected `timers`, `terminal-registry.ts:36-46`); shell session is.
- Snapshot persistence: write → SIGTERM daemon → restart → dead session restored with history.
- Update `tests/server/desktop-package-contract.test.ts` for the new packaged binary.

---

## Phase 4 — MCP / CLI control plane

*Scope: `contracts.ts`, `kiri-control.ts`, `kiri-router.ts`, `kiri-mcp.ts`, `kirictl.ts`. Mostly
plumbing over the Phase 3 HTTP API.*

### 4.1 New operations

Add to the operations enum in `src/lib/contracts.ts` (near `'terminal.input'`, line 519) and zod
schemas next to `terminalInputSchema` (line 361):

| Op | Tool | Params | Returns |
|---|---|---|---|
| `terminal.read` | `kiri_get` | `agentId`, `mode='runtime'`, `lines?` (scrollback tail), `format='text'\|'cells'` | screen lines, cursor, dims, bufferType, `exited` |
| `terminal.list` | `kiri_get` | `projectId?` | daemon `/sessions` projection |
| `terminal.wait-for` | `kiri_do` | `agentId`, `mode`, `pattern`, `flags?`, `timeoutMs?`, `scope?` | `{ matched, match, elapsedMs }` |
| `terminal.keys` | `kiri_do` | `agentId`, `mode`, `keys: string[]` | ok |
| `terminal.spawn` | `kiri_do` | `agentId` (runtime) or `projectId` (shell) | session key |
| `terminal.kill` | `kiri_do` | session key | ok |

`terminal.input` already exists (`kiri-control.ts:363`, router line 187) — extend it with an
optional `mode` so it can target shell sessions too, and route through the daemon `/input`.

### 4.2 Wiring pattern

Follow the existing shape exactly: schema in `contracts.ts` → effect in `kiri-control.ts`
(`Effect.fn('KiriControl.terminalRead')(...)` calling the daemon client) → `case` in
`kiri-router.ts` → exposure via `kiri_get`/`kiri_do` in `kiri-mcp.ts` (the MCP tools dispatch on
the operations enum; verify how `operations.list` self-describes and add the new ops to that
listing so agents discover them).

### 4.3 Named keys

`terminal.keys` maps names → bytes (single source of truth in `src/lib/terminal-keys.ts`, shared
daemon/CLI):

```
Enter→"\r"  Tab→"\t"  Esc→"\x1b"  Backspace→"\x7f"  Space→" "
Up/Down/Right/Left→"\x1b[A/B/C/D"  Home→"\x1b[H"  End→"\x1b[F"
PageUp/PageDown→"\x1b[5~/6~"  C-a..C-z→0x01..0x1a (e.g. C-c→"\x03")
F1..F12 → standard xterm sequences
```

This is what lets an agent answer a TUI prompt ("press y", arrow-select a menu) — `terminal.input`
text + `terminal.keys` Enter + `terminal.wait-for` is the full driving loop, same triad as tmux
`send-keys` / `capture-pane` / `wait-for`, and same shape as `wezterm cli send-text` / `get-text`.

### 4.4 CLI

`kirictl term ls | read <key> | input <key> [--submit] <text> | keys <key> <key-names...> |
wait-for <key> <pattern> [--timeout 30s] | spawn | kill <key> | daemon [--stop]` — thin wrappers
over the daemon HTTP API reading `~/.kiri/kiriterm/daemon.json`. This makes kiriterm usable from
*any* agent or script even outside kiri's MCP.

### 4.5 Update the injected agent prompt

`claudeKiriTerminalPrompt` (`terminal-launch.ts:242`) should mention the new capabilities, e.g.
"kiri_get terminal.read / kiri_do terminal.input+terminal.wait-for let you observe and drive the
shell terminal of this session." Keep it terse — this string ships into every Claude session.

### 4.6 Tests

- Unit: key mapping table; wait-for regex over a scripted session (fixture writes).
- Integration: MCP round-trip in the existing `tests/server/kiri-mcp.test.ts` harness —
  `terminal.spawn` shell → `terminal.input "echo hello\r"` → `terminal.wait-for "hello"` →
  `terminal.read` contains `hello`.

---

## Phase 5 — Tabs & splits (client-side mux UI)

*Scope: React only + one registry change for multiple shells. Layout is a client concern (WezTerm
model); the daemon already supports N sockets per session and N sessions.*

### 5.1 Multiple shell sessions per project

- Session key today: `${projectId}:shell` (`terminal-registry.ts:57-61`) — exactly one shell per
  project. Change to `${projectId}:shell:${termId}` where `termId` is a client-generated short id
  (`crypto.randomUUID().slice(0,8)`); add `termId` to the WS query params and
  `terminalConfigQuery`/contracts. Default `termId='main'` keeps current behavior (and existing
  MCP `terminal.input` targeting).
- `getReusable`'s cwd check (line 66) stays per-key.

### 5.2 Layout model

New `src/components/kiri-board/terminal-layout.ts`:

```ts
type PaneNode =
  | { kind: 'leaf'; id: string; termId: string }
  | { kind: 'split'; id: string; direction: 'row' | 'column'; ratio: number;
      a: PaneNode; b: PaneNode }
type TerminalTab = { id: string; title: string; root: PaneNode }
type TerminalLayoutState = { tabs: TerminalTab[]; activeTabId: string; activePaneId: string }
```

Pure functions (unit-testable, no React): `splitPane(state, paneId, direction)`,
`closePane(state, paneId)` (collapse parent split), `focusNext(state, direction)` (geometric
navigation), `setRatio`, `newTab`, `closeTab`. Persist per-project in localStorage alongside the
existing board preferences (`storage.ts` patterns); sessions themselves live in the daemon, so a
UI reload reattaches every visible pane via snapshot — that's the detach/reattach demo.

### 5.3 Components

- `TerminalWorkspace` (replaces the single `TerminalPanel` mount for the `terminal` tab in the
  sidebar — see `mountedTerminalModes` handling in the board): renders tab strip + recursive
  split tree; each leaf renders the existing `TerminalPanel` with its `termId`.
- Splitters: CSS grid with a drag handle updating `ratio` (pointer events; 4px hit area). No
  library needed.
- Keep panes mounted with `hidden` when their tab is inactive (same trick as today,
  board code `hidden={!visible}`) so reattach churn doesn't happen on tab switch.
- The `runtime` terminal (agent chat) stays a single pane in the chat tab — splits apply to the
  shell workspace only (v1).

### 5.4 Keybindings (match common muscle memory, route through existing shortcut config)

`Cmd+T` new tab · `Cmd+W` close pane/tab · `Cmd+D` split right · `Cmd+Shift+D` split down ·
`Cmd+Alt+Arrows` focus pane · `Cmd+1..9` select tab. Register where `toggleFocusKey` and the
Electron menu accelerator (`CmdOrCtrl+\``, `src/desktop/main.mjs` menu → `kiri:menu-action` IPC)
are handled; be careful these fire only when the terminal workspace is focused, and they must be
intercepted in `attachCustomKeyEventHandler` (`terminal-panel.tsx:219`) so xterm doesn't swallow
them.

### 5.5 Tests

- Pure layout functions: split/close/focus invariants (closing the last pane of a tab closes the
  tab; ratios clamp 0.1–0.9; focus navigation is total).
- `tests/kiri-board/terminal-panel.test.ts` additions: workspace renders N leaves; closing a pane
  detaches (socket close) but does not kill the daemon session.

---

## Phase 6 — Stretch (post-MVP, separate decisions)

- **Shell integration marks**: emit/parse OSC 133 prompt markers (Ghostty/WezTerm/Kitty all do
  this) → "jump to previous prompt", command-scoped `terminal.read`, per-command exit status in
  decorations. xterm decorations API (`registerDecoration`) is already available.
- **Images**: `@xterm/addon-image` (sixel + iTerm2 IIP + partial Kitty TGP) — useful for agents
  that plot.
- **Standalone kiriterm**: the daemon WS/HTTP protocol is already client-agnostic; a trivial
  standalone window (new Electron `BrowserWindow` or Tauri shell hosting just `TerminalWorkspace`)
  makes kiriterm usable without the board. Defer until the daemon protocol has been stable for a
  while.
- **Renderer swap**: if WebGL ever becomes the bottleneck, Rio's `sugarloaf` crate (wasm +
  WebGPU) is the watch item — renderer-only, would need the whole widget layer rebuilt. Not
  justified today.

---

## Sequencing, estimates, gates

| Phase | Depends on | Size | Gate |
|---|---|---|---|
| 1 Renderer | — | S (1–2 days) | visual check + `pnpm verify` |
| 2 Headless state + proto v2 | — (parallel with 1) | M (3–5 days) | snapshot round-trip property tests |
| 3 Daemon | 2 | L (1–2 weeks) | kill backend → reattach with full scrollback; agent survives UI quit |
| 4 MCP/CLI | 3 (read/wait-for need 2+3) | M (3–5 days) | MCP round-trip test (4.6) |
| 5 Tabs/splits | 2 (works pre-daemon) | M (1 week) | layout unit tests + manual |
| 6 Stretch | 3/4 | — | per-item |

Run `pnpm verify` (typecheck, lint, effect:audit, tests, knip) at every phase boundary; Phase 3
also requires `pnpm verify:desktop:package` since it adds a packaged binary.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Serialize addon edge cases (alt-buffer TUIs like claude/nvim mid-frame) | Property tests in 2.6; snapshot into reset terminal; `excludeAltBuffer` stays false (we want the TUI restored); worst case the TUI redraws on next keypress — also send a `C-l`-equivalent repaint hint after reattach for runtime sessions (many TUIs repaint on resize: send a no-op resize jiggle, the trick tmux clients use). |
| Double emulation drift (client xterm vs headless xterm) | Same lib, same version, same scrollback, same unicode version (pinned in one place); add a debug assert comparing client `buffer.length` vs `terminal.read` during `kiri:terminal-debug` mode. |
| `node-pty` beta (1.2.0-beta.12) in a long-lived daemon | Already in prod use in kiri; daemon restarts are now survivable (snapshots), which *reduces* exposure. Watch upstream for 1.2 stable. |
| Daemon orphan management (zombie daemons after crashes) | pid+lock file, `/health` version check, `kirictl term daemon --stop`, stale-file cleanup on start. |
| Backpressure regressions (2.5) | Explicit flood test in CI (bounded RSS assertion). |
| Ligatures addon throws in non-Electron web deploys | try/catch (1.3); degrade silently. |

## Reference index

- Kiri: `src/components/kiri-board/terminal-panel.tsx`, `src/server/terminal-server.ts`,
  `src/server/terminal-registry.ts`, `src/server/terminal-launch.ts`, `src/server/kiri-control.ts`,
  `src/server/kiri-router.ts`, `src/server/kiri-mcp.ts`, `src/cli/kirictl.ts`,
  `src/lib/contracts.ts`, `src/server/workspace.ts` (`terminalConfigQuery`).
- xterm.js (local clone `~/code/research/terminals/xterm.js`): `addons/addon-webgl/`,
  `addons/addon-ligatures/`, `addons/addon-serialize/`, `headless/`,
  `typings/xterm-headless.d.ts` (buffer API). Docs: https://xtermjs.org/docs/.
- WezTerm mux/CLI design (clone `~/code/research/terminals/wezterm`): `mux/`, `codec/`,
  `wezterm-client/`; CLI prior art: https://wezterm.org/cli/cli/ (`send-text`, `get-text`,
  `spawn`, `list`).
- Wave Terminal daemon/persistence prior art (clone `~/code/research/terminals/waveterm`).
- tmux semantics prior art: `send-keys`, `capture-pane -p`, `wait-for`.
- node-pty API (`pause()`/`resume()`, `onData`, `onExit`): https://github.com/microsoft/node-pty.
