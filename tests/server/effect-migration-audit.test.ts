import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runPnpmJson } from '../harness/run-tsx'

const auditOutputSchema = z.object({
  ok: z.boolean(),
  trackedFiles: z.number(),
  serverFiles: z.number(),
})

describe('Effect migration audit', () => {
  it('keeps every server file classified before migration work starts', () => {
    const result = runPnpmJson(
      ['--silent', 'effect:audit'],
      (output) => auditOutputSchema.parse(output),
    )
    expect(result.ok).toBe(true)
    expect(result.trackedFiles).toBe(result.serverFiles)
    expect(result.serverFiles).toBeGreaterThan(0)
  })
})
