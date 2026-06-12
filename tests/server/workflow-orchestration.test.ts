import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  dispatchWorkflowRun,
  type WorkflowDispatchDependencies,
} from '~/server/workflow-orchestration'

type WorkflowRun = ReturnType<WorkflowDispatchDependencies['getWorkflowRun']>
type WorkflowItem = WorkflowRun['items'][number]
type WorkflowAttempt = WorkflowItem['attempts'][number]

const now = '2026-01-01T00:00:00.000Z'

describe('workflow orchestration', () => {
  it('delivers GUI workflow bodies through agent.prompt before checking in the item', async () => {
    const run = workflowRun(launchItem({
      interfaceMode: 'gui',
      body: 'implement the thing',
    }))
    const harness = workflowHarness(run)

    const result = await dispatchWorkflowRun({ id: run.id }, harness.dependencies)

    expect(harness.prompts).toEqual([{
      agentId: 'agent-1',
      text: 'implement the thing',
      images: [],
    }])
    expect(harness.attempts).toEqual([{
      itemId: 'item-1',
      agentId: 'agent-1',
      status: 'launched',
    }])
    expect(result).toMatchObject({
      launched: 1,
      failed: 0,
      results: [{
        status: 'launched',
        agentId: 'agent-1',
        terminalPaste: null,
        terminalSpawn: null,
        prompt: {
          accepted: true,
          agentId: 'agent-1',
          mode: 'prompt',
        },
      }],
    })
  })

  it('marks GUI workflow launch failed when the prompt is rejected immediately', async () => {
    const run = workflowRun(launchItem({
      interfaceMode: 'gui',
      body: 'bad prompt',
    }))
    const harness = workflowHarness(run, {
      promptAgent: () => Promise.reject(new Error('prompt rejected')),
    })

    const result = await dispatchWorkflowRun({ id: run.id }, harness.dependencies)

    expect(harness.attempts).toEqual([{
      itemId: 'item-1',
      status: 'failed',
      error: 'prompt rejected',
    }])
    expect(result).toMatchObject({
      launched: 0,
      failed: 1,
      results: [{
        status: 'failed',
        error: 'prompt rejected',
      }],
    })
  })

  it('keeps terminal workflow delivery on the terminal paste queue', async () => {
    const run = workflowRun(launchItem({
      interfaceMode: 'terminal',
      body: 'terminal body',
      terminalPaste: { submit: false },
    }))
    const harness = workflowHarness(run)

    const result = await dispatchWorkflowRun({ id: run.id }, harness.dependencies)

    expect(harness.prompts).toEqual([])
    expect(harness.queuedTerminalInputs).toEqual([{
      agentId: 'agent-1',
      text: 'terminal body',
      submit: false,
    }])
    expect(result).toMatchObject({
      launched: 1,
      failed: 0,
      results: [{
        status: 'launched',
        terminalPaste: {
          queued: true,
          submitted: false,
          bytes: 'terminal body'.length,
        },
        terminalSpawn: null,
        prompt: null,
      }],
    })
  })

  it('preserves dispatch delivery invariants across launch item shapes', async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        interfaceMode: fc.constantFrom('gui' as const, 'terminal' as const),
        tracked: fc.boolean(),
        terminalSubmit: fc.boolean(),
        spawnTerminal: fc.boolean(),
        promptRejects: fc.boolean(),
      }),
      async (shape) => {
        const previousSpawn = process.env.KIRI_WORKFLOW_SPAWN_TERMINALS
        process.env.KIRI_WORKFLOW_SPAWN_TERMINALS = shape.spawnTerminal ? '1' : '0'
        try {
          const body = `body-${shape.interfaceMode}-${shape.terminalSubmit}`
          const run = workflowRun(launchItem({
            interfaceMode: shape.interfaceMode,
            body,
            tracked: shape.tracked,
            terminalPaste: { submit: shape.terminalSubmit },
          }))
          const harness = workflowHarness(run, {}, { promptRejects: shape.promptRejects })

          const result = await dispatchWorkflowRun({ id: run.id }, harness.dependencies)
          const first = result.results[0]

          if (!shape.tracked) {
            expect(first).toMatchObject({ status: 'skipped', reason: 'untracked' })
            expect(harness.events).toEqual([])
            return
          }

          if (shape.interfaceMode === 'gui') {
            expect(harness.queuedTerminalInputs).toEqual([])
            expect(harness.prompts).toEqual([{ agentId: 'agent-1', text: body, images: [] }])
            if (shape.promptRejects) {
              expect(harness.events).toEqual(['start', 'prompt', 'attempt:failed'])
              expect(first).toMatchObject({ status: 'failed', error: 'prompt rejected' })
              return
            }
            expect(harness.events).toEqual(['start', 'prompt', 'attempt:launched'])
            expect(first).toMatchObject({
              status: 'launched',
              terminalPaste: null,
              terminalSpawn: null,
              prompt: { accepted: true, agentId: 'agent-1', mode: 'prompt' },
            })
            return
          }

          expect(harness.prompts).toEqual([])
          expect(harness.queuedTerminalInputs).toEqual([{
            agentId: 'agent-1',
            text: body,
            submit: shape.terminalSubmit,
          }])
          expect(harness.events).toEqual([
            'start',
            'queue',
            ...(shape.spawnTerminal ? ['spawn'] : []),
            'attempt:launched',
          ])
          expect(first).toMatchObject({
            status: 'launched',
            terminalPaste: {
              queued: true,
              submitted: shape.terminalSubmit,
              bytes: body.length + (shape.terminalSubmit ? 1 : 0),
            },
            prompt: null,
          })
        } finally {
          if (previousSpawn === undefined) {
            delete process.env.KIRI_WORKFLOW_SPAWN_TERMINALS
          } else {
            process.env.KIRI_WORKFLOW_SPAWN_TERMINALS = previousSpawn
          }
        }
      },
    ), { numRuns: 50 })
  })
})

function workflowHarness(
  initialRun: WorkflowRun,
  overrides: Partial<WorkflowDispatchDependencies> = {},
  options: { readonly promptRejects?: boolean } = {},
) {
  let run = initialRun
  const events: string[] = []
  const attempts: Array<{
    readonly itemId: string
    readonly agentId?: string | null
    readonly status: 'launched' | 'failed'
    readonly error?: string | null
  }> = []
  const prompts: Array<{
    readonly agentId: string
    readonly text: string
    readonly images?: readonly unknown[]
  }> = []
  const queuedTerminalInputs: Array<{
    readonly agentId: string
    readonly text: string
    readonly submit: boolean
  }> = []

  const dependencies: WorkflowDispatchDependencies = {
    getWorkflowRun: () => run,
    completeScratchpadWorkflowItem: (itemId) => {
      const item = run.items.find((candidate) => candidate.id === itemId)
      if (!item) throw new Error(`missing item ${itemId}`)
      return { ...item, status: 'completed' }
    },
    startSessionSummary: (input) => {
      events.push('start')
      return {
        id: 'agent-1',
        projectId: input.projectId,
        projectName: 'Project',
        title: input.title ?? 'Session',
        runtime: input.runtime ?? 'codex',
        interfaceMode: input.interfaceMode ?? 'gui',
        model: input.model ?? 'gpt-5.5',
        status: 'idle',
        preview: 'Ready.',
        messageCount: 0,
        updatedAt: now,
        archivedAt: null,
      }
    },
    queueAgentTerminalInput: (input) => {
      events.push('queue')
      queuedTerminalInputs.push(input)
    },
    pasteAgentRuntimeTerminal: (input) => {
      events.push('spawn')
      return Promise.resolve({ agentId: input.agentId, mode: 'runtime' })
    },
    promptAgent: (input) => {
      events.push('prompt')
      prompts.push(input)
      if (options.promptRejects) return Promise.reject(new Error('prompt rejected'))
      return Promise.resolve()
    },
    recordWorkflowItemAttempt: (input) => {
      events.push(`attempt:${input.status}`)
      attempts.push(input)
      const attempt: WorkflowAttempt = {
        id: `attempt-${attempts.length}`,
        itemId: input.itemId,
        agentId: input.agentId ?? null,
        status: input.status,
        error: input.error ?? null,
        createdAt: now,
        completedAt: now,
      }
      run = {
        ...run,
        status: input.status === 'failed' ? 'failed' : 'running',
        items: run.items.map((item) =>
          item.id === input.itemId
            ? {
              ...item,
              activeAgentId: input.agentId ?? item.activeAgentId,
              status: input.status === 'failed' ? 'failed' : 'running',
              error: input.error ?? null,
              attempts: [...item.attempts, attempt],
            }
            : item),
      }
      return attempt
    },
    ...overrides,
  }

  return {
    events,
    attempts,
    prompts,
    queuedTerminalInputs,
    dependencies,
  }
}

function workflowRun(item: WorkflowItem): WorkflowRun {
  return {
    id: 'workflow-1',
    projectId: 'project-1',
    projectName: 'Project',
    title: 'Workflow',
    status: 'validated',
    itemCount: 1,
    launchedCount: 0,
    failedCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    items: [item],
  }
}

function launchItem(overrides: Partial<WorkflowItem> = {}): WorkflowItem {
  return {
    id: 'item-1',
    runId: 'workflow-1',
    position: 0,
    clientId: 'impl',
    action: 'launch',
    title: 'Implement',
    body: 'implement',
    runtime: 'codex',
    interfaceMode: 'gui',
    model: 'gpt-5.5',
    thinkingLevel: 'medium',
    terminalPaste: { submit: true },
    scratchpadBlockId: null,
    activeAgentId: null,
    tracked: true,
    status: 'pending',
    error: null,
    createdAt: now,
    updatedAt: now,
    attempts: [],
    ...overrides,
  }
}
