---
name: aether-control
description: Use the Aether CLI to list models, manage projects, and create, rename, archive, or restore agent sessions from this repo. Use when an agent needs to operate Aether from web, desktop, shell, or automation contexts.
---

# Aether Control

Use `pnpm aether` from the repo root. `pnpm aethercli` and `pnpm aether:ctl` are aliases. Prefer `--json` for automation.

## Models

```sh
pnpm aether models list --json
pnpm aether:ctl models list --json
pnpm aether:ctl models list --runtime pi --json
```

- Runtime is the provider boundary: `pi`, `codex`, `claude`, `opencode`.
- Valid models come from `settings.json`; do not hard-code or invent model ids.

## Projects

```sh
pnpm aether:ctl projects list --all --json
pnpm aether:ctl projects add --name "Project Name" --cwd /absolute/path --id stable-id --json
pnpm aether:ctl projects hide --id stable-id --json
pnpm aether:ctl projects unhide --id stable-id --json
pnpm aether:ctl projects delete --id stable-id --yes --json
```

- `add` creates only a project row. It does not create sessions.
- `hide` removes a project from the board without deleting metadata.
- `delete` removes Aether metadata only; it does not delete the working directory.

## Sessions

```sh
pnpm aether:ctl sessions list --all --json
pnpm aether:ctl sessions create --project project-id --runtime pi --model openai-codex/gpt-5.5 --title "Build API" --json
pnpm aether:ctl sessions rename --agent agent-id --title "New title" --json
pnpm aether:title --agent agent-id --title "Current task" --json
pnpm aether:ctl sessions delete --agent agent-id --yes --json
pnpm aether:ctl sessions restore --agent agent-id --json
pnpm aether:ctl sessions resume --agent agent-id --json
```

- Session identity is `agentId`.
- For frequent in-session title updates, prefer `pnpm aether:title`; it is a tiny direct updater for low-latency agent heartbeats. If `AETHER_AGENT_ID` is set, `--agent` can be omitted.
- Keep the title short and task-shaped, and update it when the current goal changes rather than on every token.
- `delete` archives the session; use `resume` or `restore` to bring it back.
- Model/runtime selection happens at session creation.

## Rules

- Do not hand-edit `.aether/aether.sqlite`.
- Run `pnpm aether models list --json` before creating sessions unless the exact runtime/model is already known.
- Run list commands before and after mutations when changing existing state.
- Run `pnpm build` after code or contract changes.
- Run `pnpm aether:agent-harness` after CLI or skill changes; it exercises the documented commands in an isolated Aether state directory.
