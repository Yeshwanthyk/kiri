import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
  makeRuntimeRegistry,
  RuntimeRegistry,
  RuntimeRegistryError,
  runtimeAdapters,
} from '../../src/server/provider-runtime'
import { RuntimeBinariesService } from '../../src/server/runtime-binaries'

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
    expect(runtimeAdapters.codex.answerQuestion).toBeTypeOf('function')

    expect(runtimeAdapters.claude.prompt).toBeUndefined()
    expect(runtimeAdapters.claude.steer).toBeUndefined()
    expect(runtimeAdapters.claude.interrupt).toBeUndefined()
    expect(runtimeAdapters.claude.setThinkingLevel).toBeUndefined()
    expect(runtimeAdapters.claude.reset).toBeUndefined()
    expect(runtimeAdapters.claude.answerQuestion).toBeUndefined()

    expect(runtimeAdapters.opencode.prompt).toBeUndefined()
    expect(runtimeAdapters.opencode.steer).toBeUndefined()
    expect(runtimeAdapters.opencode.interrupt).toBeUndefined()
    expect(runtimeAdapters.opencode.setThinkingLevel).toBeUndefined()
    expect(runtimeAdapters.opencode.reset).toBeUndefined()
    expect(runtimeAdapters.opencode.answerQuestion).toBeUndefined()
  })

  it.effect('exposes the registry as an Effect service', () =>
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry
      const codex = yield* registry.get('codex')
      if (!codex.prompt) throw new Error('Expected Codex prompt adapter')
      expect(codex.prompt).toBeTypeOf('function')
    }).pipe(Effect.provide(RuntimeRegistry.liveLayer)),
  )

  it.effect('builds Codex runtime adapters from injected runtime binaries', () =>
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry
      const codex = yield* registry.get('codex')
      expect(codex.prompt).toBeTypeOf('function')
    }).pipe(Effect.provide(RuntimeRegistry.layer.pipe(
      Layer.provide(Layer.succeed(RuntimeBinariesService, {
        resolveExecutable: (input) => {
          throw new Error(`unexpected resolve: ${JSON.stringify(input)}`)
        },
        processEnv: () => Effect.succeed({
          PATH: '/bin',
          KIRI_CODEX_APP_SERVER_URL: 'ws://127.0.0.1:65535',
        }),
      })),
    ))),
  )

  it.effect('routes cleanup through the injected registry cleanup handlers', () =>
    Effect.gen(function* () {
      const cleaned: string[] = []
      const registry = makeRuntimeRegistry(runtimeAdapters, {
        codex: (agentId) => {
          cleaned.push(`codex:${agentId}`)
        },
      })

      yield* registry.forget('codex', 'agent-1')
      yield* registry.forget('claude', 'agent-2')
      yield* registry.forget('opencode', 'agent-3')

      expect(cleaned).toEqual(['codex:agent-1'])
    }),
  )

  it.effect('wraps cleanup failures in typed registry errors', () =>
    Effect.gen(function* () {
      const registry = makeRuntimeRegistry(runtimeAdapters, {
        pi: () => {
          throw new Error('cleanup exploded')
        },
      })

      const error = yield* registry.forget('pi', 'agent-1').pipe(Effect.flip)

      expect(error).toBeInstanceOf(RuntimeRegistryError)
      expect(error.message).toBe('cleanup exploded')
      expect(error.runtime).toBe('pi')
      expect(error.agentId).toBe('agent-1')
    }),
  )
})
