---
name: aether-projects
description: Add, list, and delete aether projects safely through the local SQLite-backed CLI.
---

# aether Projects

Use this skill when the user asks to add, remove, delete, list, or inspect aether projects.

## Commands

```sh
pnpm aether:projects list
pnpm aether:projects add --name "Project Name" --cwd /absolute/path --id stable-id
pnpm aether:projects delete --id stable-id --yes
```

## Behavior

- `add` validates that `cwd` exists and inserts a project row. It does not create default sessions.
- `delete` requires `--yes` and deletes the project row. SQLite cascades agent slots, active threads, messages, and diff artifacts.
- Deleting a project does not remove the project working directory or existing session files.

## Agent Rules

- Do not hand-edit `.aether/aether.sqlite` for normal project registry changes.
- Use stable lowercase ids when possible.
- Run `pnpm aether:projects list` before and after mutations.
