import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const harnessOutputSchema = z.object({
  ok: z.literal(true),
  checked: z.array(z.string()),
  messages: z.number(),
  events: z.number(),
  timeline: z.number(),
  firstMessageId: z.string(),
  lastMessageId: z.string(),
})

describe('agent detail history harness', () => {
  it('loads full chat history with dense runtime events', () => {
    const output = execFileSync(
      'pnpm',
      ['--silent', 'aether:history-harness'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )
    const result = harnessOutputSchema.parse(JSON.parse(output))

    expect(result).toMatchObject({
      ok: true,
      messages: 620,
      events: 1860,
      timeline: 2480,
      firstMessageId: 'message-0',
      lastMessageId: 'message-619',
    })
    expect(result.checked).toEqual(expect.arrayContaining([
      'agent-detail-preserves-500-messages',
      'agent-detail-loads-all-messages',
      'agent-detail-keeps-runtime-events-for-the-message-window',
      'timeline-no-longer-slices-messages-out',
      'unmatched-diff-appears-in-work-row',
    ]))
  }, 20_000)
})
