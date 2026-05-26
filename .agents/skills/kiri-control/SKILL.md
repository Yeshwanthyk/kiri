---
name: kiri-control
description: Use the compact Kiri MCP/CLI operation surface to list models, manage projects, manage scratchpad blocks, create sessions, and run durable workflows from this repo.
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
- `workflow.list`, `workflow.show`

Mutate via `kiri_do` / `pnpm kiri:ctl call`:

- `project.add`, `project.hide`, `project.unhide`, `project.delete`
- `session.create`, `session.rename`, `session.archive`, `session.restore`
- `terminal.open`, `terminal.input`, `terminal.close`
- `scratchpad.add`, `scratchpad.delete`, `scratchpad.trigger`
- `workflow.validate`, `workflow.create`, `workflow.dispatch`
- `workflow.retrigger`, `workflow.track`, `workflow.untrack`
- `workflow.archive`, `workflow.restore`

## Examples

```sh
pnpm kiri:ctl call '{"operation":"model.list","params":{"runtime":"pi"}}'
pnpm kiri:ctl call '{"operation":"project.list","params":{"includeHidden":true}}'
pnpm kiri:ctl call '{"operation":"session.create","params":{"projectId":"kiri","runtime":"pi","model":"openai-codex/gpt-5.5","title":"Build API"}}'
pnpm kiri:ctl call '{"operation":"session.rename","params":{"agentId":"agent-id","title":"New title"}}'
pnpm kiri:ctl call '{"operation":"session.archive","params":{"agentId":"agent-id"}}'
pnpm kiri:ctl call '{"operation":"session.restore","params":{"agentId":"agent-id"}}'
pnpm kiri:ctl call '{"operation":"terminal.open","params":{"agentId":"agent-id"}}'
pnpm kiri:ctl call '{"operation":"terminal.input","params":{"agentId":"agent-id","text":"continue from here","submit":true,"spawn":true}}'
pnpm kiri:ctl call '{"operation":"terminal.close","params":{"agentId":"agent-id"}}'
pnpm kiri:ctl call '{"operation":"scratchpad.add","params":{"projectId":"kiri","body":"Capture this for later"}}'
pnpm kiri:ctl call '{"operation":"scratchpad.trigger","params":{"id":"block-id","projectId":"kiri","runtime":"pi","model":"openai-codex/gpt-5.5","title":"Follow up"}}'
pnpm kiri:ctl call '{"operation":"workflow.create","params":{"projectId":"kiri","title":"Build workflow","defaults":{"runtime":"pi","model":"openai-codex/gpt-5.5","attachScratchpad":true},"items":[{"id":"impl","action":"launch","title":"Implement","body":"Implement the plan"},{"id":"review","action":"launch","title":"Review","body":"Review the implementation","tracked":true}]}}'
pnpm kiri:ctl call '{"operation":"workflow.dispatch","params":{"id":"workflow-id"}}'
```

## Workflow Shape

```json
{
  "operation": "workflow.create",
  "params": {
    "projectId": "kiri",
    "title": "Parallel plan",
    "defaults": {
      "runtime": "pi",
      "interfaceMode": "gui",
      "model": "openai-codex/gpt-5.5",
      "attachScratchpad": true,
      "terminalPaste": { "submit": true }
    },
    "items": [
      {
        "id": "impl",
        "action": "launch",
        "title": "Implement",
        "body": "Implement the accepted plan"
      },
      {
        "id": "notes",
        "action": "scratchpad",
        "title": "Notes",
        "body": "Park this in scratchpad only"
      }
    ]
  }
}
```

Workflow runs are durable. `workflow.dispatch` launches tracked launch items as Kiri sessions and completes scratchpad-only items. When the desktop backend is running, CLI/MCP calls route through it and terminal launch items spawn the Kiri-owned runtime terminal and paste the body. If no backend is reachable, the body stays queued on the session and Kiri writes it when that terminal opens.

Archive completed or obsolete runs with `workflow.archive`; archived runs are read-only until `workflow.restore`.

## Rules

- Do not hand-edit `.kiri/kiri.sqlite`.
- Runtime is the provider boundary: `pi`, `codex`, `claude`, `opencode`.
- Valid models come from `settings.json`; do not hard-code or invent model ids.
- Session identity is `agentId`.
- `session.archive` archives the session; `session.restore` brings it back.
- Workflow identity is `id`; workflow item identity is `itemId`.
- Keep Kiri session titles meaningful. If a session is generic or stale, list sessions and call `session.rename`.
- Run `pnpm build` after code or contract changes.
- Run `pnpm kiri:agent-harness` after CLI or skill changes.
