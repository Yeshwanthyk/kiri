import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const harnessOutputSchema = z.object({
  ok: z.literal(true),
  checked: z.array(z.string()),
  requestedLimit: z.number(),
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
      ['--silent', 'kiri:history-harness'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )
    const result = harnessOutputSchema.parse(JSON.parse(output))

    expect(result).toMatchObject({
      ok: true,
      requestedLimit: 500,
      messages: 125,
      events: 375,
      timeline: 500,
      firstMessageId: 'message-495',
      lastMessageId: 'message-619',
    })
    expect(result.checked).toEqual(expect.arrayContaining([
      'agent-detail-enforces-timeline-limit',
      'agent-detail-returns-latest-page',
      'agent-detail-keeps-events-inside-returned-page',
      'agent-detail-derives-message-arrays-from-page',
      'unmatched-diff-appears-in-work-row',
    ]))
  }, 20_000)
})
