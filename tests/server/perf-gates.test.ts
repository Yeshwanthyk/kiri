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
  heapUsedDeltaMb: z.number(),
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

const terminalRenderPerfOutputSchema = z.object({
  ok: z.literal(true),
  patches: z.number(),
  renderMs: z.number(),
  avgRenderMsPerPatch: z.number(),
  renderedRows: z.number(),
  renderedRunSpans: z.number(),
  htmlBytes: z.number(),
  finalRows: z.number(),
  finalScreenSeq: z.number(),
  heapUsedDeltaMb: z.number(),
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

  it('keeps terminal patch application bounded', () => {
    const result = runTsxJson(
      'tests/perf/run-terminal-render-perf.ts',
      (output) => terminalRenderPerfOutputSchema.parse(output),
    )
    expect(result.patches).toBe(2_000)
    expect(result.finalRows).toBe(30)
    expect(result.finalScreenSeq).toBe(2_000)
    expect(result.renderMs).toBeLessThan(1_000)
    expect(result.avgRenderMsPerPatch).toBeLessThan(1)
    expect(result.renderedRunSpans).toBeGreaterThanOrEqual(result.patches)
  }, 20_000)
})
