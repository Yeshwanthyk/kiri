# pican Agent Notes

## Project Registry

Use the CLI instead of editing `.pican/pican.sqlite` by hand.

```sh
pnpm pican:projects list
pnpm pican:projects add --name "Project Name" --cwd /absolute/path --id stable-id
pnpm pican:projects delete --id stable-id --yes
```

Rules:

- `add` creates `planner`, `builder`, and `reviewer` Pi agent slots.
- `delete` removes only pican metadata; it does not delete the repo directory or session files.
- Prefer stable lowercase ids; omit `--id` only when the slugified name is acceptable.
- Run `pnpm build` after changes touching app code or contracts.

## Runtime Models

Use `settings.json` for runtime model lists. Do not hard-code model menus in UI
or server handlers. Sessions are represented as agent slots and store the
`runtime` and `model` chosen when the session starts, but valid choices come
from `settings.json`. Do not add global per-slot model settings; model choice
belongs to session start.

## Skill Routing

If asked how to add/delete projects, use `.agents/skills/pican-projects/SKILL.md`.
