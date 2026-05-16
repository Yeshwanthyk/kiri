import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runTsxJson } from '../harness/run-tsx'

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

const clientRenderPerfOutputSchema = z.object({
  ok: z.literal(true),
  chatRenderMs: z.number(),
  diffRenderMs: z.number(),
  mountedTimelineRows: z.number(),
  renderedDiffFiles: z.number(),
  renderedSelectedDiffPaths: z.number(),
  renderedDiffBodyLines: z.number(),
})

describe('perf gates', () => {
  it('keeps snapshot and detail hydration bounded on large histories', () => {
    const result = runTsxJson(
      'tests/perf/run-perf.ts',
      (output) => perfOutputSchema.parse(output),
    )
    expect(result.returnedTimelineRows).toBeLessThan(result.storedTimelineRows)
    expect(result.returnedTimelineRows).toBe(500)
    expect(result.returnedDiffs).toBe(50)
  }, 20_000)

  it('keeps large chat and diff renders bounded', () => {
    const result = runTsxJson(
      'tests/perf/run-client-render-perf.tsx',
      (output) => clientRenderPerfOutputSchema.parse(output),
    )
    expect(result.mountedTimelineRows).toBe(500)
    expect(result.renderedDiffFiles).toBeLessThanOrEqual(1)
    expect(result.renderedSelectedDiffPaths).toBeGreaterThanOrEqual(1)
    expect(result.renderedDiffBodyLines).toBeGreaterThanOrEqual(2)
  }, 20_000)
})
