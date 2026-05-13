---
name: kiri-control
description: Use the Kiri MCP server first, with the CLI only as fallback, to list models, manage projects, manage scratchpad blocks, and create, rename, archive, or restore agent sessions from this repo. Use when an agent needs to operate Kiri from web, desktop, shell, or automation contexts.
---

# kiri Control

Prefer MCP for all Kiri control operations.

1. If the host exposes the `kiri` MCP server, call its `kiri_*` tools directly.
2. If the host does not expose MCP tools in the current session, use the installed MCP helper over stdio:

```sh
/Users/yesh/Applications/kiri.app/Contents/Resources/bin/kiri-mcp
```

3. Use the repo CLI only as a fallback/manual path from the repo root. `pnpm kiri`, `pnpm kiricli`, and `pnpm kiri:ctl` are aliases. Prefer `--json` for automation.

## Models

MCP:

- `kiri_list_models`

CLI fallback:

```sh
pnpm kiri models list --json
pnpm kiri:ctl models list --json
pnpm kiri:ctl models list --runtime pi --json
```

- Runtime is the provider boundary: `pi`, `codex`, `claude`.
- Valid models come from `settings.json`; do not hard-code or invent model ids.

## Projects

MCP:

- `kiri_list_projects`
- `kiri_add_project`
- `kiri_hide_project`
- `kiri_unhide_project`
- `kiri_delete_project`

CLI fallback:

```sh
pnpm kiri:ctl projects list --all --json
pnpm kiri:ctl projects add --name "Project Name" --cwd /absolute/path --id stable-id --json
pnpm kiri:ctl projects hide --id stable-id --json
pnpm kiri:ctl projects unhide --id stable-id --json
pnpm kiri:ctl projects delete --id stable-id --yes --json
```

- `add` creates only a project row. It does not create sessions.
- `hide` removes a project from the board without deleting metadata.
- `delete` removes kiri metadata only; it does not delete the working directory.

## Sessions

MCP:

- `kiri_list_sessions`
- `kiri_start_session`
- `kiri_rename_session`
- `kiri_delete_session`
- `kiri_restore_session`
- `kiri_resume_session`

CLI fallback:

```sh
pnpm kiri:ctl sessions list --all --json
pnpm kiri:ctl sessions create --project project-id --runtime pi --model openai-codex/gpt-5.5 --title "Build API" --json
pnpm kiri:ctl sessions rename --agent agent-id --title "New title" --json
pnpm kiri:ctl sessions delete --agent agent-id --yes --json
pnpm kiri:ctl sessions restore --agent agent-id --json
pnpm kiri:ctl sessions resume --agent agent-id --json
```

- Session identity is `agentId`.
- `delete` archives the session; use `resume` or `restore` to bring it back.
- Model/runtime selection happens at session creation.

## Scratchpad

MCP:

- `kiri_list_scratchpad`
- `kiri_add_scratchpad`
- `kiri_delete_scratchpad`
- `kiri_trigger_scratchpad`

CLI fallback:

```sh
pnpm kiri:ctl scratchpad list --project project-id --json
pnpm kiri:ctl scratchpad add --project project-id --body "Capture this for later" --json
pnpm kiri:ctl scratchpad delete --id block-id --json
pnpm kiri:ctl scratchpad trigger --id block-id --project project-id --runtime pi --model openai-codex/gpt-5.5 --title "Follow up" --json
```

- `add` captures a block and optionally associates it with a project.
- `trigger` starts a new session from the block body and marks the block triggered.

## MCP

```sh
/Users/yesh/Applications/kiri.app/Contents/Resources/bin/kiri-mcp
```

- The MCP server mirrors the CLI control surface through explicit `kiri_*` tools.
- The installed helper is the permanent desktop-app path and should be preferred over `pnpm ... tsx`.
- For development-only fallback from this repo, run `pnpm kiricli mcp`.

## Rules

- Do not hand-edit `.kiri/kiri.sqlite`.
- Use `kiri_list_models` before creating sessions unless the exact runtime/model is already known.
- Run MCP list tools before and after mutations when changing existing state.
- Keep Kiri session titles meaningful. If a session is opened from Kiri and the title is generic, stale, or misleading, identify it with `kiri_list_sessions` and rename it with `kiri_rename_session`.
- Run `pnpm build` after code or contract changes.
- Run `pnpm kiri:agent-harness` after CLI or skill changes; it exercises the documented commands in an isolated kiri state directory.
