import { Context, Data, Effect, Either, Layer } from 'effect'
import type { z } from 'zod'
import type {
  AddProjectInput,
  AddScratchpadBlockInput,
  AgentDetail,
  AnswerQuestionInput,
  DeleteSessionInput,
  ReorderProjectsInput,
  RestoreSessionInput,
  StartSessionInput,
  TerminalConfig,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import {
  agentDetailInputSchema,
  deleteProjectInputSchema,
  deleteScratchpadBlockInputSchema,
  forkSessionInputSchema,
  hideProjectInputSchema,
  interruptMessageInputSchema,
  refreshTerminalDiffsInputSchema,
  renameSessionInputSchema,
  resetSessionInputSchema,
  reviewSessionInputSchema,
  sendMessageInputSchema,
  setThinkingLevelInputSchema,
  steerMessageInputSchema,
  terminalConfigInputSchema,
  triggerScratchpadBlockInputSchema,
  unhideProjectInputSchema,
} from '~/lib/contracts'
import type { UiPreferences } from '~/lib/ui-preferences'
import {
  addProject,
  addScratchpadBlock,
  deleteScratchpadBlock,
  getAgentDetail,
  getAgentLaunchConfig,
  getWorkspaceSnapshot,
  hideProject,
  renameSession,
  reorderProjects,
  restoreSession,
  startSession,
  unhideProject,
} from './db'
import { chooseProjectDirectory } from './directory-picker'
import { refreshTerminalSessionDiffs } from './diff-refresh'
import {
  setAgentByProjectPreference,
  setChatTypographyPreference,
  setKeymapPreference,
  setThemePreference,
} from './preferences'
import {
  answerAgentQuestion,
  forkAgentSession,
  interruptAgent,
  promptAgent,
  resetAgentSession,
  reviewAgentSession,
  setAgentThinkingLevel,
  steerAgent,
} from './runtime'
import {
  deleteProjectWithRuntimeCleanup,
  deleteSessionWithRuntimeCleanup,
} from './runtime-cleanup'
import { triggerScratchpadSession } from './scratchpad-trigger'
import { ensureTerminalServer } from './terminal-server'

type AgentDetailInput = z.infer<typeof agentDetailInputSchema>
type DeleteProjectInput = z.infer<typeof deleteProjectInputSchema>
type HideProjectInput = z.infer<typeof hideProjectInputSchema>
type UnhideProjectInput = z.infer<typeof unhideProjectInputSchema>
type SendMessageInput = z.infer<typeof sendMessageInputSchema>
type SteerMessageInput = z.infer<typeof steerMessageInputSchema>
type InterruptMessageInput = z.infer<typeof interruptMessageInputSchema>
type SetThinkingLevelInput = z.infer<typeof setThinkingLevelInputSchema>
type ResetSessionInput = z.infer<typeof resetSessionInputSchema>
type ForkSessionInput = z.infer<typeof forkSessionInputSchema>
type ReviewSessionInput = z.infer<typeof reviewSessionInputSchema>
type TerminalConfigInput = z.infer<typeof terminalConfigInputSchema>
type RefreshTerminalDiffsInput = z.infer<typeof refreshTerminalDiffsInputSchema>
type RenameSessionInput = z.infer<typeof renameSessionInputSchema>
type DeleteScratchpadBlockInput = z.infer<typeof deleteScratchpadBlockInputSchema>
type TriggerScratchpadBlockInput = z.infer<typeof triggerScratchpadBlockInputSchema>

type AgentLaunchConfig = ReturnType<typeof getAgentLaunchConfig>
type TerminalServerConfig = Awaited<ReturnType<typeof ensureTerminalServer>>

export type WorkspaceServiceApi = {
  readonly snapshot: () => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly agentDetail: (input: AgentDetailInput) => Effect.Effect<AgentDetail, WorkspaceServiceError>
  readonly addProject: (input: AddProjectInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly deleteProject: (input: DeleteProjectInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly hideProject: (input: HideProjectInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly reorderProjects: (input: ReorderProjectsInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly unhideProject: (input: UnhideProjectInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly chooseProjectDirectory: () => Effect.Effect<string, WorkspaceServiceError>
  readonly deleteSession: (input: DeleteSessionInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly restoreSession: (input: RestoreSessionInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly renameSession: (input: RenameSessionInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly sendMessage: (input: SendMessageInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly steerMessage: (input: SteerMessageInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly interruptMessage: (input: InterruptMessageInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly setThinkingLevel: (input: SetThinkingLevelInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly setThemePreference: (input: UiPreferences['theme']) => Effect.Effect<UiPreferences, WorkspaceServiceError>
  readonly setKeymapPreference: (input: UiPreferences['keymap']) => Effect.Effect<UiPreferences, WorkspaceServiceError>
  readonly setChatTypographyPreference: (
    input: UiPreferences['chatTypography']
  ) => Effect.Effect<UiPreferences, WorkspaceServiceError>
  readonly setAgentByProjectPreference: (
    input: UiPreferences['agentByProject']
  ) => Effect.Effect<UiPreferences, WorkspaceServiceError>
  readonly resetSession: (input: ResetSessionInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly forkSession: (input: ForkSessionInput) => Effect.Effect<{
    readonly agentId: string
    readonly snapshot: WorkspaceSnapshot
  }, WorkspaceServiceError>
  readonly reviewSession: (input: ReviewSessionInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly answerQuestion: (input: AnswerQuestionInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly terminalConfig: (input: TerminalConfigInput) => Effect.Effect<TerminalConfig, WorkspaceServiceError>
  readonly refreshTerminalDiffs: (input: RefreshTerminalDiffsInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly startSession: (input: StartSessionInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly addScratchpadBlock: (input: AddScratchpadBlockInput) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly deleteScratchpadBlock: (
    input: DeleteScratchpadBlockInput
  ) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly triggerScratchpadBlock: (input: TriggerScratchpadBlockInput) => Effect.Effect<{
    readonly agentId: string
    readonly snapshot: WorkspaceSnapshot
  }, WorkspaceServiceError>
}

export class WorkspaceServiceError extends Data.TaggedError('WorkspaceServiceError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class WorkspaceService extends Context.Tag('@kiri/WorkspaceService')<
  WorkspaceService,
  WorkspaceServiceApi
>() {
  static readonly layer = Layer.sync(WorkspaceService, () =>
    WorkspaceService.of(makeWorkspaceService(liveWorkspaceServiceDependencies)))
}

export type WorkspaceServiceDependencies = {
  readonly getWorkspaceSnapshot: () => WorkspaceSnapshot
  readonly getAgentDetail: (input: AgentDetailInput) => AgentDetail
  readonly addProject: (input: AddProjectInput) => WorkspaceSnapshot
  readonly deleteProject: (id: string) => WorkspaceSnapshot
  readonly hideProject: (id: string) => WorkspaceSnapshot
  readonly reorderProjects: (input: ReorderProjectsInput) => WorkspaceSnapshot
  readonly unhideProject: (id: string) => WorkspaceSnapshot
  readonly chooseProjectDirectory: () => string
  readonly deleteSession: (input: DeleteSessionInput) => WorkspaceSnapshot
  readonly restoreSession: (input: RestoreSessionInput) => WorkspaceSnapshot
  readonly renameSession: (input: RenameSessionInput) => WorkspaceSnapshot
  readonly promptAgent: (input: SendMessageInput) => Promise<unknown>
  readonly steerAgent: (input: SteerMessageInput) => Promise<unknown>
  readonly interruptAgent: (input: InterruptMessageInput) => Promise<unknown>
  readonly setAgentThinkingLevel: (input: SetThinkingLevelInput) => Promise<unknown>
  readonly setThemePreference: (input: UiPreferences['theme']) => UiPreferences
  readonly setKeymapPreference: (input: UiPreferences['keymap']) => UiPreferences
  readonly setChatTypographyPreference: (input: UiPreferences['chatTypography']) => UiPreferences
  readonly setAgentByProjectPreference: (input: UiPreferences['agentByProject']) => UiPreferences
  readonly resetAgentSession: (input: ResetSessionInput) => Promise<unknown>
  readonly forkAgentSession: (input: ForkSessionInput) => Promise<string>
  readonly reviewAgentSession: (input: ReviewSessionInput) => Promise<unknown>
  readonly answerAgentQuestion: (input: AnswerQuestionInput) => Promise<unknown>
  readonly getAgentLaunchConfig: (agentId: string) => AgentLaunchConfig
  readonly ensureTerminalServer: () => Promise<TerminalServerConfig>
  readonly refreshTerminalSessionDiffs: (agentId: string) => WorkspaceSnapshot
  readonly startSession: (input: StartSessionInput) => WorkspaceSnapshot
  readonly addScratchpadBlock: (input: AddScratchpadBlockInput) => WorkspaceSnapshot
  readonly deleteScratchpadBlock: (id: string) => WorkspaceSnapshot
  readonly triggerScratchpadSession: (input: TriggerScratchpadBlockInput) => Promise<{ readonly agentId: string }>
}

const liveWorkspaceServiceDependencies: WorkspaceServiceDependencies = {
  getWorkspaceSnapshot,
  getAgentDetail,
  addProject,
  deleteProject: deleteProjectWithRuntimeCleanup,
  hideProject,
  reorderProjects,
  unhideProject,
  chooseProjectDirectory,
  deleteSession: deleteSessionWithRuntimeCleanup,
  restoreSession,
  renameSession,
  promptAgent,
  steerAgent,
  interruptAgent,
  setAgentThinkingLevel,
  setThemePreference,
  setKeymapPreference,
  setChatTypographyPreference,
  setAgentByProjectPreference,
  resetAgentSession,
  forkAgentSession,
  reviewAgentSession,
  answerAgentQuestion,
  getAgentLaunchConfig,
  ensureTerminalServer,
  refreshTerminalSessionDiffs,
  startSession,
  addScratchpadBlock,
  deleteScratchpadBlock,
  triggerScratchpadSession,
}

const liveWorkspaceServiceLayer = WorkspaceService.layer

export function makeWorkspaceService(
  dependencies: WorkspaceServiceDependencies,
): WorkspaceServiceApi {
  const snapshot = Effect.fn('WorkspaceService.snapshot')(function* () {
    return yield* syncCall('WorkspaceService.snapshot', dependencies.getWorkspaceSnapshot)
  })

  const snapshotAfter = <A>(
    label: string,
    effect: Effect.Effect<A, WorkspaceServiceError>,
  ) =>
    Effect.gen(function* () {
      yield* effect
      return yield* syncCall(label, dependencies.getWorkspaceSnapshot)
    })

  return {
    snapshot,
    agentDetail: Effect.fn('WorkspaceService.agentDetail')(function* (input) {
      return yield* syncCall('WorkspaceService.agentDetail', () => dependencies.getAgentDetail(input))
    }),
    addProject: Effect.fn('WorkspaceService.addProject')(function* (input) {
      return yield* syncCall('WorkspaceService.addProject', () => dependencies.addProject(input))
    }),
    deleteProject: Effect.fn('WorkspaceService.deleteProject')(function* (input) {
      return yield* syncCall('WorkspaceService.deleteProject', () => dependencies.deleteProject(input.id))
    }),
    hideProject: Effect.fn('WorkspaceService.hideProject')(function* (input) {
      return yield* syncCall('WorkspaceService.hideProject', () => dependencies.hideProject(input.id))
    }),
    reorderProjects: Effect.fn('WorkspaceService.reorderProjects')(function* (input) {
      return yield* syncCall('WorkspaceService.reorderProjects', () => dependencies.reorderProjects(input))
    }),
    unhideProject: Effect.fn('WorkspaceService.unhideProject')(function* (input) {
      return yield* syncCall('WorkspaceService.unhideProject', () => dependencies.unhideProject(input.id))
    }),
    chooseProjectDirectory: Effect.fn('WorkspaceService.chooseProjectDirectory')(function* () {
      return yield* syncCall('WorkspaceService.chooseProjectDirectory', dependencies.chooseProjectDirectory)
    }),
    deleteSession: Effect.fn('WorkspaceService.deleteSession')(function* (input) {
      return yield* syncCall('WorkspaceService.deleteSession', () => dependencies.deleteSession(input))
    }),
    restoreSession: Effect.fn('WorkspaceService.restoreSession')(function* (input) {
      return yield* syncCall('WorkspaceService.restoreSession', () => dependencies.restoreSession(input))
    }),
    renameSession: Effect.fn('WorkspaceService.renameSession')(function* (input) {
      return yield* syncCall('WorkspaceService.renameSession', () => dependencies.renameSession(input))
    }),
    sendMessage: Effect.fn('WorkspaceService.sendMessage')(function* (input) {
      return yield* snapshotAfter(
        'WorkspaceService.sendMessage.snapshot',
        promiseCall('WorkspaceService.sendMessage', () => dependencies.promptAgent(input)),
      )
    }),
    steerMessage: Effect.fn('WorkspaceService.steerMessage')(function* (input) {
      return yield* snapshotAfter(
        'WorkspaceService.steerMessage.snapshot',
        promiseCall('WorkspaceService.steerMessage', () => dependencies.steerAgent(input)),
      )
    }),
    interruptMessage: Effect.fn('WorkspaceService.interruptMessage')(function* (input) {
      return yield* snapshotAfter(
        'WorkspaceService.interruptMessage.snapshot',
        promiseCall('WorkspaceService.interruptMessage', () => dependencies.interruptAgent(input)),
      )
    }),
    setThinkingLevel: Effect.fn('WorkspaceService.setThinkingLevel')(function* (input) {
      return yield* snapshotAfter(
        'WorkspaceService.setThinkingLevel.snapshot',
        promiseCall('WorkspaceService.setThinkingLevel', () => dependencies.setAgentThinkingLevel(input)),
      )
    }),
    setThemePreference: Effect.fn('WorkspaceService.setThemePreference')(function* (input) {
      return yield* syncCall('WorkspaceService.setThemePreference', () => dependencies.setThemePreference(input))
    }),
    setKeymapPreference: Effect.fn('WorkspaceService.setKeymapPreference')(function* (input) {
      return yield* syncCall('WorkspaceService.setKeymapPreference', () => dependencies.setKeymapPreference(input))
    }),
    setChatTypographyPreference: Effect.fn('WorkspaceService.setChatTypographyPreference')(function* (input) {
      return yield* syncCall(
        'WorkspaceService.setChatTypographyPreference',
        () => dependencies.setChatTypographyPreference(input),
      )
    }),
    setAgentByProjectPreference: Effect.fn('WorkspaceService.setAgentByProjectPreference')(function* (input) {
      return yield* syncCall(
        'WorkspaceService.setAgentByProjectPreference',
        () => dependencies.setAgentByProjectPreference(input),
      )
    }),
    resetSession: Effect.fn('WorkspaceService.resetSession')(function* (input) {
      return yield* snapshotAfter(
        'WorkspaceService.resetSession.snapshot',
        promiseCall('WorkspaceService.resetSession', () => dependencies.resetAgentSession(input)),
      )
    }),
    forkSession: Effect.fn('WorkspaceService.forkSession')(function* (input) {
      const agentId = yield* promiseCall(
        'WorkspaceService.forkSession',
        () => dependencies.forkAgentSession(input),
      )
      const forkSnapshot = yield* syncCall(
        'WorkspaceService.forkSession.snapshot',
        dependencies.getWorkspaceSnapshot,
      )
      return { agentId, snapshot: forkSnapshot }
    }),
    reviewSession: Effect.fn('WorkspaceService.reviewSession')(function* (input) {
      return yield* snapshotAfter(
        'WorkspaceService.reviewSession.snapshot',
        promiseCall('WorkspaceService.reviewSession', () => dependencies.reviewAgentSession(input)),
      )
    }),
    answerQuestion: Effect.fn('WorkspaceService.answerQuestion')(function* (input) {
      return yield* snapshotAfter(
        'WorkspaceService.answerQuestion.snapshot',
        promiseCall('WorkspaceService.answerQuestion', () => dependencies.answerAgentQuestion(input)),
      )
    }),
    terminalConfig: Effect.fn('WorkspaceService.terminalConfig')(function* (input) {
      const config = yield* syncCall(
        'WorkspaceService.terminalConfig.launchConfig',
        () => dependencies.getAgentLaunchConfig(input.agentId),
      )
      const server = yield* promiseCall(
        'WorkspaceService.terminalConfig.server',
        dependencies.ensureTerminalServer,
      )
      return {
        ...server,
        mode: input.mode,
        runtime: config.runtime,
        model: config.model,
      }
    }),
    refreshTerminalDiffs: Effect.fn('WorkspaceService.refreshTerminalDiffs')(function* (input) {
      return yield* syncCall(
        'WorkspaceService.refreshTerminalDiffs',
        () => dependencies.refreshTerminalSessionDiffs(input.agentId),
      )
    }),
    startSession: Effect.fn('WorkspaceService.startSession')(function* (input) {
      return yield* syncCall('WorkspaceService.startSession', () => dependencies.startSession(input))
    }),
    addScratchpadBlock: Effect.fn('WorkspaceService.addScratchpadBlock')(function* (input) {
      return yield* syncCall('WorkspaceService.addScratchpadBlock', () => dependencies.addScratchpadBlock(input))
    }),
    deleteScratchpadBlock: Effect.fn('WorkspaceService.deleteScratchpadBlock')(function* (input) {
      return yield* syncCall(
        'WorkspaceService.deleteScratchpadBlock',
        () => dependencies.deleteScratchpadBlock(input.id),
      )
    }),
    triggerScratchpadBlock: Effect.fn('WorkspaceService.triggerScratchpadBlock')(function* (input) {
      const { agentId } = yield* promiseCall(
        'WorkspaceService.triggerScratchpadBlock',
        () => dependencies.triggerScratchpadSession(input),
      )
      const triggerSnapshot = yield* syncCall(
        'WorkspaceService.triggerScratchpadBlock.snapshot',
        dependencies.getWorkspaceSnapshot,
      )
      return { agentId, snapshot: triggerSnapshot }
    }),
  }
}

export function runWorkspaceService<A>(
  effect: Effect.Effect<A, WorkspaceServiceError, WorkspaceService>,
) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(liveWorkspaceServiceLayer),
      Effect.either,
    ),
  ).then((result) => {
    if (Either.isRight(result)) return result.right
    throw normalizeWorkspaceServiceFailure(result.left)
  })
}

export function runWorkspaceServiceMethod<A>(
  method: (service: WorkspaceServiceApi) => Effect.Effect<A, WorkspaceServiceError>,
) {
  return runWorkspaceService(Effect.gen(function* () {
    const service = yield* WorkspaceService
    return yield* method(service)
  }))
}

function syncCall<A>(label: string, call: () => A) {
  return Effect.try({
    try: call,
    catch: (error) => workspaceServiceError(label, error),
  })
}

function promiseCall<A>(label: string, call: () => Promise<A>) {
  return Effect.tryPromise({
    try: call,
    catch: (error) => workspaceServiceError(label, error),
  })
}

function workspaceServiceError(label: string, error: unknown) {
  return new WorkspaceServiceError({
    message: error instanceof Error ? error.message : `${label} failed`,
    cause: error,
  })
}

function normalizeWorkspaceServiceFailure(error: unknown) {
  if (error instanceof WorkspaceServiceError && error.cause instanceof Error) {
    return error.cause
  }
  if (error instanceof Error) return error
  return new WorkspaceServiceError({
    message: 'Workspace service failed',
    cause: error,
  })
}
