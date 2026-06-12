import { describe, expect, it } from 'vitest'

import {
  commandBelongsToAppBundle,
  runningPidsFromPs,
} from '../../scripts/install-desktop-app.mjs'

const contentsDir = '/Users/yesh/Applications/kiri.app/Contents'

describe('desktop installer process matching', () => {
  it('matches only commands executing from the installed app bundle', () => {
    expect(commandBelongsToAppBundle(
      '/Users/yesh/Applications/kiri.app/Contents/MacOS/kiri',
      contentsDir,
    )).toBe(true)
    expect(commandBelongsToAppBundle(
      '/Users/yesh/Applications/kiri.app/Contents/MacOS/kiri /Users/yesh/Applications/kiri.app/Contents/Resources/app.asar/scripts/kiri-desktop-backend.mjs',
      contentsDir,
    )).toBe(true)
    expect(commandBelongsToAppBundle(
      '/Users/yesh/.codex/computer-use/SkyComputerUseClient {"message":"/Users/yesh/Applications/kiri.app/Contents/Resources/bin/kiri-mcp"}',
      contentsDir,
    )).toBe(false)
  })

  it('extracts only installed app pids from ps output', () => {
    const output = [
      '  100 /Users/yesh/Applications/kiri.app/Contents/MacOS/kiri',
      '  101 /Users/yesh/.codex/computer-use/SkyComputerUseClient {"message":"/Users/yesh/Applications/kiri.app/Contents/MacOS/kiri"}',
      '  102 /Users/yesh/Applications/kiri.app/Contents/Frameworks/kiri Helper.app/Contents/MacOS/kiri Helper --type=renderer',
    ].join('\n')

    expect(runningPidsFromPs(output, contentsDir)).toEqual(['100', '102'])
  })
})
