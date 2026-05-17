import { Context, Effect, Layer, Schema } from 'effect'
import type {
  AddProjectInput,
  AddScratchpadBlockInput,
  AgentCell,
  CreateWorkflowRunInput,
  KiriSettings,
  ListWorkflowRunsInput,
  ScratchpadBlock,
  RestoreSessionInput,
  RuntimeKind,
  SessionInterfaceMode,
  StartSessionInput,
  ThinkingLevel,
  WorkflowItemOperationInput,
  WorkflowRunOperationInput,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import {
  addScratchpadBlockSummary,
  addProjectSummary,
  deleteScratchpadBlockSummary,
  getWorkspaceSnapshot,
  hideProjectSummary,
  listScratchpadBlocks,
  listProjectSummaries,
  listSessionSummaries,
  renameSessionSummary,
  restoreSessionSummary,
  startSessionSummary,
  unhideProjectSummary,
} from './db'
import { triggerScratchpadSession } from './scratchpad-trigger'
import { getSettings } from './settings'
import {
  deleteProjectSummaryWithRuntimeCleanup,
  deleteSessionSummaryWithRuntimeCleanup,
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
  readonly startSession: (input: StartSessionInput) => ControlEffect<SessionSummary>
  readonly renameSession: (input: {
    readonly agentId: string
    readonly title: string
  }) => ControlEffect<SessionSummary>
  readonly deleteSession: (agentId: string) => ControlEffect<SessionSummary>
  readonly restoreSession: (input: RestoreSessionInput) => ControlEffect<SessionSummary>
  readonly listScratchpad: (input?: {
    readonly projectId?: string
  }) => ControlEffect<readonly ScratchpadBlock[]>
  readonly addScratchpad: (input: AddScratchpadBlockInput) => ControlEffect<ScratchpadBlock>
  readonly deleteScratchpad: (id: string) => ControlEffect<ScratchpadBlock>
  readonly triggerScratchpad: (input: TriggerScratchpadInput) => ControlEffect<TriggerScratchpadResult>
  readonly listWorkflowRuns: (input?: ListWorkflowRunsInput) => ControlEffect<unknown>
  readonly getWorkflowRun: (id: string) => ControlEffect<unknown>
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
  readonly startSessionSummary: (input: StartSessionInput) => SessionSummary
  readonly renameSessionSummary: (input: {
    readonly agentId: string
    readonly title: string
  }) => SessionSummary
  readonly deleteSessionSummary: (input: { readonly agentId: string }) => SessionSummary
  readonly restoreSessionSummary: (input: RestoreSessionInput) => SessionSummary
  readonly listScratchpadBlocks: (input?: {
    readonly projectId?: string
  }) => readonly ScratchpadBlock[]
  readonly addScratchpadBlockSummary: (input: AddScratchpadBlockInput) => ScratchpadBlock
  readonly deleteScratchpadBlockSummary: (id: string) => ScratchpadBlock
  readonly triggerScratchpadSession: (input: TriggerScratchpadInput) => Promise<TriggerScratchpadResult>
  readonly listWorkflowRuns: (input?: ListWorkflowRunsInput) => unknown
  readonly getWorkflowRun: (id: string) => unknown
  readonly validateWorkflow: (input: CreateWorkflowRunInput) => unknown
  readonly createWorkflowRun: (input: CreateWorkflowRunInput) => unknown
  readonly dispatchWorkflowRun: (input: WorkflowRunOperationInput) => unknown
  readonly retriggerWorkflowItem: (input: WorkflowItemOperationInput) => unknown
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
  startSessionSummary,
  renameSessionSummary,
  deleteSessionSummary: deleteSessionSummaryWithRuntimeCleanup,
  restoreSessionSummary,
  listScratchpadBlocks,
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

  const startSessionEffect = Effect.fn('KiriControl.startSession')(function* (input: StartSessionInput) {
    return yield* fromSync(() => dependencies.startSessionSummary(input))
  })

  const renameSessionEffect = Effect.fn('KiriControl.renameSession')(
    function* (input: { readonly agentId: string; readonly title: string }) {
      return yield* fromSync(() => dependencies.renameSessionSummary(input))
    },
  )

  const deleteSessionEffect = Effect.fn('KiriControl.deleteSession')(function* (agentId: string) {
    return yield* fromSync(() => dependencies.deleteSessionSummary({ agentId }))
  })

  const restoreSessionEffect = Effect.fn('KiriControl.restoreSession')(function* (input: RestoreSessionInput) {
    return yield* fromSync(() => dependencies.restoreSessionSummary(input))
  })

  const listScratchpad = Effect.fn('KiriControl.listScratchpad')(
    function* (input: { readonly projectId?: string } = {}) {
      return yield* fromSync(() => dependencies.listScratchpadBlocks(input))
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
      return yield* fromSync(() => dependencies.dispatchWorkflowRun(input))
    },
  )

  const retriggerWorkflowItemEffect = Effect.fn('KiriControl.retriggerWorkflowItem')(
    function* (input: WorkflowItemOperationInput) {
      return yield* fromSync(() => dependencies.retriggerWorkflowItem(input))
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
    startSession: startSessionEffect,
    renameSession: renameSessionEffect,
    deleteSession: deleteSessionEffect,
    restoreSession: restoreSessionEffect,
    listScratchpad,
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

function normalizeError(error: unknown) {
  return new KiriControlError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  })
}
