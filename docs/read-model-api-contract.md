# Read-Model API Contract

This is the stable boundary for the Rust projection/indexer lane.

## Contract

- Version: `1`
- Source of truth: SQLite domain tables remain canonical.
- Derived state: `read_model_entries` is a cache table and can be rebuilt.
- Supported kinds:
  - `workspace.summary`
  - `agent.timeline.summary`
  - `diff.summary`
- Row identity: `(kind, entityId)`.
- Row payload: kind-specific JSON object validated at the TypeScript boundary.
- Row revision: content hash of `kind`, `entityId`, and stable payload JSON.

## State Boundary

Refreshing the index may mutate only `read_model_entries`.

It must not mutate:

- `projects`
- `agent_slots`
- `threads`
- `messages`
- `timeline_events`
- `diff_artifacts`
- `agent_tasks`
- runtime state
- scratchpad blocks

## Rust Boundary

Rust receives normalized candidates:

```json
{
  "version": 1,
  "candidates": [
    {
      "kind": "agent.timeline.summary",
      "entityId": "agent-1",
      "payload": {
        "agentId": "agent-1",
        "messageCount": 10
      },
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

Rust returns indexed rows:

```json
{
  "version": 1,
  "entries": [
    {
      "kind": "agent.timeline.summary",
      "entityId": "agent-1",
      "revision": "content-hash",
      "payload": {
        "agentId": "agent-1",
        "messageCount": 10
      },
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

## Desktop Startup Rule

Desktop readiness must stay light:

- Validate settings.
- Open/initialize SQLite.
- Do not import the built app-server bundle before readiness.
- Do not hydrate full workspace snapshots before the browser shell can load.

## Next Steps

1. Add read APIs over `read_model_entries` once UI/server call sites need them.
2. Move candidate collection into Rust only if SQLite access from Rust beats normalized TypeScript input.
3. Package the Rust indexer only after a production read path starts consuming the table.
