import { describe, expect, it } from 'vitest'
import { projectClaudeSessionJsonl } from '~/server/claude-jsonl'

describe('Claude JSONL projection', () => {
  it('projects assistant text messages and ignores metadata', () => {
    const projection = projectClaudeSessionJsonl({
      sessionId: 'session-1',
      content: [
        JSON.stringify({ type: 'permission-mode', sessionId: 'session-1' }),
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-05-18T12:00:00.000Z',
          message: { role: 'user', content: 'hello' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1',
          timestamp: '2026-05-18T12:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'First line' },
              { type: 'tool_use', name: 'Bash' },
              { type: 'text', text: 'Second line' },
            ],
          },
        }),
      ].join('\n') + '\n',
    })

    expect(projection.messages).toEqual([{
      id: 'claude:session-1:assistant-1',
      role: 'assistant',
      text: 'First line\nSecond line',
      timestamp: '2026-05-18T12:00:01.000Z',
    }])
    expect(projection.nextState.claudeLastSeenUuid).toBe('assistant-1')
  })

  it('skips entries through the last seen UUID', () => {
    const projection = projectClaudeSessionJsonl({
      sessionId: 'session-1',
      afterUuid: 'assistant-1',
      content: [
        assistantLine('assistant-1', 'old'),
        assistantLine('assistant-2', 'new'),
      ].join('\n') + '\n',
    })

    expect(projection.messages.map((message) => message.text)).toEqual(['new'])
    expect(projection.nextState.claudeLastSeenUuid).toBe('assistant-2')
  })

  it('tracks the byte offset after projected lines', () => {
    const first = `${assistantLine('assistant-1', 'old')}\n`
    const second = `${assistantLine('assistant-2', 'new 🚀')}\n`

    const projection = projectClaudeSessionJsonl({
      sessionId: 'session-1',
      afterUuid: 'assistant-1',
      offset: Buffer.byteLength(first, 'utf8'),
      content: second,
    })

    expect(projection.messages.map((message) => message.text)).toEqual(['new 🚀'])
    expect(projection.nextState.claudeLastSeenOffset).toBe(
      Buffer.byteLength(first + second, 'utf8'),
    )
  })

  it('treats zero offset as UUID scan mode', () => {
    const projection = projectClaudeSessionJsonl({
      sessionId: 'session-1',
      afterUuid: 'assistant-1',
      offset: 0,
      content: [
        assistantLine('assistant-0', 'pre'),
        assistantLine('assistant-1', 'old'),
        assistantLine('assistant-2', 'post'),
      ].join('\n') + '\n',
    })

    expect(projection.messages.map((message) => message.text)).toEqual(['post'])
    expect(projection.nextState.claudeLastSeenUuid).toBe('assistant-2')
  })

  it('preserves cursor state when a full scan cannot find the last seen UUID', () => {
    const projection = projectClaudeSessionJsonl({
      sessionId: 'session-1',
      afterUuid: 'missing',
      content: [
        assistantLine('assistant-1', 'old'),
        assistantLine('assistant-2', 'new'),
      ].join('\n') + '\n',
    })

    expect(projection.messages).toEqual([])
    expect(projection.nextState).toEqual({ claudeLastSeenUuid: 'missing' })
  })

  it('does not consume incomplete trailing lines', () => {
    const complete = `${assistantLine('assistant-1', 'old')}\n`
    const partial = assistantLine('assistant-2', 'new').slice(0, -3)

    const projection = projectClaudeSessionJsonl({
      sessionId: 'session-1',
      offset: Buffer.byteLength(complete, 'utf8'),
      content: partial,
    })

    expect(projection.messages).toEqual([])
    expect(projection.nextState.claudeLastSeenOffset).toBe(
      Buffer.byteLength(complete, 'utf8'),
    )
  })
})

function assistantLine(uuid: string, text: string) {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-05-18T12:00:01.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  })
}
