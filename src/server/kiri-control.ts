import { Context, Effect, Layer, Schema } from 'effect'
import type {
  AddProjectInput,
  AddScratchpadBlockInput,
  AgentCell,
  AgentDetail,
  AgentEvent,
  AgentPromptInput,
  AgentStatus,
  AgentTask,
  AgentStatusSetInput,
  AgentTasksReplaceInput,
  CreateWorkflowRunInput,
  KiriSettings,
  KnowledgeAddInput,
  KnowledgeEntry,
  KnowledgeMarkSeenInput,
  KnowledgeSearchInput,
  ListAgentEventsInput,
  ListWorkflowRunsInput,
  ScratchpadBlock,
  RestoreSessionInput,
  RuntimeKind,
  SessionInterfaceMode,
  SpawnSessionInput,
  StartSessionInput,
  TerminalInput,
  TerminalKeysInput,
  TerminalReadInput,
  TerminalTarget,
  TerminalWaitForInput,
  ThinkingLevel,
  WorkflowAwaitInput,
  WorkflowItemOperationInput,
  WorkflowRunOperationInput,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import {
  addScratchpadBlockSummary,
  addProjectSummary,
  deleteScratchpadBlockSummary,
  getAgentDetail,
  getWorkspaceSnapshot,
  hideProjectSummary,
  listAgentEvents,
  addKnowledgeEntry,
  markKnowledgeEntrySeen,
  listScratchpadBlocks,
  listProjectSummaries,
  listSessionSummaries,
  replaceAgentTasks,
  renameSessionSummary,
  restoreSessionSummary,
  setAgentStatus,
  startSessionSummary,
  unhideProjectSummary,
  queueAgentTerminalInput,
  searchKnowledgeEntries,
  getAgentLaunchConfig,
} from './db'
import { promptAgent, steerAgent } from './runtime'
import {
  defaultRuntimeTurnAcceptanceWindowMs,
  detachAfterAcceptance,
} from './runtime-acceptance'
import { triggerScratchpadSession } from './scratchpad-trigger'
import { getSettings } from './settings'
import { pasteAgentRuntimeTerminal, terminalControlRequest } from './terminal-server'
import {
  archiveSessionSummaryWithRuntimeCleanup,
  deleteProjectSummaryWithRuntimeCleanup,
} from './runtime-cleanup'
import {
  archiveWorkflowRun as archiveWorkflowRunById,
  createWorkflowRun,
  dispatchWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  restoreWorkflowRun as restoreWorkflowRunById,
  retriggerWorkflowItem,
  trackWorkflowItem,
  untrackWorkflowItem,
  validateWorkflow,
} from './workflow-orchestration'

type ModelChoice = {
  readonly runtime: RuntimeKind
  readonly model: string
  readonly isDefault: boolean
  readonly contextWindow: number | null
}

type ProjectSummary = {
  readonly id: string
  readonly name: string
  readonly cwd: string
  readonly hidden: boolean
  readonly sessionCount: number
}

type SessionSummary = {
  readonly id: string
  readonly projectId: string
  readonly projectName: string
  readonly title: string
  readonly runtime: RuntimeKind
  readonly interfaceMode: SessionInterfaceMode
  readonly model: string
  readonly status: AgentCell['status']
  readonly preview: string
  readonly messageCount: number
  readonly updatedAt: string
  readonly archivedAt: string | null
}

type ControlContext = {
  readonly selectedProject: {
    readonly id: string
    readonly name: string
    readonly cwd: string
  } | null
  readonly selectedSession: SessionSummary | null
  readonly projects: readonly ProjectSummary[]
  readonly sessions: readonly SessionSummary[]
  readonly scratchpadCount: number
}

type TriggerScratchpadInput = {
  readonly id: string
  readonly projectId: string
  readonly runtime?: RuntimeKind
  readonly interfaceMode?: SessionInterfaceMode
  readonly model?: string
  readonly title?: string
  readonly thinkingLevel?: ThinkingLevel
}

type TriggerScratchpadResult = {
  readonly agentId: string
  readonly session: SessionSummary
  readonly block: ScratchpadBlock
}

class KiriControlError extends Schema.TaggedError<KiriControlError>()(
  'KiriControlError',
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

type ControlEffect<A> = Effect.Effect<A, KiriControlError>

export type KiriControlApi = {
  readonly snapshot: () => ControlEffect<WorkspaceSnapshot>
  readonly getContext: () => ControlEffect<ControlContext>
  readonly listModels: (runtime?: RuntimeKind) => ControlEffect<readonly ModelChoice[]>
  readonly listProjects: (includeHidden?: boolean) => ControlEffect<readonly ProjectSummary[]>
  readonly addProject: (input: AddProjectInput) => ControlEffect<ProjectSummary>
  readonly hideProject: (id: string) => ControlEffect<ProjectSummary>
  readonly unhideProject: (id: string) => ControlEffect<ProjectSummary>
  readonly deleteProject: (id: string) => ControlEffect<ProjectSummary>
  readonly listSessions: (input?: {
    readonly projectId?: string
    readonly includeArchived?: boolean
  }) => ControlEffect<readonly SessionSummary[]>
  readonly agentDetail: (input: { readonly agentId: string; readonly limit?: number; readonly offset?: number }) => ControlEffect<AgentDetail>
  readonly listAgentEvents: (input: ListAgentEventsInput) => ControlEffect<readonly AgentEvent[]>
  readonly startSession: (input: StartSessionInput) => ControlEffect<SessionSummary>
  readonly spawnSession: (input: SpawnSessionInput) => ControlEffect<{
    readonly session: SessionSummary
    readonly delivery:
      | {
        readonly kind: 'agentPrompt'
        readonly accepted: true
        readonly agentId: string
        readonly mode: 'prompt' | 'steer'
      }
      | {
        readonly kind: 'terminal'
        readonly accepted: true
        readonly agentId: string
        readonly queued: true
        readonly spawned: boolean
      }
  }>
  readonly renameSession: (input: {
    readonly agentId: string
    readonly title: string
  }) => ControlEffect<SessionSummary>
  readonly deleteSession: (agentId: string) => ControlEffect<SessionSummary>
  readonly restoreSession: (input: RestoreSessionInput) => ControlEffect<SessionSummary>
  readonly agentPrompt: (input: AgentPromptInput) => ControlEffect<{
    readonly accepted: true
    readonly agentId: string
    readonly mode: 'prompt' | 'steer'
  }>
  readonly setAgentStatus: (input: AgentStatusSetInput) => ControlEffect<{
    readonly agentId: string
    readonly status: AgentStatus
  }>
  readonly replaceAgentTasks: (input: AgentTasksReplaceInput) => ControlEffect<{
    readonly agentId: string
    readonly source: AgentTask['source']
    readonly tasks: readonly AgentTask[]
    readonly updatedAt?: string
  }>
  readonly terminalInput: (input: TerminalInput) => ControlEffect<{
    readonly accepted: true
    readonly agentId: string
    readonly queued: true
    readonly spawned: boolean
  }>
  readonly terminalRead: (input: TerminalReadInput) => ControlEffect<unknown>
  readonly terminalList: () => ControlEffect<unknown>
  readonly terminalKeys: (input: TerminalKeysInput) => ControlEffect<unknown>
  readonly terminalWaitFor: (input: TerminalWaitForInput) => ControlEffect<unknown>
  readonly terminalSpawn: (input: { readonly agentId: string }) => ControlEffect<{
    readonly agentId: string
    readonly mode: 'runtime'
  }>
  readonly terminalKill: (input: TerminalTarget) => ControlEffect<unknown>
  readonly listScratchpad: (input?: {
    readonly projectId?: string
  }) => ControlEffect<readonly ScratchpadBlock[]>
  readonly searchKnowledge: (input: KnowledgeSearchInput) => ControlEffect<readonly KnowledgeEntry[]>
  readonly addKnowledge: (input: KnowledgeAddInput) => ControlEffect<KnowledgeEntry>
  readonly markKnowledgeSeen: (input: KnowledgeMarkSeenInput) => ControlEffect<KnowledgeEntry>
  readonly addScratchpad: (input: AddScratchpadBlockInput) => ControlEffect<ScratchpadBlock>
  readonly deleteScratchpad: (id: string) => ControlEffect<ScratchpadBlock>
  readonly triggerScratchpad: (input: TriggerScratchpadInput) => ControlEffect<TriggerScratchpadResult>
  readonly listWorkflowRuns: (input?: ListWorkflowRunsInput) => ControlEffect<unknown>
  readonly getWorkflowRun: (id: string) => ControlEffect<unknown>
  readonly workflowAwait: (input: WorkflowAwaitInput) => ControlEffect<unknown>
  readonly validateWorkflow: (input: CreateWorkflowRunInput) => ControlEffect<unknown>
  readonly createWorkflowRun: (input: CreateWorkflowRunInput) => ControlEffect<unknown>
  readonly dispatchWorkflowRun: (input: WorkflowRunOperationInput) => ControlEffect<unknown>
  readonly retriggerWorkflowItem: (input: WorkflowItemOperationInput) => ControlEffect<unknown>
  readonly trackWorkflowItem: (input: Pick<WorkflowItemOperationInput, 'itemId'>) => ControlEffect<unknown>
  readonly untrackWorkflowItem: (input: Pick<WorkflowItemOperationInput, 'itemId'>) => ControlEffect<unknown>
  readonly archiveWorkflowRun: (input: WorkflowRunOperationInput) => ControlEffect<unknown>
  readonly restoreWorkflowRun: (input: WorkflowRunOperationInput) => ControlEffect<unknown>
}

export class KiriControl extends Context.Tag('@kiri/KiriControl')<
  KiriControl,
  KiriControlApi
>() {
  static readonly layer = Layer.sync(KiriControl, () => makeKiriControl(liveKiriControlDependencies))
}

export type KiriControlDependencies = {
  readonly getWorkspaceSnapshot: () => WorkspaceSnapshot
  readonly getSettings: () => KiriSettings
  readonly listProjectSummaries: (includeHidden?: boolean) => readonly ProjectSummary[]
  readonly addProjectSummary: (input: AddProjectInput) => ProjectSummary
  readonly hideProjectSummary: (id: string) => ProjectSummary
  readonly unhideProjectSummary: (id: string) => ProjectSummary
  readonly deleteProjectSummary: (id: string) => ProjectSummary
  readonly listSessionSummaries: (input?: {
    readonly projectId?: string
    readonly includeArchived?: boolean
  }) => readonly SessionSummary[]
  readonly getAgentDetail: (input: { readonly agentId: string; readonly limit?: number; readonly offset?: number }) => AgentDetail
  readonly listAgentEvents: (input: ListAgentEventsInput) => readonly AgentEvent[]
  readonly startSessionSummary: (input: StartSessionInput) => SessionSummary
  readonly renameSessionSummary: (input: {
    readonly agentId: string
    readonly title: string
  }) => SessionSummary
  readonly archiveSessionSummary: (input: { readonly agentId: string }) => SessionSummary
  readonly restoreSessionSummary: (input: RestoreSessionInput) => SessionSummary
  readonly promptAgent: typeof promptAgent
  readonly steerAgent: typeof steerAgent
  readonly setAgentStatus: typeof setAgentStatus
  readonly replaceAgentTasks: typeof replaceAgentTasks
  // How long agent.prompt waits for validation rejections before detaching
  // from the turn; the turn itself keeps running in the background.
  readonly agentPromptAcceptanceWindowMs?: number
  readonly queueAgentTerminalInput: typeof queueAgentTerminalInput
  readonly pasteAgentRuntimeTerminal: typeof pasteAgentRuntimeTerminal
  readonly getAgentLaunchConfig: typeof getAgentLaunchConfig
  readonly terminalControlRequest: typeof terminalControlRequest
  // The agent identity of this control-plane process (KIRI_AGENT_ID for MCP
  // servers spawned inside an agent's session); wake delivery defaults here.
  readonly callerAgentId: () => string | null
  readonly listScratchpadBlocks: (input?: {
    readonly projectId?: string
  }) => readonly ScratchpadBlock[]
  readonly searchKnowledgeEntries: (input: KnowledgeSearchInput & { readonly projectId: string }) => readonly KnowledgeEntry[]
  readonly addKnowledgeEntry: (input: KnowledgeAddInput & { readonly projectId: string }) => KnowledgeEntry
  readonly markKnowledgeEntrySeen: (input: KnowledgeMarkSeenInput) => KnowledgeEntry
  readonly addScratchpadBlockSummary: (input: AddScratchpadBlockInput) => ScratchpadBlock
  readonly deleteScratchpadBlockSummary: (id: string) => ScratchpadBlock
  readonly triggerScratchpadSession: (input: TriggerScratchpadInput) => Promise<TriggerScratchpadResult>
  readonly listWorkflowRuns: (input?: ListWorkflowRunsInput) => unknown
  readonly getWorkflowRun: (id: string) => unknown
  readonly validateWorkflow: (input: CreateWorkflowRunInput) => unknown
  readonly createWorkflowRun: (input: CreateWorkflowRunInput) => unknown
  readonly dispatchWorkflowRun: (input: WorkflowRunOperationInput) => Promise<unknown>
  readonly retriggerWorkflowItem: (input: WorkflowItemOperationInput) => Promise<unknown>
  readonly trackWorkflowItem: (input: Pick<WorkflowItemOperationInput, 'itemId'>) => unknown
  readonly untrackWorkflowItem: (input: Pick<WorkflowItemOperationInput, 'itemId'>) => unknown
  readonly archiveWorkflowRun: (input: WorkflowRunOperationInput) => unknown
  readonly restoreWorkflowRun: (input: WorkflowRunOperationInput) => unknown
}

const liveKiriControlDependencies: KiriControlDependencies = {
  getWorkspaceSnapshot,
  getSettings,
  listProjectSummaries,
  addProjectSummary,
  hideProjectSummary,
  unhideProjectSummary,
  deleteProjectSummary: deleteProjectSummaryWithRuntimeCleanup,
  listSessionSummaries,
  getAgentDetail,
  listAgentEvents,
  startSessionSummary,
  renameSessionSummary,
  archiveSessionSummary: archiveSessionSummaryWithRuntimeCleanup,
  restoreSessionSummary,
  promptAgent,
  steerAgent,
  setAgentStatus,
  replaceAgentTasks,
  queueAgentTerminalInput,
  pasteAgentRuntimeTerminal,
  getAgentLaunchConfig,
  terminalControlRequest,
  callerAgentId: () => process.env.KIRI_AGENT_ID?.trim() || null,
  listScratchpadBlocks,
  searchKnowledgeEntries,
  addKnowledgeEntry,
  markKnowledgeEntrySeen,
  addScratchpadBlockSummary,
  deleteScratchpadBlockSummary,
  triggerScratchpadSession,
  listWorkflowRuns,
  getWorkflowRun,
  validateWorkflow,
  createWorkflowRun,
  dispatchWorkflowRun,
  retriggerWorkflowItem,
  trackWorkflowItem,
  untrackWorkflowItem,
  archiveWorkflowRun: (input) => archiveWorkflowRunById(input.id),
  restoreWorkflowRun: (input) => restoreWorkflowRunById(input.id),
}

export function makeKiriControl(
  dependencies: KiriControlDependencies = liveKiriControlDependencies,
): KiriControlApi {
  const snapshot = Effect.fn('KiriControl.snapshot')(function* () {
    return yield* fromSync(dependencies.getWorkspaceSnapshot)
  })

  const getContext = Effect.fn('KiriControl.getContext')(function* () {
    return yield* fromSync(() => contextFromSnapshot(dependencies.getWorkspaceSnapshot()))
  })

  const listModels = Effect.fn('KiriControl.listModels')(function* (runtime?: RuntimeKind) {
    return yield* fromSync(() => {
      const settings = dependencies.getSettings()
      const runtimes = runtime ? [runtime] : (Object.keys(settings.runtimes) as RuntimeKind[])
      return runtimes.flatMap((runtimeName) => {
        const runtimeSettings = settings.runtimes[runtimeName]
        return runtimeSettings.models.map((model) => ({
          runtime: runtimeName,
          model,
          isDefault: model === runtimeSettings.defaultModel,
          contextWindow: runtimeSettings.contextWindows?.[model] ?? null,
        }))
      })
    })
  })

  const listProjects = Effect.fn('KiriControl.listProjects')(function* (includeHidden: boolean = false) {
    return yield* fromSync(() => dependencies.listProjectSummaries(includeHidden))
  })

  const addProjectEffect = Effect.fn('KiriControl.addProject')(function* (input: AddProjectInput) {
    return yield* fromSync(() => dependencies.addProjectSummary(input))
  })

  const hideProjectEffect = Effect.fn('KiriControl.hideProject')(function* (id: string) {
    return yield* fromSync(() => dependencies.hideProjectSummary(id))
  })

  const unhideProjectEffect = Effect.fn('KiriControl.unhideProject')(function* (id: string) {
    return yield* fromSync(() => dependencies.unhideProjectSummary(id))
  })

  const deleteProjectEffect = Effect.fn('KiriControl.deleteProject')(function* (id: string) {
    return yield* fromSync(() => dependencies.deleteProjectSummary(id))
  })

  const listSessions = Effect.fn('KiriControl.listSessions')(
    function* (input: { readonly projectId?: string; readonly includeArchived?: boolean } = {}) {
      return yield* fromSync(() => dependencies.listSessionSummaries(input))
    },
  )

  const agentDetailEffect = Effect.fn('KiriControl.agentDetail')(
    function* (input: { readonly agentId: string; readonly limit?: number; readonly offset?: number }) {
      return yield* fromSync(() => dependencies.getAgentDetail(input))
    },
  )

  const listAgentEventsEffect = Effect.fn('KiriControl.listAgentEvents')(
    function* (input: ListAgentEventsInput) {
      return yield* fromSync(() => dependencies.listAgentEvents(input))
    },
  )

  const startSessionEffect = Effect.fn('KiriControl.startSession')(function* (input: StartSessionInput) {
    return yield* fromSync(() => dependencies.startSessionSummary(input))
  })

  const renameSessionEffect = Effect.fn('KiriControl.renameSession')(
    function* (input: { readonly agentId: string; readonly title: string }) {
      return yield* fromSync(() => dependencies.renameSessionSummary(input))
    },
  )

  const archiveSessionEffect = Effect.fn('KiriControl.deleteSession')(function* (agentId: string) {
    return yield* fromSync(() => dependencies.archiveSessionSummary({ agentId }))
  })

  const restoreSessionEffect = Effect.fn('KiriControl.restoreSession')(function* (input: RestoreSessionInput) {
    return yield* fromSync(() => dependencies.restoreSessionSummary(input))
  })

  const agentPromptEffect = Effect.fn('KiriControl.agentPrompt')(
    function* (input: AgentPromptInput) {
      // promptAgent resolves only when the full model turn completes, but this
      // surface promises acceptance — holding the response open for the whole
      // turn makes control clients time out on every real prompt.
      yield* Effect.tryPromise({
        try: () => detachAfterAcceptance(
          input.mode === 'steer' ? dependencies.steerAgent(input) : dependencies.promptAgent(input),
          dependencies.agentPromptAcceptanceWindowMs ?? defaultRuntimeTurnAcceptanceWindowMs,
        ),
        catch: normalizeError,
      })
      return {
        accepted: true as const,
        agentId: input.agentId,
        mode: input.mode,
      }
    },
  )

  const spawnSessionEffect = Effect.fn('KiriControl.spawnSession')(
    function* (input: SpawnSessionInput) {
      const session = yield* startSessionEffect(input)
      if (session.interfaceMode === 'terminal') {
        const delivery = yield* terminalInputEffect({
          agentId: session.id,
          text: input.text,
          submit: input.terminalSubmit ?? true,
          spawn: input.terminalSpawn ?? true,
        })
        return {
          session,
          delivery: {
            kind: 'terminal' as const,
            ...delivery,
          },
        }
      }

      const delivery = yield* agentPromptEffect({
        agentId: session.id,
        text: input.text,
        images: input.images ?? [],
        mode: input.mode ?? 'prompt',
      })
      return {
        session,
        delivery: {
          kind: 'agentPrompt' as const,
          ...delivery,
        },
      }
    },
  )

  const setAgentStatusEffect = Effect.fn('KiriControl.setAgentStatus')(
    function* (input: AgentStatusSetInput) {
      yield* fromSync(() => dependencies.setAgentStatus(input.agentId, input.status))
      return {
        agentId: input.agentId,
        status: input.status,
      }
    },
  )

  const replaceAgentTasksEffect = Effect.fn('KiriControl.replaceAgentTasks')(
    function* (input: AgentTasksReplaceInput) {
      yield* fromSync(() => dependencies.replaceAgentTasks(input))
      return {
        agentId: input.agentId,
        source: input.source,
        tasks: input.tasks,
        ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
      }
    },
  )

  const terminalInputEffect = Effect.fn('KiriControl.terminalInput')(
    function* (input: TerminalInput) {
      let spawned = false
      yield* fromSync(() =>
        dependencies.queueAgentTerminalInput({
          agentId: input.agentId,
          text: input.text,
          submit: input.submit,
        }))
      if (input.spawn) {
        const result = yield* Effect.either(Effect.tryPromise({
          try: () => dependencies.pasteAgentRuntimeTerminal({ agentId: input.agentId }),
          catch: normalizeError,
        }))
        spawned = result._tag === 'Right'
      }
      return {
        accepted: true as const,
        agentId: input.agentId,
        queued: true as const,
        spawned,
      }
    },
  )

  // Shell terminals are intentionally project-scoped: any session in the
  // project shares and can control the same shell PTY.
  const terminalSessionKey = (target: TerminalTarget) =>
    target.mode === 'runtime'
      ? `${target.agentId}:runtime`
      : `${dependencies.getAgentLaunchConfig(target.agentId).projectId}:shell`

  const terminalReadEffect = Effect.fn('KiriControl.terminalRead')(
    function* (input: TerminalReadInput) {
      const key = yield* fromSync(() => terminalSessionKey(input))
      return yield* Effect.tryPromise({
        try: () => dependencies.terminalControlRequest('sessions/read', {
          key,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        }),
        catch: normalizeError,
      })
    },
  )

  const terminalListEffect = Effect.fn('KiriControl.terminalList')(function* () {
    return yield* Effect.tryPromise({
      try: () => dependencies.terminalControlRequest('sessions'),
      catch: normalizeError,
    })
  })

  const terminalKeysEffect = Effect.fn('KiriControl.terminalKeys')(
    function* (input: TerminalKeysInput) {
      const key = yield* fromSync(() => terminalSessionKey(input))
      return yield* Effect.tryPromise({
        try: () => dependencies.terminalControlRequest('sessions/input', {
          key,
          ...(input.text !== undefined ? { data: input.text } : {}),
          ...(input.keys.length > 0 ? { keys: input.keys } : {}),
        }),
        catch: normalizeError,
      })
    },
  )

  const terminalWaitForEffect = Effect.fn('KiriControl.terminalWaitFor')(
    function* (input: TerminalWaitForInput) {
      const key = yield* fromSync(() => terminalSessionKey(input))
      return yield* Effect.tryPromise({
        try: () => dependencies.terminalControlRequest('sessions/wait-for', {
          key,
          pattern: input.pattern,
          flags: input.flags,
          timeoutMs: input.timeoutMs,
          scope: input.scope,
          followReplacement: input.followReplacement ?? true,
        }),
        catch: normalizeError,
      })
    },
  )

  const terminalSpawnEffect = Effect.fn('KiriControl.terminalSpawn')(
    function* (input: { readonly agentId: string }) {
      return yield* Effect.tryPromise({
        try: () => dependencies.pasteAgentRuntimeTerminal({ agentId: input.agentId }),
        catch: normalizeError,
      })
    },
  )

  // One condition engine, two delivery modes. deliver:'return' blocks until
  // workers match (regex and/or idle) and resolves with the result;
  // deliver:'wake' registers a subscription with the session owner and
  // returns immediately — the result is later typed into the receiving
  // agent's terminal as a fresh user turn, so orchestrators wait for free.
  const workflowAwaitEffect = Effect.fn('KiriControl.workflowAwait')(
    function* (input: WorkflowAwaitInput) {
      const run = yield* fromSync(() => dependencies.getWorkflowRun(input.id))
      const agents = workflowActiveAgents(run)
      if (agents.length === 0) {
        return {
          matched: false,
          subscribed: false,
          reason: 'no_active_agents',
          matches: [],
          agents: 0,
        }
      }
      const targets = agents.map((agent) => ({
        key: `${agent.agentId}:runtime`,
        label: agent.title || agent.agentId,
        ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
        flags: input.flags,
        scope: input.scope,
        // A wake with no condition is a pure timer: idle over the timeout
        // window keeps the target schema satisfied while the timeout drives
        // the wake.
        ...(input.idleMs !== undefined
          ? { idleMs: input.idleMs }
          : input.pattern === undefined
            ? { idleMs: Math.min(input.timeoutMs, 600_000) }
            : {}),
      }))

      if (input.deliver === 'wake') {
        const deliverAgentId = input.deliverTo ?? dependencies.callerAgentId()
        if (!deliverAgentId) {
          return yield* normalizeError(new Error(
            'deliver:"wake" needs deliverTo (no KIRI_AGENT_ID in this environment)',
          ))
        }
        const payload = yield* Effect.tryPromise({
          try: () => dependencies.terminalControlRequest('sessions/subscribe', {
            targets,
            timeoutMs: input.timeoutMs,
            quorum: input.quorum,
            deliver: {
              agentId: deliverAgentId,
              ...(input.note === undefined ? {} : { note: input.note }),
              title: workflowTitle(run) ?? input.id,
            },
          }),
          catch: normalizeError,
        })
        return {
          subscribed: true,
          deliverTo: deliverAgentId,
          agents: agents.length,
          ...(typeof payload === 'object' && payload !== null && 'id' in payload
            ? { subscriptionId: payload.id }
            : {}),
        }
      }

      const payload = yield* Effect.tryPromise({
        try: () => dependencies.terminalControlRequest('sessions/wait-any', {
          targets,
          timeoutMs: input.timeoutMs,
          quorum: input.quorum,
        }),
        catch: normalizeError,
      })
      return resolveWorkflowAwaitPayload(payload, agents)
    },
  )

  const terminalKillEffect = Effect.fn('KiriControl.terminalKill')(
    function* (input: TerminalTarget) {
      const key = yield* fromSync(() => terminalSessionKey(input))
      return yield* Effect.tryPromise({
        try: () => dependencies.terminalControlRequest('sessions/kill', { key }),
        catch: normalizeError,
      })
    },
  )

  const listScratchpad = Effect.fn('KiriControl.listScratchpad')(
    function* (input: { readonly projectId?: string } = {}) {
      return yield* fromSync(() => dependencies.listScratchpadBlocks(input))
    },
  )

  const searchKnowledge = Effect.fn('KiriControl.searchKnowledge')(
    function* (input: KnowledgeSearchInput) {
      return yield* fromSync(() =>
        dependencies.searchKnowledgeEntries({
          ...input,
          projectId: resolveProjectId(input.projectId, dependencies),
        }))
    },
  )

  const addKnowledge = Effect.fn('KiriControl.addKnowledge')(
    function* (input: KnowledgeAddInput) {
      return yield* fromSync(() =>
        dependencies.addKnowledgeEntry({
          ...input,
          projectId: resolveProjectId(input.projectId, dependencies),
        }))
    },
  )

  const markKnowledgeSeen = Effect.fn('KiriControl.markKnowledgeSeen')(
    function* (input: KnowledgeMarkSeenInput) {
      return yield* fromSync(() => dependencies.markKnowledgeEntrySeen(input))
    },
  )

  const addScratchpad = Effect.fn('KiriControl.addScratchpad')(function* (input: AddScratchpadBlockInput) {
    return yield* fromSync(() => dependencies.addScratchpadBlockSummary(input))
  })

  const deleteScratchpad = Effect.fn('KiriControl.deleteScratchpad')(function* (id: string) {
    return yield* fromSync(() => dependencies.deleteScratchpadBlockSummary(id))
  })

  const triggerScratchpad = Effect.fn('KiriControl.triggerScratchpad')(
    function* (input: TriggerScratchpadInput) {
      return yield* Effect.tryPromise({
        try: () => dependencies.triggerScratchpadSession(input),
        catch: normalizeError,
      })
    },
  )

  const listWorkflowRunsEffect = Effect.fn('KiriControl.listWorkflowRuns')(
    function* (input: ListWorkflowRunsInput = { includeArchived: false }) {
      return yield* fromSync(() => dependencies.listWorkflowRuns(input))
    },
  )

  const getWorkflowRunEffect = Effect.fn('KiriControl.getWorkflowRun')(function* (id: string) {
    return yield* fromSync(() => dependencies.getWorkflowRun(id))
  })

  const validateWorkflowEffect = Effect.fn('KiriControl.validateWorkflow')(
    function* (input: CreateWorkflowRunInput) {
      return yield* fromSync(() => dependencies.validateWorkflow(input))
    },
  )

  const createWorkflowRunEffect = Effect.fn('KiriControl.createWorkflowRun')(
    function* (input: CreateWorkflowRunInput) {
      return yield* fromSync(() => dependencies.createWorkflowRun(input))
    },
  )

  const dispatchWorkflowRunEffect = Effect.fn('KiriControl.dispatchWorkflowRun')(
    function* (input: WorkflowRunOperationInput) {
      return yield* fromMaybePromise(() => dependencies.dispatchWorkflowRun(input))
    },
  )

  const retriggerWorkflowItemEffect = Effect.fn('KiriControl.retriggerWorkflowItem')(
    function* (input: WorkflowItemOperationInput) {
      return yield* fromMaybePromise(() => dependencies.retriggerWorkflowItem(input))
    },
  )

  const trackWorkflowItemEffect = Effect.fn('KiriControl.trackWorkflowItem')(
    function* (input: Pick<WorkflowItemOperationInput, 'itemId'>) {
      return yield* fromSync(() => dependencies.trackWorkflowItem(input))
    },
  )

  const untrackWorkflowItemEffect = Effect.fn('KiriControl.untrackWorkflowItem')(
    function* (input: Pick<WorkflowItemOperationInput, 'itemId'>) {
      return yield* fromSync(() => dependencies.untrackWorkflowItem(input))
    },
  )

  const archiveWorkflowRunEffect = Effect.fn('KiriControl.archiveWorkflowRun')(
    function* (input: WorkflowRunOperationInput) {
      return yield* fromSync(() => dependencies.archiveWorkflowRun(input))
    },
  )

  const restoreWorkflowRunEffect = Effect.fn('KiriControl.restoreWorkflowRun')(
    function* (input: WorkflowRunOperationInput) {
      return yield* fromSync(() => dependencies.restoreWorkflowRun(input))
    },
  )

  return {
    snapshot,
    getContext,
    listModels,
    listProjects,
    addProject: addProjectEffect,
    hideProject: hideProjectEffect,
    unhideProject: unhideProjectEffect,
    deleteProject: deleteProjectEffect,
    listSessions,
    agentDetail: agentDetailEffect,
    listAgentEvents: listAgentEventsEffect,
    startSession: startSessionEffect,
    spawnSession: spawnSessionEffect,
    renameSession: renameSessionEffect,
    deleteSession: archiveSessionEffect,
    restoreSession: restoreSessionEffect,
    agentPrompt: agentPromptEffect,
    setAgentStatus: setAgentStatusEffect,
    replaceAgentTasks: replaceAgentTasksEffect,
    terminalInput: terminalInputEffect,
    terminalRead: terminalReadEffect,
    terminalList: terminalListEffect,
    terminalKeys: terminalKeysEffect,
    terminalWaitFor: terminalWaitForEffect,
    terminalSpawn: terminalSpawnEffect,
    terminalKill: terminalKillEffect,
    workflowAwait: workflowAwaitEffect,
    listScratchpad,
    searchKnowledge,
    addKnowledge,
    markKnowledgeSeen,
    addScratchpad,
    deleteScratchpad,
    triggerScratchpad,
    listWorkflowRuns: listWorkflowRunsEffect,
    getWorkflowRun: getWorkflowRunEffect,
    validateWorkflow: validateWorkflowEffect,
    createWorkflowRun: createWorkflowRunEffect,
    dispatchWorkflowRun: dispatchWorkflowRunEffect,
    retriggerWorkflowItem: retriggerWorkflowItemEffect,
    trackWorkflowItem: trackWorkflowItemEffect,
    untrackWorkflowItem: untrackWorkflowItemEffect,
    archiveWorkflowRun: archiveWorkflowRunEffect,
    restoreWorkflowRun: restoreWorkflowRunEffect,
  }
}

function contextFromSnapshot(snapshot: WorkspaceSnapshot): ControlContext {
  const selectedProject =
    snapshot.projects.find((project) => project.id === snapshot.selected.projectId) ??
    snapshot.projects[0] ??
    null
  const selectedAgent =
    selectedProject?.agents.find((agent) => agent.id === snapshot.selected.agentId) ??
    selectedProject?.agents[0] ??
    null
  const projects = [
    ...snapshot.projects.map((project) => ({
      id: project.id,
      name: project.name,
      cwd: project.cwd,
      hidden: false,
      sessionCount: project.agents.length,
    })),
    ...snapshot.hiddenProjects.map((project) => ({
      id: project.id,
      name: project.name,
      cwd: project.cwd,
      hidden: true,
      sessionCount: project.agents.length,
    })),
  ]
  const sessions = snapshot.projects.flatMap((project) =>
    project.agents
      .filter((agent) => agent.isSession)
      .map((agent) => sessionSummaryFromAgent(project, agent, null)),
  )
  return {
    selectedProject: selectedProject
      ? { id: selectedProject.id, name: selectedProject.name, cwd: selectedProject.cwd }
      : null,
    selectedSession: selectedProject && selectedAgent
      ? sessionSummaryFromAgent(selectedProject, selectedAgent, null)
      : null,
    projects,
    sessions,
    scratchpadCount: snapshot.scratchpadBlocks.length,
  }
}

function resolveProjectId(projectId: string | undefined, dependencies: KiriControlDependencies) {
  const explicit = projectId?.trim()
  if (explicit) return explicit
  const snapshot = dependencies.getWorkspaceSnapshot()
  const selectedProject =
    snapshot.projects.find((project) => project.id === snapshot.selected.projectId) ??
    snapshot.projects[0]
  if (!selectedProject) throw new Error('Project id is required')
  return selectedProject.id
}

function sessionSummaryFromAgent(
  project: WorkspaceSnapshot['projects'][number],
  agent: WorkspaceSnapshot['projects'][number]['agents'][number],
  archivedAt: string | null,
): SessionSummary {
  return {
    id: agent.id,
    projectId: project.id,
    projectName: project.name,
    title: agent.title,
    runtime: agent.runtime,
    interfaceMode: agent.interfaceMode,
    model: agent.model,
    status: agent.status,
    preview: agent.preview,
    messageCount: agent.messageCount,
    updatedAt: agent.updatedAt,
    archivedAt,
  }
}

function fromSync<A>(evaluate: () => A) {
  return Effect.try({
    try: evaluate,
    catch: normalizeError,
  })
}

function fromMaybePromise<A>(evaluate: () => A | Promise<A>) {
  return Effect.tryPromise({
    try: async () => evaluate(),
    catch: normalizeError,
  })
}

function normalizeError(error: unknown) {
  return new KiriControlError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  })
}

type WorkflowAwaitAgent = {
  readonly agentId: string
  readonly itemId: string
  readonly title: string
}

function workflowTitle(run: unknown): string | null {
  if (run && typeof run === 'object' && 'title' in run && typeof run.title === 'string') {
    return run.title
  }
  return null
}

function workflowActiveAgents(run: unknown): WorkflowAwaitAgent[] {
  const source = recordValue(run)
  const items = source && Array.isArray(source.items) ? source.items : []
  const agents: WorkflowAwaitAgent[] = []
  for (const value of items) {
    const item = recordValue(value)
    if (!item) continue
    const agentId = stringField(item, 'activeAgentId')
    if (!agentId) continue
    agents.push({
      agentId,
      itemId: stringField(item, 'id') ?? '',
      title: stringField(item, 'title') ?? '',
    })
  }
  return agents
}

function resolveWorkflowAwaitPayload(payload: unknown, agents: readonly WorkflowAwaitAgent[]) {
  const byKey = new Map(agents.map((agent) => [`${agent.agentId}:runtime`, agent]))
  let matched = false
  let elapsedMs: number | undefined
  const matches: Array<WorkflowAwaitAgent & { match: string; idle: boolean; tail: string[] }> = []
  const missing: string[] = []
  const source = recordValue(payload)
  if (source) {
    if (typeof source.matched === 'boolean') matched = source.matched
    if (typeof source.elapsedMs === 'number') elapsedMs = source.elapsedMs
    if (Array.isArray(source.matches)) {
      for (const value of source.matches) {
        const candidate = recordValue(value)
        if (!candidate) continue
        const key = stringField(candidate, 'key')
        const agent = key ? byKey.get(key) : undefined
        if (!agent) continue
        matches.push({
          ...agent,
          match: stringField(candidate, 'match') ?? '',
          idle: candidate.idle === true,
          tail: Array.isArray(candidate.tail)
            ? candidate.tail.filter((line: unknown): line is string => typeof line === 'string')
            : [],
        })
      }
    }
    if (Array.isArray(source.missing)) {
      for (const key of source.missing) {
        if (typeof key !== 'string') continue
        missing.push(byKey.get(key)?.agentId ?? key)
      }
    }
  }
  return {
    matched,
    matches,
    missing,
    agents: agents.length,
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(value: Record<string, unknown>, field: string) {
  const candidate = value[field]
  return typeof candidate === 'string' ? candidate : undefined
}
