# pican

Keyboard-first kanban orchestrator for Pi agent sessions.

## Run

```sh
pnpm install
pnpm dev
```

## Verify

```sh
pnpm build
```

## Projects

```sh
pnpm pican:projects list
pnpm pican:projects add --name "Pican Orchestrator" --cwd /path/to/repo --id pican
pnpm pican:projects delete --id pican --yes
```

Adding a project creates the default Pi agent slots: `planner`, `builder`, and
`reviewer`. Deleting a project removes pican metadata for that project; it does
not delete the project working directory.

## Settings

Runtime model lists live in `settings.json`. Start a session from the selected
project, choose a runtime/model, or keep the runtime default for a base session.
Pi launches with the configured list through `pi --models ...` and the selected
session model through `--model ...`.

## Shape

- TanStack Start app shell.
- SQLite read model under `.pican/pican.sqlite`.
- Pi is the first runtime via `pi --mode rpc`.
- Pi JSONL is parsed as a transcript/read-model source, not the live command channel.
- Pierre diffs render review artifacts.

## Keyboard

- `Shift+ArrowUp` / `Shift+ArrowDown`: move between projects.
- `Shift+H/J/K/L`: move between agents in the selected project.
- `Shift+N`: start a session in the selected project.
