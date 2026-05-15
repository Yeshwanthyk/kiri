import { describe, expect, it } from 'vitest'
import {
  TurnCompletedParamsSchema,
  decodeServerParams,
  parseResponse,
  parseServerMessage,
} from '~/server/codex-app-protocol'

describe('Codex app-server protocol helpers', () => {
  it('parses JSON-RPC responses without treating notifications as responses', () => {
    expect(parseResponse({
      id: 'request-1',
      result: { ok: true },
    })).toEqual({
      id: 'request-1',
      result: { ok: true },
      error: undefined,
    })

    expect(parseResponse({
      method: 'turn/completed',
      params: {},
    })).toBeNull()
  })

  it('preserves JSON-RPC error details', () => {
    expect(parseResponse({
      id: 7,
      error: {
        code: -32099,
        message: 'bad codex thing',
        data: { reason: 'shape drift' },
      },
    })).toEqual({
      id: 7,
      result: undefined,
      error: {
        code: -32099,
        message: 'bad codex thing',
        data: { reason: 'shape drift' },
      },
    })
  })

  it('parses server requests and notifications', () => {
    expect(parseServerMessage({
      id: 'server-request',
      method: 'tool/call',
      params: { name: 'shell' },
    })).toEqual({
      id: 'server-request',
      method: 'tool/call',
      params: { name: 'shell' },
    })

    expect(parseServerMessage({
      method: 'turn/completed',
      params: { threadId: 'thread-1' },
    })).toEqual({
      method: 'turn/completed',
      params: { threadId: 'thread-1' },
    })
  })

  it('decodes known notification params and rejects malformed params', () => {
    const valid = parseServerMessage({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', items: [] },
      },
    })
    const invalid = parseServerMessage({
      method: 'turn/completed',
      params: {
        turn: { id: 'turn-1', status: 'completed' },
      },
    })

    expect(valid && decodeServerParams(valid, TurnCompletedParamsSchema)).toEqual({
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    })
    expect(invalid && decodeServerParams(invalid, TurnCompletedParamsSchema)).toBeUndefined()
  })
})
