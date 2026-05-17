---
name: kiri-control
description: Use the compact Kiri MCP/CLI operation surface to list models, manage projects, manage scratchpad blocks, and create, rename, archive, or restore agent sessions from this repo.
---

# kiri Control

Prefer MCP for Kiri control operations.

1. If the host exposes the `kiri` MCP server, call `kiri_get` for read operations and `kiri_do` for mutations.
2. If MCP is unavailable, use the installed helper over stdio:

```sh
/Users/yesh/Applications/kiri.app/Contents/Resources/bin/kiri-mcp
```

3. Repo fallback from the project root:

```sh
pnpm kiri:ctl call '{"operation":"operations.list"}'
pnpm kiri:ctl call --file request.json
pnpm kiricli mcp
```

## Request Shape

```json
{
  "operation": "session.rename",
  "params": {
    "agentId": "kiri-session-id",
    "title": "Useful title"
  },
  "options": {
    "compact": true
  }
}
```

Responses are always JSON envelopes:

```json
{"ok":true,"operation":"session.rename","result":{"id":"kiri-session-id","title":"Useful title"}}
```

## Operations

Read via `kiri_get` / `pnpm kiri:ctl call`:

- `operations.list`
- `context.show`
- `model.list`
- `project.list`
- `session.list`
- `scratchpad.list`

Mutate via `kiri_do` / `pnpm kiri:ctl call`:

- `project.add`, `project.hide`, `project.unhide`, `project.delete`
- `session.create`, `session.rename`, `session.archive`, `session.restore`
- `scratchpad.add`, `scratchpad.delete`, `scratchpad.trigger`

## Examples

```sh
pnpm kiri:ctl call '{"operation":"model.list","params":{"runtime":"pi"}}'
pnpm kiri:ctl call '{"operation":"project.list","params":{"includeHidden":true}}'
pnpm kiri:ctl call '{"operation":"session.create","params":{"projectId":"kiri","runtime":"pi","model":"openai-codex/gpt-5.5","title":"Build API"}}'
pnpm kiri:ctl call '{"operation":"session.rename","params":{"agentId":"agent-id","title":"New title"}}'
pnpm kiri:ctl call '{"operation":"session.archive","params":{"agentId":"agent-id"}}'
pnpm kiri:ctl call '{"operation":"session.restore","params":{"agentId":"agent-id"}}'
pnpm kiri:ctl call '{"operation":"scratchpad.add","params":{"projectId":"kiri","body":"Capture this for later"}}'
pnpm kiri:ctl call '{"operation":"scratchpad.trigger","params":{"id":"block-id","projectId":"kiri","runtime":"pi","model":"openai-codex/gpt-5.5","title":"Follow up"}}'
```

## Rules

- Do not hand-edit `.kiri/kiri.sqlite`.
- Runtime is the provider boundary: `pi`, `codex`, `claude`, `opencode`.
- Valid models come from `settings.json`; do not hard-code or invent model ids.
- Session identity is `agentId`.
- `session.archive` archives the session; `session.restore` brings it back.
- Keep Kiri session titles meaningful. If a session is generic or stale, list sessions and call `session.rename`.
- Run `pnpm build` after code or contract changes.
- Run `pnpm kiri:agent-harness` after CLI or skill changes.
