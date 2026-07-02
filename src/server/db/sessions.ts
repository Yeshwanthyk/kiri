import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { RuntimeKind, SessionInterfaceMode, ThinkingLevel } from '~/lib/contracts'
import {
  idDbRowSchema,
  sessionSummaryDbRowSchema,
} from './schema'
import { forgetPiHydrationStamp } from './session-operations'
import { withTransaction } from './transaction'

type SessionSummaryInput = {
  readonly projectId?: string
  readonly includeArchived?: boolean
}

type InsertSessionInput = {
  readonly projectId: string
  readonly title?: string
  readonly runtime: RuntimeKind
  readonly interfaceMode: SessionInterfaceMode
  readonly model: string
  readonly thinkingLevel?: ThinkingLevel
  readonly sessionDirForSlot: (slot: string) => string
  readonly now?: () => string
  readonly slotTimestampMs?: () => number
  readonly slotSuffix?: () => string
}

type RenameSessionInput = {
  readonly agentId: string
  readonly title: string
}

export function listSessionSummaries(
  database: DatabaseSync,
  input: SessionSummaryInput = {},
) {
  const rows = database
    .prepare(
      `
        SELECT
          a.id,
          a.project_id AS projectId,
          p.name AS projectName,
          a.title,
          a.runtime,
          a.interface_mode AS interfaceMode,
          a.model,
          a.status,
          t.preview,
          t.message_count AS messageCount,
          t.updated_at AS updatedAt,
          a.archived_at AS archivedAt
        FROM agent_slots a
        INNER JOIN projects p ON p.id = a.project_id
        LEFT JOIN threads t ON t.agent_id = a.id AND t.active = 1
        WHERE a.slot LIKE 'session-%'
          AND (? IS NULL OR a.project_id = ?)
          AND (? = 1 OR a.archived_at IS NULL)
        ORDER BY COALESCE(t.updated_at, '') DESC, a.position ASC, a.id ASC
      `,
    )
    .all(
      input.projectId ?? null,
      input.projectId ?? null,
      input.includeArchived ? 1 : 0,
    )

  return rows.map(sessionSummaryFromDbRow)
}

export function requireSessionSummary(
  database: DatabaseSync,
  agentId: string,
  includeArchived = false,
) {
  const id = agentId.trim()
  const session = database
    .prepare(
      `
        SELECT
          a.id,
          a.project_id AS projectId,
          p.name AS projectName,
          a.title,
          a.runtime,
          a.interface_mode AS interfaceMode,
          a.model,
          a.status,
          t.preview,
          t.message_count AS messageCount,
          t.updated_at AS updatedAt,
          a.archived_at AS archivedAt
        FROM agent_slots a
        INNER JOIN projects p ON p.id = a.project_id
        LEFT JOIN threads t ON t.agent_id = a.id AND t.active = 1
        WHERE a.id = ?
          AND a.slot LIKE 'session-%'
          AND (? = 1 OR a.archived_at IS NULL)
      `,
    )
    .get(id, includeArchived ? 1 : 0)
  if (!session) throw new Error(`Session not found: ${id}`)
  return sessionSummaryFromDbRow(session)
}

export function insertSessionRow(database: DatabaseSync, input: InsertSessionInput) {
  const projectId = input.projectId.trim()
  assertSessionProjectExists(database, projectId)

  const nextPosition = database
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM agent_slots WHERE project_id = ?')
    .get(projectId) as { position: number }
  const title = input.title?.trim() || `Session ${nextPosition.position + 1}`

  let lastCollision: unknown
  const maxAttempts = input.slotSuffix ? 1 : 5
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const suffix = input.slotSuffix?.() ?? randomSessionSlotSuffix()
    const slot = `session-${(input.slotTimestampMs?.() ?? Date.now()).toString(36)}-${suffix}`
    const id = `${projectId}-${slot}`
    const now = input.now?.() ?? new Date().toISOString()
    const sessionDir = input.sessionDirForSlot(slot)

    try {
      withTransaction(database, () => {
        database
          .prepare(
            `
              INSERT INTO agent_slots (
                id, project_id, slot, title, runtime, interface_mode, model, status, session_dir, session_file, position
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, NULL, ?)
            `,
          )
          .run(
            id,
            projectId,
            slot,
            title,
            input.runtime,
            input.interfaceMode,
            input.model,
            sessionDir,
            nextPosition.position,
          )
        database
          .prepare(
            `
              INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
              VALUES (?, ?, 1, 'Ready.', 0, ?)
            `,
          )
          .run(`thread-${id}`, id, now)
        insertAgentInfoEvent(database, {
          agentId: id,
          kind: 'thinking_level',
          label: 'Thinking level changed',
          detail: input.thinkingLevel,
          timestamp: now,
        })
      })

      return id
    } catch (error) {
      if (input.slotSuffix || !isSessionIdCollision(error)) throw normalizeInsertSessionError(error)
      lastCollision = error
    }
  }

  throw normalizeInsertSessionError(lastCollision)
}

function randomSessionSlotSuffix() {
  return Math.random().toString(36).slice(2, 8)
}

function isSessionIdCollision(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = 'code' in error ? String(error.code) : ''
  return code.includes('SQLITE_CONSTRAINT') ||
    /UNIQUE constraint failed: agent_slots\.id|PRIMARY KEY/i.test(error.message)
}

function normalizeInsertSessionError(error: unknown) {
  if (error instanceof Error) return error
  if (error === undefined) return new Error('Session id collision retry exhausted')
  if (typeof error === 'string') return new Error(error)
  return new Error('Session insert failed', { cause: error })
}

export function assertSessionProjectExists(database: DatabaseSync, projectId: string) {
  const id = projectId.trim()
  const project = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(id)
  if (!project) throw new Error(`Project not found: ${id}`)
}

export function archiveSessionRow(database: DatabaseSync, agentId: string) {
  const id = agentId.trim()
  const row = database
    .prepare('SELECT id, project_id AS projectId, slot FROM agent_slots WHERE id = ?')
    .get(id) as { id: string; projectId: string; slot: string } | undefined
  if (!row) throw new Error(`Session not found: ${id}`)
  assertStartedSession(row.slot, 'removed')

  withTransaction(database, () => {
    const archivedAt = new Date().toISOString()
    database
      .prepare('UPDATE agent_slots SET archived_at = ? WHERE id = ?')
      .run(archivedAt, id)
    const rows = database
      .prepare(
        'SELECT id FROM agent_slots WHERE project_id = ? ORDER BY position ASC, id ASC',
      )
      .all(row.projectId)
      .map((item) => idDbRowSchema.parse(item))
    const update = database.prepare('UPDATE agent_slots SET position = ? WHERE id = ?')
    for (const [position, item] of rows.entries()) {
      update.run(position, item.id)
    }
  })

  forgetPiHydrationStamp(id)
  return id
}

export function hardDeleteSessionRow(database: DatabaseSync, agentId: string) {
  const id = agentId.trim()
  const row = database
    .prepare(
      `
        SELECT
          id,
          project_id AS projectId,
          slot,
          session_dir AS sessionDir,
          archived_at AS archivedAt
        FROM agent_slots
        WHERE id = ?
      `,
    )
    .get(id) as
    | {
        id: string
        projectId: string
        slot: string
        sessionDir: string
        archivedAt: string | null
      }
    | undefined
  if (!row) throw new Error(`Session not found: ${id}`)
  assertStartedSession(row.slot, 'hard-deleted')
  if (!row.archivedAt) throw new Error(`Session must be archived before hard-delete: ${id}`)

  withTransaction(database, () => {
    const deletedAt = new Date().toISOString()
    database
      .prepare(
        `
          INSERT INTO deleted_sessions (project_id, slot, deleted_at)
          VALUES (?, ?, ?)
        `,
      )
      .run(row.projectId, row.slot, deletedAt)
    database.prepare('DELETE FROM agent_slots WHERE id = ?').run(id)
  })

  forgetPiHydrationStamp(id)
  removeSessionDirBestEffort(row.sessionDir, id)
  return id
}

export function restoreSessionRow(database: DatabaseSync, agentId: string) {
  const id = agentId.trim()
  const row = database
    .prepare('SELECT id, slot FROM agent_slots WHERE id = ?')
    .get(id) as { id: string; slot: string } | undefined
  if (!row) throw new Error(`Session not found: ${id}`)
  assertStartedSession(row.slot, 'restored')

  withTransaction(database, () => {
    database
      .prepare('UPDATE agent_slots SET archived_at = NULL WHERE id = ?')
      .run(id)
  })
  return id
}

export function renameSessionRow(database: DatabaseSync, input: RenameSessionInput) {
  const agentId = input.agentId.trim()
  const title = input.title.trim()
  if (!title) throw new Error('Session title cannot be empty')
  const row = database
    .prepare('SELECT id, slot FROM agent_slots WHERE id = ?')
    .get(agentId) as { id: string; slot: string } | undefined
  if (!row) throw new Error(`Session not found: ${agentId}`)
  assertStartedSession(row.slot, 'renamed')

  database.prepare('UPDATE agent_slots SET title = ? WHERE id = ?').run(title, agentId)
  return agentId
}

function sessionSummaryFromDbRow(row: unknown) {
  const parsed = sessionSummaryDbRowSchema.parse(row)
  return {
    id: parsed.id,
    projectId: parsed.projectId,
    projectName: parsed.projectName,
    title: parsed.title,
    runtime: parsed.runtime,
    interfaceMode: parsed.interfaceMode,
    model: parsed.model,
    status: parsed.status,
    preview: parsed.preview ?? 'No messages yet',
    messageCount: parsed.messageCount ?? 0,
    updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
    archivedAt: parsed.archivedAt,
  }
}

function insertAgentInfoEvent(
  database: DatabaseSync,
  input: {
    readonly agentId: string
    readonly kind: string
    readonly label: string
    readonly detail?: string | null
    readonly timestamp: string
  },
) {
  const thread = database
    .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
    .get(input.agentId) as { id: string } | undefined
  if (!thread) throw new Error(`No active thread for agent: ${input.agentId}`)

  const payload = {
    type: input.kind,
    label: input.label,
    detail: input.detail ?? null,
    timestamp: input.timestamp,
  }
  database
    .prepare(
      `
        INSERT OR IGNORE INTO timeline_events (
          id, thread_id, kind, tone, label, detail, timestamp, payload_json
        )
        VALUES (?, ?, ?, 'info', ?, ?, ?, ?)
      `,
    )
    .run(
      eventId(input.agentId, payload),
      thread.id,
      input.kind,
      input.label,
      input.detail ?? null,
      input.timestamp,
      JSON.stringify(payload),
    )
}

function eventId(agentId: string, event: { readonly type: string } & Record<string, unknown>) {
  const hash = createHash('sha256')
    .update(JSON.stringify(event))
    .digest('hex')
    .slice(0, 16)
  return `pi-event-${agentId}-${event.type}-${hash}`
}

function removeSessionDirBestEffort(sessionDir: string, agentId: string) {
  try {
    rmSync(sessionDir, { recursive: true, force: true })
  } catch (error) {
    console.warn(`Failed to remove session directory for ${agentId}: ${sessionDir}`, error)
  }
}

function assertStartedSession(slot: string, action: 'removed' | 'restored' | 'renamed' | 'hard-deleted') {
  if (!slot.startsWith('session-')) {
    throw new Error(`Only started sessions can be ${action}`)
  }
}
