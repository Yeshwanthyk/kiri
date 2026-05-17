import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import type { ProviderRuntimeAdapter } from '../../src/server/provider-runtime'
import { makeRuntimeRegistry } from '../../src/server/provider-runtime'
import {
  RuntimeCommandError,
  makeRuntimeCommands,
} from '../../src/server/runtime'
import { runTsxJson } from '../harness/run-tsx'

describe('runtime commands', () => {
  it.effect('dispatches through the injected runtime registry', () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const piAdapter: ProviderRuntimeAdapter = {
        prompt: (input) => {
          calls.push(`pi:${input.agentId}:${input.text}`)
          return Promise.resolve('pi-ok')
        },
      }
      const commands = makeRuntimeCommands({
        registry: makeRuntimeRegistry({
          pi: piAdapter,
          codex: { prompt: () => Promise.resolve('codex-ok') },
          claude: { prompt: () => Promise.resolve('claude-ok') },
          opencode: {},
        }),
        getLaunchConfig: () => ({ runtime: 'pi' }),
      })

      const result = yield* commands.prompt({ agentId: 'agent-1', text: 'hello' })

      expect(result).toBe('pi-ok')
      expect(calls).toEqual(['pi:agent-1:hello'])
    }),
  )

  it.effect('fails unsupported capabilities with a typed runtime command error', () =>
    Effect.gen(function* () {
      const commands = makeRuntimeCommands({
        registry: makeRuntimeRegistry({
          pi: { prompt: () => Promise.resolve(undefined) },
          codex: { prompt: () => Promise.resolve(undefined) },
          claude: {},
          opencode: {},
        }),
        getLaunchConfig: () => ({ runtime: 'claude' }),
      })

      const error = yield* commands.reset({ agentId: 'agent-1' }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(RuntimeCommandError)
      if (error instanceof RuntimeCommandError) {
        expect(error.message).toBe('claude agents do not support /new yet')
      }
    }),
  )

  it.effect('fails terminal-only prompts through the same typed command boundary', () =>
    Effect.gen(function* () {
      const commands = makeRuntimeCommands({
        registry: makeRuntimeRegistry({
          pi: { prompt: () => Promise.resolve(undefined) },
          codex: { prompt: () => Promise.resolve(undefined) },
          claude: {},
          opencode: {},
        }),
        getLaunchConfig: () => ({ runtime: 'claude' }),
      })

      const error = yield* commands.prompt({ agentId: 'agent-1', text: 'hello' }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(RuntimeCommandError)
      if (error instanceof RuntimeCommandError) {
        expect(error.message).toBe('Claude sessions run in terminal mode only')
      }
    }),
  )

  it.effect('fails OpenCode prompts as terminal-only', () =>
    Effect.gen(function* () {
      const commands = makeRuntimeCommands({
        registry: makeRuntimeRegistry({
          pi: { prompt: () => Promise.resolve(undefined) },
          codex: { prompt: () => Promise.resolve(undefined) },
          claude: {},
          opencode: {},
        }),
        getLaunchConfig: () => ({ runtime: 'opencode' }),
      })

      const error = yield* commands.prompt({ agentId: 'agent-1', text: 'hello' }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(RuntimeCommandError)
      if (error instanceof RuntimeCommandError) {
        expect(error.message).toBe('OpenCode sessions run in terminal mode only')
      }
    }),
  )

  it.effect('wraps adapter promise rejections in a typed runtime command error', () =>
    Effect.gen(function* () {
      const commands = makeRuntimeCommands({
        registry: makeRuntimeRegistry({
          pi: {
            prompt: () => Promise.reject(new Error('adapter exploded')),
          },
          codex: { prompt: () => Promise.resolve(undefined) },
          claude: {},
          opencode: {},
        }),
        getLaunchConfig: () => ({ runtime: 'pi' }),
      })

      const error = yield* commands.prompt({ agentId: 'agent-1', text: 'hello' }).pipe(
        Effect.flip,
      )

      expect(error).toBeInstanceOf(RuntimeCommandError)
      if (error instanceof RuntimeCommandError) {
        expect(error.message).toBe('adapter exploded')
      }
    }),
  )

  it('keeps public async exports rejecting with typed errors instead of FiberFailure', () => {
    const result = runTsxJson('tests/harness/runtime-command-public-harness.ts', (output) => z.object({
      ok: z.literal(true),
      ctor: z.string(),
      isError: z.literal(true),
      isRuntimeCommandError: z.literal(true),
      message: z.literal('claude agents do not support /new yet'),
    }).parse(output))

    expect(result.ctor).toBe('RuntimeCommandError')
  })
})
