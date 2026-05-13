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

  it('projects Pi task tool calls into latest task state', () => {
    const projection = projectPiSessionJsonl([
      JSON.stringify({
        type: 'message',
        id: 'task-create-1',
        timestamp: '2026-05-11T12:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall',
            name: 'TaskCreate',
            arguments: {
              subject: 'Inspect current task flow',
              description: 'Find the current state',
            },
          }],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'task-create-2',
        timestamp: '2026-05-11T12:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall',
            name: 'TaskCreate',
            arguments: {
              subject: 'Render task strip',
            },
          }],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'task-update-1',
        timestamp: '2026-05-11T12:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall',
            name: 'TaskUpdate',
            arguments: {
              taskId: '1',
              status: 'in_progress',
            },
          }],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'task-update-2',
        timestamp: '2026-05-11T12:00:03.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall',
            name: 'TaskUpdate',
            arguments: {
              taskId: '1',
              status: 'completed',
            },
          }],
        },
      }),
    ].join('\n'))

    expect(projection.tasks).toEqual([
      {
        id: '1',
        title: 'Inspect current task flow',
        status: 'completed',
        source: 'pi',
        updatedAt: '2026-05-11T12:00:03.000Z',
      },
      {
        id: '2',
        title: 'Render task strip',
        status: 'pending',
        source: 'pi',
        updatedAt: '2026-05-11T12:00:01.000Z',
      },
    ])
  })

  it('projects an empty Pi task list as a clear', () => {
    const projection = projectPiSessionJsonl([
      JSON.stringify({
        type: 'message',
        id: 'task-create-1',
        timestamp: '2026-05-11T12:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall',
            name: 'TaskCreate',
            arguments: {
              subject: 'Temporary task',
            },
          }],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'task-list-empty',
        timestamp: '2026-05-11T12:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall',
            name: 'TaskList',
            arguments: {
              tasks: [],
            },
          }],
        },
      }),
    ].join('\n'))

    expect(projection.tasks).toEqual([])
  })
})
