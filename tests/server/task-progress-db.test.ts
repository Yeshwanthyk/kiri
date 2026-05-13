import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const harnessOutputSchema = z.object({
  ok: z.literal(true),
  beforeReset: z.number(),
  afterReset: z.number(),
})

describe('task progress persistence', () => {
  it('clears persisted task snapshots when a session resets', () => {
    const output = execFileSync(
      'pnpm',
      ['--silent', 'tsx', 'tests/harness/task-progress-db-harness.ts'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )
    const result = harnessOutputSchema.parse(JSON.parse(output))

    expect(result.beforeReset).toBe(1)
    expect(result.afterReset).toBe(0)
  })
})
