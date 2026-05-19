import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runPnpmJson } from '../harness/run-tsx'

const harnessOutputSchema = z.object({
  ok: z.literal(true),
  checked: z.array(z.string()),
  messages: z.array(z.object({
    id: z.string(),
    role: z.string(),
    text: z.string(),
    timestamp: z.string(),
  })),
  preview: z.string(),
  messageCount: z.number(),
  cursorUuid: z.string(),
  cursorOffset: z.number(),
})

describe('Claude agent detail harness', () => {
  it('hydrates Claude JSONL before returning agent.detail', () => {
    const result = runPnpmJson(
      ['--silent', 'tsx', 'tests/harness/kiri-claude-agent-detail-harness.ts'],
      (output) => harnessOutputSchema.parse(output),
    )

    expect(result).toMatchObject({
      ok: true,
      preview: 'Second Claude answer',
      messageCount: 2,
      cursorUuid: 'uuid-2',
    })
    expect(result.messages.map((message) => message.text)).toEqual([
      'First Claude answer',
      'Second Claude answer',
    ])
    expect(result.checked).toEqual(expect.arrayContaining([
      'agent-detail-hydrates-claude-jsonl',
      'agent-detail-returns-parsed-claude-messages',
      'agent-detail-updates-thread-summary',
      'agent-detail-persists-claude-cursor',
    ]))
  }, 20_000)
})
