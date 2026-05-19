import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { agentEventSchema, agentEventTypeSchema, type AgentEvent, type AgentEventType } from '~/lib/contracts'

const agentEventRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  sequence: z.number().int().positive(),
  type: agentEventTypeSchema,
  payloadJson: z.string(),
  createdAt: z.string(),
})

export function appendAgentEvent(
  database: DatabaseSync,
  input: {
    readonly agentId: string
    readonly type: AgentEventType
    readonly payload: Record<string, unknown>
    readonly timestamp?: string
  },
): AgentEvent {
  const timestamp = input.timestamp ?? new Date().toISOString()
  const next = database.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_events WHERE agent_id = ?').get(input.agentId) as { sequence: number }
  const id = `agent-event-${input.agentId}-${String(next.sequence)}`
  database
    .prepare(
      `
        INSERT INTO agent_events (id, agent_id, sequence, type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    )
    .run(id, input.agentId, next.sequence, input.type, JSON.stringify(input.payload), timestamp)
  return agentEventSchema.parse({
    id,
    agentId: input.agentId,
    sequence: next.sequence,
    type: input.type,
    payload: input.payload,
    createdAt: timestamp,
  })
}

export function listAgentEvents(
  database: DatabaseSync,
  input: {
    readonly agentId: string
    readonly afterSequence?: number
    readonly limit?: number
  },
): AgentEvent[] {
  const rows = database
    .prepare(
      `
        SELECT
          id,
          agent_id AS agentId,
          sequence,
          type,
          payload_json AS payloadJson,
          created_at AS createdAt
        FROM agent_events
        WHERE agent_id = ?
          AND sequence > ?
        ORDER BY sequence ASC
        LIMIT ?
      `,
    )
    .all(input.agentId, input.afterSequence ?? 0, input.limit ?? 100)
  return rows.map(agentEventFromRow)
}

function agentEventFromRow(row: unknown): AgentEvent {
  const parsed = agentEventRowSchema.parse(row)
  return agentEventSchema.parse({
    id: parsed.id,
    agentId: parsed.agentId,
    sequence: parsed.sequence,
    type: parsed.type,
    payload: parsePayload(parsed.payloadJson),
    createdAt: parsed.createdAt,
  })
}

function parsePayload(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }
  return parsed as Record<string, unknown>
}
