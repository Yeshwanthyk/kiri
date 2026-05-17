---
name: kiri-projects
description: Add, list, hide, unhide, and delete kiri projects safely through the agent-first Kiri operation CLI.
---

# kiri Projects

Use this skill when the user asks to add, remove, delete, hide, unhide, list, or inspect kiri projects.

## Commands

All project operations use the JSON operation surface:

```sh
pnpm kiri:ctl call '{"operation":"project.list","params":{"includeHidden":true}}'
pnpm kiri:ctl call '{"operation":"project.add","params":{"name":"Project Name","cwd":"/absolute/path","id":"stable-id"}}'
pnpm kiri:ctl call '{"operation":"project.hide","params":{"id":"stable-id"}}'
pnpm kiri:ctl call '{"operation":"project.unhide","params":{"id":"stable-id"}}'
pnpm kiri:ctl call '{"operation":"project.delete","params":{"id":"stable-id"}}'
```

## Behavior

- `project.add` validates that `cwd` exists and inserts a project row. It does not create default sessions.
- `project.hide` removes a project from the board without deleting metadata or sessions.
- `project.unhide` makes a hidden project visible again.
- `project.delete` deletes the project row. SQLite cascades agent slots, active threads, messages, and diff artifacts.
- Deleting a project does not remove the project working directory or existing session files.

## Agent Rules

- Do not hand-edit `.kiri/kiri.sqlite` for normal project registry changes.
- Use stable lowercase ids when possible.
- Run `project.list` with `includeHidden: true` before and after mutations.
- For session/model/scratchpad work, use the `kiri-control` skill and the same operation CLI.
