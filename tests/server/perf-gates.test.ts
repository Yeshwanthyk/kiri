import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const perfOutputSchema = z.object({
  ok: z.literal(true),
  storedTimelineRows: z.number(),
  returnedTimelineRows: z.number(),
  returnedDiffs: z.number(),
  detailJsonBytes: z.number(),
  snapshotMs: z.number(),
  detailMs: z.number(),
  rssDeltaMb: z.number(),
})

describe('perf gates', () => {
  it('keeps snapshot and detail hydration bounded on large histories', () => {
    const output = execFileSync(
      'pnpm',
      ['exec', 'tsx', 'tests/perf/run-perf.ts'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )
    const result = perfOutputSchema.parse(JSON.parse(output))
    expect(result.returnedTimelineRows).toBeLessThan(result.storedTimelineRows)
    expect(result.returnedTimelineRows).toBe(500)
    expect(result.returnedDiffs).toBe(50)
  }, 20_000)
})
