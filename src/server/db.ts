import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context, Effect, Layer } from 'effect'
import type {
  AddProjectInput,
  AddScratchpadBlockInput,
  AgentStatus,
  AgentTask,
  AgentDetail,
  DiffArtifact,
  DeleteSessionInput,
  RestoreSessionInput,
  ScratchpadBlock,
  StartSessionInput,
  ReorderProjectsInput,
  TimelineEventTone,
  BoardMessage,
} from '~/lib/contracts'
import {
  agentDetailSchema,
  runtimeKindSchema,
  sessionInterfaceModeForRuntime,
  sessionInterfaceModeSchema,
} from '~/lib/contracts'
import {
  deletedSessionDbRowSchema,
  idDbRowSchema,
  persistedSessionDbRowSchema,
  projectIdDbRowSchema,
} from './db/schema'
import { readAgentDetail } from './db/agent-detail'
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
import {
  archiveSessionRow,
  assertSessionProjectExists,
  insertSessionRow,
  listSessionSummaries as listSessionSummariesFromDb,
  renameSessionRow as renameSessionRowInDb,
  requireSessionSummary,
  restoreSessionRow as restoreSessionRowFromDb,
} from './db/sessions'
import {
  clearAgentContextUsage,
  clearAgentRuntimeState as clearAgentRuntimeStateInDb,
  getAgentLaunchConfig as getAgentLaunchConfigFromDb,
  getAgentRuntimeState as getAgentRuntimeStateFromDb,
  getAgentThinkingLevel as getAgentThinkingLevelFromDb,
  readContextUsage,
  readPendingQuestion,
  setAgentRuntimeState as setAgentRuntimeStateInDb,
  setAgentStatus as setAgentStatusInDb,
  upsertAgentContextUsage,
} from './db/runtime-state'
import {
  appendUserMessageRow,
  ensureThreadForAgent,
  hydrateProjectionMessages,
  recordAgentInfoEventRow,
  recordPiLiveMessages,
  recordPiProjectionMessages,
  recordPiTimelineEventRow,
  recordRuntimeMessageRow,
  recordRuntimeTimelineEventRow,
  replaceAgentDiffArtifactsRows,
  replaceAgentTasksForThread,
  replaceAgentTasksRows,
} from './db/timeline-writes'
import { readWorkspaceSnapshot } from './db/workspace-snapshot'
import type { PiRpcEvent, PiRpcMessage } from './pi-rpc'
import { projectPiSessionFile } from './pi-jsonl'
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

export function getWorkspaceSnapshot() {
  const database = getDb()
  hydratePersistedPiSessions(database)
  return readWorkspaceSnapshot(database, {
    settings: getSettings(),
    preferences: getUiPreferences(),
    scratchpadBlocks: listScratchpadBlocks(),
  })
}

const agentDetailDiffLimit = 50

export function getAgentDetail(input: { agentId: string; limit?: number }): AgentDetail {
  const database = getDb()
  hydratePersistedPiSessions(database)
  const agentId = input.agentId.trim()
  const limit = Math.max(1, Math.min(input.limit ?? 500, 500))
  const settings = getSettings()
  const detail = readAgentDetail(database, {
    agentId,
    limit,
    diffLimit: agentDetailDiffLimit,
  })
  const parsedAgent = detail.agent

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
    diffCount: detail.diffs.length,
    contextUsage: readContextUsage(
      parsedAgent,
      settings,
      detail.contextUsage,
    ),
    pendingQuestion: readPendingQuestion(database, parsedAgent.id),
    updatedAt: parsedAgent.updatedAt ?? new Date(0).toISOString(),
    isSession: parsedAgent.slot.startsWith('session-'),
    messages: detail.timeline.flatMap((item) => item.type === 'message' ? [item.message] : []),
    timelineEvents: detail.timeline.flatMap((item) => item.type === 'event' ? [item.event] : []),
    timeline: detail.timeline,
    diffs: detail.diffs.map(({ agentId: _agentId, ...diff }) => diff),
    tasks: detail.tasks,
  })
}

export function listProjectSummaries(includeHidden = false) {
  return listProjectSummariesFromDb(getDb(), includeHidden)
}

export function listSessionSummaries(input: {
  readonly projectId?: string
  readonly includeArchived?: boolean
} = {}) {
  return listSessionSummariesFromDb(getDb(), input)
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
  return requireSessionSummary(getDb(), id, true)
}

function insertSession(input: StartSessionInput) {
  const database = getDb()
  const projectId = input.projectId.trim()
  assertSessionProjectExists(database, projectId)
  const runtime = runtimeKindSchema.parse(input.runtime ?? 'pi')
  const requestedInterfaceMode = sessionInterfaceModeSchema.parse(input.interfaceMode ?? 'gui')
  const interfaceMode = sessionInterfaceModeForRuntime(runtime, requestedInterfaceMode)
  const runtimeSettings = getRuntimeSettings(runtime)
  const model = input.model?.trim() || runtimeSettings.defaultModel
  assertConfiguredModel(runtime, model)

  return insertSessionRow(database, {
    projectId,
    title: input.title,
    runtime,
    interfaceMode,
    model,
    thinkingLevel: input.thinkingLevel,
    sessionDirForSlot: (slot) => runtimeSessionDir(runtime, projectId, slot),
  })
}

export function deleteSession(input: DeleteSessionInput) {
  archiveSession(input)
  return getWorkspaceSnapshot()
}

export function deleteSessionSummary(input: DeleteSessionInput) {
  const id = archiveSession(input)
  return requireSessionSummary(getDb(), id, true)
}

function archiveSession(input: DeleteSessionInput) {
  return archiveSessionRow(getDb(), input.agentId)
}

export function restoreSession(input: RestoreSessionInput) {
  restoreSessionRow(input)
  return getWorkspaceSnapshot()
}

export function restoreSessionSummary(input: RestoreSessionInput) {
  const id = restoreSessionRow(input)
  return requireSessionSummary(getDb(), id, true)
}

function restoreSessionRow(input: RestoreSessionInput) {
  return restoreSessionRowFromDb(getDb(), input.agentId)
}

export function renameSession(input: { agentId: string; title: string }) {
  renameSessionRow(input)
  return getWorkspaceSnapshot()
}

export function renameSessionSummary(input: { agentId: string; title: string }) {
  const id = renameSessionRow(input)
  return requireSessionSummary(getDb(), id, true)
}

function renameSessionRow(input: { agentId: string; title: string }) {
  return renameSessionRowInDb(getDb(), input)
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
  return getAgentLaunchConfigFromDb(getDb(), agentId)
}

export function getAgentRuntimeState(agentId: string) {
  return getAgentRuntimeStateFromDb(getDb(), agentId)
}

export function setAgentRuntimeState(agentId: string, state: Record<string, unknown>) {
  setAgentRuntimeStateInDb(getDb(), agentId, state)
}

export function clearAgentRuntimeState(agentId: string) {
  clearAgentRuntimeStateInDb(getDb(), agentId)
}

export function setAgentStatus(agentId: string, status: AgentStatus) {
  setAgentStatusInDb(getDb(), agentId, status)
}

export function appendUserMessage(input: { agentId: string; text: string }) {
  appendUserMessageRow(getDb(), input)
}

export function recordRuntimeMessage(input: {
  agentId: string
  id: string
  role: BoardMessage['role']
  text: string
  timestamp?: string
}) {
  recordRuntimeMessageRow(getDb(), input)
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
  recordRuntimeTimelineEventRow(getDb(), input)
}

export function replaceAgentTasks(input: {
  agentId: string
  source: AgentTask['source']
  tasks: AgentTask[]
  updatedAt?: string
}) {
  replaceAgentTasksRows(getDb(), input)
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
  clearAgentContextUsage(getDb(), agentId)
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
  if (input.sessionFile && existsSync(input.sessionFile)) {
    const projection = safeProjectPiSessionFile(input.sessionFile)
    if (projection) {
      recordPiProjectionMessages(database, {
        agentId: input.agentId,
        promptText: input.promptText,
        sessionFile: input.sessionFile,
        projection,
      })
      return
    }
  }

  recordPiLiveMessages(database, input)
}

export function recordPiTimelineEvent(input: {
  agentId: string
  event: PiRpcEvent
}) {
  recordPiTimelineEventRow(getDb(), input)
}

export function recordAgentInfoEvent(input: {
  agentId: string
  kind: string
  label: string
  detail?: string | null
}) {
  recordAgentInfoEventRow(getDb(), input)
}

export function getAgentThinkingLevel(agentId: string) {
  return getAgentThinkingLevelFromDb(getDb(), agentId)
}

export function replaceAgentDiffArtifacts(input: {
  agentId: string
  diffs: Array<Pick<DiffArtifact, 'title' | 'path' | 'patch'>>
}) {
  replaceAgentDiffArtifactsRows(getDb(), input)
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
