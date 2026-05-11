# aether

Keyboard-first kanban orchestrator for Pi agent sessions.

## Run

```sh
pnpm install
pnpm dev
```

For Tailscale access, bind Vite to all interfaces:

```sh
pnpm exec vite dev --host 0.0.0.0 --port 3090
```

`--host 127.0.0.1` is localhost-only and will not be reachable over Tailscale.

## Verify

```sh
pnpm build
```

## Projects

```sh
pnpm aether:projects list [--all]
pnpm aether:projects add --name "Aether Orchestrator" --cwd /path/to/repo --id aether
pnpm aether:projects hide --id aether
pnpm aether:projects unhide --id aether
pnpm aether:projects delete --id aether --yes
```

Adding a project creates a project row with no sessions. Hiding removes a
project from the board while preserving its sessions and metadata. Deleting a
project removes aether metadata for that project; it does not delete the project
working directory.

## Settings

Runtime model lists live in `settings.json`. Start a session from the selected
project, choose a runtime/model, or keep the runtime default for a base session.
Pi launches with the configured list through `pi --models ...` and the selected
session model through `--model ...`.

## Shape

- TanStack Start app shell.
- SQLite read model under `.aether/aether.sqlite`.
- Pi is the first runtime via `pi --mode rpc`.
- Pi JSONL is parsed as a transcript/read-model source, not the live command channel.
- Pierre diffs render review artifacts.

## Keyboard

- `Shift+ArrowUp` / `Shift+ArrowDown`: move between projects.
- `Shift+H/J/K/L`: move between agents in the selected project.
- `Shift+N`: start a session in the selected project.
- `Shift+X`: confirm and remove the selected session.
