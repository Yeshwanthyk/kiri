---
name: kiri-projects
description: Add, list, hide, unhide, and delete kiri projects safely through the project CLI.
---

# kiri Projects

Use this skill when the user asks to add, remove, delete, hide, unhide, list, or inspect kiri projects.

## Commands

```sh
pnpm kiri:projects list
pnpm kiri:projects list --all
pnpm kiri:projects add --name "Project Name" --cwd /absolute/path --id stable-id
pnpm kiri:projects hide --id stable-id
pnpm kiri:projects unhide --id stable-id
pnpm kiri:projects delete --id stable-id --yes
```

## Behavior

- `add` validates that `cwd` exists and inserts a project row. It does not create default sessions.
- `hide` removes a project from the board without deleting metadata or sessions.
- `unhide` makes a hidden project visible again.
- `delete` requires `--yes` and deletes the project row. SQLite cascades agent slots, active threads, messages, and diff artifacts.
- Deleting a project does not remove the project working directory or existing session files.

## Agent Rules

- Do not hand-edit `.kiri/kiri.sqlite` for normal project registry changes.
- Use stable lowercase ids when possible.
- Run `pnpm kiri:projects list --all` before and after mutations.
- For session/model work, use the `kiri-control` skill and `pnpm kiri:ctl`.
