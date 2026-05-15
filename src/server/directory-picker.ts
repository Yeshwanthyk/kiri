import { execFileSync } from 'node:child_process'
import { Context, Data, Effect, Either, Layer } from 'effect'

const chooseProjectDirectoryScript =
  'POSIX path of (choose folder with prompt "Choose a project directory")'

export class DirectoryPickerError extends Data.TaggedError('DirectoryPickerError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type DirectoryPickerCommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
) => string

export type DirectoryPickerServiceApi = {
  readonly chooseProjectDirectory: Effect.Effect<string, DirectoryPickerError>
}

export class DirectoryPickerService extends Context.Tag('@kiri/DirectoryPicker')<
  DirectoryPickerService,
  DirectoryPickerServiceApi
>() {
  static readonly layer = Layer.succeed(
    DirectoryPickerService,
    DirectoryPickerService.of(makeDirectoryPickerService()),
  )
}

export function makeDirectoryPickerService(input: {
  readonly runCommand?: DirectoryPickerCommandRunner
} = {}): DirectoryPickerServiceApi {
  const runCommand = input.runCommand ?? runOsascript
  return {
    chooseProjectDirectory: Effect.try({
      try: () => runCommand('osascript', ['-e', chooseProjectDirectoryScript]).trim(),
      catch: (error) => new DirectoryPickerError({
        message: error instanceof Error ? error.message : 'Project directory selection failed',
        cause: error,
      }),
    }),
  }
}

export function chooseProjectDirectory() {
  const result = Effect.runSync(
    Effect.gen(function* () {
      const picker = yield* DirectoryPickerService
      return yield* picker.chooseProjectDirectory
    }).pipe(
      Effect.provide(DirectoryPickerService.layer),
      Effect.either,
    ),
  )
  if (Either.isRight(result)) return result.right
  throw result.left
}

function runOsascript(command: string, args: ReadonlyArray<string>) {
  return execFileSync(command, args, { encoding: 'utf8' })
}
