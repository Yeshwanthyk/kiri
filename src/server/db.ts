import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type {
  AddProjectInput,
  AgentStatus,
  ContextUsage,
  DiffArtifact,
  DeleteSessionInput,
  StartSessionInput,
  MessageRole,
  ThinkingLevel,
  TimelineEventTone,
  BoardMessage,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import {
  agentStatusSchema,
  messageRoleSchema,
  pendingQuestionSchema,
  runtimeKindSchema,
  thinkingLevelSchema,
  timelineEventToneSchema,
  workspaceSnapshotSchema,
} from '~/lib/contracts'
import type { PiRpcEvent, PiRpcMessage } from './pi-rpc'
import { projectPiSessionFile, type PiSessionProjection } from './pi-jsonl'
import { assertConfiguredModel, getRuntimeSettings, getSettings } from './settings'

const dbPath = process.env.AETHER_DB_PATH
  ? resolve(process.env.AETHER_DB_PATH)
  : join(process.cwd(), '.aether', 'aether.sqlite')

let db: DatabaseSync | undefined

const projectDbRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  position: z.number().int().nonnegative(),
  hiddenAt: z.string().nullable(),
})

const agentDbRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  slot: z.string(),
  title: z.string(),
  runtime: runtimeKindSchema,
  model: z.string(),
  status: agentStatusSchema,
  sessionDir: z.string(),
  sessionFile: z.string().nullable(),
  position: z.number().int().nonnegative(),
  preview: z.string().nullable(),
  messageCount: z.number().int().nonnegative().nullable(),
  updatedAt: z.string().nullable(),
  diffCount: z.number().int().nonnegative(),
  threadId: z.string().nullable(),
})

const messageDbRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  role: messageRoleSchema,
  text: z.string(),
  timestamp: z.string(),
})

const timelineEventDbRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  kind: z.string(),
  tone: timelineEventToneSchema,
  label: z.string(),
  detail: z.string().nullable(),
  timestamp: z.string(),
  payloadJson: z.string(),
})

const diffDbRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  path: z.string(),
  patch: z.string(),
  updatedAt: z.string(),
})

const contextUsageDbRowSchema = z.object({
  agentId: z.string(),
  usedTokens: z.number().int().nonnegative(),
  windowTokens: z.number().int().positive().nullable(),
  updatedAt: z.string(),
  sessionFile: z.string().nullable(),
})

const agentLaunchConfigSchema = z.object({
  id: z.string(),
  runtime: runtimeKindSchema,
  sessionDir: z.string(),
  sessionFile: z.string().nullable(),
  model: z.string(),
  cwd: z.string(),
  runtimeStateJson: z.string().nullable().default(null),
})

const idDbRowSchema = z.object({
  id: z.string(),
})

const projectIdDbRowSchema = z.object({
  id: z.string(),
})

const persistedSessionDbRowSchema = z.object({
  id: z.string(),
  slot: z.string(),
  sessionDir: z.string(),
  sessionFile: z.string().nullable(),
})

const deletedSessionDbRowSchema = z.object({
  slot: z.string(),
})

export function getDb() {
  if (db) return db
  mkdirSync(dirname(dbPath), { recursive: true })
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  normalizeSeededModels(db)
  seed(db)
  return db
}

export function getWorkspaceSnapshot(): WorkspaceSnapshot {
  const database = getDb()
  hydratePersistedPiSessions(database)
  const projects = database
    .prepare(
      `
        SELECT id, name, cwd, position, hidden_at AS hiddenAt
        FROM projects
        ORDER BY position ASC
      `,
    )
    .all()
    .map((row) => projectDbRowSchema.parse(row))

  const agents = database
    .prepare(
      `
        SELECT
          a.id,
          a.project_id AS projectId,
          a.slot,
          a.title,
          a.runtime,
          a.model,
          a.status,
          a.session_dir AS sessionDir,
          a.session_file AS sessionFile,
          a.position,
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
        LEFT JOIN threads t ON t.agent_id = a.id AND t.active = 1
        ORDER BY a.position ASC
      `,
    )
    .all()
    .map((row) => agentDbRowSchema.parse(row))

  const messages = database
    .prepare(
      `
        SELECT m.id, t.agent_id AS agentId, m.role, m.text, m.timestamp
        FROM messages m
        INNER JOIN threads t ON t.id = m.thread_id
        WHERE t.active = 1
        ORDER BY m.timestamp ASC, m.id ASC
      `,
    )
    .all()
    .map((row) => messageDbRowSchema.parse(row))

  const timelineEvents = database
    .prepare(
      `
        SELECT
          e.id,
          t.agent_id AS agentId,
          e.kind,
          e.tone,
          e.label,
          e.detail,
          e.timestamp,
          e.payload_json AS payloadJson
        FROM timeline_events e
        INNER JOIN threads t ON t.id = e.thread_id
        WHERE t.active = 1
        ORDER BY e.timestamp ASC, e.id ASC
      `,
    )
    .all()
    .map((row) => timelineEventFromDbRow(timelineEventDbRowSchema.parse(row)))

  const diffs = database
    .prepare(
      `
        SELECT id, agent_id AS agentId, title, path, patch, updated_at AS updatedAt
        FROM diff_artifacts
        ORDER BY updated_at DESC
      `,
    )
    .all()
    .map((row) => diffDbRowSchema.parse(row))

  const contextUsages = database
    .prepare(
      `
        SELECT
          agent_id AS agentId,
          used_tokens AS usedTokens,
          window_tokens AS windowTokens,
          updated_at AS updatedAt,
          session_file AS sessionFile
        FROM agent_context_usage
      `,
    )
    .all()
    .map((row) => contextUsageDbRowSchema.parse(row))

  const settings = getSettings()
  const messagesByAgent = groupBy(messages, (message) => message.agentId)
  const timelineEventsByAgent = groupBy(
    timelineEvents,
    (event) => event.agentId,
  )
  const diffsByAgent = groupBy(diffs, (diff) => diff.agentId)
  const contextUsageByAgent = new Map(
    contextUsages.map((usage) => [usage.agentId, usage]),
  )
  const agentsByProject = groupBy(agents, (agent) => agent.projectId)

  const snapshotProjectRows = projects.map((project) => ({
    ...project,
    agents: (agentsByProject.get(project.id) ?? []).map((agent) => {
      const messages = (messagesByAgent.get(agent.id) ?? []).map(
        ({ agentId: _agentId, ...message }) => message,
      )
      const timelineEvents = (timelineEventsByAgent.get(agent.id) ?? []).map(
        ({ agentId: _agentId, ...event }) => event,
      )

      return {
        id: agent.id,
        projectId: agent.projectId,
        slot: agent.slot,
        title: agent.title,
        runtime: agent.runtime,
        model: agent.model,
        status: agent.status,
        sessionDir: agent.sessionDir,
        sessionFile: agent.sessionFile,
        preview: agent.preview ?? 'No messages yet',
        messageCount: agent.messageCount ?? 0,
        diffCount: agent.diffCount,
        contextUsage: readContextUsage(
          agent,
          settings,
          contextUsageByAgent.get(agent.id),
        ),
        pendingQuestion: readPendingQuestion(agent.id),
        updatedAt: agent.updatedAt ?? new Date(0).toISOString(),
        isSession: agent.slot.startsWith('session-'),
        messages,
        timelineEvents,
        timeline: mergeTimeline(messages, timelineEvents),
        diffs: (diffsByAgent.get(agent.id) ?? []).map(
          ({ agentId: _agentId, ...diff }) => diff,
        ),
      }
    }),
  }))
  const snapshotProjects = snapshotProjectRows.filter((project) => !project.hiddenAt)
  const hiddenProjects = snapshotProjectRows.filter((project) => project.hiddenAt)
  const selectedProject = snapshotProjects[0]
  const selectedAgent = selectedProject?.agents[0]

  const snapshot = {
    settings,
    projects: snapshotProjects,
    hiddenProjects,
    selected: {
      projectId: selectedProject?.id ?? '',
      agentId: selectedAgent?.id ?? '',
    },
  }

  return workspaceSnapshotSchema.parse(snapshot)
}

export function addProject(input: AddProjectInput) {
  const database = getDb()
  const id = input.id?.trim() || slugify(input.name)
  const name = input.name.trim()
  const cwd = input.cwd.trim()

  if (!name) throw new Error('Project name is required')
  if (!cwd) throw new Error('Project cwd is required')
  if (!existsSync(cwd)) throw new Error(`Project cwd does not exist: ${cwd}`)

  const existing = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(id)
  if (existing) throw new Error(`Project already exists: ${id}`)

  const nextPosition = database
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM projects')
    .get() as { position: number }
  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, cwd, position)
    VALUES (?, ?, ?, ?)
  `)
  database.exec('BEGIN')
  try {
    insertProject.run(id, name, cwd, nextPosition.position)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  return getWorkspaceSnapshot()
}

export function startSession(input: StartSessionInput) {
  const database = getDb()
  const projectId = input.projectId.trim()
  const project = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(projectId)
  if (!project) throw new Error(`Project not found: ${projectId}`)

  const runtime = runtimeKindSchema.parse(input.runtime ?? 'pi')
  const runtimeSettings = getRuntimeSettings(runtime)
  const model = input.model?.trim() || runtimeSettings.defaultModel
  assertConfiguredModel(runtime, model)

  const nextPosition = database
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM agent_slots WHERE project_id = ?')
    .get(projectId) as { position: number }
  const suffix = Math.random().toString(36).slice(2, 8)
  const slot = `session-${Date.now().toString(36)}-${suffix}`
  const id = `${projectId}-${slot}`
  const title = input.title?.trim() || `Session ${nextPosition.position + 1}`
  const now = new Date().toISOString()
  const sessionDir = runtimeSessionDir(runtime, projectId, slot)

  database.exec('BEGIN')
  try {
    database
      .prepare(
        `
          INSERT INTO agent_slots (
            id, project_id, slot, title, runtime, model, status, session_dir, session_file, position
          )
          VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, NULL, ?)
        `,
      )
      .run(
        id,
        projectId,
        slot,
        title,
        runtime,
        model,
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
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  return getWorkspaceSnapshot()
}

export function deleteSession(input: DeleteSessionInput) {
  const database = getDb()
  const agentId = input.agentId.trim()
  const row = database
    .prepare('SELECT id, project_id AS projectId, slot FROM agent_slots WHERE id = ?')
    .get(agentId) as { id: string; projectId: string; slot: string } | undefined
  if (!row) throw new Error(`Session not found: ${agentId}`)
  if (!row.slot.startsWith('session-')) {
    throw new Error('Only started sessions can be removed')
  }

  database.exec('BEGIN')
  try {
    database
      .prepare(
        `
          INSERT OR REPLACE INTO deleted_sessions (project_id, slot, deleted_at)
          VALUES (?, ?, ?)
        `,
      )
      .run(row.projectId, row.slot, new Date().toISOString())
    database.prepare('DELETE FROM agent_slots WHERE id = ?').run(agentId)
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
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  return getWorkspaceSnapshot()
}

export function resetSession(agentId: string) {
  const database = getDb()
  const id = agentId.trim()
  const thread = database
    .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
    .get(id) as { id: string } | undefined
  if (!thread) throw new Error(`No active thread for agent: ${id}`)

  const now = new Date().toISOString()
  database.exec('BEGIN')
  try {
    database.prepare('DELETE FROM messages WHERE thread_id = ?').run(thread.id)
    database.prepare('DELETE FROM timeline_events WHERE thread_id = ?').run(thread.id)
    database.prepare('DELETE FROM diff_artifacts WHERE agent_id = ?').run(id)
    database.prepare('DELETE FROM agent_context_usage WHERE agent_id = ?').run(id)
    database
      .prepare("UPDATE threads SET preview = 'Ready.', message_count = 0, updated_at = ? WHERE id = ?")
      .run(now, thread.id)
    database
      .prepare("UPDATE agent_slots SET status = 'idle', session_file = NULL WHERE id = ?")
      .run(id)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function createForkedSession(input: {
  sourceAgentId: string
  sessionFile: string
}) {
  const database = getDb()
  const source = database
    .prepare(
      `
        SELECT
          a.id,
          a.project_id AS projectId,
          a.title,
          a.runtime,
          a.model
        FROM agent_slots a
        WHERE a.id = ?
      `,
    )
    .get(input.sourceAgentId) as
    | {
        id: string
        projectId: string
        title: string
        runtime: string
        model: string
      }
    | undefined
  if (!source) throw new Error(`Agent not found: ${input.sourceAgentId}`)
  if (source.runtime !== 'pi') throw new Error(`${source.runtime} agents do not support /fork yet`)
  if (!existsSync(input.sessionFile)) {
    throw new Error(`Forked Pi session file does not exist: ${input.sessionFile}`)
  }

  const nextPosition = database
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM agent_slots WHERE project_id = ?')
    .get(source.projectId) as { position: number }
  const suffix = Math.random().toString(36).slice(2, 8)
  const slot = `session-${Date.now().toString(36)}-${suffix}`
  const id = `${source.projectId}-${slot}`
  const sessionDir = join(process.cwd(), '.aether', 'pi-sessions', source.projectId, slot)
  mkdirSync(sessionDir, { recursive: true })
  const sessionFile = join(sessionDir, basename(input.sessionFile))
  if (resolve(sessionFile) !== resolve(input.sessionFile)) {
    copyFileSync(input.sessionFile, sessionFile)
  }
  const projection = safeProjectPiSessionFile(sessionFile)
  const now = new Date().toISOString()

  database.exec('BEGIN')
  try {
    database
      .prepare(
        `
          INSERT INTO agent_slots (
            id, project_id, slot, title, runtime, model, status, session_dir, session_file, position
          )
          VALUES (?, ?, ?, ?, 'pi', ?, 'idle', ?, ?, ?)
        `,
      )
      .run(
        id,
        source.projectId,
        slot,
        `${source.title} fork`,
        source.model,
        sessionDir,
        sessionFile,
        nextPosition.position,
      )
    database
      .prepare(
        `
          INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
          VALUES (?, ?, 1, ?, 0, ?)
        `,
      )
      .run(`thread-${id}`, id, projection?.preview || 'Ready.', projection?.updatedAt ?? now)
    if (projection) {
      hydrateProjectionMessages(database, id, projection)
      upsertAgentContextUsage(database, {
        agentId: id,
        usedTokens: projection.contextUsedTokens,
        sessionFile,
        updatedAt: projection.updatedAt,
      })
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  return id
}

export function deleteProject(id: string) {
  const database = getDb()
  const projectId = id.trim()
  if (!projectId) throw new Error('Project id is required')

  const count = database
    .prepare('SELECT COUNT(*) AS count FROM projects')
    .get() as { count: number }
  if (count.count <= 1) throw new Error('Cannot delete the last project')

  const existing = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(projectId)
  if (!existing) throw new Error(`Project not found: ${projectId}`)

  database.exec('BEGIN')
  try {
    database.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    const rows = database
      .prepare('SELECT id FROM projects ORDER BY position ASC, id ASC')
      .all()
      .map((row) => idDbRowSchema.parse(row))
    const update = database.prepare('UPDATE projects SET position = ? WHERE id = ?')
    for (const [position, row] of rows.entries()) {
      update.run(position, row.id)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  return getWorkspaceSnapshot()
}

export function hideProject(id: string) {
  const database = getDb()
  const projectId = id.trim()
  if (!projectId) throw new Error('Project id is required')

  const visibleCount = database
    .prepare('SELECT COUNT(*) AS count FROM projects WHERE hidden_at IS NULL')
    .get() as { count: number }
  if (visibleCount.count <= 1) throw new Error('Cannot hide the last visible project')

  const existing = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(projectId)
  if (!existing) throw new Error(`Project not found: ${projectId}`)

  database
    .prepare('UPDATE projects SET hidden_at = ? WHERE id = ?')
    .run(new Date().toISOString(), projectId)

  return getWorkspaceSnapshot()
}

export function unhideProject(id: string) {
  const database = getDb()
  const projectId = id.trim()
  if (!projectId) throw new Error('Project id is required')

  const existing = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(projectId)
  if (!existing) throw new Error(`Project not found: ${projectId}`)

  database.prepare('UPDATE projects SET hidden_at = NULL WHERE id = ?').run(projectId)
  return getWorkspaceSnapshot()
}

export function getAgentLaunchConfig(agentId: string) {
  const row = getDb()
    .prepare(
      `
        SELECT
          a.id,
          a.runtime,
          a.session_dir AS sessionDir,
          a.session_file AS sessionFile,
          a.model,
          a.runtime_state_json AS runtimeStateJson,
          p.cwd
        FROM agent_slots a
        INNER JOIN projects p ON p.id = a.project_id
        WHERE a.id = ?
      `,
    )
    .get(agentId)
  if (!row) throw new Error(`Agent not found: ${agentId}`)
  return agentLaunchConfigSchema.parse(row)
}

export function getSessionDiffFallbackCwds(agentId: string) {
  const database = getDb()
  const rows = database
    .prepare(
      `
        SELECT DISTINCT p.cwd
        FROM agent_slots a
        INNER JOIN projects p ON p.id = a.project_id
        ORDER BY CASE WHEN a.id = ? THEN 0 ELSE 1 END, p.position ASC, p.cwd ASC
      `,
    )
    .all(agentId) as Array<{ cwd: string }>
  return rows.map((row) => row.cwd)
}

export function getAgentRuntimeState(agentId: string) {
  const row = getDb()
    .prepare('SELECT runtime_state_json AS runtimeStateJson FROM agent_slots WHERE id = ?')
    .get(agentId) as { runtimeStateJson: string | null } | undefined
  if (!row?.runtimeStateJson) return {}
  try {
    const parsed = JSON.parse(row.runtimeStateJson)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function setAgentRuntimeState(agentId: string, state: Record<string, unknown>) {
  getDb()
    .prepare('UPDATE agent_slots SET runtime_state_json = ? WHERE id = ?')
    .run(JSON.stringify(state), agentId)
}

export function clearAgentRuntimeState(agentId: string) {
  getDb()
    .prepare('UPDATE agent_slots SET runtime_state_json = NULL WHERE id = ?')
    .run(agentId)
}

export function setAgentStatus(agentId: string, status: AgentStatus) {
  const parsed = agentStatusSchema.parse(status)
  getDb().prepare('UPDATE agent_slots SET status = ? WHERE id = ?').run(parsed, agentId)
}

export function appendUserMessage(input: { agentId: string; text: string }) {
  const text = input.text.trim()
  if (!text) throw new Error('Message text is required')

  const database = getDb()
  const thread = database
    .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
    .get(input.agentId) as { id: string } | undefined
  if (!thread) throw new Error(`No active thread for agent: ${input.agentId}`)

  const timestamp = new Date().toISOString()
  const hash = createHash('sha256')
    .update(`${input.agentId}\n${timestamp}\n${text}`)
    .digest('hex')
    .slice(0, 16)
  database.exec('BEGIN')
  try {
    database
      .prepare(
        `
          INSERT INTO messages (id, thread_id, role, text, timestamp)
          VALUES (?, ?, 'user', ?, ?)
        `,
      )
      .run(`user-${input.agentId}-${hash}`, thread.id, text, timestamp)
    updateThreadSummary(database, thread.id, text, timestamp)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function recordRuntimeMessage(input: {
  agentId: string
  id: string
  role: BoardMessage['role']
  text: string
  timestamp?: string
}) {
  const text = input.text.trim()
  if (!text) return

  const database = getDb()
  const threadId = ensureThreadForAgent(database, input.agentId, undefined)
  const timestamp = input.timestamp ?? new Date().toISOString()
  database.exec('BEGIN')
  try {
    database
      .prepare(
        `
          INSERT INTO messages (id, thread_id, role, text, timestamp)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            role = excluded.role,
            text = excluded.text,
            timestamp = excluded.timestamp
        `,
      )
      .run(input.id, threadId, input.role, text, timestamp)
    updateThreadSummary(database, threadId, input.role === 'assistant' ? text : null, timestamp)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function recordRuntimeTimelineEvent(input: {
  agentId: string
  kind: string
  tone: TimelineEventTone
  label: string
  detail?: string | null
  payload?: unknown
  timestamp?: string
}) {
  const database = getDb()
  const threadId = ensureThreadForAgent(database, input.agentId, undefined)
  const timestamp = input.timestamp ?? new Date().toISOString()
  const payload = {
    ...(input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
      ? input.payload as Record<string, unknown>
      : {}),
    type: input.kind,
    label: input.label,
    detail: input.detail ?? null,
    timestamp,
  } as Record<string, unknown> & { type: string }
  database
    .prepare(
      `
        INSERT OR IGNORE INTO timeline_events (
          id, thread_id, kind, tone, label, detail, timestamp, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      eventId(input.agentId, payload),
      threadId,
      input.kind,
      input.tone,
      input.label,
      input.detail ?? null,
      timestamp,
      JSON.stringify(payload),
    )
}

export function recordRuntimeContextUsage(input: {
  agentId: string
  usedTokens: number | undefined
  windowTokens?: number | undefined
  updatedAt?: string
}) {
  upsertAgentContextUsage(getDb(), input)
}

export function clearRuntimeContextUsage(agentId: string) {
  getDb().prepare('DELETE FROM agent_context_usage WHERE agent_id = ?').run(agentId)
}

export function recordPiMessages(input: {
  agentId: string
  promptText: string
  messages: PiRpcMessage[]
  turnStartedAt: number
  turnCompletedAt: number
  sessionFile?: string
}) {
  const database = getDb()
  const thread = database
    .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
    .get(input.agentId) as { id: string } | undefined
  if (!thread) throw new Error(`No active thread for agent: ${input.agentId}`)

  if (input.sessionFile && existsSync(input.sessionFile)) {
    const projection = safeProjectPiSessionFile(input.sessionFile)
    if (projection) {
      database.exec('BEGIN')
      try {
        database
          .prepare('UPDATE agent_slots SET session_file = ? WHERE id = ?')
          .run(input.sessionFile, input.agentId)
        database
          .prepare(
            `
              DELETE FROM messages
              WHERE thread_id = ?
                AND role = 'user'
                AND text = ?
                AND id LIKE ?
            `,
          )
          .run(thread.id, input.promptText.trim(), `user-${input.agentId}-%`)
        hydrateProjectionMessages(database, input.agentId, projection)
        upsertAgentContextUsage(database, {
          agentId: input.agentId,
          usedTokens: projection.contextUsedTokens,
          sessionFile: input.sessionFile,
          updatedAt: projection.updatedAt,
        })
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
      return
    }
  }

  const insertMessage = database.prepare(`
    INSERT OR IGNORE INTO messages (id, thread_id, role, text, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `)
  const currentTurn = currentPiTurn(input.messages, input.promptText)
  const rows = currentTurn
    .map((message, index) => {
      const role = normalizePiRole(message.role)
      const text = piMessageToText(message)
      if (!role || !text) return null
      if (role === 'user' && text === input.promptText.trim()) return null
      const timestamp = new Date(
        piMessageTimestamp({
          message,
          index,
          role,
          text,
          promptText: input.promptText,
          turnStartedAt: input.turnStartedAt,
          turnCompletedAt: input.turnCompletedAt,
        }),
      ).toISOString()
      return {
        id: liveMessageId(input.agentId, role, text, timestamp),
        role,
        text,
        timestamp,
      }
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
  const preview = lastMessageText(rows, 'assistant') ?? rows[rows.length - 1]?.text

  database.exec('BEGIN')
  try {
    for (const row of rows) {
      insertMessage.run(row.id, thread.id, row.role, row.text, row.timestamp)
    }
    const count = database
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?')
      .get(thread.id) as { count: number }
    database
      .prepare('UPDATE threads SET preview = COALESCE(?, preview), message_count = ?, updated_at = ? WHERE id = ?')
      .run(preview ?? null, count.count, new Date().toISOString(), thread.id)
    if (input.sessionFile) {
      database
        .prepare('UPDATE agent_slots SET session_file = ? WHERE id = ?')
        .run(input.sessionFile, input.agentId)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function recordPiTimelineEvent(input: {
  agentId: string
  event: PiRpcEvent
}) {
  const database = getDb()
  const thread = database
    .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
    .get(input.agentId) as { id: string } | undefined
  if (!thread) throw new Error(`No active thread for agent: ${input.agentId}`)

  const event = piEventToTimelineEvent(input.agentId, input.event)
  if (!event) return

  database
    .prepare(
      `
        INSERT OR IGNORE INTO timeline_events (
          id, thread_id, kind, tone, label, detail, timestamp, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      event.id,
      thread.id,
      event.kind,
      event.tone,
      event.label,
      event.detail,
      event.timestamp,
      JSON.stringify(input.event),
    )
}

export function recordAgentInfoEvent(input: {
  agentId: string
  kind: string
  label: string
  detail?: string | null
}) {
  insertAgentInfoEvent(getDb(), { ...input, timestamp: new Date().toISOString() })
}

export function getAgentThinkingLevel(agentId: string): ThinkingLevel | null {
  const row = getDb()
    .prepare(
      `
        SELECT e.detail
        FROM timeline_events e
        INNER JOIN threads t ON t.id = e.thread_id
        WHERE t.agent_id = ? AND t.active = 1 AND e.kind = 'thinking_level'
        ORDER BY e.timestamp DESC, e.id DESC
        LIMIT 1
      `,
    )
    .get(agentId) as { detail: string | null } | undefined
  const parsed = thinkingLevelSchema.safeParse(row?.detail)
  return parsed.success ? parsed.data : null
}

function insertAgentInfoEvent(
  database: DatabaseSync,
  input: {
    agentId: string
    kind: string
    label: string
    detail?: string | null
    timestamp: string
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

export function replaceAgentDiffArtifacts(input: {
  agentId: string
  diffs: Array<Pick<DiffArtifact, 'title' | 'path' | 'patch'>>
}) {
  const database = getDb()
  const updatedAt = new Date().toISOString()
  database.exec('BEGIN')
  try {
    database.prepare('DELETE FROM diff_artifacts WHERE agent_id = ?').run(input.agentId)
    const insert = database.prepare(`
      INSERT INTO diff_artifacts (id, agent_id, title, path, patch, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const diff of input.diffs) {
      const hash = createHash('sha256')
        .update(`${input.agentId}\n${diff.path}\n${diff.patch}`)
        .digest('hex')
        .slice(0, 16)
      insert.run(
        `diff-${input.agentId}-${hash}`,
        input.agentId,
        diff.title,
        diff.path,
        diff.patch,
        updatedAt,
      )
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function migrate(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      position INTEGER NOT NULL,
      hidden_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_slots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      slot TEXT NOT NULL,
      title TEXT NOT NULL,
      runtime TEXT NOT NULL CHECK (runtime IN ('pi', 'codex', 'claude', 'opencode')),
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'queued', 'blocked', 'failed')),
      session_dir TEXT NOT NULL,
      session_file TEXT,
      runtime_state_json TEXT,
      position INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
      active INTEGER NOT NULL DEFAULT 1,
      preview TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_thread_per_agent
      ON threads(agent_id)
      WHERE active = 1;

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system', 'summary')),
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timeline_events (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      tone TEXT NOT NULL CHECK (tone IN ('thinking', 'tool', 'info', 'error')),
      label TEXT NOT NULL,
      detail TEXT,
      timestamp TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS timeline_events_thread_timestamp
      ON timeline_events(thread_id, timestamp, id);

    CREATE TABLE IF NOT EXISTS deleted_sessions (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      slot TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      PRIMARY KEY (project_id, slot)
    );

    CREATE TABLE IF NOT EXISTS diff_artifacts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      patch TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_context_usage (
      agent_id TEXT PRIMARY KEY REFERENCES agent_slots(id) ON DELETE CASCADE,
      used_tokens INTEGER NOT NULL,
      window_tokens INTEGER,
      updated_at TEXT NOT NULL,
      session_file TEXT
    );
  `)
  widenRuntimeCheck(database)
  addContextUsageWindowTokensColumn(database)
  addProjectHiddenAtColumn(database)
  addRuntimeStateColumn(database)
  repairAgentSlotReferences(database)
  removeLegacyDefaultAgentSlots(database)
}

function addProjectHiddenAtColumn(database: DatabaseSync) {
  const columns = database
    .prepare('PRAGMA table_info(projects)')
    .all() as Array<{ name: string }>
  if (columns.some((column) => column.name === 'hidden_at')) return
  database.exec('ALTER TABLE projects ADD COLUMN hidden_at TEXT')
}

function addContextUsageWindowTokensColumn(database: DatabaseSync) {
  const columns = database
    .prepare('PRAGMA table_info(agent_context_usage)')
    .all() as Array<{ name: string }>
  if (columns.some((column) => column.name === 'window_tokens')) return
  database.exec('ALTER TABLE agent_context_usage ADD COLUMN window_tokens INTEGER')
}

function addRuntimeStateColumn(database: DatabaseSync) {
  const columns = database
    .prepare('PRAGMA table_info(agent_slots)')
    .all() as Array<{ name: string }>
  if (columns.some((column) => column.name === 'runtime_state_json')) return
  database.exec('ALTER TABLE agent_slots ADD COLUMN runtime_state_json TEXT')
}

function removeLegacyDefaultAgentSlots(database: DatabaseSync) {
  database.prepare("DELETE FROM agent_slots WHERE slot NOT LIKE 'session-%'").run()
}

function widenRuntimeCheck(database: DatabaseSync) {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_slots'")
    .get() as { sql?: string } | undefined
  if (!row?.sql?.includes("CHECK (runtime = 'pi')")) return

  database.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    ALTER TABLE agent_slots RENAME TO agent_slots_old;

    CREATE TABLE agent_slots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      slot TEXT NOT NULL,
      title TEXT NOT NULL,
      runtime TEXT NOT NULL CHECK (runtime IN ('pi', 'codex', 'claude', 'opencode')),
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'queued', 'blocked', 'failed')),
      session_dir TEXT NOT NULL,
      session_file TEXT,
      runtime_state_json TEXT,
      position INTEGER NOT NULL
    );

    INSERT INTO agent_slots (
      id, project_id, slot, title, runtime, model, status, session_dir, session_file, runtime_state_json, position
    )
    SELECT id, project_id, slot, title, runtime, model, status, session_dir, session_file, NULL, position
    FROM agent_slots_old;

    DROP TABLE agent_slots_old;
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;
  `)
}

function runtimeSessionDir(runtime: string, projectId: string, slot: string) {
  if (runtime === 'pi') return join(process.cwd(), '.aether', 'pi-sessions', projectId, slot)
  return join(process.cwd(), '.aether', 'runtime-sessions', runtime, projectId, slot)
}

function repairAgentSlotReferences(database: DatabaseSync) {
  const tables = database
    .prepare(
      `
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('threads', 'diff_artifacts')
      `,
    )
    .all() as Array<{ name: string; sql?: string }>
  if (!tables.some((table) => table.sql?.includes('agent_slots_old'))) return

  database.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;

    ALTER TABLE threads RENAME TO threads_old;
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
      active INTEGER NOT NULL DEFAULT 1,
      preview TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
    SELECT id, agent_id, active, preview, message_count, updated_at
    FROM threads_old;
    DROP TABLE threads_old;

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_thread_per_agent
      ON threads(agent_id)
      WHERE active = 1;

    ALTER TABLE diff_artifacts RENAME TO diff_artifacts_old;
    CREATE TABLE diff_artifacts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      patch TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO diff_artifacts (id, agent_id, title, path, patch, updated_at)
    SELECT id, agent_id, title, path, patch, updated_at
    FROM diff_artifacts_old;
    DROP TABLE diff_artifacts_old;

    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;
  `)
}

function hydratePersistedPiSessions(database: DatabaseSync) {
  const projects = database
    .prepare('SELECT id FROM projects ORDER BY position ASC')
    .all()
    .map((row) => projectIdDbRowSchema.parse(row))
  const piSettings = getRuntimeSettings('pi')

  for (const project of projects) {
    const projectSessionRoot = join(process.cwd(), '.aether', 'pi-sessions', project.id)
    if (!existsSync(projectSessionRoot)) continue
    const deletedSlots = new Set(
      database
        .prepare('SELECT slot FROM deleted_sessions WHERE project_id = ?')
        .all(project.id)
        .map((row) => deletedSessionDbRowSchema.parse(row).slot),
    )

    const slots = readdirSync(projectSessionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
      .map((entry) => entry.name)
      .filter((slot) => !deletedSlots.has(slot))
      .sort()

    for (const slot of slots) {
      const sessionDir = join(projectSessionRoot, slot)
      const id = `${project.id}-${slot}`
      const existing = database
        .prepare(
          `
            SELECT
              id,
              slot,
              session_dir AS sessionDir,
              session_file AS sessionFile
            FROM agent_slots
            WHERE id = ?
          `,
        )
        .get(id)
      const existingAgent = existing
        ? persistedSessionDbRowSchema.parse(existing)
        : undefined
      const sessionFile = activePiSessionFile(sessionDir, existingAgent?.sessionFile)
      const projection = sessionFile ? safeProjectPiSessionFile(sessionFile) : undefined
      const agent = existingAgent ??
        createPersistedSessionAgent(database, {
            id,
            projectId: project.id,
            slot,
            title: sessionTitle(projection?.preview, slot),
            model: piSettings.defaultModel,
            sessionDir,
            sessionFile,
          })

      if (sessionFile && !agent.sessionFile) {
        database
          .prepare('UPDATE agent_slots SET session_file = ? WHERE id = ?')
          .run(sessionFile, id)
      }
      ensureThreadForAgent(database, id, projection)
      if (projection?.messages.length) {
        hydrateProjectionMessages(database, id, projection)
        upsertAgentContextUsage(database, {
          agentId: id,
          usedTokens: projection.contextUsedTokens,
          sessionFile,
          updatedAt: projection.updatedAt,
        })
      }
    }
  }
}

function activePiSessionFile(sessionDir: string, storedSessionFile: string | null | undefined) {
  if (storedSessionFile && existsSync(storedSessionFile)) return storedSessionFile
  return latestPiSessionFile(sessionDir)
}

function createPersistedSessionAgent(
  database: DatabaseSync,
  input: {
    id: string
    projectId: string
    slot: string
    title: string
    model: string
    sessionDir: string
    sessionFile?: string
  },
) {
  const nextPosition = database
    .prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM agent_slots WHERE project_id = ?',
    )
    .get(input.projectId) as { position: number }
  database
    .prepare(
      `
        INSERT INTO agent_slots (
          id, project_id, slot, title, runtime, model, status, session_dir, session_file, position
        )
        VALUES (?, ?, ?, ?, 'pi', ?, 'idle', ?, ?, ?)
      `,
    )
    .run(
      input.id,
      input.projectId,
      input.slot,
      input.title,
      input.model,
      input.sessionDir,
      input.sessionFile ?? null,
      nextPosition.position,
    )
  return {
    id: input.id,
    slot: input.slot,
    sessionDir: input.sessionDir,
    sessionFile: input.sessionFile ?? null,
  }
}

function ensureThreadForAgent(
  database: DatabaseSync,
  agentId: string,
  projection:
    | {
        preview: string
        messages: Array<{ timestamp: string }>
        updatedAt?: string
      }
    | undefined,
) {
  const existing = database
    .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
    .get(agentId) as { id: string } | undefined
  if (existing) return existing.id

  const updatedAt = projection?.updatedAt ??
    projection?.messages.at(-1)?.timestamp ??
    new Date().toISOString()
  database
    .prepare(
      `
        INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
        VALUES (?, ?, 1, ?, 0, ?)
      `,
    )
    .run(`thread-${agentId}`, agentId, projection?.preview || 'Ready.', updatedAt)
  return `thread-${agentId}`
}

function hydrateProjectionMessages(
  database: DatabaseSync,
  agentId: string,
  projection: Pick<PiSessionProjection, 'preview' | 'updatedAt' | 'messages'>,
) {
  const threadId = ensureThreadForAgent(database, agentId, projection)
  database
    .prepare('DELETE FROM messages WHERE thread_id = ? AND id NOT LIKE ?')
    .run(threadId, `user-${agentId}-%`)
  const insertMessage = database.prepare(`
    INSERT INTO messages (id, thread_id, role, text, timestamp)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
  for (const message of projection.messages) {
    if (!message.text.trim()) continue
    insertMessage.run(
      jsonlMessageId(agentId, message.id),
      threadId,
      message.role,
      message.text,
      message.timestamp,
    )
  }
  updateThreadSummary(
    database,
    threadId,
    projection.preview || projection.messages.at(-1)?.text || null,
    projection.updatedAt ?? projection.messages.at(-1)?.timestamp,
  )
}

function upsertAgentContextUsage(
  database: DatabaseSync,
  input: {
    agentId: string
    usedTokens: number | undefined
    windowTokens?: number | undefined
    sessionFile?: string
    updatedAt?: string
  },
) {
  if (input.usedTokens === undefined) return
  database
    .prepare(
      `
        INSERT INTO agent_context_usage (
          agent_id, used_tokens, window_tokens, updated_at, session_file
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          used_tokens = excluded.used_tokens,
          window_tokens = COALESCE(excluded.window_tokens, agent_context_usage.window_tokens),
          updated_at = excluded.updated_at,
          session_file = excluded.session_file
      `,
    )
    .run(
      input.agentId,
      input.usedTokens,
      input.windowTokens ?? null,
      input.updatedAt ?? new Date().toISOString(),
      input.sessionFile ?? null,
    )
}

function readContextUsage(
  agent: z.infer<typeof agentDbRowSchema>,
  settings: ReturnType<typeof getSettings>,
  persistedUsage: z.infer<typeof contextUsageDbRowSchema> | undefined,
): ContextUsage | null {
  const windowTokens =
    persistedUsage?.windowTokens ?? settings.runtimes[agent.runtime].contextWindows?.[agent.model]
  if (!windowTokens) return null

  const usedTokens = persistedUsage?.usedTokens
  if (usedTokens === undefined) return null

  return {
    usedTokens,
    remainingTokens: Math.max(windowTokens - usedTokens, 0),
    windowTokens,
    usedPercent: Math.min((usedTokens / windowTokens) * 100, 100),
  }
}

function readPendingQuestion(agentId: string) {
  const parsed = pendingQuestionSchema.safeParse(getAgentRuntimeState(agentId).pendingQuestion)
  return parsed.success ? parsed.data : null
}

function latestPiSessionFile(sessionDir: string) {
  if (!existsSync(sessionDir)) return undefined
  return readdirSync(sessionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(sessionDir, entry.name))
    .sort()
    .at(-1)
}

function safeProjectPiSessionFile(path: string) {
  try {
    return projectPiSessionFile(path)
  } catch {
    return undefined
  }
}

function sessionTitle(preview: string | undefined, fallback: string) {
  const title = preview?.replace(/\s+/g, ' ').trim()
  if (!title) return fallback
  return title.length > 44 ? `${title.slice(0, 41)}...` : title
}

function updateThreadSummary(
  database: DatabaseSync,
  threadId: string,
  preview: string | null | undefined,
  updatedAt: string | undefined,
) {
  const count = database
    .prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?')
    .get(threadId) as { count: number }
  database
    .prepare(
      'UPDATE threads SET preview = COALESCE(?, preview), message_count = ?, updated_at = COALESCE(?, updated_at) WHERE id = ?',
    )
    .run(preview ?? null, count.count, updatedAt ?? null, threadId)
}

function jsonlMessageId(agentId: string, messageId: string) {
  return `pi-jsonl-${agentId}-${messageId}`
}

function liveMessageId(
  agentId: string,
  role: MessageRole,
  text: string,
  timestamp: string,
) {
  const hash = createHash('sha256')
    .update(`${agentId}\n${role}\n${timestamp}\n${text}`)
    .digest('hex')
    .slice(0, 16)
  return `pi-live-${agentId}-${hash}`
}

function normalizeSeededModels(database: DatabaseSync) {
  const piSettings = getRuntimeSettings('pi')
  const staleRows = database
    .prepare(
      `
        SELECT id
        FROM agent_slots
        WHERE runtime = 'pi'
          AND model NOT IN (${piSettings.models.map(() => '?').join(', ')})
      `,
    )
    .all(...piSettings.models)
    .map((row) => idDbRowSchema.parse(row))

  const update = database.prepare('UPDATE agent_slots SET model = ? WHERE id = ?')
  for (const row of staleRows) {
    update.run(piSettings.defaultModel, row.id)
  }
}

function timelineEventFromDbRow(row: z.infer<typeof timelineEventDbRowSchema>) {
  const payload = parseEventPayload(row.payloadJson)
  const derived = payload ? piEventDisplayFields(payload, row.kind) : undefined
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    tone: row.tone,
    label: derived?.label ?? row.label,
    detail: derived?.detail ?? row.detail,
    timestamp: row.timestamp,
  }
}

function piEventToTimelineEvent(agentId: string, event: PiRpcEvent) {
  const kind = event.type.trim()
  if (!kind || kind === 'agent_end') return null

  const display = piEventDisplayFields(event, kind)
  const timestamp = numberField(event, 'timestamp')
  const createdAt = stringField(event, 'createdAt') ?? stringField(event, 'timestamp')

  return {
    id: eventId(agentId, event),
    kind,
    tone: eventTone(event),
    label: display.label,
    detail: display.detail,
    timestamp: timestamp !== undefined
      ? new Date(normalizeUnixTimestamp(timestamp)).toISOString()
      : parseTimestamp(createdAt) ?? new Date().toISOString(),
  }
}

function piEventDisplayFields(event: Record<string, unknown>, kind: string) {
  const toolName = stringField(event, 'toolName')
  const args = recordField(event, 'args')
  const command = args ? stringField(args, 'command') : undefined
  const label = toolName === 'bash'
    ? 'Ran command'
    : toolName ??
      stringField(event, 'label') ??
      stringField(event, 'title') ??
      stringField(event, 'message') ??
      formatEventKind(kind)
  const detail = command ??
    stringField(event, 'detail') ??
    stringField(event, 'command') ??
    stringField(event, 'rawCommand') ??
    stringField(event, 'error')
  return { label, detail: detail ?? null }
}

function parseEventPayload(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function eventId(agentId: string, event: PiRpcEvent) {
  const stableId = stringField(event, 'id') ??
    stringField(event, 'eventId') ??
    stringField(event, 'toolCallId') ??
    stringField(event, 'requestId')
  if (stableId) return `pi-event-${agentId}-${event.type}-${stableId}`
  const hash = createHash('sha256')
    .update(JSON.stringify(event))
    .digest('hex')
    .slice(0, 16)
  return `pi-event-${agentId}-${event.type}-${hash}`
}

function eventTone(event: PiRpcEvent): TimelineEventTone {
  const explicitTone = stringField(event, 'tone')
  if (explicitTone && timelineEventToneSchema.safeParse(explicitTone).success) {
    return explicitTone as TimelineEventTone
  }

  const type = event.type.toLowerCase()
  if (type.includes('error') || type.includes('failed')) return 'error'
  if (type.includes('tool') || type.includes('bash') || type.includes('exec')) {
    return 'tool'
  }
  if (type.includes('think') || type.includes('plan')) return 'thinking'
  return 'info'
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function normalizeUnixTimestamp(value: number) {
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function parseTimestamp(value: string | undefined) {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

function formatEventKind(kind: string) {
  return kind
    .replace(/[_:.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function groupBy<T, K extends string>(
  items: T[],
  getKey: (item: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const key = getKey(item)
    const group = groups.get(key)
    if (group) {
      group.push(item)
    } else {
      groups.set(key, [item])
    }
  }
  return groups
}

function mergeTimeline(
  messages: Array<{
    id: string
    role: MessageRole
    text: string
    timestamp: string
  }>,
  events: Array<{
    id: string
    kind: string
    tone: TimelineEventTone
    label: string
    detail: string | null
    timestamp: string
  }>,
) {
  return [
    ...messages.map((message) => ({
      type: 'message' as const,
      id: `message:${message.id}`,
      timestamp: message.timestamp,
      message,
    })),
    ...events.map((event) => ({
      type: 'event' as const,
      id: `event:${event.id}`,
      timestamp: event.timestamp,
      event,
    })),
  ].sort(compareTimelineItems)
}

function piMessageTimestamp(input: {
  message: PiRpcMessage
  index: number
  role: MessageRole
  text: string
  promptText: string
  turnStartedAt: number
  turnCompletedAt: number
}) {
  if (input.message.timestamp !== undefined) {
    return normalizeUnixTimestamp(input.message.timestamp)
  }

  if (input.role === 'user' && input.text === input.promptText.trim()) {
    return input.turnStartedAt
  }

  if (input.role === 'assistant') {
    return input.turnCompletedAt + input.index
  }

  return input.turnStartedAt + input.index
}

function compareTimelineItems(
  left: { timestamp: string; id: string },
  right: { timestamp: string; id: string },
) {
  const byTimestamp = left.timestamp.localeCompare(right.timestamp)
  if (byTimestamp !== 0) return byTimestamp
  return left.id.localeCompare(right.id)
}

function seed(database: DatabaseSync) {
  const count = database
    .prepare('SELECT COUNT(*) AS count FROM projects')
    .get() as { count: number }
  if (count.count > 0) return

  const root = process.cwd()

  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, cwd, position)
    VALUES (?, ?, ?, ?)
  `)

  const projects = [['aether', 'Aether Orchestrator', root, 0]] as const

  for (const project of projects) {
    insertProject.run(...project)
  }
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) throw new Error('Project name must contain at least one ASCII letter or digit')
  return slug
}

function normalizePiRole(role: string): MessageRole | null {
  const parsed = messageRoleSchema.safeParse(role)
  if (parsed.success && parsed.data !== 'summary' && parsed.data !== 'tool') {
    return parsed.data
  }
  if (role === 'toolResult' || role === 'bashExecution') return 'tool'
  return null
}

function currentPiTurn(messages: PiRpcMessage[], promptText: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && piMessageToText(message) === promptText.trim()) {
      return messages.slice(index)
    }
  }
  return messages
}

function lastMessageText(
  rows: Array<{ role: MessageRole; text: string }>,
  role: MessageRole,
) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.role === role) return rows[index]?.text
  }
  return undefined
}

function piMessageToText(message: PiRpcMessage) {
  if (typeof message.content === 'string') return message.content.trim()
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      if ('text' in part && typeof part.text === 'string') return part.text
      if ('thinking' in part && typeof part.thinking === 'string') {
        return part.thinking
      }
      if ('name' in part && typeof part.name === 'string') {
        return `tool call: ${part.name}`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}
