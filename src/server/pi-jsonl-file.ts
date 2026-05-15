import { readFileSync } from 'node:fs'
import { Context, Data, Effect, Either, Layer } from 'effect'
import {
  projectPiSessionJsonl,
  type PiSessionProjection,
} from './pi-jsonl'

export class PiJsonlFileError extends Data.TaggedError('PiJsonlFileError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type PiJsonlFileServiceApi = {
  readonly projectFile: (path: string) => Effect.Effect<PiSessionProjection, PiJsonlFileError>
}

export class PiJsonlFileService extends Context.Tag('@kiri/PiJsonlFile')<
  PiJsonlFileService,
  PiJsonlFileServiceApi
>() {
  static readonly layer = Layer.sync(PiJsonlFileService, () =>
    PiJsonlFileService.of(makePiJsonlFileService()))
}

export type PiJsonlFileDependencies = {
  readonly readFile: (path: string) => string
  readonly projectJsonl: (content: string) => PiSessionProjection
}

export function makePiJsonlFileService(
  dependencies: PiJsonlFileDependencies = {
    readFile: (path) => readFileSync(path, 'utf8'),
    projectJsonl: projectPiSessionJsonl,
  },
): PiJsonlFileServiceApi {
  return {
    projectFile: Effect.fn('PiJsonlFile.projectFile')(function* (path) {
      return yield* Effect.try({
        try: () => dependencies.projectJsonl(dependencies.readFile(path)),
        catch: normalizePiJsonlFileError,
      })
    }),
  }
}

export function projectPiSessionFile(path: string): PiSessionProjection {
  const result = Effect.runSync(
    PiJsonlFileService.pipe(
      Effect.flatMap((service) => service.projectFile(path)),
      Effect.provide(PiJsonlFileService.layer),
      Effect.either,
    ),
  )
  if (Either.isRight(result)) return result.right
  throw normalizePiJsonlFileFailure(result.left)
}

function normalizePiJsonlFileError(error: unknown) {
  return new PiJsonlFileError({
    message: error instanceof Error ? error.message : 'Pi JSONL file projection failed',
    cause: error,
  })
}

function normalizePiJsonlFileFailure(error: unknown) {
  if (error instanceof PiJsonlFileError && error.cause instanceof Error) {
    return error.cause
  }
  if (error instanceof Error) return error
  return new PiJsonlFileError({
    message: 'Pi JSONL file projection failed',
    cause: error,
  })
}
