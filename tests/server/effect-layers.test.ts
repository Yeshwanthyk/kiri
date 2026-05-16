import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runTsxJson } from '../harness/run-tsx'

const harnessOutputSchema = z.object({
  ok: z.literal(true),
  dbOpen: z.literal(true),
  defaultPiModel: z.string().min(1),
  runtimeKinds: z.array(z.string()).min(3),
  codexPromptRegistered: z.literal(true),
})

describe('Effect service layers', () => {
  it('wires DB, settings, and runtime registry through testable layers', () => {
    const result = runTsxJson(
      'tests/harness/effect-layers.ts',
      (output) => harnessOutputSchema.parse(output),
    )
    expect(result.runtimeKinds).toEqual(['claude', 'codex', 'pi'])
  }, 20_000)
})
