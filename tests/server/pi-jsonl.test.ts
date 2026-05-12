import { describe, expect, it } from 'vitest'
import { projectPiSessionJsonl } from '../../src/server/pi-jsonl'

describe('projectPiSessionJsonl', () => {
  it('does not project Pi tool-use placeholders as assistant messages', () => {
    const projection = projectPiSessionJsonl([
      JSON.stringify({
        type: 'message',
        id: 'user-1',
        timestamp: '2026-05-11T12:00:00.000Z',
        message: {
          role: 'user',
          content: 'change it',
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'assistant-tool',
        timestamp: '2026-05-11T12:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ name: 'edit', input: { path: 'src/app.ts' } }],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'assistant-text',
        timestamp: '2026-05-11T12:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ text: 'done' }],
        },
      }),
    ].join('\n'))

    expect(projection.messages).toEqual([
      {
        id: 'user-1',
        role: 'user',
        text: 'change it',
        timestamp: '2026-05-11T12:00:00.000Z',
      },
      {
        id: 'assistant-text',
        role: 'assistant',
        text: 'done',
        timestamp: '2026-05-11T12:00:02.000Z',
      },
    ])
  })
})
