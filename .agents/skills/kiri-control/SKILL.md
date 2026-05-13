---
name: kiri-control
description: Use the kiri CLI to list models, manage projects, and create, rename, archive, or restore agent sessions from this repo. Use when an agent needs to operate kiri from web, desktop, shell, or automation contexts.
---

# kiri Control

Use `pnpm kiri` from the repo root. `pnpm kiricli` and `pnpm kiri:ctl` are aliases. Prefer `--json` for automation.

## Models

```sh
pnpm kiri models list --json
pnpm kiri:ctl models list --json
pnpm kiri:ctl models list --runtime pi --json
```

- Runtime is the provider boundary: `pi`, `codex`, `claude`.
- Valid models come from `settings.json`; do not hard-code or invent model ids.

## Projects

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

## Rules

- Do not hand-edit `.kiri/kiri.sqlite`.
- Run `pnpm kiri models list --json` before creating sessions unless the exact runtime/model is already known.
- Run list commands before and after mutations when changing existing state.
- Run `pnpm build` after code or contract changes.
- Run `pnpm kiri:agent-harness` after CLI or skill changes; it exercises the documented commands in an isolated kiri state directory.
