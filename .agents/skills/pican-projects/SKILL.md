---
name: pican-projects
description: Add, list, and delete pican projects safely through the local SQLite-backed CLI.
---

# pican Projects

Use this skill when the user asks to add, remove, delete, list, or inspect pican projects.

## Commands

```sh
pnpm pican:projects list
pnpm pican:projects add --name "Project Name" --cwd /absolute/path --id stable-id
pnpm pican:projects delete --id stable-id --yes
```

## Behavior

- `add` validates that `cwd` exists, inserts a project row, and creates default Pi slots: `planner`, `builder`, `reviewer`.
- `delete` requires `--yes` and deletes the project row. SQLite cascades agent slots, active threads, messages, and diff artifacts.
- Deleting a project does not remove the project working directory or existing session files.

## Agent Rules

- Do not hand-edit `.pican/pican.sqlite` for normal project registry changes.
- Use stable lowercase ids when possible.
- Run `pnpm pican:projects list` before and after mutations.
