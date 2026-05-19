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
  WorkspaceRevision,
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
  refreshReadModels,
  getWorkspaceRevision,
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
  UiPreferencesService,
  type UiPreferencesApi,
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
import { triggerScratchpadSessionAndSpawn } from './scratchpad-trigger'
import { TerminalServerService, type TerminalServerApi } from './terminal-server'

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
type TerminalServerConfig = Awaited<ReturnType<TerminalServerApi['ensure']>>

export type WorkspaceServiceApi = {
  readonly snapshot: () => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>
  readonly revision: () => Effect.Effect<WorkspaceRevision, WorkspaceServiceError>
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
  static readonly layer = Layer.effect(
    WorkspaceService,
    Effect.gen(function* () {
      const terminalServer = yield* TerminalServerService
      const preferences = yield* UiPreferencesService
      return WorkspaceService.of(makeWorkspaceService(liveWorkspaceServiceDependencies({
        preferences,
        terminalServer,
      })))
    }),
  )

  static readonly liveLayer = WorkspaceService.layer.pipe(Layer.provide(Layer.mergeAll(
    TerminalServerService.liveLayer,
    UiPreferencesService.layer,
  )))
}

export type WorkspaceServiceDependencies = {
  readonly getWorkspaceSnapshot: () => WorkspaceSnapshot
  readonly getWorkspaceRevision: () => WorkspaceRevision
  readonly refreshReadModels: () => readonly unknown[]
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
  readonly setThemePreference: (input: UiPreferences['theme']) => Effect.Effect<UiPreferences, unknown>
  readonly setKeymapPreference: (input: UiPreferences['keymap']) => Effect.Effect<UiPreferences, unknown>
  readonly setChatTypographyPreference: (
    input: UiPreferences['chatTypography']
  ) => Effect.Effect<UiPreferences, unknown>
  readonly setAgentByProjectPreference: (
    input: UiPreferences['agentByProject']
  ) => Effect.Effect<UiPreferences, unknown>
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

function liveWorkspaceServiceDependencies(
  input: {
    readonly preferences: UiPreferencesApi
    readonly terminalServer: TerminalServerApi
  },
): WorkspaceServiceDependencies {
  return {
    getWorkspaceSnapshot,
    getWorkspaceRevision,
    refreshReadModels,
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
    setThemePreference: input.preferences.setTheme,
    setKeymapPreference: input.preferences.setKeymap,
    setChatTypographyPreference: input.preferences.setChatTypography,
    setAgentByProjectPreference: input.preferences.setAgentByProject,
    resetAgentSession,
    forkAgentSession,
    reviewAgentSession,
    answerAgentQuestion,
    getAgentLaunchConfig,
    ensureTerminalServer: input.terminalServer.ensure,
    refreshTerminalSessionDiffs,
    startSession,
    addScratchpadBlock,
    deleteScratchpadBlock,
    triggerScratchpadSession: triggerScratchpadSessionAndSpawn,
  }
}

const liveWorkspaceServiceLayer = WorkspaceService.liveLayer

export function makeWorkspaceService(
  dependencies: WorkspaceServiceDependencies,
): WorkspaceServiceApi {
  const snapshot = Effect.fn('WorkspaceService.snapshot')(function* () {
    yield* syncCall('WorkspaceService.refreshReadModels', dependencies.refreshReadModels)
    return yield* syncCall('WorkspaceService.snapshot', dependencies.getWorkspaceSnapshot)
  })
  const revision = Effect.fn('WorkspaceService.revision')(function* () {
    return yield* syncCall('WorkspaceService.revision', dependencies.getWorkspaceRevision)
  })

  const snapshotAfter = <A>(
    label: string,
    effect: Effect.Effect<A, WorkspaceServiceError>,
  ) =>
    Effect.gen(function* () {
      yield* effect
      yield* syncCall('WorkspaceService.refreshReadModels', dependencies.refreshReadModels)
      return yield* syncCall(label, dependencies.getWorkspaceSnapshot)
    })
  const syncSnapshotMethod = <Input>(
    label: string,
    call: (input: Input) => WorkspaceSnapshot,
  ) =>
    Effect.fn(label)(function* (input: Input) {
      const next = yield* syncCall(label, () => call(input))
      yield* syncCall('WorkspaceService.refreshReadModels', dependencies.refreshReadModels)
      return next
    })
  const syncSnapshotIdMethod = <Input extends { readonly id: string }>(
    label: string,
    call: (id: string) => WorkspaceSnapshot,
  ) => syncSnapshotMethod(label, (input: Input) => call(input.id))
  const snapshotAfterPromiseMethod = <Input>(
    label: string,
    call: (input: Input) => Promise<unknown>,
  ) =>
    Effect.fn(label)(function* (input: Input) {
      return yield* snapshotAfter(
        `${label}.snapshot`,
        promiseCall(label, () => call(input)),
      )
    })
  const effectMethod = <Input, Output>(
    label: string,
    call: (input: Input) => Effect.Effect<Output, unknown>,
  ) =>
    Effect.fn(label)(function* (input: Input) {
      return yield* call(input).pipe(
        Effect.mapError((error) => workspaceServiceError(label, error)),
      )
    })

  return {
    snapshot,
    revision,
    agentDetail: Effect.fn('WorkspaceService.agentDetail')(function* (input: AgentDetailInput) {
      yield* syncCall('WorkspaceService.refreshReadModels', dependencies.refreshReadModels)
      return yield* syncCall('WorkspaceService.agentDetail', () => dependencies.getAgentDetail(input))
    }),
    addProject: syncSnapshotMethod('WorkspaceService.addProject', dependencies.addProject),
    deleteProject: syncSnapshotIdMethod('WorkspaceService.deleteProject', dependencies.deleteProject),
    hideProject: syncSnapshotIdMethod('WorkspaceService.hideProject', dependencies.hideProject),
    reorderProjects: syncSnapshotMethod('WorkspaceService.reorderProjects', dependencies.reorderProjects),
    unhideProject: syncSnapshotIdMethod('WorkspaceService.unhideProject', dependencies.unhideProject),
    chooseProjectDirectory: Effect.fn('WorkspaceService.chooseProjectDirectory')(function* () {
      return yield* syncCall('WorkspaceService.chooseProjectDirectory', dependencies.chooseProjectDirectory)
    }),
    deleteSession: syncSnapshotMethod('WorkspaceService.deleteSession', dependencies.deleteSession),
    restoreSession: syncSnapshotMethod('WorkspaceService.restoreSession', dependencies.restoreSession),
    renameSession: syncSnapshotMethod('WorkspaceService.renameSession', dependencies.renameSession),
    sendMessage: snapshotAfterPromiseMethod('WorkspaceService.sendMessage', dependencies.promptAgent),
    steerMessage: snapshotAfterPromiseMethod('WorkspaceService.steerMessage', dependencies.steerAgent),
    interruptMessage: snapshotAfterPromiseMethod('WorkspaceService.interruptMessage', dependencies.interruptAgent),
    setThinkingLevel: snapshotAfterPromiseMethod('WorkspaceService.setThinkingLevel', dependencies.setAgentThinkingLevel),
    setThemePreference: effectMethod('WorkspaceService.setThemePreference', dependencies.setThemePreference),
    setKeymapPreference: effectMethod('WorkspaceService.setKeymapPreference', dependencies.setKeymapPreference),
    setChatTypographyPreference: effectMethod(
      'WorkspaceService.setChatTypographyPreference',
      dependencies.setChatTypographyPreference,
    ),
    setAgentByProjectPreference: effectMethod(
      'WorkspaceService.setAgentByProjectPreference',
      dependencies.setAgentByProjectPreference,
    ),
    resetSession: snapshotAfterPromiseMethod('WorkspaceService.resetSession', dependencies.resetAgentSession),
    forkSession: Effect.fn('WorkspaceService.forkSession')(function* (input) {
      const agentId = yield* promiseCall(
        'WorkspaceService.forkSession',
        () => dependencies.forkAgentSession(input),
      )
      yield* syncCall('WorkspaceService.refreshReadModels', dependencies.refreshReadModels)
      const forkSnapshot = yield* syncCall(
        'WorkspaceService.forkSession.snapshot',
        dependencies.getWorkspaceSnapshot,
      )
      return { agentId, snapshot: forkSnapshot }
    }),
    reviewSession: snapshotAfterPromiseMethod('WorkspaceService.reviewSession', dependencies.reviewAgentSession),
    answerQuestion: snapshotAfterPromiseMethod('WorkspaceService.answerQuestion', dependencies.answerAgentQuestion),
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
    refreshTerminalDiffs: syncSnapshotMethod(
      'WorkspaceService.refreshTerminalDiffs',
      (input: RefreshTerminalDiffsInput) => dependencies.refreshTerminalSessionDiffs(input.agentId),
    ),
    startSession: syncSnapshotMethod('WorkspaceService.startSession', dependencies.startSession),
    addScratchpadBlock: syncSnapshotMethod('WorkspaceService.addScratchpadBlock', dependencies.addScratchpadBlock),
    deleteScratchpadBlock: syncSnapshotIdMethod(
      'WorkspaceService.deleteScratchpadBlock',
      dependencies.deleteScratchpadBlock,
    ),
    triggerScratchpadBlock: Effect.fn('WorkspaceService.triggerScratchpadBlock')(function* (input) {
      const { agentId } = yield* promiseCall(
        'WorkspaceService.triggerScratchpadBlock',
        () => dependencies.triggerScratchpadSession(input),
      )
      yield* syncCall('WorkspaceService.refreshReadModels', dependencies.refreshReadModels)
      const triggerSnapshot = yield* syncCall(
        'WorkspaceService.triggerScratchpadBlock.snapshot',
        dependencies.getWorkspaceSnapshot,
      )
      return { agentId, snapshot: triggerSnapshot }
    }),
  }
}

function runWorkspaceService<A>(
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
