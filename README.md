# kiri

Keyboard-first kanban orchestrator for Pi agent sessions.

## Run

```sh
pnpm install
pnpm dev
```

For Tailscale access, bind Vite to all interfaces:

```sh
pnpm dev
```

The dev and desktop servers use port `3090` and listen on all interfaces, so a
phone on Tailscale can open `http://<mac-tailnet-name-or-ip>:3090`.

## Verify

```sh
pnpm build
```

## Projects

```sh
pnpm kiri:projects list [--all]
pnpm kiri:projects add --name "kiri Orchestrator" --cwd /path/to/repo --id kiri
pnpm kiri:projects hide --id kiri
pnpm kiri:projects unhide --id kiri
pnpm kiri:projects delete --id kiri --yes
```

Adding a project creates a project row with no sessions. Hiding removes a
project from the board while preserving its sessions and metadata. Deleting a
project removes kiri metadata for that project; it does not delete the project
working directory.

## Settings

Runtime model lists live in `settings.json`. Start a session from the selected
project, choose a runtime/model, or keep the runtime default for a base session.
Pi launches with the configured list through `pi --models ...` and the selected
session model through `--model ...`.

## Shape

- TanStack Start app shell.
- SQLite read model under `~/.kiri/userdata/kiri.sqlite` by default.
- First run transfers an existing Aether database from `~/.aether/userdata/aether.sqlite` or repo-local `.aether/aether.sqlite` when the kiri database is still empty.
- Pi is the first runtime via `pi --mode rpc`.
- Pi JSONL is parsed as a transcript/read-model source, not the live command channel.
- Pierre diffs render review artifacts.

## Keyboard

- `Shift+ArrowUp` / `Shift+ArrowDown`: move between projects.
- `Shift+H/J/K/L`: move between agents in the selected project.
- `Shift+N`: start a session in the selected project.
- `Shift+X`: confirm and remove the selected session.
