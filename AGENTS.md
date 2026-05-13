# kiri Agent Notes

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.
<!-- effect-solutions:end -->

## Project Registry

Use the CLI instead of editing `~/.kiri/userdata/kiri.sqlite` by hand.

```sh
pnpm kiri:projects list [--all]
pnpm kiri:projects add --name "Project Name" --cwd /absolute/path --id stable-id
pnpm kiri:projects hide --id stable-id
pnpm kiri:projects unhide --id stable-id
pnpm kiri:projects delete --id stable-id --yes
```

Rules:

- `add` creates only a project row. Sessions are created explicitly from the board.
- `hide` removes a project from the board without deleting metadata or sessions.
- `delete` removes only kiri metadata; it does not delete the repo directory or session files.
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

## Desktop Build / Replace Flow

Use the installer script when validating or handing off the packaged Mac app:

```sh
pnpm install:desktop
```

This command:

- Runs the production web/server build.
- Packages the macOS app bundle for the current arch.
- Creates `dist/kiri-<version>-<arch>.dmg`.
- Stops any running installed kiri app.
- Removes `~/Applications/kiri.app`.
- Copies the fresh bundle into `~/Applications/kiri.app` with `ditto` so macOS framework symlinks and resources stay intact.
- Opens the installed app bundle.

Do not manually copy the app with `cp -R`; it can rewrite framework symlinks and break Electron runtime resources. After installer changes, verify with:

```sh
pnpm install:desktop
```

Then confirm the app opens from `~/Applications/kiri.app` and the packaged backend stays running.

## Skill Routing

If asked to control kiri models, projects, or sessions from shell/automation, use `.agents/skills/kiri-control/SKILL.md`.
If asked how to add/delete projects, use `.agents/skills/kiri-projects/SKILL.md`.
