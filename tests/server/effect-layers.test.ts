import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const harnessOutputSchema = z.object({
  ok: z.literal(true),
  dbOpen: z.literal(true),
  defaultPiModel: z.string().min(1),
  runtimeKinds: z.array(z.string()).min(3),
  codexPromptRegistered: z.literal(true),
})

describe('Effect service layers', () => {
  it('wires DB, settings, and runtime registry through testable layers', () => {
    const output = execFileSync(
      'pnpm',
      ['exec', 'tsx', 'tests/harness/effect-layers.ts'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )
    const result = harnessOutputSchema.parse(JSON.parse(output))
    expect(result.runtimeKinds).toEqual(['claude', 'codex', 'pi'])
  }, 20_000)
})
