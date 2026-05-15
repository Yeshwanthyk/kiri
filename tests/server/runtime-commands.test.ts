import { describe, expect, it } from '@effect/vitest'
import { execFileSync } from 'node:child_process'
import { Effect } from 'effect'
import { z } from 'zod'
import type { ProviderRuntimeAdapter } from '../../src/server/provider-runtime'
import { makeRuntimeRegistry } from '../../src/server/provider-runtime'
import {
  RuntimeCommandError,
  makeRuntimeCommands,
} from '../../src/server/runtime'

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
          claude: { prompt: () => Promise.resolve(undefined) },
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

  it.effect('wraps adapter promise rejections in a typed runtime command error', () =>
    Effect.gen(function* () {
      const commands = makeRuntimeCommands({
        registry: makeRuntimeRegistry({
          pi: {
            prompt: () => Promise.reject(new Error('adapter exploded')),
          },
          codex: { prompt: () => Promise.resolve(undefined) },
          claude: { prompt: () => Promise.resolve(undefined) },
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
    const output = execFileSync(
      'pnpm',
      ['exec', 'tsx', 'tests/harness/runtime-command-public-harness.ts'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )
    const result = z.object({
      ok: z.literal(true),
      ctor: z.string(),
      isError: z.literal(true),
      isRuntimeCommandError: z.literal(true),
      message: z.literal('claude agents do not support /new yet'),
    }).parse(JSON.parse(output))

    expect(result.ctor).toBe('RuntimeCommandError')
  })
})
