import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  makePiJsonlFileService,
  PiJsonlFileError,
  projectPiSessionFile,
} from '~/server/pi-jsonl-file'

describe('PiJsonlFileService', () => {
  it('reads a session file through an injected file boundary', async () => {
    const calls: string[] = []
    const service = makePiJsonlFileService({
      readFile: (path) => {
        calls.push(`read:${path}`)
        return JSON.stringify({
          type: 'message',
          id: 'message-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'hello' },
        })
      },
      projectJsonl: (content) => {
        calls.push(`project:${content.length}`)
        return {
          messages: [{
            id: 'message-1',
            role: 'user',
            text: 'hello',
            timestamp: '2026-01-01T00:00:00.000Z',
          }],
          tasks: [],
          preview: 'hello',
        }
      },
    })

    const projection = await Effect.runPromise(service.projectFile('/tmp/session.jsonl'))

    expect(projection.preview).toBe('hello')
    expect(calls[0]).toBe('read:/tmp/session.jsonl')
    expect(calls[1]).toMatch(/^project:\d+$/)
  })

  it('wraps injected projection failures in the file-service error type', async () => {
    const cause = new Error('bad projection')
    const service = makePiJsonlFileService({
      readFile: () => 'not-jsonl',
      projectJsonl: () => {
        throw cause
      },
    })

    const result = await Effect.runPromise(
      Effect.either(service.projectFile('/tmp/session.jsonl')),
    )

    expect(result).toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'PiJsonlFileError',
        cause,
        message: 'bad projection',
      } satisfies Partial<PiJsonlFileError>,
    })
  })

  it('preserves normal Error shape through the compatibility export', () => {
    expect(() => projectPiSessionFile('/definitely/missing/pi-session.jsonl'))
      .toThrow(/ENOENT/)
  })
})
