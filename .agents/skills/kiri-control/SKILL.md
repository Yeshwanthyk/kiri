---
name: kiri-control
description: Use the compact Kiri MCP/CLI operation surface to deterministically list models, manage projects, manage scratchpad blocks, spawn or steer sessions, drive terminal sessions, and run durable workflows from this repo.
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
- `agent.detail`, `agent.events.list`
- `scratchpad.list`
- `workflow.list`, `workflow.show`

Mutate via `kiri_do` / `pnpm kiri:ctl call`:

- `project.add`, `project.hide`, `project.unhide`, `project.delete`
- `session.create`, `session.spawn`, `session.rename`, `session.archive`, `session.restore`
- `agent.prompt`
- `terminal.input`, `terminal.keys`, `terminal.wait-for`, `terminal.spawn`, `terminal.kill`
- `scratchpad.add`, `scratchpad.delete`, `scratchpad.trigger`
- `workflow.validate`, `workflow.create`, `workflow.dispatch`
- `workflow.retrigger`, `workflow.track`, `workflow.untrack`
- `workflow.archive`, `workflow.restore`

## Deterministic Flow

Choose the first matching row. Do not compose lower-level operations when a higher-level operation matches.

| Intent | Operation | Rule |
|---|---|---|
| Start one new worker with a prompt | `session.spawn` | Default for new work. It creates the session and delivers the first turn. |
| Create an empty session only | `session.create` | Use only when the user asks for a blank session or manual setup. |
| Continue an existing GUI session | `agent.prompt` | Use when you already have the `agentId` and the session is GUI-capable. |
| Drive an existing terminal session | `terminal.input` | Use when you already have the `agentId` and need terminal text/commands. |
| Start from a saved scratchpad block | `scratchpad.trigger` | Use for a known scratchpad `id`; do not copy the block body manually. |
| Launch multiple tracked workers | `workflow.create` then `workflow.dispatch` | Use for durable multi-agent work, review loops, or scratchpad-only workflow items. |
| Wait for workflow check-ins | `workflow.await` | Use after dispatch when workers must report back. |

Required preflight:

1. Call `operations.list` when unsure which operation exists or what recipe to follow.
2. Call `model.list` for the selected runtime before passing `model`; otherwise omit `model`.
3. Use the returned `session.id` / `agentId` from Kiri responses. Do not invent ids.

Required success checks:

- `session.spawn`: require `delivery.accepted === true`.
- `agent.prompt`: require `accepted === true`.
- `terminal.input`: require `queued === true`; `spawned` may be `false` in CI or when `spawn:false`.
- `workflow.dispatch`: require each launch result to include `prompt.accepted === true` or `terminalPaste.queued === true`; failed items are not launched.
- `scratchpad.trigger`: success means Kiri created the session, delivered or queued the block, and marked the block triggered.

## Examples

```sh
pnpm kiri:ctl call '{"operation":"model.list","params":{"runtime":"pi"}}'
pnpm kiri:ctl call '{"operation":"project.list","params":{"includeHidden":true}}'
pnpm kiri:ctl call '{"operation":"session.create","params":{"projectId":"kiri","runtime":"pi","model":"openai-codex/gpt-5.5","title":"Build API"}}'
pnpm kiri:ctl call '{"operation":"session.spawn","params":{"projectId":"kiri","runtime":"codex","model":"gpt-5.5","title":"Build API","text":"Implement the API plan"}}'
pnpm kiri:ctl call '{"operation":"agent.prompt","params":{"agentId":"agent-id","text":"Continue from the plan","mode":"prompt"}}'
pnpm kiri:ctl call '{"operation":"terminal.input","params":{"agentId":"agent-id","text":"pnpm test","submit":true,"spawn":true}}'
pnpm kiri:ctl call '{"operation":"session.rename","params":{"agentId":"agent-id","title":"New title"}}'
pnpm kiri:ctl call '{"operation":"session.archive","params":{"agentId":"agent-id"}}'
pnpm kiri:ctl call '{"operation":"session.restore","params":{"agentId":"agent-id"}}'
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

Use `session.spawn` when a new session should begin work immediately. It creates the session and delivers the first turn through the correct channel: GUI sessions use `agent.prompt`; terminal sessions queue terminal input and can spawn the Kiri-owned runtime terminal. Prefer it over manually composing `session.create` + `agent.prompt`.

Use `agent.prompt` for an existing GUI session. Use `terminal.input` for an existing terminal session.

Workflow runs are durable. `workflow.dispatch` launches tracked launch items as Kiri sessions, delivers each launch body, and completes scratchpad-only items. GUI launch items use `agent.prompt`; terminal launch items queue the body and, when the desktop backend is running, may spawn the Kiri-owned runtime terminal. If no backend is reachable, terminal body input stays queued on the session and Kiri writes it when that terminal opens.

Archive completed or obsolete runs with `workflow.archive`; archived runs are read-only until `workflow.restore`.

## Rules

- Do not hand-edit `.kiri/kiri.sqlite`.
- Runtime is the provider boundary: `pi`, `codex`, `claude`, `opencode`.
- Valid models come from `settings.json`; do not hard-code or invent model ids.
- Prefer `model.list` or omit `model` when unsure; model ids are runtime-local (`codex` uses `gpt-5.5`, while `pi` uses `openai-codex/gpt-5.5`).
- Never pass a `pi` model id to `codex` or a `codex` model id to `pi`.
- Do not use workflows for a single new worker; use `session.spawn`.
- Do not use `session.create` + `agent.prompt` for new prompted work; use `session.spawn`.
- In tests or headless CLI runs, set `terminalSpawn:false` when no desktop backend should open a terminal.
- Session identity is `agentId`.
- `session.archive` archives the session; `session.restore` brings it back.
- Workflow identity is `id`; workflow item identity is `itemId`.
- Keep Kiri session titles meaningful. If a session is generic or stale, list sessions and call `session.rename`.
- Run `pnpm build` after code or contract changes.
- Run `pnpm kiri:agent-harness` after CLI or skill changes.
