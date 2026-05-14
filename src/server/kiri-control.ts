import { Context, Effect, Layer, Schema } from 'effect'
import type {
  AddProjectInput,
  AddScratchpadBlockInput,
  AgentCell,
  ScratchpadBlock,
  RestoreSessionInput,
  RuntimeKind,
  SessionInterfaceMode,
  StartSessionInput,
  ThinkingLevel,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import { sessionInterfaceModeForRuntime } from '~/lib/contracts'
import {
  addScratchpadBlockSummary,
  addProjectSummary,
  deleteProjectSummary,
  deleteScratchpadBlockSummary,
  deleteSessionSummary,
  getScratchpadBlock,
  getWorkspaceSnapshot,
  hideProjectSummary,
  listScratchpadBlocks,
  listProjectSummaries,
  listSessionSummaries,
  markScratchpadBlockTriggered,
  renameSessionSummary,
  restoreSessionSummary,
  startSessionAndGetId,
  startSessionSummary,
  unhideProjectSummary,
} from './db'
import { promptAgent } from './runtime'
import { getSettings } from './settings'

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
}

export class KiriControl extends Context.Tag('@kiri/KiriControl')<
  KiriControl,
  KiriControlApi
>() {
  static readonly layer = Layer.sync(KiriControl, makeKiriControl)
}

function makeKiriControl(): KiriControlApi {
  const snapshot = Effect.fn('KiriControl.snapshot')(function* () {
    return yield* fromSync(getWorkspaceSnapshot)
  })

  const getContext = Effect.fn('KiriControl.getContext')(function* () {
    return yield* fromSync(() => contextFromSnapshot(getWorkspaceSnapshot()))
  })

  const listModels = Effect.fn('KiriControl.listModels')(function* (runtime?: RuntimeKind) {
    return yield* fromSync(() => {
      const settings = getSettings()
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

  const listProjects = Effect.fn('KiriControl.listProjects')(function* (includeHidden = false) {
    return yield* fromSync(() => listProjectSummaries(includeHidden))
  })

  const addProjectEffect = Effect.fn('KiriControl.addProject')(function* (input: AddProjectInput) {
    return yield* fromSync(() => addProjectSummary(input))
  })

  const hideProjectEffect = Effect.fn('KiriControl.hideProject')(function* (id: string) {
    return yield* fromSync(() => hideProjectSummary(id))
  })

  const unhideProjectEffect = Effect.fn('KiriControl.unhideProject')(function* (id: string) {
    return yield* fromSync(() => unhideProjectSummary(id))
  })

  const deleteProjectEffect = Effect.fn('KiriControl.deleteProject')(function* (id: string) {
    return yield* fromSync(() => deleteProjectSummary(id))
  })

  const listSessions = Effect.fn('KiriControl.listSessions')(
    function* (input: { readonly projectId?: string; readonly includeArchived?: boolean } = {}) {
      return yield* fromSync(() => listSessionSummaries(input))
    },
  )

  const startSessionEffect = Effect.fn('KiriControl.startSession')(function* (input: StartSessionInput) {
    return yield* fromSync(() => startSessionSummary(input))
  })

  const renameSessionEffect = Effect.fn('KiriControl.renameSession')(
    function* (input: { readonly agentId: string; readonly title: string }) {
      return yield* fromSync(() => renameSessionSummary(input))
    },
  )

  const deleteSessionEffect = Effect.fn('KiriControl.deleteSession')(function* (agentId: string) {
    return yield* fromSync(() => deleteSessionSummary({ agentId }))
  })

  const restoreSessionEffect = Effect.fn('KiriControl.restoreSession')(function* (input: RestoreSessionInput) {
    return yield* fromSync(() => restoreSessionSummary(input))
  })

  const listScratchpad = Effect.fn('KiriControl.listScratchpad')(
    function* (input: { readonly projectId?: string } = {}) {
      return yield* fromSync(() => listScratchpadBlocks(input))
    },
  )

  const addScratchpad = Effect.fn('KiriControl.addScratchpad')(function* (input: AddScratchpadBlockInput) {
    return yield* fromSync(() => addScratchpadBlockSummary(input))
  })

  const deleteScratchpad = Effect.fn('KiriControl.deleteScratchpad')(function* (id: string) {
    return yield* fromSync(() => deleteScratchpadBlockSummary(id))
  })

  const triggerScratchpad = Effect.fn('KiriControl.triggerScratchpad')(
    function* (input: TriggerScratchpadInput) {
      const block = yield* fromSync(() => {
        const found = getScratchpadBlock(input.id)
        if (!found) throw new Error(`Scratchpad block not found: ${input.id}`)
        return found
      })
      const runtime = input.runtime ?? 'pi'
      const interfaceMode = sessionInterfaceModeForRuntime(runtime, input.interfaceMode ?? 'gui')
      const agentId = yield* fromSync(() => startSessionAndGetId({
        projectId: input.projectId,
        runtime,
        interfaceMode,
        model: input.model,
        title: input.title,
        thinkingLevel: input.thinkingLevel ?? 'medium',
      }))
      if (interfaceMode !== 'terminal') {
        yield* Effect.tryPromise({
          try: () => promptAgent({ agentId, text: block.body, images: [] }),
          catch: normalizeError,
        }).pipe(Effect.catchAll((error) =>
          fromSync(() => deleteSessionSummary({ agentId })).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.zipRight(Effect.fail(error)),
          )))
      }
      yield* fromSync(() => markScratchpadBlockTriggered(input.id, agentId))
      const session = yield* fromSync(() => renameSafeSessionRead(agentId))
      return { agentId, session, block }
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

function renameSafeSessionRead(agentId: string) {
  const session = listSessionSummaries({ includeArchived: true })
    .find((candidate) => candidate.id === agentId)
  if (!session) throw new Error(`Session not found: ${agentId}`)
  return session
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
