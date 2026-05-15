import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  type KiriMcpContext,
  makeKiriMcpRuntimeService,
} from '~/server/kiri-mcp-runtime'

const baseContext: KiriMcpContext = {
  selectedProject: null,
  selectedSession: null,
  projects: [],
  sessions: [],
  scratchpadCount: 0,
}

describe('KiriMcpRuntimeService', () => {
  it('runs control effects and attaches fresh context to mutation results', async () => {
    const runtime = makeKiriMcpRuntimeService({
      getContext: () => Effect.succeed({
        ...baseContext,
        scratchpadCount: 2,
      }),
    })

    await expect(runtime.run(Effect.succeed('ok'))).resolves.toBe('ok')
    await expect(runtime.withContext({ id: 'result-1' })).resolves.toMatchObject({
      result: { id: 'result-1' },
      context: { scratchpadCount: 2 },
    })
  })

  it('resolves the selected session id from context', async () => {
    const runtime = makeKiriMcpRuntimeService({
      getContext: () => Effect.succeed({
        ...baseContext,
        selectedSession: {
          id: 'session-1',
          projectId: 'project-1',
          projectName: 'Project',
          title: 'Session',
          runtime: 'pi',
          interfaceMode: 'gui',
          model: 'model',
          status: 'idle',
          preview: '',
          messageCount: 0,
          updatedAt: '2026-01-01T00:00:00.000Z',
          archivedAt: null,
        },
      }),
    })

    await expect(runtime.selectedSessionId()).resolves.toBe('session-1')
  })

  it('rejects default-selected session operations without selected context', async () => {
    const runtime = makeKiriMcpRuntimeService({
      getContext: () => Effect.succeed(baseContext),
    })

    await expect(runtime.selectedSessionId()).rejects.toThrow('No selected session available')
  })
})
