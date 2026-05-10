# aether Agent Notes

## Project Registry

Use the CLI instead of editing `.aether/aether.sqlite` by hand.

```sh
pnpm aether:projects list [--all]
pnpm aether:projects add --name "Project Name" --cwd /absolute/path --id stable-id
pnpm aether:projects hide --id stable-id
pnpm aether:projects unhide --id stable-id
pnpm aether:projects delete --id stable-id --yes
```

Rules:

- `add` creates only a project row. Sessions are created explicitly from the board.
- `hide` removes a project from the board without deleting metadata or sessions.
- `delete` removes only aether metadata; it does not delete the repo directory or session files.
- Prefer stable lowercase ids; omit `--id` only when the slugified name is acceptable.
- Run `pnpm build` after changes touching app code or contracts.

## Runtime Models

Use `settings.json` for runtime model lists. Do not hard-code model menus in UI
or server handlers. Sessions are represented as agent slots and store the
`runtime` and `model` chosen when the session starts, but valid choices come
from `settings.json`. Do not add global per-slot model settings; model choice
belongs to session start.

Started sessions are agent slots whose `slot` starts with `session-`. Projects
do not have default planner/builder/reviewer slots.

## Skill Routing

If asked how to add/delete projects, use `.agents/skills/aether-projects/SKILL.md`.
