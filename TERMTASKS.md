# Kiri Terminal Tasks

## Mission

Replace the current xterm/node-pty terminal path with a Kiri-owned terminal stack that is fast, testable, and built for agents.

The target is not xterm compatibility for its own sake. The target is a high-performance terminal for:

- agent runtime sessions
- project shell terminals
- workflow-spawned terminals
- repeated paste/inject into an already-open terminal thread
- multiple terminal tabs
- split panes
- attach/resume
- editor/TUI/script use

No migration fallback lane. The implementation may land in slices, but the end state removes the xterm/node-pty terminal dependency path.

## References

Current Kiri files:

- `src/components/kiri-board/terminal-panel.tsx` - current xterm view, websocket connect, input/resize, debug transcript.
- `src/components/kiri-board/selected-agent-pane.tsx` - current Chat runtime terminal vs Terminal shell terminal mount behavior.
- `src/server/terminal-server.ts` - current websocket server, node-pty spawn, pending input write, runtime spawn.
- `src/server/terminal-registry.ts` - current raw replay buffer, session reuse, idle kill.
- `src/server/terminal-launch.ts` - runtime/shell command construction. Preserve this logic as much as possible.
- `src/server/workflow-orchestration.ts` - workflow terminal queue/spawn behavior.
- `src/server/kiri-control.ts` - `terminal.input` control path.
- `src/server/scratchpad-trigger.ts` - scratchpad terminal trigger path.
- `src/lib/contracts.ts` - `TerminalMode`, `TerminalConfig`, `TerminalInput`, workflow terminal paste contracts.
- `tests/server/terminal-server.test.ts`
- `tests/server/terminal-registry.test.ts`
- `tests/server/terminal-launch.test.ts`
- `tests/server/kiri-control-cli.test.ts`
- `tests/server/scratchpad-trigger-service.test.ts`
- `tests/kiri-board/terminal-panel.test.ts`
- `tests/e2e/kiri.spec.ts`

Solo evidence:

- `/Applications/Solo.app`
- Strongly evidenced libs/patterns: `portable-pty`, `vte`, `unicode-width`, Rust terminal document/grid/history/patch stream, binary snapshot/attach/history/input APIs, render instrumentation.
- Important architectural pattern: backend owns terminal truth; frontend paints snapshots and patches.

WezTerm reference:

- `/tmp/wezterm`
- Relevant concepts only: mux, window/tab/pane identity, split pane commands, pane focus, pane movement.
- Useful source references:
  - `/tmp/wezterm/mux/src/lib.rs`
  - `/tmp/wezterm/mux/src/tab.rs`
  - `/tmp/wezterm/mux/src/pane.rs`
  - `/tmp/wezterm/wezterm/src/cli/split_pane.rs`
  - `/tmp/wezterm/wezterm/src/cli/send_text.rs`

Rust crate references already available locally:

- `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/portable-pty-0.8.1`
- `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/vte-0.15.0`
- `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/unicode-width-0.2.2`

## Non-Negotiable Invariants

- Runtime terminals are still agent-bound.
- Shell terminals are still project-bound.
- Workflow dispatch can create a terminal session and paste the workflow prompt.
- A second paste to the same open runtime terminal must continue the same terminal thread, not spawn a new process.
- Claude Code, OpenCode, Codex terminal, and shell flows must remain controllable through Kiri.
- The launch resolver keeps existing runtime behavior unless a task explicitly proves a change is required.
- All functional changes need tests.
- Performance work needs measurable harnesses, not anecdotal checks.
- No xterm fallback. If a task needs an intermediate adapter, it is temporary scaffolding inside the same replacement path, not a supported alternate terminal.

## Target Architecture

```text
Kiri UI
  TerminalSection
    TerminalTabs
      TerminalPaneView
        Kiri DOM renderer
        input/paste/copy/scroll/focus

TS server
  WorkspaceService / KiriControl / WorkflowOrchestration
  KiriTermClient
    spawn runtime/shell
    create tab/pane
    attach/detach
    paste/inject/input/resize/signal

Rust sidecar: crates/kiri-term
  portable-pty process owner
  vte parser
  terminal document
  patch stream
  history ring
  tab/pane/session registry
  MessagePack websocket/control protocol
```

### Core Runtime Types

```ts
type TerminalId = string
type TerminalTabId = string
type TerminalPaneId = string

type TerminalKind = "runtime" | "shell" | "workflow"

type TerminalSession = {
  terminalId: TerminalId
  projectId: string
  agentId: string | null
  kind: TerminalKind
  cwd: string
  commandLabel: string
  status: "starting" | "running" | "exited" | "failed"
  pid: number | null
  cols: number
  rows: number
  screenSeq: number
  historySeq: number
}

type TerminalTab = {
  tabId: TerminalTabId
  projectId: string
  title: string
  activePaneId: TerminalPaneId
  layout: TerminalPaneTree
}

type TerminalPane = {
  paneId: TerminalPaneId
  tabId: TerminalTabId
  terminalId: TerminalId
}
```

### Patch Protocol

Hot path should be binary MessagePack.

```ts
type TerminalClientFrame =
  | { type: "attach"; terminalId: TerminalId; knownScreenSeq?: number; knownHistorySeq?: number }
  | { type: "input"; terminalId: TerminalId; bytes: Uint8Array }
  | { type: "paste"; terminalId: TerminalId; text: string; submit: boolean; bracketed: "auto" | "force" | "off" }
  | { type: "inject"; terminalId: TerminalId; text: string; submit: boolean; idempotencyKey: string; source: "workflow" | "kiri-control" | "scratchpad" | "agent" }
  | { type: "resize"; terminalId: TerminalId; cols: number; rows: number }
  | { type: "signal"; terminalId: TerminalId; signal: "interrupt" | "eof" | "terminate" | "kill" }

type TerminalServerFrame =
  | { type: "snapshot"; terminalId: TerminalId; snapshot: TerminalSnapshot }
  | { type: "patch"; terminalId: TerminalId; patch: TerminalFramePatch }
  | { type: "historyDelta"; terminalId: TerminalId; delta: TerminalHistoryDelta }
  | { type: "status"; terminalId: TerminalId; status: TerminalSession["status"]; pid?: number; exitCode?: number }
  | { type: "metric"; terminalId: TerminalId; metric: TerminalMetric }
  | { type: "error"; terminalId: TerminalId | null; message: string }
```

Patch ops should start with the Solo-shaped minimum:

- `replaceRow`
- `replaceCells`
- `insertRows`
- `deleteRows`
- `setCursor`
- `setModes`
- `setBufferKind`
- `setViewport`
- `reset`

## Task Breakdown

### T0. Terminal ADR And Contract Freeze

Purpose: turn this file into an accepted ADR before implementation.

Files:

- `docs/adr/000x-kiri-terminal-stack.md` or equivalent new ADR path.
- `TERMTASKS.md`

Work:

- Record the decision to replace xterm/node-pty with a Rust terminal core and Kiri renderer.
- Record no-fallback scope.
- Record supported terminal semantics: runtime, shell, workflow, tabs, panes, attach/resume, paste/inject.
- Record libraries: `portable-pty`, `vte`, `unicode-width`, `serde`, `rmp-serde`.
- Record non-goals: full WezTerm clone, full tmux clone, terminal marketplace, remote terminal domains.

Verification:

- ADR reviewed by human.
- No code changes.

Dependencies:

- None.

### T1. Rust Crate Skeleton

Purpose: add the Rust terminal crate without changing Kiri behavior yet.

Files:

- `Cargo.toml`
- `crates/kiri-term/Cargo.toml`
- `crates/kiri-term/src/main.rs`
- `crates/kiri-term/src/lib.rs`
- `crates/kiri-term/src/protocol.rs`
- `crates/kiri-term/src/pty.rs`
- `crates/kiri-term/src/document.rs`
- `crates/kiri-term/src/patch.rs`
- `crates/kiri-term/src/history.rs`
- `crates/kiri-term/src/registry.rs`
- `crates/kiri-term/tests/`

Work:

- Add `crates/kiri-term` to the workspace.
- Add deps:
  - `portable-pty = "0.8.1"`
  - `vte = "0.15.0"`
  - `unicode-width = "0.2.2"`
  - `serde`
  - `serde_json`
  - `rmp-serde`
  - `anyhow` or thiserror-style typed errors
- Define protocol structs in Rust first.
- Add a small CLI mode that can parse fixture bytes into a snapshot for test use.

Tests:

- `cargo fmt`
- `cargo test -p kiri-term`
- Fixture parse test for plain output, ANSI color, clear screen, cursor move, alt screen.

Acceptance:

- Crate builds and tests.
- No TS behavior changed.

### T2. Terminal Document Model

Purpose: make Rust own terminal truth.

Files:

- `crates/kiri-term/src/document.rs`
- `crates/kiri-term/src/grid.rs`
- `crates/kiri-term/src/cell.rs`
- `crates/kiri-term/src/modes.rs`
- `crates/kiri-term/src/parser.rs`
- `crates/kiri-term/tests/document_*.rs`
- `tests/fixtures/terminal/ansi/`

Work:

- Implement a fixed viewport grid plus scrollback history.
- Model main and alt buffers.
- Track cursor position, shape, visibility.
- Track text attributes:
  - bold
  - dim
  - italic
  - underline
  - inverse
  - foreground/background 16-color, 256-color, truecolor
- Track modes:
  - bracketed paste
  - app cursor keys
  - app keypad
  - mouse mode basic/sgr
  - focus reporting
  - origin mode
  - wrap
  - synchronized output
- Use `unicode-width` for cell width.
- Produce `CellRun`s per row, not one object per cell in the wire format.

Tests:

- Golden snapshot tests for:
  - color/style runs
  - wide characters
  - combining characters
  - cursor movement
  - line wrapping
  - erase display/line
  - alt screen enter/exit
  - bracketed paste mode set/reset
  - resize behavior

Acceptance:

- Fixtures parse deterministically.
- Snapshot JSON/MessagePack can be compared in tests.

### T3. Patch Stream And History Delta

Purpose: make attach/resume cheap and exact.

Files:

- `crates/kiri-term/src/patch.rs`
- `crates/kiri-term/src/history.rs`
- `crates/kiri-term/src/document.rs`
- `crates/kiri-term/tests/patch_*.rs`

Work:

- Add monotonically increasing `screenSeq`.
- Add monotonically increasing `historySeq`.
- Add row fingerprints.
- Emit patch ops:
  - replace row
  - replace cell range
  - insert rows
  - delete rows
  - cursor update
  - mode update
  - buffer kind update
  - viewport update
  - reset
- Keep history separate from visible grid.
- Implement attach behavior:
  - if client has current enough sequence, send patches since seq
  - otherwise send full snapshot
- Keep patch ring bounded with explicit "snapshot required" outcome.

Tests:

- Patch replay equals full snapshot for fixture streams.
- Old sequence returns snapshot-required.
- History delta can reconstruct scrollback tail.
- Resize produces valid snapshot/patch.

Acceptance:

- `snapshot_after(full bytes)` equals `snapshot + patches`.
- Patch ring memory is bounded.

### T4. PTY Process Owner

Purpose: replace node-pty process ownership with Rust `portable-pty`.

Files:

- `crates/kiri-term/src/pty.rs`
- `crates/kiri-term/src/registry.rs`
- `crates/kiri-term/src/runtime.rs`
- `crates/kiri-term/tests/pty_*.rs`

Work:

- Spawn command with cwd/env/cols/rows.
- Read PTY output on background thread/task.
- Feed bytes into parser/document.
- Coalesce reads into frame patches.
- Implement write queue with backpressure metrics.
- Implement resize.
- Implement kill/terminate/interrupt/eof.
- Capture pid and exit status where available.
- Preserve process group cleanup behavior.

Tests:

- Spawn `/bin/sh` or configured shell in temp dir.
- Write `pwd`, verify rendered output.
- Resize, verify dimensions.
- Kill, verify exit status event.
- Backpressure test with a command that writes large output.

Acceptance:

- Rust can own a shell PTY end-to-end.
- No Kiri TS integration yet required.

### T5. Rust Terminal Server Protocol

Purpose: expose Rust terminal sessions to the TS server and browser.

Files:

- `crates/kiri-term/src/server.rs`
- `crates/kiri-term/src/protocol.rs`
- `crates/kiri-term/src/main.rs`
- `crates/kiri-term/tests/protocol_*.rs`
- `src/server/terminal-server.ts`
- `src/server/terminal-registry.ts`

Work:

- Add local server mode to `kiri-term`.
- Use MessagePack frames for hot path.
- Keep auth token semantics from current `terminal-server.ts`.
- Support:
  - create runtime/shell terminal
  - attach/detach
  - input
  - paste
  - inject
  - resize
  - signal
  - kill
  - snapshot
- TS `TerminalServerApi` becomes a client for the Rust server.
- Remove raw replay string behavior from the primary path.

Tests:

- Rust protocol roundtrip tests.
- TS server tests updated:
  - `tests/server/terminal-server.test.ts`
  - `tests/server/terminal-registry.test.ts`
- Attach returns snapshot.
- Repeat attach does not spawn another PTY.
- Input write failure requeues pending input.

Acceptance:

- Current server tests pass against Rust-owned terminal process.
- Current `TerminalConfig` shape may change, but callers remain simple.

### T6. Kiri Renderer

Purpose: replace xterm with an imperative Kiri DOM renderer.

Files:

- `src/components/kiri-board/terminal-panel.tsx`
- `src/components/kiri-board/terminal-view.tsx`
- `src/lib/terminal/renderer.ts`
- `src/lib/terminal/dom-grid.ts`
- `src/lib/terminal/selection.ts`
- `src/lib/terminal/input.ts`
- `src/styles/app/board-chat-diff-terminal.css`
- `tests/kiri-board/terminal-renderer.test.ts`
- `tests/kiri-board/terminal-panel.test.ts`

Work:

- Remove xterm creation/import from the terminal view.
- Render rows from `TerminalSnapshot` and `TerminalFramePatch`.
- Keep renderer outside React render loops.
- Use stable row nodes and patch only dirty rows.
- Render `CellRun`s as spans.
- Cursor overlay.
- Scrollback virtualization.
- Selection/copy support.
- Wheel behavior for normal buffer.
- Alt buffer wheel passes through as encoded terminal mouse input if mouse mode is active.
- Typography/theme support using current Kiri settings.
- Renderer-neutral debug attrs:
  - `data-terminal-renderer`
  - `data-terminal-screen-seq`
  - `data-terminal-history-seq`
  - `data-terminal-buffer-kind`
  - `data-terminal-render-ms`
  - `data-terminal-dirty-rows`

Tests:

- Snapshot apply renders expected text.
- Patch apply updates only dirty rows.
- Selection copies text across wrapped rows.
- Cursor render updates.
- Theme/typography update does not recreate terminal session.
- Existing focus tests still pass.

Acceptance:

- `@xterm/xterm` and `@xterm/addon-fit` are no longer used in app code.

### T7. Terminal Tabs

Purpose: support multiple terminals in the terminal section.

Files:

- `src/components/kiri-board/terminal-tabs.tsx`
- `src/components/kiri-board/terminal-panel.tsx`
- `src/components/kiri-board/selected-agent-pane.tsx`
- `src/lib/contracts.ts`
- `src/server/db/migrations.ts`
- `src/server/db/terminal-tabs.ts`
- `src/server/workspace-service.ts`
- `src/server/workspace.ts`
- `tests/server/db-terminal-tabs.test.ts`
- `tests/kiri-board/terminal-tabs.test.tsx`

Work:

- Add persistent terminal tab metadata.
- Support default tabs:
  - agent runtime terminal tab
  - project shell terminal tab
- Support user-created shell tab.
- Support workflow-created terminal tab.
- Tab switch attaches to existing terminal, does not spawn.
- Hidden tabs do not repaint.
- Closing a tab asks Rust to terminate or detach according to status.

Tests:

- Create tab persists.
- Switch tabs preserves terminal id and pid.
- Close tab kills process when requested.
- Workflow tab is visible and selected when spawned from workflow.

Acceptance:

- Multiple independent shell terminals can run in one project.
- Runtime terminal and shell terminal are not conflated.

### T8. Split Panes

Purpose: support WezTerm-style split panes without becoming a full terminal multiplexer clone.

Files:

- `src/components/kiri-board/terminal-tabs.tsx`
- `src/components/kiri-board/terminal-split-layout.tsx`
- `src/lib/terminal/layout.ts`
- `src/server/db/terminal-tabs.ts`
- `src/lib/contracts.ts`
- `tests/kiri-board/terminal-split-layout.test.ts`
- `tests/server/db-terminal-tabs.test.ts`

Work:

- Model a tab as a binary pane tree.
- Each pane references exactly one `terminalId`.
- Support:
  - split right
  - split down
  - close pane
  - focus pane
  - resize divider
  - new terminal in split using same cwd/env defaults
- Keep layout in TS/UI/persistence. Rust owns terminal processes, not visual layout.
- Use WezTerm as vocabulary reference: tabs contain panes; panes own terminals.

Tests:

- Split creates a new pane and terminal.
- Focus changes active pane.
- Resize persists layout ratio.
- Closing one pane does not kill sibling terminal.
- Moving between tabs keeps pane focus.

Acceptance:

- A user can run two commands side by side in the Terminal section.

### T9. Paste And Inject Semantics

Purpose: make workflow/agent input reliable and auditable.

Files:

- `src/lib/contracts.ts`
- `src/server/kiri-control.ts`
- `src/server/workflow-orchestration.ts`
- `src/server/scratchpad-trigger.ts`
- `src/server/db/runtime-state.ts`
- `crates/kiri-term/src/protocol.rs`
- `crates/kiri-term/src/registry.rs`
- `tests/server/kiri-control-cli.test.ts`
- `tests/server/scratchpad-trigger-service.test.ts`
- `tests/server/db-runtime-state.test.ts`
- `tests/e2e/kiri.spec.ts`

Work:

- Preserve current `terminal.input` behavior.
- Make target explicit:
  - by `agentId` for runtime terminal
  - by `terminalId` for existing terminal
  - by active project terminal when user action comes from UI
- `paste`:
  - human/workflow text
  - bracketed-paste aware
  - can submit or not submit
- `inject`:
  - system path
  - requires `idempotencyKey`
  - records source: workflow, scratchpad, kiri-control, agent
  - writes once even if dispatch/retry happens twice
- If terminal exists and is running, paste into it.
- If terminal does not exist and spawn=true, create it then paste.
- If terminal does not exist and spawn=false, queue it.

Tests:

- Workflow dispatch queues and spawns terminal.
- Re-dispatch with same idempotency key does not duplicate input.
- `terminal.input` can paste again into the same open Claude/OpenCode/Codex runtime terminal.
- Pending input requeues on write failure.
- Submit false does not append enter.

Acceptance:

- AI agents can continue an already-open runtime terminal thread through Kiri control.

### T10. Runtime Agent Harness

Purpose: let AI agents test terminal behavior without needing real external auth.

Files:

- `tests/harness/fake-codex-terminal.mjs` existing
- `tests/harness/fake-claude-terminal.mjs`
- `tests/harness/fake-opencode-terminal.mjs`
- `tests/harness/terminal-agent-harness.ts`
- `tests/server/terminal-agent-harness.test.ts`
- `tests/e2e/terminal-agent.spec.ts`

Work:

- Add fake Claude terminal that mimics:
  - prompt
  - accepts pasted text
  - prints session id
  - supports repeated turns
  - supports `/exit` or ctrl-d
  - emits a marker on resume
- Add fake OpenCode terminal with the same surface.
- Add harness commands:
  - create runtime terminal
  - attach
  - paste
  - paste again to same terminal
  - split
  - new tab
  - kill
  - read rendered snapshot
- Add a deterministic transcript format so tests can assert same terminal thread.

Tests:

- Fake Claude: first paste and second paste land in same PID/session marker.
- Fake OpenCode: first paste and second paste land in same PID/session marker.
- Fake Codex: existing resume behavior still works.
- Harness can run without network or auth.

Acceptance:

- An AI agent can exercise the same flows a human uses: open terminal, paste, continue, split pane, create tab, run command, inspect rendered output.

### T11. Project Shell Harness

Purpose: verify normal terminal work: editors, scripts, and long output.

Files:

- `tests/harness/terminal-shell-harness.ts`
- `tests/e2e/terminal-shell.spec.ts`
- `tests/fixtures/terminal/scripts/`

Work:

- Add scripts:
  - long output generator
  - ANSI color matrix
  - alt-screen smoke
  - bracketed paste detector
  - mouse reporting detector
  - resize reporter
- Add optional editor smoke:
  - `vim` or `nvim` if installed
  - `less`
  - `top`-style alt-screen fixture if editor missing
- Assert rendered screen, not raw transcript only.

Tests:

- Long output does not freeze UI.
- Bracketed paste wraps pasted content.
- Resize updates PTY and rendered grid.
- Alt screen enters/exits correctly.
- Shell tab survives switching tabs/panes.

Acceptance:

- Kiri terminal is useful as a project terminal, not only an agent prompt launcher.

### T12. E2E Current Kiri Flow Preservation

Purpose: prove replacement still works in the current product.

Files:

- `tests/e2e/kiri.spec.ts`
- new focused tests may be split into `tests/e2e/terminal.spec.ts`

Required E2E flows:

- Sidebar opens Terminal tab and shows connected shell.
- Terminal preserves running shell across Chat/Diffs/Terminal/Scratchpad switches.
- Terminal-mode session renders runtime terminal in Chat.
- Terminal tab renders shell terminal while Chat runtime terminal stays alive.
- Codex terminal interface resumes and keeps diffs available.
- Scratchpad trigger starts Codex terminal by default.
- Workflow dispatch spawns terminal and pastes prompt.
- Second workflow/control paste targets same open runtime terminal.
- Multiple terminal tabs run different commands independently.
- Split pane runs two commands independently.
- Closing one pane does not kill another pane.

Acceptance:

- Focused terminal E2E suite passes on Chromium.

### T13. Performance Harness

Purpose: make performance regression visible.

Files:

- `crates/kiri-term/benches/`
- `tests/perf/run-terminal-perf.ts`
- `tests/server/perf-gates.test.ts`
- `tests/fixtures/terminal/perf/`

Metrics:

- Rust PTY read bytes/sec.
- Rust parse bytes/sec.
- Patch build time.
- Patch encode/decode time.
- Snapshot size.
- Patch size.
- Client patch apply time.
- Dirty rows per frame.
- Render frame p95/p99.
- Memory for scrollback.
- Time to attach.
- Time to paste into running terminal.
- Time to recover after UI detach/reattach.

Perf scenarios:

- 10k lines plain output.
- 100k lines plain output.
- ANSI color matrix.
- Cargo/build-like mixed output.
- Alt-screen rapid repaint.
- Large paste.
- Split pane with two noisy terminals.
- Four terminal tabs with one active, three hidden.

Initial target budgets:

- Hidden terminals do not repaint.
- Active terminal patch apply p95 under one frame budget on normal output.
- 100k-line output keeps UI responsive.
- Attach to existing terminal returns usable snapshot under 100ms on typical local state.
- Repeated paste into running terminal completes under 50ms excluding agent response time.

Acceptance:

- Perf harness becomes part of `pnpm test:perf` or a new explicit `pnpm test:terminal-perf`.
- Baselines are checked into a small JSON fixture or documented threshold file.

### T14. Packaging And Dependency Cleanup

Purpose: ship the Rust terminal in desktop builds.

Files:

- `package.json`
- `scripts/build-cli.mjs`
- `scripts/sanitize-desktop-package-inputs.mjs`
- `scripts/normalize-desktop-app.mjs`
- `src/desktop/main.mjs`
- `resources/bin/`
- `tests/server/desktop-package-contract.test.ts`

Work:

- Build `kiri-term` during desktop packaging.
- Include the sidecar binary in `extraResources`.
- Remove `node-pty` dependency after server path is fully replaced.
- Remove `@xterm/xterm` and `@xterm/addon-fit` after renderer is fully replaced.
- Remove `asarUnpack node_modules/node-pty/**`.
- Ensure codesign/notarization-sensitive layout is stable.

Tests:

- `pnpm verify:desktop:smoke`
- `pnpm verify:desktop:package`
- `pnpm install:desktop`
- Launch installed app and run focused terminal smoke.

Acceptance:

- Packaged app can spawn shell and runtime terminals through Rust terminal.

### T15. Observability And Diagnostics

Purpose: make terminal failures debuggable by humans and agents.

Files:

- `crates/kiri-term/src/metrics.rs`
- `src/lib/terminal/metrics.ts`
- `src/components/kiri-board/terminal-panel.tsx`
- `src/server/kiri-control.ts`
- `tests/server/kiri-mcp.test.ts`

Work:

- Add renderer-neutral debug attributes.
- Add control op or dev-only diagnostic to flush terminal metrics.
- Add per-terminal status:
  - pid
  - cwd
  - cols/rows
  - screenSeq/historySeq
  - buffer kind
  - active modes
  - last input source
  - last patch latency
- Add panic/failure snapshots from Rust.

Tests:

- Diagnostic returns current terminal state.
- Metrics are emitted for spawn, attach, paste, render.

Acceptance:

- When a terminal test fails, the harness prints enough state to diagnose without a manual screen recording.

## Suggested Parallel Workstreams

These can be separate worktrees after ADR approval:

1. Rust core:
   - T1, T2, T3, T4

2. TS protocol/server integration:
   - T5, T9, T15 server side

3. Renderer:
   - T6, T11 renderer fixtures, T13 client perf

4. Tabs/panes:
   - T7, T8

5. Harness/E2E:
   - T10, T11, T12, T13

6. Packaging:
   - T14 after T5/T6 are usable

## Verification Matrix

Minimum gates before replacing current terminal path:

```sh
cargo fmt
cargo test -p kiri-term
pnpm exec vitest run tests/server/terminal-launch.test.ts tests/server/terminal-server.test.ts tests/server/terminal-registry.test.ts
pnpm exec vitest run tests/server/kiri-control-cli.test.ts tests/server/scratchpad-trigger-service.test.ts tests/server/db-runtime-state.test.ts
pnpm exec vitest run tests/kiri-board/terminal-panel.test.ts
pnpm test:e2e tests/e2e/kiri.spec.ts -g "terminal preserves|terminal interface|codex terminal interface|scratchpad trigger starts codex" --project=chromium
pnpm test:perf
pnpm build
```

Additional gates before desktop handoff:

```sh
pnpm verify:desktop:smoke
pnpm verify:desktop:package
pnpm install:desktop
```

## Agent Rules For This Work

- Always work in a separate worktree.
- Do not edit the original checkout unless explicitly told.
- Preserve current runtime launch logic unless your task explicitly owns that file and tests the behavior.
- Do not add xterm fallback paths.
- Do not broaden scope into remote terminals, SSH, or a full tmux clone.
- Every changed functional path gets tests.
- For UI work, verify with browser/E2E, not just unit tests.
- For Rust work, run `cargo fmt` and `cargo test -p kiri-term`.
- Report changed files, commands run, perf deltas, and blockers.
