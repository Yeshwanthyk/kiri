import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runTsxJson } from '../harness/run-tsx'

const perfOutputSchema = z.object({
  ok: z.literal(true),
  storedTimelineRows: z.number(),
  returnedTimelineRows: z.number(),
  detailJsonBytes: z.number(),
  snapshotMs: z.number(),
  detailMs: z.number(),
  rssDeltaMb: z.number(),
})

describe('perf gates', () => {
  it('keeps snapshot and detail hydration bounded on large histories', () => {
    const result = runTsxJson(
      'tests/perf/run-perf.ts',
      (output) => perfOutputSchema.parse(output),
    )
    expect(result.returnedTimelineRows).toBeLessThan(result.storedTimelineRows)
    expect(result.returnedTimelineRows).toBe(500)
  }, 20_000)
})
