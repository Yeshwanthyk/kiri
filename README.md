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

## Shape

- TanStack Start app shell.
- SQLite read model under `.pican/pican.sqlite`.
- Pi is the first runtime via `pi --mode rpc`.
- Pi JSONL is parsed as a transcript/read-model source, not the live command channel.
- Pierre diffs render review artifacts.

## Keyboard

- `Shift+ArrowUp` / `Shift+ArrowDown`: move between projects.
- `Shift+H/J/K/L`: move between agents in the selected project.
