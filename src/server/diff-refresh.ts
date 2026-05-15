import { Context, Data, Effect, Either, Layer } from 'effect'
import type { AgentDetail, DiffArtifact, WorkspaceSnapshot } from '~/lib/contracts'
import {
  getAgentDetail,
  getAgentLaunchConfig,
  getWorkspaceSnapshot,
  replaceAgentDiffArtifacts,
} from './db'
import { GitDiffService, type GitDiffServiceApi } from './git-diff'

type AgentDetailLookup = Pick<AgentDetail, 'interfaceMode'>
type AgentLaunchConfigLookup = {
  readonly cwd: string
}

export class DiffRefreshError extends Data.TaggedError('DiffRefreshError')<{
  readonly message: string
  readonly agentId: string
  readonly cause?: unknown
}> {}

export type DiffRefreshServiceApi = {
  readonly refreshTerminalSession: (
    input: { readonly agentId: string },
  ) => Effect.Effect<WorkspaceSnapshot, DiffRefreshError>
}

export class DiffRefreshService extends Context.Tag('@kiri/DiffRefresh')<
  DiffRefreshService,
  DiffRefreshServiceApi
>() {
  static readonly layer = Layer.effect(
    DiffRefreshService,
    Effect.gen(function* () {
      const gitDiff = yield* GitDiffService
      return DiffRefreshService.of(makeDiffRefreshService({
        gitDiff,
        getAgentDetail,
        getAgentLaunchConfig,
        replaceAgentDiffArtifacts,
        getWorkspaceSnapshot,
      }))
    }),
  )
}

const liveDiffRefreshLayer = DiffRefreshService.layer.pipe(
  Layer.provide(GitDiffService.layer),
)

export function makeDiffRefreshService(input: {
  readonly gitDiff: GitDiffServiceApi
  readonly getAgentDetail: (input: { readonly agentId: string; readonly limit?: number }) => AgentDetailLookup
  readonly getAgentLaunchConfig: (agentId: string) => AgentLaunchConfigLookup
  readonly replaceAgentDiffArtifacts: (input: {
    readonly agentId: string
    readonly diffs: Array<Pick<DiffArtifact, 'title' | 'path' | 'patch'>>
  }) => void
  readonly getWorkspaceSnapshot: () => WorkspaceSnapshot
}): DiffRefreshServiceApi {
  return {
    refreshTerminalSession: Effect.fn('DiffRefresh.refreshTerminalSession')(function* (command) {
      const agent = yield* Effect.try({
        try: () => input.getAgentDetail({ agentId: command.agentId, limit: 1 }),
        catch: (error) => new DiffRefreshError({
          message: error instanceof Error ? error.message : 'Failed to load agent detail',
          agentId: command.agentId,
          cause: error,
        }),
      })
      if (agent.interfaceMode !== 'terminal') {
        return yield* new DiffRefreshError({
          message: `Diff refresh is only available for terminal sessions: ${command.agentId}`,
          agentId: command.agentId,
        })
      }

      const config = yield* Effect.try({
        try: () => input.getAgentLaunchConfig(command.agentId),
        catch: (error) => new DiffRefreshError({
          message: error instanceof Error ? error.message : 'Failed to load agent launch config',
          agentId: command.agentId,
          cause: error,
        }),
      })
      const diffs = yield* input.gitDiff.collectArtifacts(config.cwd).pipe(
        Effect.mapError((error) => new DiffRefreshError({
          message: error.message,
          agentId: command.agentId,
          cause: error,
        })),
      )

      yield* Effect.try({
        try: () => input.replaceAgentDiffArtifacts({
          agentId: command.agentId,
          diffs,
        }),
        catch: (error) => new DiffRefreshError({
          message: error instanceof Error ? error.message : 'Failed to replace agent diffs',
          agentId: command.agentId,
          cause: error,
        }),
      })

      return yield* Effect.try({
        try: input.getWorkspaceSnapshot,
        catch: (error) => new DiffRefreshError({
          message: error instanceof Error ? error.message : 'Failed to load workspace snapshot',
          agentId: command.agentId,
          cause: error,
        }),
      })
    }),
  }
}

export function refreshTerminalSessionDiffs(agentId: string) {
  return runDiffRefresh(Effect.gen(function* () {
    const service = yield* DiffRefreshService
    return yield* service.refreshTerminalSession({ agentId })
  }))
}

function runDiffRefresh<A>(
  effect: Effect.Effect<A, DiffRefreshError, DiffRefreshService>,
) {
  const result = Effect.runSync(
    effect.pipe(
      Effect.provide(liveDiffRefreshLayer),
      Effect.either,
    ),
  )
  if (Either.isRight(result)) return result.right
  throw result.left
}
