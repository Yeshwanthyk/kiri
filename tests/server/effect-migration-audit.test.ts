import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('Effect migration audit', () => {
  it('keeps every server file classified before migration work starts', () => {
    const output = execFileSync('pnpm', ['--silent', 'effect:audit'], {
      encoding: 'utf8',
    })
    const result = JSON.parse(output) as {
      ok: boolean
      trackedFiles: number
      serverFiles: number
    }
    expect(result.ok).toBe(true)
    expect(result.trackedFiles).toBe(result.serverFiles)
    expect(result.serverFiles).toBeGreaterThan(0)
  })
})
