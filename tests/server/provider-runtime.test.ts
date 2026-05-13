import { describe, expect, it } from 'vitest'
import { runtimeAdapters } from '../../src/server/provider-runtime'

describe('provider runtime registry', () => {
  it('exposes adapter capabilities by runtime kind', () => {
    expect(runtimeAdapters.pi).toMatchObject({
      prompt: expect.any(Function),
      steer: expect.any(Function),
      interrupt: expect.any(Function),
      setThinkingLevel: expect.any(Function),
      reset: expect.any(Function),
      fork: expect.any(Function),
    })
    expect(runtimeAdapters.codex).toMatchObject({
      prompt: expect.any(Function),
      steer: expect.any(Function),
      interrupt: expect.any(Function),
      setThinkingLevel: expect.any(Function),
      reset: expect.any(Function),
      review: expect.any(Function),
    })
    expect(runtimeAdapters.claude).toMatchObject({
      prompt: expect.any(Function),
      steer: expect.any(Function),
      interrupt: expect.any(Function),
      setThinkingLevel: expect.any(Function),
      reset: expect.any(Function),
      answerQuestion: expect.any(Function),
    })
  })
})
