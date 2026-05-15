import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  DirectoryPickerError,
  makeDirectoryPickerService,
} from '../../src/server/directory-picker'

describe('directory picker service', () => {
  it.effect('runs osascript and trims the selected project directory', () =>
    Effect.gen(function* () {
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = []
      const service = makeDirectoryPickerService({
        runCommand: (command, args) => {
          calls.push({ command, args })
          return '/Users/yesh/project\n'
        },
      })

      const result = yield* service.chooseProjectDirectory

      expect(result).toBe('/Users/yesh/project')
      expect(calls).toEqual([{
        command: 'osascript',
        args: [
          '-e',
          'POSIX path of (choose folder with prompt "Choose a project directory")',
        ],
      }])
    }),
  )

  it.effect('wraps osascript failures in a typed error', () =>
    Effect.gen(function* () {
      const service = makeDirectoryPickerService({
        runCommand: () => {
          throw new Error('selection canceled')
        },
      })

      const error = yield* service.chooseProjectDirectory.pipe(Effect.flip)

      expect(error).toBeInstanceOf(DirectoryPickerError)
      expect(error.message).toBe('selection canceled')
    }),
  )
})
