import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runTsxJson } from '../harness/run-tsx'

const harnessOutputSchema = z.object({
  ok: z.literal(true),
  terminalPromptCalls: z.literal(0),
  failedPromptCalls: z.literal(1),
  terminalTriggered: z.literal(true),
  failedSessionArchived: z.literal(true),
  failedRuntimeStateCleaned: z.literal(true),
})

describe('scratchpad trigger semantics', () => {
  it('uses one trigger path for terminal and gui sessions', () => {
    expect(runTsxJson(
      'tests/harness/scratchpad-trigger-harness.ts',
      (output) => harnessOutputSchema.parse(output),
    )).toMatchObject({
      ok: true,
    })
  }, 20_000)
})
