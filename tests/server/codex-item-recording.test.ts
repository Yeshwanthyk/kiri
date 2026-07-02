import { describe, expect, it } from 'vitest'
import { codexItemRecord } from '~/server/codex-item-recording'

describe('Codex item recording', () => {
  it('formats assistant messages with stable ids', () => {
    expect(codexItemRecord('agent-1', {
      id: 'item-1',
      type: 'agentMessage',
      text: 'done',
    }, '2026-05-16T04:00:00.000Z')).toEqual({
      type: 'message',
      value: {
        agentId: 'agent-1',
        id: 'codex-agent-1-item-1',
        role: 'assistant',
        text: 'done',
        timestamp: '2026-05-16T04:00:00.000Z',
      },
    })
  })

  it('formats reasoning summaries and content into one timeline detail', () => {
    expect(codexItemRecord('agent-1', {
      id: 'item-2',
      type: 'reasoning',
      summary: ['looked'],
      content: ['decided'],
    }, '2026-05-16T04:00:00.000Z')).toEqual({
      type: 'timelineEvent',
      value: {
        agentId: 'agent-1',
        kind: 'codex_reasoning',
        tone: 'thinking',
        label: 'Reasoning',
        detail: 'looked\ndecided',
        payload: {
          id: 'item-2',
          type: 'reasoning',
          summary: ['looked'],
          content: ['decided'],
        },
        timestamp: '2026-05-16T04:00:00.000Z',
      },
    })
  })

  it('keeps command execution output formatting stable', () => {
    expect(codexItemRecord('agent-1', {
      id: 'item-3',
      type: 'commandExecution',
      command: 'pnpm test',
      aggregatedOutput: 'ok',
    }, '2026-05-16T04:00:00.000Z')).toEqual({
      type: 'message',
      value: {
        agentId: 'agent-1',
        id: 'codex-agent-1-item-3',
        role: 'tool',
        text: 'pnpm test\nok',
        timestamp: '2026-05-16T04:00:00.000Z',
      },
    })
  })

  it('records unsupported items as explicit timeline events', () => {
    expect(codexItemRecord('agent-1', { id: 'item-4', type: 'webSearch' }, 'now')).toEqual({
      type: 'timelineEvent',
      value: {
        agentId: 'agent-1',
        kind: 'codex_unrecognized_item',
        tone: 'info',
        label: 'Unrecognized item: webSearch',
        detail: null,
        payload: { id: 'item-4', type: 'webSearch' },
        timestamp: 'now',
      },
    })
  })

  it('ignores incomplete items', () => {
    expect(codexItemRecord('agent-1', { type: 'agentMessage', text: 'missing id' }, 'now')).toBeNull()
  })
})
