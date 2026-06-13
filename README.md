# kiri

Keyboard-first local agent control plane for Codex, Claude Code, Pi, and
OpenCode.

Kiri keeps local AI coding sessions organized by project, with persistent
terminal panes, chat timelines, scratchpad, workflow runs, and compact CLI/MCP
controls.

Website: https://kiri-8zk.pages.dev

## Download

The latest macOS Apple Silicon build is published on GitHub Releases:

https://github.com/Yeshwanthyk/kiri/releases

## Features

- Project lanes for grouping local repos and sessions.
- Keyboard-first navigation for switching projects, tabs, and sessions.
- Runtime sessions for Codex, Claude Code, Pi, OpenCode, and shell terminals.
- Persistent terminal panes backed by Kiri-owned PTYs.
- Chat timeline, terminal, and scratchpad views for each session.
- Durable workflow runs for splitting a plan into launchable items.
- Agent-first CLI and MCP operations for automation.

## Development

```sh
pnpm install
pnpm dev
```

The dev and desktop servers use port `3090`.

## Verification

```sh
pnpm verify
```

Focused gates:

```sh
pnpm typecheck
pnpm lint
pnpm effect:audit
pnpm test
pnpm verify:e2e
pnpm verify:desktop
```

## Desktop Build

```sh
pnpm install:desktop
```

This builds the web/server bundles, packages the macOS app, creates the DMG,
replaces `~/Applications/kiri.app`, and opens the installed app.

## CLI

```sh
pnpm kiri:ctl call '{"operation":"project.list","params":{"includeHidden":true}}'
pnpm kiri:ctl call '{"operation":"project.add","params":{"name":"Project Name","cwd":"/absolute/path","id":"project-id"}}'
pnpm kiri:ctl call '{"operation":"project.hide","params":{"id":"project-id"}}'
pnpm kiri:ctl call '{"operation":"project.unhide","params":{"id":"project-id"}}'
pnpm kiri:ctl call '{"operation":"project.delete","params":{"id":"project-id"}}'
```

Project deletion removes Kiri metadata only. It does not delete the project
working directory.

## Workflows

```sh
pnpm kiri:ctl call '{"operation":"workflow.create","params":{"projectId":"kiri","title":"Parallel plan","defaults":{"runtime":"pi","model":"openai-codex/gpt-5.5","attachScratchpad":true},"items":[{"id":"impl","action":"launch","title":"Implement","body":"Implement the accepted plan"},{"id":"review","action":"launch","title":"Review","body":"Review the implementation"},{"id":"notes","action":"scratchpad","title":"Notes","body":"Track this note without launching a session"}]}}'
pnpm kiri:ctl call '{"operation":"workflow.dispatch","params":{"id":"workflow-id"}}'
pnpm kiri:ctl call '{"operation":"workflow.show","params":{"id":"workflow-id"}}'
pnpm kiri:ctl call '{"operation":"workflow.archive","params":{"id":"workflow-id"}}'
```

When the desktop backend is running, workflow dispatch opens Kiri-owned runtime
terminals and pastes each launch item into the PTY. If the backend is not
reachable, launch text stays queued until Kiri opens that terminal.

## State

Kiri stores its local read model under `~/.kiri/userdata/kiri.sqlite` by
default. Runtime model lists live in `settings.json`.
