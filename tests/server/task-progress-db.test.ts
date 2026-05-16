import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runTsxJson } from '../harness/run-tsx'

const harnessOutputSchema = z.object({
  ok: z.literal(true),
  beforeReset: z.number(),
  afterReset: z.number(),
})

describe('task progress persistence', () => {
  it('clears persisted task snapshots when a session resets', () => {
    const result = runTsxJson(
      'tests/harness/task-progress-db-harness.ts',
      (output) => harnessOutputSchema.parse(output),
    )

    expect(result.beforeReset).toBe(1)
    expect(result.afterReset).toBe(0)
  })
})
