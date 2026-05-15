import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { RuntimeRegistry, runtimeAdapters } from '../../src/server/provider-runtime'

describe('provider runtime registry', () => {
  it('exposes adapter capabilities by runtime kind', () => {
    expect(runtimeAdapters.pi.prompt).toBeTypeOf('function')
    expect(runtimeAdapters.pi.steer).toBeTypeOf('function')
    expect(runtimeAdapters.pi.interrupt).toBeTypeOf('function')
    expect(runtimeAdapters.pi.setThinkingLevel).toBeTypeOf('function')
    expect(runtimeAdapters.pi.reset).toBeTypeOf('function')
    expect(runtimeAdapters.pi.fork).toBeTypeOf('function')

    expect(runtimeAdapters.codex.prompt).toBeTypeOf('function')
    expect(runtimeAdapters.codex.steer).toBeTypeOf('function')
    expect(runtimeAdapters.codex.interrupt).toBeTypeOf('function')
    expect(runtimeAdapters.codex.setThinkingLevel).toBeTypeOf('function')
    expect(runtimeAdapters.codex.reset).toBeTypeOf('function')
    expect(runtimeAdapters.codex.review).toBeTypeOf('function')

    expect(runtimeAdapters.claude.prompt).toBeTypeOf('function')
    expect(runtimeAdapters.claude.steer).toBeUndefined()
    expect(runtimeAdapters.claude.interrupt).toBeUndefined()
    expect(runtimeAdapters.claude.setThinkingLevel).toBeUndefined()
    expect(runtimeAdapters.claude.reset).toBeUndefined()
    expect(runtimeAdapters.claude.answerQuestion).toBeUndefined()
  })

  it('rejects chat prompts for terminal-only Claude sessions', async () => {
    await expect(runtimeAdapters.claude.prompt({ agentId: 'agent-1', text: 'hello' }))
      .rejects.toThrow('Claude sessions run in terminal mode only')
  })

  it.effect('exposes the registry as an Effect service', () =>
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry
      const codex = yield* registry.get('codex')
      expect(codex.prompt).toBeTypeOf('function')
    }).pipe(Effect.provide(RuntimeRegistry.layer)),
  )
})
