import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context, Effect, Layer } from 'effect'
import { z } from 'zod'
import type {
  AddProjectInput,
  AddScratchpadBlockInput,
  AgentTask,
  AgentStatus,
  AgentDetail,
  ContextUsage,
  DiffArtifact,
  DeleteSessionInput,
  RestoreSessionInput,
  ScratchpadBlock,
  StartSessionInput,
  MessageRole,
  ReorderProjectsInput,
  ThinkingLevel,
  TimelineEventTone,
  BoardMessage,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import {
  agentTaskSchema,
  agentStatusSchema,
  agentDetailSchema,
  messageRoleSchema,
  pendingQuestionSchema,
  runtimeKindSchema,
  sessionInterfaceModeForRuntime,
  sessionInterfaceModeSchema,
  thinkingLevelSchema,
  timelineEventToneSchema,
  workspaceSnapshotSchema,
} from '~/lib/contracts'
import {
  agentDbRowSchema,
  agentDetailDbRowSchema,
  agentLaunchConfigSchema,
  agentTaskDbRowSchema,
  archivedSessionDbRowSchema,
  contextUsageDbRowSchema,
  deletedSessionDbRowSchema,
  diffDbRowSchema,
  idDbRowSchema,
  messageDbRowSchema,
  persistedSessionDbRowSchema,
  projectDbRowSchema,
  projectIdDbRowSchema,
  sessionSummaryDbRowSchema,
  timelineEventDbRowSchema,
} from './db/schema'
import { openKiriDatabase } from './db/connection'
import {
  deleteProjectRow,
  hideProjectRow,
  insertProject,
  listProjectSummaries as listProjectSummariesFromDb,
  reorderVisibleProjectRows,
  requireProjectSummary,
  unhideProjectRow,
} from './db/projects'
import {
  deleteScratchpadBlockRow,
  getScratchpadBlock as getScratchpadBlockFromDb,
  insertScratchpadBlock,
  listScratchpadBlocks as listScratchpadBlocksFromDb,
  markScratchpadBlockTriggered as markScratchpadBlockTriggeredInDb,
} from './db/scratchpad'
import type { PiRpcEvent, PiRpcMessage } from './pi-rpc'
import { projectPiSessionFile, type PiSessionProjection } from './pi-jsonl'
import { assertConfiguredModel, getRuntimeSettings, getSettings } from './settings'
import { getKiriConfig, runtimeSessionDirPath } from './kiri-config'
import { getUiPreferences } from './preferences'

let db: DatabaseSync | undefined

export type KiriDbApi = {
  readonly get: Effect.Effect<DatabaseSync>
}

export class KiriDbService extends Context.Tag('@kiri/KiriDb')<
  KiriDbService,
  KiriDbApi
>() {
  static readonly layer = Layer.sync(KiriDbService, () =>
    KiriDbService.of({
      get: Effect.sync(() => getDb()),
    }),
  )
}

export function getDb() {
  if (db) return db
  const config = getKiriConfig()
  db = openKiriDatabase(config.dbPath)
  normalizeSeededModels(db)
  removeLegacySeedProject(db)
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
        ORDER BY a.position ASC
      `,
    )
    .all()
    .map((row) => agentDetailDbRowSchema.parse(row))

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
  const contextUsageByAgent = new Map(
    contextUsages.map((usage) => [usage.agentId, usage]),
  )
  const activeAgentsByProject = groupBy(
    agents.filter((agent) => !agent.archivedAt),
    (agent) => agent.projectId,
  )

  const snapshotProjectRows = projects.map((project) => ({
    ...project,
    agents: (activeAgentsByProject.get(project.id) ?? []).map((agent) => {
      return {
        id: agent.id,
        projectId: agent.projectId,
        slot: agent.slot,
        title: agent.title,
        runtime: agent.runtime,
        interfaceMode: agent.interfaceMode,
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
        messages: [],
        timelineEvents: [],
        timeline: [],
        diffs: [],
        tasks: [],
      }
    }),
  }))
  const projectNameById = new Map(projects.map((project) => [project.id, project.name]))
  const visibleProjectIds = new Set(
    projects.flatMap((project) => project.hiddenAt ? [] : [project.id]),
  )
  const archivedSessions = agents
    .flatMap((agent) => {
      if (!agent.archivedAt || !visibleProjectIds.has(agent.projectId)) return []
      return [archivedSessionDbRowSchema.parse({
        ...agent,
        projectName: projectNameById.get(agent.projectId) ?? agent.projectId,
        archivedAt: agent.archivedAt,
      })]
    })
    .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))
    .map((agent) => ({
      id: agent.id,
      projectId: agent.projectId,
      projectName: agent.projectName,
      title: agent.title,
        runtime: agent.runtime,
        interfaceMode: agent.interfaceMode,
        model: agent.model,
      status: agent.status,
      preview: agent.preview ?? 'No messages yet',
      messageCount: agent.messageCount ?? 0,
      updatedAt: agent.updatedAt ?? new Date(0).toISOString(),
      archivedAt: agent.archivedAt,
    }))
  const snapshotProjects = snapshotProjectRows.filter((project) => !project.hiddenAt)
  const hiddenProjects = snapshotProjectRows.filter((project) => project.hiddenAt)
  const selectedProject = snapshotProjects[0]
  const selectedAgent = selectedProject?.agents[0]
  const scratchpadBlocks = listScratchpadBlocks()

  const snapshot = {
    settings,
    preferences: getUiPreferences(),
    projects: snapshotProjects,
    hiddenProjects,
    archivedSessions,
    scratchpadBlocks,
    selected: {
      projectId: selectedProject?.id ?? '',
      agentId: selectedAgent?.id ?? '',
    },
  }

  return workspaceSnapshotSchema.parse(snapshot)
}

const agentDetailDiffLimit = 50

export function getAgentDetail(input: { agentId: string; limit?: number }): AgentDetail {
  const database = getDb()
  hydratePersistedPiSessions(database)
  const agentId = input.agentId.trim()
  const limit = Math.max(1, Math.min(input.limit ?? 500, 500))
  const settings = getSettings()
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
    .all(activeThreadId, activeThreadId, limit)
    .reverse()
  const timeline = timelineRows.map((row) => timelineItemFromDetailRow(row, agentId))
  const diffs = readDiffs(database, agentId, agentDetailDiffLimit)
  const tasks = readAgentTasks(database, agentId)

  return agentDetailSchema.parse({
    id: parsedAgent.id,
    projectId: parsedAgent.projectId,
    slot: parsedAgent.slot,
    title: parsedAgent.title,
    runtime: parsedAgent.runtime,
    interfaceMode: parsedAgent.interfaceMode,
    model: parsedAgent.model,
    status: parsedAgent.status,
    sessionDir: parsedAgent.sessionDir,
    sessionFile: parsedAgent.sessionFile,
    preview: parsedAgent.preview ?? 'No messages yet',
    messageCount: parsedAgent.messageCount ?? 0,
    diffCount: diffs.length,
    contextUsage: readContextUsage(
      parsedAgent,
      settings,
      usage ? contextUsageDbRowSchema.parse(usage) : undefined,
    ),
    pendingQuestion: readPendingQuestion(parsedAgent.id),
    updatedAt: parsedAgent.updatedAt ?? new Date(0).toISOString(),
    isSession: parsedAgent.slot.startsWith('session-'),
    messages: timeline.flatMap((item) => item.type === 'message' ? [item.message] : []),
    timelineEvents: timeline.flatMap((item) => item.type === 'event' ? [item.event] : []),
    timeline,
    diffs: diffs.map(({ agentId: _agentId, ...diff }) => diff),
    tasks,
  })
}

export function listProjectSummaries(includeHidden = false) {
  return listProjectSummariesFromDb(getDb(), includeHidden)
}

export function listSessionSummaries(input: {
  readonly projectId?: string
  readonly includeArchived?: boolean
} = {}) {
  const rows = getDb()
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

function requireSessionSummary(agentId: string, includeArchived = false) {
  const id = agentId.trim()
  const session = getDb()
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

export function addProject(input: AddProjectInput) {
  insertProject(getDb(), input)
  return getWorkspaceSnapshot()
}

export function addProjectSummary(input: AddProjectInput) {
  const database = getDb()
  const id = insertProject(database, input)
  return requireProjectSummary(database, id, true)
}

export function startSession(input: StartSessionInput) {
  const id = insertSession(input)
  return getWorkspaceSnapshot()
}

export function startSessionSummary(input: StartSessionInput) {
  const id = insertSession(input)
  return requireSessionSummary(id, true)
}

function insertSession(input: StartSessionInput) {
  const database = getDb()
  const projectId = input.projectId.trim()
  const project = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(projectId)
  if (!project) throw new Error(`Project not found: ${projectId}`)

  const runtime = runtimeKindSchema.parse(input.runtime ?? 'pi')
  const requestedInterfaceMode = sessionInterfaceModeSchema.parse(input.interfaceMode ?? 'gui')
  const interfaceMode = sessionInterfaceModeForRuntime(runtime, requestedInterfaceMode)
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
        runtime,
        interfaceMode,
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

  return id
}

export function deleteSession(input: DeleteSessionInput) {
  archiveSession(input)
  return getWorkspaceSnapshot()
}

export function deleteSessionSummary(input: DeleteSessionInput) {
  const id = archiveSession(input)
  return requireSessionSummary(id, true)
}

function archiveSession(input: DeleteSessionInput) {
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
    const archivedAt = new Date().toISOString()
    database
      .prepare('UPDATE agent_slots SET archived_at = ? WHERE id = ?')
      .run(archivedAt, agentId)
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

  return agentId
}

export function restoreSession(input: RestoreSessionInput) {
  restoreSessionRow(input)
  return getWorkspaceSnapshot()
}

export function restoreSessionSummary(input: RestoreSessionInput) {
  const id = restoreSessionRow(input)
  return requireSessionSummary(id, true)
}

function restoreSessionRow(input: RestoreSessionInput) {
  const database = getDb()
  const agentId = input.agentId.trim()
  const row = database
    .prepare('SELECT id, project_id AS projectId, slot, archived_at AS archivedAt FROM agent_slots WHERE id = ?')
    .get(agentId) as { id: string; projectId: string; slot: string; archivedAt: string | null } | undefined
  if (!row) throw new Error(`Session not found: ${agentId}`)
  if (!row.slot.startsWith('session-')) {
    throw new Error('Only started sessions can be restored')
  }

  database
    .prepare('UPDATE agent_slots SET archived_at = NULL WHERE id = ?')
    .run(agentId)
  return agentId
}

export function renameSession(input: { agentId: string; title: string }) {
  renameSessionRow(input)
  return getWorkspaceSnapshot()
}

export function renameSessionSummary(input: { agentId: string; title: string }) {
  const id = renameSessionRow(input)
  return requireSessionSummary(id, true)
}

function renameSessionRow(input: { agentId: string; title: string }) {
  const database = getDb()
  const agentId = input.agentId.trim()
  const title = input.title.trim()
  if (!title) throw new Error('Session title cannot be empty')
  const row = database
    .prepare('SELECT id, slot FROM agent_slots WHERE id = ?')
    .get(agentId) as { id: string; slot: string } | undefined
  if (!row) throw new Error(`Session not found: ${agentId}`)
  if (!row.slot.startsWith('session-')) {
    throw new Error('Only started sessions can be renamed')
  }
  database.prepare('UPDATE agent_slots SET title = ? WHERE id = ?').run(title, agentId)
  return agentId
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
    database.prepare('DELETE FROM agent_tasks WHERE thread_id = ?').run(thread.id)
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
          a.interface_mode AS interfaceMode,
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
        interfaceMode: string
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
  const sessionDir = runtimeSessionDirPath(getKiriConfig(), 'pi', source.projectId, slot)
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
            id, project_id, slot, title, runtime, interface_mode, model, status, session_dir, session_file, position
          )
          VALUES (?, ?, ?, ?, 'pi', ?, ?, 'idle', ?, ?, ?)
        `,
      )
      .run(
        id,
        source.projectId,
        slot,
        `${source.title} fork`,
        source.interfaceMode,
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
  deleteProjectRow(getDb(), id)
  return getWorkspaceSnapshot()
}

export function deleteProjectSummary(id: string) {
  const database = getDb()
  const project = requireProjectSummary(database, id, true)
  deleteProjectRow(database, id)
  return project
}

export function hideProject(id: string) {
  hideProjectRow(getDb(), id)
  return getWorkspaceSnapshot()
}

export function reorderProjects(input: ReorderProjectsInput) {
  reorderVisibleProjectRows(getDb(), input.ids)
  return getWorkspaceSnapshot()
}

export function hideProjectSummary(id: string) {
  const database = getDb()
  const projectId = hideProjectRow(database, id)
  return requireProjectSummary(database, projectId, true)
}

export function unhideProject(id: string) {
  unhideProjectRow(getDb(), id)
  return getWorkspaceSnapshot()
}

export function unhideProjectSummary(id: string) {
  const database = getDb()
  const projectId = unhideProjectRow(database, id)
  return requireProjectSummary(database, projectId, true)
}

export function listScratchpadBlocks(input: {
  readonly projectId?: string
} = {}): ScratchpadBlock[] {
  return listScratchpadBlocksFromDb(getDb(), input)
}

export function addScratchpadBlock(input: AddScratchpadBlockInput) {
  insertScratchpadBlock(getDb(), input)
  return getWorkspaceSnapshot()
}

export function addScratchpadBlockSummary(input: AddScratchpadBlockInput) {
  const database = getDb()
  const id = insertScratchpadBlock(database, input)
  const block = getScratchpadBlockFromDb(database, id)
  if (!block) throw new Error(`Scratchpad block not found: ${id}`)
  return block
}

export function deleteScratchpadBlock(id: string) {
  deleteScratchpadBlockRow(getDb(), id)
  return getWorkspaceSnapshot()
}

export function deleteScratchpadBlockSummary(id: string) {
  const block = getScratchpadBlock(id)
  if (!block) throw new Error(`Scratchpad block not found: ${id}`)
  deleteScratchpadBlockRow(getDb(), id)
  return block
}

export function markScratchpadBlockTriggered(blockId: string, agentId: string) {
  markScratchpadBlockTriggeredInDb(getDb(), blockId, agentId)
}

export function getScratchpadBlock(id: string) {
  return getScratchpadBlockFromDb(getDb(), id)
}

export function startSessionAndGetId(input: StartSessionInput) {
  return insertSession(input)
}

export function getAgentLaunchConfig(agentId: string) {
  const row = getDb()
    .prepare(
      `
        SELECT
          a.id,
          a.project_id AS projectId,
          a.runtime,
          a.session_dir AS sessionDir,
          a.session_file AS sessionFile,
          a.model,
          a.runtime_state_json AS runtimeStateJson,
          p.cwd
        FROM agent_slots a
        INNER JOIN projects p ON p.id = a.project_id
        WHERE a.id = ?
          AND a.archived_at IS NULL
      `,
    )
    .get(agentId)
  if (!row) throw new Error(`Agent not found: ${agentId}`)
  return agentLaunchConfigSchema.parse(row)
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

export function replaceAgentTasks(input: {
  agentId: string
  source: AgentTask['source']
  tasks: AgentTask[]
  updatedAt?: string
}) {
  const database = getDb()
  const threadId = ensureThreadForAgent(database, input.agentId, undefined)
  const updatedAt = input.updatedAt ?? new Date().toISOString()
  database.exec('BEGIN')
  try {
    replaceAgentTasksForThread(database, {
      threadId,
      source: input.source,
      tasks: input.tasks,
      updatedAt,
    })
    database
      .prepare('UPDATE threads SET updated_at = ? WHERE id = ?')
      .run(updatedAt, threadId)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
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
        replaceAgentTasksForThread(database, {
          threadId: thread.id,
          source: 'pi',
          tasks: projection.tasks,
          updatedAt: projection.updatedAt ?? new Date().toISOString(),
        })
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
    .flatMap((message, index) => {
      const role = normalizePiRole(message.role)
      const text = piMessageToText(message)
      if (!role || !text) return []
      if (role === 'user' && text === input.promptText.trim()) return []
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
      return [{
        id: liveMessageId(input.agentId, role, text, timestamp),
        role,
        text,
        timestamp,
      }]
    })
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
  const row = database
    .prepare(
      `
        SELECT a.id
        FROM agent_slots a
        WHERE a.id = ?
      `,
    )
    .get(input.agentId)
  if (!row) return
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

function runtimeSessionDir(runtime: string, projectId: string, slot: string) {
  return runtimeSessionDirPath(getKiriConfig(), runtime, projectId, slot)
}

function hydratePersistedPiSessions(database: DatabaseSync) {
  const projects = database
    .prepare('SELECT id FROM projects ORDER BY position ASC')
    .all()
    .map((row) => projectIdDbRowSchema.parse(row))
  const piSettings = getRuntimeSettings('pi')

  for (const project of projects) {
    const projectSessionRoot = join(getKiriConfig().piSessionsDir, project.id)
    if (!existsSync(projectSessionRoot)) continue
    const deletedSlots = new Set(
      database
        .prepare('SELECT slot FROM deleted_sessions WHERE project_id = ?')
        .all(project.id)
        .map((row) => deletedSessionDbRowSchema.parse(row).slot),
    )

    const slots = readdirSync(projectSessionRoot, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory() && entry.name.startsWith('session-') && !deletedSlots.has(entry.name)
          ? [entry.name]
          : [],
      )
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
      const threadId = ensureThreadForAgent(database, id, projection)
      if (projection) {
        hydrateProjectionMessages(database, id, projection)
        replaceAgentTasksForThread(database, {
          threadId,
          source: 'pi',
          tasks: projection.tasks,
          updatedAt: projection.updatedAt ?? new Date().toISOString(),
        })
      }
      if (projection?.messages.length) {
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
          id, project_id, slot, title, runtime, interface_mode, model, status, session_dir, session_file, position
        )
        VALUES (?, ?, ?, ?, 'pi', 'gui', ?, 'idle', ?, ?, ?)
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

function replaceAgentTasksForThread(
  database: DatabaseSync,
  input: {
    threadId: string
    source: AgentTask['source']
    tasks: AgentTask[]
    updatedAt: string
  },
) {
  const parsedTasks = input.tasks.map((task) => agentTaskSchema.parse(task))
  database
    .prepare('DELETE FROM agent_tasks WHERE thread_id = ? AND source = ?')
    .run(input.threadId, input.source)
  const insertTask = database.prepare(`
    INSERT OR REPLACE INTO agent_tasks (
      thread_id, source, task_id, position, title, status, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  parsedTasks.forEach((task, index) => {
    insertTask.run(
      input.threadId,
      input.source,
      task.id,
      index,
      task.title,
      task.status,
      task.updatedAt || input.updatedAt,
    )
  })
}

function readAgentTasks(database: DatabaseSync, agentId: string): AgentTask[] {
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
  if (!persistedUsage) return null

  const windowTokens =
    persistedUsage.windowTokens ?? settings.runtimes[agent.runtime].contextWindows?.[agent.model]
  if (!windowTokens) return null

  const usedTokens = persistedUsage.usedTokens
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
    .flatMap((entry) => entry.isFile() && entry.name.endsWith('.jsonl') ? [join(sessionDir, entry.name)] : [])
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
  const derived = payload && !row.kind.startsWith('fileOperation')
    ? piEventDisplayFields(payload, row.kind)
    : undefined
  const path = eventPath(payload)
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    tone: row.tone,
    label: derived?.label ?? row.label,
    detail: derived?.detail ?? row.detail,
    ...(path ? { path } : {}),
    timestamp: row.timestamp,
  }
}

function eventPath(payload: Record<string, unknown> | null | undefined) {
  if (!payload) return undefined
  const path = stringField(payload, 'path')
  return path?.trim() || undefined
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
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
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

function normalizeDetailLimit(value: number | undefined) {
  return Number.isInteger(value)
    ? Math.max(1, Math.min(value ?? 500, 500))
    : 500
}

function removeLegacySeedProject(database: DatabaseSync) {
  database.exec(`
    DELETE FROM projects
    WHERE id = 'kiri'
      AND name = 'kiri Orchestrator'
      AND (
        SELECT COUNT(*)
        FROM projects
      ) = 1
      AND NOT EXISTS (
        SELECT 1
        FROM agent_slots
        WHERE project_id = 'kiri'
      )
  `)
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
    .flatMap((part) => {
      if (!part || typeof part !== 'object') return []
      if ('text' in part && typeof part.text === 'string') return [part.text]
      if ('thinking' in part && typeof part.thinking === 'string') {
        return [part.thinking]
      }
      return []
    })
    .join('\n')
    .trim()
}
