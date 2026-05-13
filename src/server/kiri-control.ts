import { Context, Effect, Layer, Schema } from 'effect'
import type {
  AddProjectInput,
  AgentCell,
  RestoreSessionInput,
  RuntimeKind,
  StartSessionInput,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import {
  addProjectSummary,
  deleteProjectSummary,
  deleteSessionSummary,
  getWorkspaceSnapshot,
  hideProjectSummary,
  listProjectSummaries,
  listSessionSummaries,
  renameSessionSummary,
  restoreSessionSummary,
  startSessionSummary,
  unhideProjectSummary,
} from './db'
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
  readonly model: string
  readonly status: AgentCell['status']
  readonly preview: string
  readonly messageCount: number
  readonly updatedAt: string
  readonly archivedAt: string | null
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

  return {
    snapshot,
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
