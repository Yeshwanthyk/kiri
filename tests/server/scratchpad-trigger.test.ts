import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

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
    const output = execFileSync(
      'pnpm',
      ['exec', 'tsx', 'tests/harness/scratchpad-trigger-harness.ts'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )
    expect(harnessOutputSchema.parse(JSON.parse(output))).toMatchObject({
      ok: true,
    })
  }, 20_000)
})
