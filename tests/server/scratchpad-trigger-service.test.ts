import { Effect } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ScratchpadBlock } from '~/lib/contracts'
import {
  makeScratchpadTriggerService,
  type ScratchpadTriggerDependencies,
} from '~/server/scratchpad-trigger'

const block: ScratchpadBlock = {
  id: 'block-1',
  projectId: 'project-1',
  projectName: 'Project',
  body: 'Do the work',
  createdAt: '2026-01-01T00:00:00.000Z',
  triggeredAt: null,
  triggeredAgentId: null,
}

describe('ScratchpadTriggerService', () => {
  it('defaults codex scratchpad triggers to the configured GUI session mode', async () => {
    const calls: string[] = []
    const service = makeScratchpadTriggerService(testDependencies({
      startSessionAndGetId: (input) => {
        calls.push(`start:${input.runtime}:${input.interfaceMode}`)
        return 'agent-1'
      },
      queueAgentTerminalInput: (input) => {
        calls.push(`queue:${input.agentId}:${input.text}:${input.submit}`)
      },
      pasteAgentRuntimeTerminal: (input) => {
        calls.push(`spawn:${input.agentId}`)
        return Promise.resolve({ agentId: input.agentId, mode: 'runtime' })
      },
      promptAgent: () => {
        calls.push('prompt')
        return Promise.resolve()
      },
    }))

    await Effect.runPromise(service.trigger({
      id: 'block-1',
      projectId: 'project-1',
      runtime: 'codex',
    }))

    expect(calls).toEqual([
      'start:codex:gui',
      'prompt',
    ])
  })

  it('defaults Pi scratchpad triggers to terminal sessions', async () => {
    const calls: string[] = []
    const service = makeScratchpadTriggerService(testDependencies({
      startSessionAndGetId: (input) => {
        calls.push(`start:${input.runtime}:${input.interfaceMode}`)
        return 'agent-1'
      },
      queueAgentTerminalInput: (input) => {
        calls.push(`queue:${input.agentId}:${input.text}:${input.submit}`)
      },
      pasteAgentRuntimeTerminal: (input) => {
        calls.push(`spawn:${input.agentId}`)
        return Promise.resolve({ agentId: input.agentId, mode: 'runtime' })
      },
      promptAgent: () => {
        calls.push('prompt')
        return Promise.resolve()
      },
    }))

    await Effect.runPromise(service.trigger({
      id: 'block-1',
      projectId: 'project-1',
      runtime: 'pi',
    }))

    expect(calls).toEqual([
      'start:pi:terminal',
      'queue:agent-1:Do the work:true',
      'spawn:agent-1',
    ])
  })

  it('queues and spawns terminal sessions without prompting', async () => {
    const calls: string[] = []
    const service = makeScratchpadTriggerService(testDependencies({
      startSessionAndGetId: (input) => {
        calls.push(`start:${input.runtime}:${input.interfaceMode}`)
        return 'agent-1'
      },
      markScratchpadBlockTriggered: (id, agentId) => {
        calls.push(`mark:${id}:${agentId}`)
      },
      queueAgentTerminalInput: (input) => {
        calls.push(`queue:${input.agentId}:${input.text}:${input.submit}`)
      },
      pasteAgentRuntimeTerminal: (input) => {
        calls.push(`spawn:${input.agentId}`)
        return Promise.resolve({ agentId: input.agentId, mode: 'runtime' })
      },
      promptAgent: () => {
        calls.push('prompt')
        return Promise.resolve()
      },
    }))

    const result = await Effect.runPromise(service.trigger({
      id: 'block-1',
      projectId: 'project-1',
      runtime: 'codex',
      interfaceMode: 'terminal',
    }))

    expect(result.agentId).toBe('agent-1')
    expect(calls).toEqual([
      'start:codex:terminal',
      'queue:agent-1:Do the work:true',
      'spawn:agent-1',
      'mark:block-1:agent-1',
    ])
  })

  it('preserves scratchpad delivery invariants across GUI and terminal triggers', async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        interfaceMode: fc.constantFrom('gui' as const, 'terminal' as const),
        spawnTerminal: fc.boolean(),
      }),
      async (shape) => {
        const calls: string[] = []
        const service = makeScratchpadTriggerService(testDependencies({
          spawnTerminalOnTrigger: shape.spawnTerminal,
          startSessionAndGetId: (input) => {
            calls.push(`start:${input.runtime}:${input.interfaceMode}`)
            return 'agent-1'
          },
          markScratchpadBlockTriggered: (id, agentId) => {
            calls.push(`mark:${id}:${agentId}`)
          },
          queueAgentTerminalInput: (input) => {
            calls.push(`queue:${input.agentId}:${input.text}:${input.submit}`)
          },
          pasteAgentRuntimeTerminal: (input) => {
            calls.push(`spawn:${input.agentId}`)
            return Promise.resolve({ agentId: input.agentId, mode: 'runtime' })
          },
          promptAgent: (input) => {
            calls.push(`prompt:${input.agentId}:${input.text}`)
            return Promise.resolve()
          },
        }))

        await Effect.runPromise(service.trigger({
          id: 'block-1',
          projectId: 'project-1',
          runtime: 'codex',
          interfaceMode: shape.interfaceMode,
        }))

        if (shape.interfaceMode === 'gui') {
          expect(calls).toEqual([
            'start:codex:gui',
            'prompt:agent-1:Do the work',
            'mark:block-1:agent-1',
          ])
          return
        }

        expect(calls).toEqual([
          'start:codex:terminal',
          'queue:agent-1:Do the work:true',
          ...(shape.spawnTerminal ? ['spawn:agent-1'] : []),
          'mark:block-1:agent-1',
        ])
      },
    ), { numRuns: 40 })
  })

  it('archives the created gui session when prompt enqueue fails', async () => {
    const calls: string[] = []
    const service = makeScratchpadTriggerService(testDependencies({
      promptAgent: () => {
        calls.push('prompt')
        return Promise.reject(new Error('Prompt failed'))
      },
      archiveSessionSummary: (input) => {
        calls.push(`delete:${input.agentId}`)
      },
      reportPromptFailure: (error) => {
        calls.push(`report:${error instanceof Error ? error.message : String(error)}`)
      },
    }))

    await expect(Effect.runPromise(service.trigger({
      id: 'block-1',
      projectId: 'project-1',
      runtime: 'codex',
      interfaceMode: 'gui',
    }))).rejects.toMatchObject({ message: 'Prompt failed' })

    expect(calls).toEqual(['prompt', 'delete:agent-1', 'report:Prompt failed'])
  })

  it('archives the created session when marking the block as triggered fails', async () => {
    const calls: string[] = []
    const service = makeScratchpadTriggerService(testDependencies({
      startSessionAndGetId: () => {
        calls.push('start')
        return 'agent-1'
      },
      markScratchpadBlockTriggered: () => {
        calls.push('mark')
        throw new Error('Mark failed')
      },
      archiveSessionSummary: (input) => {
        calls.push(`delete:${input.agentId}`)
      },
      promptAgent: () => {
        calls.push('prompt')
        return Promise.resolve()
      },
    }))

    await expect(Effect.runPromise(service.trigger({
      id: 'block-1',
      projectId: 'project-1',
      runtime: 'codex',
      interfaceMode: 'gui',
    }))).rejects.toMatchObject({ message: 'Mark failed' })

    expect(calls).toEqual(['start', 'prompt', 'mark', 'delete:agent-1'])
  })

  it('archives terminal scratchpad sessions when terminal paste fails', async () => {
    const calls: string[] = []
    const service = makeScratchpadTriggerService(testDependencies({
      queueAgentTerminalInput: (input) => {
        calls.push(`queue:${input.agentId}`)
      },
      pasteAgentRuntimeTerminal: (input) => {
        calls.push(`spawn:${input.agentId}`)
        return Promise.reject(new Error('Paste failed'))
      },
      markScratchpadBlockTriggered: () => {
        calls.push('mark')
      },
      archiveSessionSummary: (input) => {
        calls.push(`delete:${input.agentId}`)
      },
      reportPromptFailure: (error) => {
        calls.push(`report:${error instanceof Error ? error.message : String(error)}`)
      },
    }))

    await expect(Effect.runPromise(service.trigger({
      id: 'block-1',
      projectId: 'project-1',
      runtime: 'codex',
      interfaceMode: 'terminal',
    }))).rejects.toMatchObject({ message: 'Paste failed' })

    expect(calls).toEqual([
      'queue:agent-1',
      'spawn:agent-1',
      'delete:agent-1',
      'report:Paste failed',
    ])
  })

  it('fails before creating a session when the scratchpad block is missing', async () => {
    const calls: string[] = []
    const service = makeScratchpadTriggerService(testDependencies({
      getScratchpadBlock: () => null,
      startSessionAndGetId: () => {
        calls.push('start')
        return 'agent-1'
      },
    }))

    await expect(Effect.runPromise(service.trigger({
      id: 'missing',
      projectId: 'project-1',
      runtime: 'codex',
      interfaceMode: 'gui',
    }))).rejects.toMatchObject({ message: 'Scratchpad block not found: missing' })
    expect(calls).toEqual([])
  })
})

function testDependencies(
  overrides: Partial<ScratchpadTriggerDependencies> = {},
): ScratchpadTriggerDependencies {
  return {
    getScratchpadBlock: () => block,
    startSessionAndGetId: () => 'agent-1',
    markScratchpadBlockTriggered: () => undefined,
    listSessionSummaries: () => [{
      id: 'agent-1',
      projectId: 'project-1',
      projectName: 'Project',
      title: 'Session',
      runtime: 'codex',
      interfaceMode: 'gui',
      model: 'gpt-5.3-codex',
      status: 'idle',
      preview: '',
      messageCount: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    }],
    archiveSessionSummary: () => undefined,
    promptAgent: () => Promise.resolve(),
    queueAgentTerminalInput: () => undefined,
    pasteAgentRuntimeTerminal: (input) => Promise.resolve({ agentId: input.agentId, mode: 'runtime' }),
    spawnTerminalOnTrigger: true,
    reportPromptFailure: () => undefined,
    ...overrides,
  }
}
