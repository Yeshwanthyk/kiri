import { Context, Data, Effect, Either, Layer } from 'effect'
import { getDb } from './db'
import { getSettings } from './settings'

export class BackendReadinessError extends Data.TaggedError('BackendReadinessError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type BackendReadinessServiceApi = {
  readonly check: () => Effect.Effect<void, BackendReadinessError>
}

class BackendReadinessService extends Context.Tag('@kiri/BackendReadiness')<
  BackendReadinessService,
  BackendReadinessServiceApi
>() {
  static readonly layer = Layer.sync(BackendReadinessService, () =>
    BackendReadinessService.of(makeBackendReadinessService()))
}

export type BackendReadinessDependencies = {
  readonly loadSettings: () => unknown
  readonly openDb: () => unknown
}

export function makeBackendReadinessService(
  dependencies: BackendReadinessDependencies = {
    loadSettings: getSettings,
    openDb: getDb,
  },
): BackendReadinessServiceApi {
  return {
    check: Effect.fn('BackendReadiness.check')(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await dependencies.loadSettings()
          await dependencies.openDb()
        },
        catch: normalizeBackendReadinessError,
      })
    }),
  }
}

export async function checkBackendReadiness(dependencies?: BackendReadinessDependencies) {
  const result = await Effect.runPromise(
    makeBackendReadinessService(dependencies).check().pipe(Effect.either),
  )
  if (Either.isRight(result)) return
  throw normalizeBackendReadinessFailure(result.left)
}

function normalizeBackendReadinessError(error: unknown) {
  return new BackendReadinessError({
    message: error instanceof Error ? error.message : 'Backend readiness check failed',
    cause: error,
  })
}

function normalizeBackendReadinessFailure(error: unknown) {
  if (error instanceof BackendReadinessError && error.cause instanceof Error) {
    return error.cause
  }
  if (error instanceof Error) return error
  return new BackendReadinessError({
    message: 'Backend readiness check failed',
    cause: error,
  })
}
