import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Context, Effect, Layer } from 'effect'
import type {
  AddProjectInput,
  AddScratchpadBlockInput,
  AgentStatus,
  AgentTask,
  AgentDetail,
  AgentEvent,
  DeleteSessionInput,
  KnowledgeAddInput,
  KnowledgeListInput,
  KnowledgeMarkSeenInput,
  KnowledgeSearchInput,
  KnowledgeUpdateInput,
  PendingQuestion,
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
  sessionInterfaceModeSchema,
} from '~/lib/contracts'
import {
  applyDatabaseBootstraps,
} from './db/bootstrap'
import { hydrateClaudeSession } from './claude-projection'
import { listActiveThreadTasks, readAgentDetail } from './db/agent-detail'
import { listAgentEvents as listAgentEventsFromDb } from './db/agent-events'
import { hydrateCodexTerminalTasksRows } from './db/codex-terminal-tasks'
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
  addKnowledgeEntry as addKnowledgeEntryInDb,
  deleteKnowledgeEntry as deleteKnowledgeEntryInDb,
  listKnowledgeEntries as listKnowledgeEntriesFromDb,
  markKnowledgeEntrySeen as markKnowledgeEntrySeenInDb,
  searchKnowledgeEntries as searchKnowledgeEntriesFromDb,
  updateKnowledgeEntry as updateKnowledgeEntryInDb,
} from './db/knowledge'
import {
  completeScratchpadWorkflowItem as completeScratchpadWorkflowItemInDb,
  getWorkflowItem as getWorkflowItemFromDb,
  getWorkflowRun as getWorkflowRunFromDb,
  insertWorkflowRun,
  listWorkflowRuns as listWorkflowRunsFromDb,
  recordWorkflowItemAttempt as recordWorkflowItemAttemptInDb,
  setWorkflowItemTracking as setWorkflowItemTrackingInDb,
  setWorkflowRunArchiveState,
  type PersistWorkflowRunInput,
} from './db/workflows'
import {
  archiveSessionRow,
  assertSessionProjectExists,
  hardDeleteSessionRow,
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
  isAgentArchived as isAgentArchivedInDb,
  queueAgentTerminalInput as queueAgentTerminalInputInDb,
  requeueAgentTerminalInputs as requeueAgentTerminalInputsInDb,
  readContextUsage,
  readPendingQuestion,
  setAgentPendingQuestion as setAgentPendingQuestionInDb,
  setAgentRuntimeState as setAgentRuntimeStateInDb,
  setAgentStatus as setAgentStatusInDb,
  takeAgentTerminalInputs as takeAgentTerminalInputsFromDb,
  upsertAgentContextUsage,
} from './db/runtime-state'
import {
  appendUserMessageRow,
  recordAgentInfoEventRow,
  recordPiLiveMessages,
  recordPiProjectionMessages,
  recordPiTimelineEventRow,
  recordRuntimeMessageRow,
  recordRuntimeTimelineEventRow,
  replaceAgentTasksRows,
} from './db/timeline-writes'
import { readWorkspaceRevision, readWorkspaceSnapshot } from './db/workspace-snapshot'
import {
  createForkedSessionRow,
  hydratePersistedPiSessionRows,
  resetSessionRows,
  safeProjectPiSessionFile,
} from './db/session-operations'
import type { PiRpcEvent, PiRpcMessage } from './pi-rpc'
import {
  assertConfiguredModel,
  defaultRuntime,
  getRuntimeSettings,
  getSettings,
  normalizeConfiguredInterfaceMode,
} from './settings'
import { getKiriConfig, runtimeSessionDirPath, type KiriConfig } from './kiri-config'
import { getUiPreferences } from './preferences'
import { refreshReadModelEntriesIfChanged } from './read-model-indexer'

let readModelRefreshWarningShown = false

export type KiriDbApi = {
  readonly get: Effect.Effect<DatabaseSync>
  readonly close: Effect.Effect<boolean>
}

export class KiriDbService extends Context.Tag('@kiri/KiriDb')<
  KiriDbService,
  KiriDbApi
>() {
  static readonly layer = Layer.sync(KiriDbService, () =>
    KiriDbService.of(makeKiriDbService()),
  )
}

export type KiriDbDependencies = {
  readonly getConfig: () => Pick<KiriConfig, 'dbPath'>
  readonly openDatabase: (dbPath: string) => DatabaseSync
  readonly getPiRuntimeSettings: () => {
    readonly models: readonly string[]
    readonly defaultModel: string
  }
  readonly bootstrap: (
    database: DatabaseSync,
    input: {
      readonly piModels: readonly string[]
      readonly defaultPiModel: string
    },
  ) => void
}

const liveKiriDb = makeKiriDbService()

export function makeKiriDbService(
  dependencies: KiriDbDependencies = {
    getConfig: getKiriConfig,
    openDatabase: openKiriDatabase,
    getPiRuntimeSettings: () => getRuntimeSettings('pi'),
    bootstrap: applyDatabaseBootstraps,
  },
): KiriDbApi {
  let database: DatabaseSync | undefined
  return {
    get: Effect.sync(() => {
      if (database) return database
      const config = dependencies.getConfig()
      database = dependencies.openDatabase(config.dbPath)
      const piSettings = dependencies.getPiRuntimeSettings()
      dependencies.bootstrap(database, {
        piModels: piSettings.models,
        defaultPiModel: piSettings.defaultModel,
      })
      return database
    }),
    close: Effect.sync(() => {
      if (!database) return false
      database.close()
      database = undefined
      return true
    }),
  }
}

export function getDb() {
  return Effect.runSync(liveKiriDb.get)
}

export function getWorkspaceSnapshot() {
  const database = getDb()
  hydratePersistedPiSessions(database)
  return readWorkspaceSnapshot(database, {
    settings: getSettings(),
    preferences: getUiPreferences(),
    scratchpadBlocks: listScratchpadBlocks(),
    knowledgeEntries: listKnowledgeEntries(),
  })
}

export function getWorkspaceRevision() {
  const database = getDb()
  return readWorkspaceRevision(database, {
    settings: getSettings(),
    preferences: getUiPreferences(),
  })
}

// As of plan 015, read_model_entries has no readers in app code or kiri-control/router.
// If that remains true, remove this refresh path instead of paying it on mutations.
export function refreshReadModels() {
  if (readModelRefreshDisabled(process.env)) return []
  const database = getDb()
  try {
    return [...refreshReadModelEntriesIfChanged(database).entries]
  } catch (error) {
    if (!readModelRefreshWarningShown) {
      readModelRefreshWarningShown = true
      console.warn('[kiri] read-model refresh failed; continuing with source tables', error)
    }
    return []
  }
}

function readModelRefreshDisabled(env: NodeJS.ProcessEnv) {
  const value = env.KIRI_READ_MODEL_REFRESH?.trim().toLowerCase()
  return value === '0' || value === 'false' || value === 'off'
}

export function getAgentDetail(input: { agentId: string; limit?: number; offset?: number }): AgentDetail {
  const database = getDb()
  hydratePersistedPiSessions(database, input.agentId)
  hydrateCodexTerminalTasksRows(database, { agentId: input.agentId })
  const agentId = input.agentId.trim()
  if (agentRuntime(database, agentId) === 'claude') {
    hydrateClaudeSession(database, agentId)
  }
  const limit = Math.max(1, Math.min(input.limit ?? 500, 500))
  const offset = Math.max(0, Math.min(input.offset ?? 0, 100_000))
  const settings = getSettings()
  const detail = readAgentDetail(database, {
    agentId,
    limit,
    offset,
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
    timelinePage: detail.timelinePage,
    tasks: detail.tasks,
  })
}

export function hydrateCodexTerminalTasks(input: {
  agentId?: string
  projectId?: string
  codexHome?: string
} = {}) {
  hydrateCodexTerminalTasksRows(getDb(), input)
}

export function listAgentEvents(input: {
  agentId: string
  afterSequence?: number
  limit?: number
}): AgentEvent[] {
  return listAgentEventsFromDb(getDb(), input)
}

function agentRuntime(database: DatabaseSync, agentId: string) {
  const row = database
    .prepare('SELECT runtime FROM agent_slots WHERE id = ?')
    .get(agentId) as { runtime: unknown } | undefined
  const parsed = runtimeKindSchema.safeParse(row?.runtime)
  return parsed.success ? parsed.data : null
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
  insertSession(input)
  return getWorkspaceSnapshot()
}

export function startSessionSummary(input: StartSessionInput) {
  const id = insertSession(input)
  return requireSessionSummary(getDb(), id, true)
}

type InternalStartSessionInput = StartSessionInput & {
  readonly titleSetManually?: boolean
  readonly sourceScratchpadId?: string
}

function insertSession(input: InternalStartSessionInput) {
  const database = getDb()
  const projectId = input.projectId.trim()
  assertSessionProjectExists(database, projectId)
  const settings = getSettings()
  const runtime = runtimeKindSchema.parse(input.runtime ?? defaultRuntime(settings))
  const requestedInterfaceMode = input.interfaceMode
    ? sessionInterfaceModeSchema.parse(input.interfaceMode)
    : undefined
  const interfaceMode = normalizeConfiguredInterfaceMode(runtime, requestedInterfaceMode, settings)
  const runtimeSettings = settings.runtimes[runtime] ?? getRuntimeSettings(runtime)
  const model = input.model?.trim() || runtimeSettings.defaultModel
  assertConfiguredModel(runtime, model)

  return insertSessionRow(database, {
    projectId,
    title: input.title,
    runtime,
    interfaceMode,
    model,
    thinkingLevel: input.thinkingLevel,
    titleSetManually: input.titleSetManually,
    sourceScratchpadId: input.sourceScratchpadId,
    sessionDirForSlot: (slot) => runtimeSessionDir(runtime, projectId, slot),
  })
}

export function archiveSession(input: DeleteSessionInput) {
  archiveSessionByInput(input)
  return getWorkspaceSnapshot()
}

export function archiveSessionSummary(input: DeleteSessionInput) {
  const id = archiveSessionByInput(input)
  return requireSessionSummary(getDb(), id, true)
}

function archiveSessionByInput(input: DeleteSessionInput) {
  return archiveSessionRow(getDb(), input.agentId)
}

export function hardDeleteSession(agentId: string) {
  return hardDeleteSessionRow(getDb(), agentId)
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
  resetSessionRows(getDb(), agentId)
}

export function createForkedSession(input: {
  sourceAgentId: string
  sessionFile: string
}) {
  return createForkedSessionRow(getDb(), {
    ...input,
    sessionDirForProjectSlot: (projectId, slot) =>
      runtimeSessionDirPath(getKiriConfig(), 'pi', projectId, slot),
  })
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

export function searchKnowledgeEntries(input: KnowledgeSearchInput & { readonly projectId: string }) {
  return searchKnowledgeEntriesFromDb(getDb(), input)
}

export function listKnowledgeEntries(input: KnowledgeListInput = {}) {
  return listKnowledgeEntriesFromDb(getDb(), input)
}

export function addKnowledgeEntry(input: KnowledgeAddInput & { readonly projectId: string }) {
  return addKnowledgeEntryInDb(getDb(), input)
}

export function updateKnowledgeEntry(input: KnowledgeUpdateInput) {
  return updateKnowledgeEntryInDb(getDb(), input)
}

export function deleteKnowledgeEntry(id: string) {
  return deleteKnowledgeEntryInDb(getDb(), id)
}

export function markKnowledgeEntrySeen(input: KnowledgeMarkSeenInput) {
  return markKnowledgeEntrySeenInDb(getDb(), input)
}

export function listTasks(input: {
  readonly projectId?: string
  readonly includeArchived?: boolean
} = {}) {
  const database = getDb()
  hydrateCodexTerminalTasksRows(database, { projectId: input.projectId })
  return listActiveThreadTasks(database, {
    ...input,
    includeArchived: input.includeArchived ?? false,
  })
}

export function listWorkflowRuns(input: {
  readonly projectId?: string
  readonly includeArchived?: boolean
} = {}) {
  return listWorkflowRunsFromDb(getDb(), input)
}

export function getWorkflowRun(id: string) {
  return getWorkflowRunFromDb(getDb(), id)
}

export function getWorkflowItem(id: string) {
  return getWorkflowItemFromDb(getDb(), id)
}

export function addWorkflowRun(input: PersistWorkflowRunInput) {
  return insertWorkflowRun(getDb(), input)
}

export function recordWorkflowItemAttempt(input: {
  readonly itemId: string
  readonly agentId?: string | null
  readonly status: 'launched' | 'failed'
  readonly error?: string | null
}) {
  return recordWorkflowItemAttemptInDb(getDb(), input)
}

export function completeScratchpadWorkflowItem(itemId: string) {
  return completeScratchpadWorkflowItemInDb(getDb(), itemId)
}

export function setWorkflowItemTracking(itemId: string, tracked: boolean) {
  return setWorkflowItemTrackingInDb(getDb(), itemId, tracked)
}

export function archiveWorkflowRun(id: string) {
  return setWorkflowRunArchiveState(getDb(), id, true)
}

export function restoreWorkflowRun(id: string) {
  return setWorkflowRunArchiveState(getDb(), id, false)
}

export function startSessionAndGetId(input: InternalStartSessionInput) {
  return insertSession(input)
}

export function getAgentLaunchConfig(agentId: string) {
  return getAgentLaunchConfigFromDb(getDb(), agentId)
}

export function getAgentRuntimeState(agentId: string) {
  return getAgentRuntimeStateFromDb(getDb(), agentId)
}

export function isAgentArchived(agentId: string) {
  return isAgentArchivedInDb(getDb(), agentId)
}

export function setAgentRuntimeState(agentId: string, state: Record<string, unknown>) {
  setAgentRuntimeStateInDb(getDb(), agentId, state)
}

export function setAgentPendingQuestion(agentId: string, pendingQuestion: PendingQuestion | null) {
  setAgentPendingQuestionInDb(getDb(), agentId, pendingQuestion)
}

export function queueAgentTerminalInput(input: {
  readonly agentId: string
  readonly text: string
  readonly submit: boolean
}) {
  queueAgentTerminalInputInDb(getDb(), input.agentId, input)
}

export function takeAgentTerminalInputs(agentId: string) {
  return takeAgentTerminalInputsFromDb(getDb(), agentId)
}

export function requeueAgentTerminalInputs(
  agentId: string,
  inputs: ReturnType<typeof takeAgentTerminalInputsFromDb>,
) {
  requeueAgentTerminalInputsInDb(getDb(), agentId, inputs)
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

function runtimeSessionDir(runtime: string, projectId: string, slot: string) {
  return runtimeSessionDirPath(getKiriConfig(), runtime, projectId, slot)
}

function hydratePersistedPiSessions(database: DatabaseSync, agentId?: string) {
  const piSettings = getRuntimeSettings('pi')
  hydratePersistedPiSessionRows(database, {
    piSessionsDir: getKiriConfig().piSessionsDir,
    defaultModel: piSettings.defaultModel,
    onlyAgentId: agentId,
  })
}
