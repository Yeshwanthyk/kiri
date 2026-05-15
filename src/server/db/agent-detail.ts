import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  agentTaskSchema,
  messageRoleSchema,
  timelineEventToneSchema,
} from '~/lib/contracts'
import {
  agentDetailDbRowSchema,
  agentTaskDbRowSchema,
  contextUsageDbRowSchema,
  diffDbRowSchema,
  idDbRowSchema,
  messageDbRowSchema,
  timelineEventDbRowSchema,
} from './schema'
import { timelineEventFromDbRow } from './timeline-format'

type ReadAgentDetailInput = {
  readonly agentId: string
  readonly limit: number
  readonly diffLimit: number
}

export function readAgentDetail(database: DatabaseSync, input: ReadAgentDetailInput) {
  const agentId = input.agentId.trim()
  const agent = database
    .prepare(
      `
        SELECT
          a.id,
          a.project_id AS projectId,
          p.cwd,
          a.slot,
          a.title,
          a.runtime,
          a.interface_mode AS interfaceMode,
          a.model,
          a.status,
          a.session_dir AS sessionDir,
          a.session_file AS sessionFile,
          a.position,
          a.archived_at AS archivedAt,
          t.id AS threadId,
          t.preview,
          t.message_count AS messageCount,
          t.updated_at AS updatedAt,
          (
            SELECT COUNT(*)
            FROM diff_artifacts d
            WHERE d.agent_id = a.id
          ) AS diffCount
        FROM agent_slots a
        INNER JOIN projects p ON p.id = a.project_id
        LEFT JOIN threads t ON t.agent_id = a.id AND t.active = 1
        WHERE a.id = ?
      `,
    )
    .get(agentId)
  const parsedAgent = agentDetailDbRowSchema.parse(agent)
  const usage = database
    .prepare(
      `
        SELECT
          agent_id AS agentId,
          used_tokens AS usedTokens,
          window_tokens AS windowTokens,
          updated_at AS updatedAt,
          session_file AS sessionFile
        FROM agent_context_usage
        WHERE agent_id = ?
      `,
    )
    .get(agentId)
  const activeThread = database
    .prepare(
      `
        SELECT id
        FROM threads
        WHERE active = 1 AND agent_id = ?
      `,
    )
    .get(agentId)
  const activeThreadId = idDbRowSchema.parse(activeThread).id
  const timelineRows = database
    .prepare(
      `
        SELECT
          kind,
          id,
          role,
          text,
          event_kind AS eventKind,
          tone,
          label,
          detail,
          path,
          timestamp,
          payload_json AS payloadJson
        FROM (
          SELECT
            'message' AS kind,
            m.id,
            m.role,
            m.text,
            NULL AS event_kind,
            NULL AS tone,
            NULL AS label,
            NULL AS detail,
            NULL AS path,
            m.timestamp,
            NULL AS payload_json
          FROM messages m
          WHERE m.thread_id = ?
          UNION ALL
          SELECT
            'event' AS kind,
            e.id,
            NULL AS role,
            NULL AS text,
            e.kind AS event_kind,
            e.tone,
            e.label,
            e.detail,
            json_extract(e.payload_json, '$.path') AS path,
            e.timestamp,
            e.payload_json
          FROM timeline_events e
          WHERE e.thread_id = ?
        )
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      `,
    )
    .all(activeThreadId, activeThreadId, input.limit)
    .reverse()
  const timeline = timelineRows.map((row) => timelineItemFromDetailRow(row, agentId))

  return {
    agent: parsedAgent,
    contextUsage: usage ? contextUsageDbRowSchema.parse(usage) : undefined,
    timeline,
    diffs: readDiffs(database, agentId, input.diffLimit),
    tasks: readAgentTasks(database, agentId),
  }
}

function readDiffs(database: DatabaseSync, agentId: string, limit?: number) {
  return database
    .prepare(
      `
        SELECT id, agent_id AS agentId, title, path, patch, updated_at AS updatedAt
        FROM diff_artifacts
        WHERE agent_id = ?
        ORDER BY updated_at DESC
        ${limit === undefined ? '' : 'LIMIT ?'}
      `,
    )
    .all(...(limit === undefined ? [agentId] : [agentId, limit]))
    .map((row) => diffDbRowSchema.parse(row))
}

function readAgentTasks(database: DatabaseSync, agentId: string) {
  return database
    .prepare(
      `
        SELECT
          task_id AS id,
          title,
          status,
          source,
          tasks.updated_at AS updatedAt,
          position
        FROM agent_tasks tasks
        INNER JOIN threads t ON t.id = tasks.thread_id
        WHERE t.active = 1 AND t.agent_id = ?
        ORDER BY tasks.position ASC, tasks.task_id ASC
      `,
    )
    .all(agentId)
    .map((row) => {
      const parsed = agentTaskDbRowSchema.parse(row)
      return agentTaskSchema.parse({
        id: parsed.id,
        title: parsed.title,
        status: parsed.status,
        source: parsed.source,
        updatedAt: parsed.updatedAt,
      })
    })
}

function timelineItemFromDetailRow(row: unknown, agentId: string) {
  const parsed = z.object({
    kind: z.enum(['message', 'event']),
    id: z.string(),
    role: messageRoleSchema.nullable(),
    text: z.string().nullable(),
    eventKind: z.string().nullable(),
    tone: timelineEventToneSchema.nullable(),
    label: z.string().nullable(),
    detail: z.string().nullable(),
    path: z.string().nullable(),
    timestamp: z.string(),
    payloadJson: z.string().nullable(),
  }).parse(row)

  if (parsed.kind === 'message') {
    const message = messageDbRowSchema.parse({
      id: parsed.id,
      agentId,
      role: parsed.role,
      text: parsed.text,
      timestamp: parsed.timestamp,
    })
    const { agentId: _agentId, ...value } = message
    return {
      type: 'message' as const,
      id: `message:${value.id}`,
      timestamp: value.timestamp,
      message: value,
    }
  }

  const event = timelineEventFromDbRow(timelineEventDbRowSchema.parse({
    id: parsed.id,
    agentId,
    kind: parsed.eventKind,
    tone: parsed.tone,
    label: parsed.label,
    detail: parsed.detail,
    timestamp: parsed.timestamp,
    payloadJson: parsed.path
      ? JSON.stringify({ ...safeJson(parsed.payloadJson), path: parsed.path })
      : parsed.payloadJson,
  }))
  const { agentId: _agentId, ...value } = event
  return {
    type: 'event' as const,
    id: `event:${value.id}`,
    timestamp: value.timestamp,
    event: value,
  }
}

function safeJson(value: string | null) {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
