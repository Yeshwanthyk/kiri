import { Effect } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type {
  AgentTask,
  KnowledgeEntry,
  KiriSettings,
  ScratchpadBlock,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import { defaultUiPreferences } from '~/lib/ui-preferences'
import {
  makeKiriControl,
  type KiriControlDependencies,
} from '~/server/kiri-control'

const settings: KiriSettings = {
  runtimes: {
    pi: { models: ['sonnet'], defaultModel: 'sonnet', contextWindows: { sonnet: 200_000 } },
    codex: { models: ['gpt-5.3-codex'], defaultModel: 'gpt-5.3-codex' },
    claude: { models: ['sonnet'], defaultModel: 'sonnet' },
    opencode: { models: ['opencode/gpt-5.5'], defaultModel: 'opencode/gpt-5.5' },
  },
}

const scratchpadBlock: ScratchpadBlock = {
  id: 'block-1',
  projectId: 'project-1',
  projectName: 'Project',
  body: 'Build it',
  createdAt: '2026-01-01T00:00:00.000Z',
  triggeredAt: null,
  triggeredAgentId: null,
}

const knowledgeEntry: KnowledgeEntry = {
  id: 'knowledge-1',
  projectId: 'project-1',
  title: 'Cached build fix',
  problem: 'Build cache points at a stale bundle.',
  answer: 'Clear the stale bundle and rerun the build.',
  tags: ['build'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: null,
  seenCount: 0,
}

const snapshot: WorkspaceSnapshot = {
  settings,
  preferences: defaultUiPreferences,
  projects: [{
    id: 'project-1',
    name: 'Project',
    cwd: '/tmp/project',
    position: 0,
    hiddenAt: null,
    agents: [{
      id: 'agent-1',
      projectId: 'project-1',
      slot: 'session-1',
      title: 'Session',
      runtime: 'codex',
      interfaceMode: 'gui',
      model: 'gpt-5.3-codex',
      status: 'idle',
      sessionDir: '/tmp/session',
      sessionFile: null,
      preview: 'Ready',
      messageCount: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      isSession: true,
      contextUsage: null,
      pendingQuestion: null,
      messages: [],
      timelineEvents: [],
      timeline: [],
      tasks: [],
    }],
  }],
  hiddenProjects: [],
  archivedSessions: [],
  scratchpadBlocks: [scratchpadBlock],
  knowledgeEntries: [knowledgeEntry],
  selected: { projectId: 'project-1', agentId: 'agent-1' },
}

describe('KiriControl service construction', () => {
  it('builds context and model choices from injected dependencies', async () => {
    const control = makeKiriControl(testDependencies())

    const context = await Effect.runPromise(control.getContext())
    const models = await Effect.runPromise(control.listModels('pi'))

    expect(context.selectedProject?.id).toBe('project-1')
    expect(context.selectedSession?.id).toBe('agent-1')
    expect(context.scratchpadCount).toBe(1)
    expect(models).toEqual([{
      runtime: 'pi',
      model: 'sonnet',
      isDefault: true,
      contextWindow: 200_000,
    }])
  })

  it('routes delete operations through injected cleanup dependencies', async () => {
    const calls: string[] = []
    const control = makeKiriControl(testDependencies({
      deleteProjectSummary: (id) => {
        calls.push(`deleteProject:${id}`)
        return projectSummary(id)
      },
      archiveSessionSummary: (input) => {
        calls.push(`deleteSession:${input.agentId}`)
        return sessionSummary(input.agentId)
      },
    }))

    await expect(Effect.runPromise(control.deleteProject('project-1')))
      .resolves.toMatchObject({ id: 'project-1' })
    await expect(Effect.runPromise(control.deleteSession('agent-1')))
      .resolves.toMatchObject({ id: 'agent-1' })
    expect(calls).toEqual(['deleteProject:project-1', 'deleteSession:agent-1'])
  })

  it('routes scratchpad trigger through the injected shared trigger path', async () => {
    const calls: string[] = []
    const control = makeKiriControl(testDependencies({
      triggerScratchpadSession: (input) => {
        calls.push(`trigger:${input.id}:${input.projectId}`)
        return Promise.resolve({
          agentId: 'agent-2',
          session: sessionSummary('agent-2'),
          block: scratchpadBlock,
        })
      },
    }))

    const result = await Effect.runPromise(control.triggerScratchpad({
      id: 'block-1',
      projectId: 'project-1',
      interfaceMode: 'gui',
      thinkingLevel: 'medium',
    }))

    expect(result.agentId).toBe('agent-2')
    expect(result.session.id).toBe('agent-2')
    expect(calls).toEqual(['trigger:block-1:project-1'])
  })

  it('routes status and task projection writes through injected dependencies', async () => {
    const calls: string[] = []
    const tasks: AgentTask[] = [{
      id: 'todo-1',
      title: 'Wire hooks',
      status: 'inProgress',
      source: 'claude',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }]
    const control = makeKiriControl(testDependencies({
      setAgentStatus: (agentId, status) => {
        calls.push(`status:${agentId}:${status}`)
      },
      replaceAgentTasks: (input) => {
        calls.push(`tasks:${input.agentId}:${input.source}:${input.tasks.length}:${input.updatedAt}`)
      },
    }))

    await expect(Effect.runPromise(control.setAgentStatus({
      agentId: 'agent-1',
      status: 'running',
    }))).resolves.toEqual({
      agentId: 'agent-1',
      status: 'running',
    })
    await expect(Effect.runPromise(control.replaceAgentTasks({
      agentId: 'agent-1',
      source: 'claude',
      tasks,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }))).resolves.toEqual({
      agentId: 'agent-1',
      source: 'claude',
      tasks,
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(calls).toEqual([
      'status:agent-1:running',
      'tasks:agent-1:claude:1:2026-01-01T00:00:00.000Z',
    ])
  })

  it('routes workflow operations through injected dependencies', async () => {
    const calls: string[] = []
    const control = makeKiriControl(testDependencies({
      validateWorkflow: (input) => {
        calls.push(`validate:${input.title}`)
        return { valid: true }
      },
      createWorkflowRun: (input) => {
        calls.push(`create:${input.items.length}`)
        return { id: 'workflow-1' }
      },
      dispatchWorkflowRun: (input) => {
        calls.push(`dispatch:${input.id}`)
        return Promise.resolve({ id: input.id, status: 'running' })
      },
      retriggerWorkflowItem: (input) => {
        calls.push(`retrigger:${input.itemId}`)
        return Promise.resolve({ itemId: input.itemId, status: 'launched' })
      },
    }))
    const workflowInput = {
      projectId: 'project-1',
      title: 'Workflow',
      defaults: { attachScratchpad: true },
      items: [{
        action: 'launch' as const,
        title: 'Build',
        body: 'Build it',
        tracked: true,
      }],
    }

    await expect(Effect.runPromise(control.validateWorkflow(workflowInput)))
      .resolves.toMatchObject({ valid: true })
    await expect(Effect.runPromise(control.createWorkflowRun(workflowInput)))
      .resolves.toMatchObject({ id: 'workflow-1' })
    await expect(Effect.runPromise(control.dispatchWorkflowRun({ id: 'workflow-1' })))
      .resolves.toMatchObject({ status: 'running' })
    await expect(Effect.runPromise(control.retriggerWorkflowItem({ itemId: 'item-1' })))
      .resolves.toMatchObject({ status: 'launched' })
    expect(calls).toEqual([
      'validate:Workflow',
      'create:1',
      'dispatch:workflow-1',
      'retrigger:item-1',
    ])
  })

  it('routes knowledge operations through selected-project defaults', async () => {
    const calls: string[] = []
    const control = makeKiriControl(testDependencies({
      searchKnowledgeEntries: (input) => {
        calls.push(`search:${input.projectId}:${input.query}`)
        return [knowledgeEntry]
      },
      addKnowledgeEntry: (input) => {
        calls.push(`add:${input.projectId}:${input.title}`)
        return { ...knowledgeEntry, title: input.title }
      },
      markKnowledgeEntrySeen: (input) => {
        calls.push(`seen:${input.id}`)
        return { ...knowledgeEntry, id: input.id, seenCount: 1 }
      },
    }))

    await expect(Effect.runPromise(control.searchKnowledge({ query: 'cache', limit: 10 })))
      .resolves.toEqual([knowledgeEntry])
    await expect(Effect.runPromise(control.addKnowledge({
      title: 'New fix',
      problem: 'Problem',
      answer: 'Answer',
      tags: [],
    }))).resolves.toMatchObject({ title: 'New fix' })
    await expect(Effect.runPromise(control.markKnowledgeSeen({ id: 'knowledge-1' })))
      .resolves.toMatchObject({ seenCount: 1 })

    expect(calls).toEqual([
      'search:project-1:cache',
      'add:project-1:New fix',
      'seen:knowledge-1',
    ])
  })

  it('wraps injected sync failures with the original message', async () => {
    const control = makeKiriControl(testDependencies({
      listProjectSummaries: () => {
        throw new Error('Project list failed')
      },
    }))

    await expect(Effect.runPromise(control.listProjects()))
      .rejects.toMatchObject({ message: 'Project list failed' })
  })

  it('wraps injected async scratchpad trigger failures with the original message', async () => {
    const control = makeKiriControl(testDependencies({
      triggerScratchpadSession: () => Promise.reject(new Error('Trigger failed')),
    }))

    await expect(Effect.runPromise(control.triggerScratchpad({
      id: 'block-1',
      projectId: 'project-1',
      interfaceMode: 'gui',
      thinkingLevel: 'medium',
    }))).rejects.toMatchObject({ message: 'Trigger failed' })
  })

  it('routes terminal control operations to the session owner with resolved keys', async () => {
    const requests: Array<{ route: string; body: unknown }> = []
    const control = makeKiriControl(testDependencies({
      terminalControlRequest: (route, body) => {
        requests.push({ route, body })
        return Promise.resolve({ ok: true })
      },
    }))

    await Effect.runPromise(control.terminalRead({ agentId: 'agent-1', mode: 'runtime' }))
    await Effect.runPromise(control.terminalRead({ agentId: 'agent-1', mode: 'shell' }))
    await Effect.runPromise(control.terminalKeys({
      agentId: 'agent-1',
      mode: 'shell',
      keys: ['up', 'enter'],
    }))
    await Effect.runPromise(control.terminalWaitFor({
      agentId: 'agent-1',
      mode: 'shell',
      pattern: 'done',
      flags: '',
      timeoutMs: 5_000,
      scope: 'screen',
    }))
    await Effect.runPromise(control.terminalKill({ agentId: 'agent-1', mode: 'shell' }))
    await Effect.runPromise(control.terminalList())

    expect(requests).toEqual([
      { route: 'sessions/read', body: { key: 'agent-1:runtime' } },
      // Shell sessions are keyed by the agent's project.
      { route: 'sessions/read', body: { key: 'project-1:shell' } },
      { route: 'sessions/input', body: { key: 'project-1:shell', keys: ['up', 'enter'] } },
      {
        route: 'sessions/wait-for',
        body: {
          key: 'project-1:shell',
          pattern: 'done',
          flags: '',
          timeoutMs: 5_000,
          scope: 'screen',
          followReplacement: true,
        },
      },
      { route: 'sessions/kill', body: { key: 'project-1:shell' } },
      { route: 'sessions', body: undefined },
    ])
  })

  it('spawns runtime terminals through the existing paste path', async () => {
    const control = makeKiriControl(testDependencies())
    await expect(Effect.runPromise(control.terminalSpawn({ agentId: 'agent-9' })))
      .resolves.toEqual({ agentId: 'agent-9', mode: 'runtime' })
  })

  it('preserves direct terminal input invariants across submit and spawn flags', async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        text: fc.array(fc.constantFrom('a', 'b', ' ', '-', '_'), { minLength: 1, maxLength: 24 })
          .map((chars) => chars.join('').trim() || 'x'),
        submit: fc.boolean(),
        spawn: fc.boolean(),
        spawnFails: fc.boolean(),
      }),
      async (shape) => {
        const calls: string[] = []
        const control = makeKiriControl(testDependencies({
          queueAgentTerminalInput: (input) => {
            calls.push(`queue:${input.agentId}:${input.text}:${input.submit}`)
          },
          pasteAgentRuntimeTerminal: (input) => {
            calls.push(`spawn:${input.agentId}`)
            return shape.spawnFails
              ? Promise.reject(new Error('spawn failed'))
              : Promise.resolve({ agentId: input.agentId, mode: 'runtime' as const })
          },
        }))

        const result = await Effect.runPromise(control.terminalInput({
          agentId: 'agent-1',
          text: shape.text,
          submit: shape.submit,
          spawn: shape.spawn,
        }))

        expect(result).toEqual({
          accepted: true,
          agentId: 'agent-1',
          queued: true,
          spawned: shape.spawn && !shape.spawnFails,
        })
        expect(calls).toEqual([
          `queue:agent-1:${shape.text}:${shape.submit}`,
          ...(shape.spawn ? ['spawn:agent-1'] : []),
        ])
      },
    ), { numRuns: 40 })
  })

  it('acknowledges agent.prompt without waiting for the turn to finish', async () => {
    const control = makeKiriControl(testDependencies({
      agentPromptAcceptanceWindowMs: 20,
      // Resolves long after the acceptance window; the control surface must
      // not hold the response open for the turn.
      promptAgent: () => new Promise((resolve) => setTimeout(resolve, 5_000)),
    }))
    const result = await Effect.runPromise(
      control.agentPrompt({ agentId: 'agent-1', text: 'hello', images: [], mode: 'prompt' }),
    )
    expect(result).toEqual({ accepted: true, agentId: 'agent-1', mode: 'prompt' })
  }, 1_000)

  it('spawns sessions and delivers the first turn through the selected interface', async () => {
    const calls: string[] = []
    const control = makeKiriControl(testDependencies({
      startSessionSummary: (input) => ({
        ...sessionSummary(input.interfaceMode === 'terminal' ? 'agent-terminal' : 'agent-gui'),
        title: input.title ?? 'Session',
        interfaceMode: input.interfaceMode ?? 'gui',
      }),
      promptAgent: (input) => {
        calls.push(`prompt:${input.agentId}:${input.text}`)
        return Promise.resolve({})
      },
      queueAgentTerminalInput: (input) => {
        calls.push(`queue:${input.agentId}:${input.text}:${input.submit}`)
      },
      pasteAgentRuntimeTerminal: (input) => {
        calls.push(`spawn:${input.agentId}`)
        return Promise.resolve({ agentId: input.agentId, mode: 'runtime' as const })
      },
    }))

    await expect(Effect.runPromise(control.spawnSession({
      projectId: 'project-1',
      runtime: 'codex',
      interfaceMode: 'gui',
      title: 'GUI Spawn',
      text: 'first gui turn',
    }))).resolves.toMatchObject({
      session: { id: 'agent-gui', title: 'GUI Spawn' },
      delivery: {
        kind: 'agentPrompt',
        accepted: true,
        agentId: 'agent-gui',
        mode: 'prompt',
      },
    })

    await expect(Effect.runPromise(control.spawnSession({
      projectId: 'project-1',
      runtime: 'codex',
      interfaceMode: 'terminal',
      title: 'Terminal Spawn',
      text: 'first terminal turn',
      terminalSubmit: false,
    }))).resolves.toMatchObject({
      session: { id: 'agent-terminal', title: 'Terminal Spawn' },
      delivery: {
        kind: 'terminal',
        accepted: true,
        agentId: 'agent-terminal',
        queued: true,
        spawned: true,
      },
    })

    expect(calls).toEqual([
      'prompt:agent-gui:first gui turn',
      'queue:agent-terminal:first terminal turn:false',
      'spawn:agent-terminal',
    ])
  })

  it('surfaces prompt validation failures that reject inside the acceptance window', async () => {
    const control = makeKiriControl(testDependencies({
      promptAgent: () => Promise.reject(new Error('unknown agent agent-404')),
    }))
    await expect(Effect.runPromise(
      control.agentPrompt({ agentId: 'agent-404', text: 'hello', images: [], mode: 'prompt' }),
    )).rejects.toThrow('unknown agent agent-404')
  })
})

function testDependencies(
  overrides: Partial<KiriControlDependencies> = {},
): KiriControlDependencies {
  return {
    getWorkspaceSnapshot: () => snapshot,
    getSettings: () => settings,
    listProjectSummaries: () => [projectSummary('project-1')],
    addProjectSummary: (input) => projectSummary(input.id ?? 'project-1'),
    hideProjectSummary: (id) => projectSummary(id, true),
    unhideProjectSummary: (id) => projectSummary(id),
    deleteProjectSummary: (id) => projectSummary(id),
    listSessionSummaries: () => [sessionSummary('agent-1')],
    listAgentEvents: () => [],
    getAgentDetail: () => snapshot.projects[0]?.agents[0] ?? (() => {
      throw new Error('Missing test agent')
    })(),
    startSessionSummary: () => sessionSummary('agent-1'),
    renameSessionSummary: (input) => ({ ...sessionSummary(input.agentId), title: input.title }),
    archiveSessionSummary: (input) => ({ ...sessionSummary(input.agentId), archivedAt: '2026-01-01T00:00:01.000Z' }),
    restoreSessionSummary: (input) => sessionSummary(input.agentId),
    promptAgent: () => Promise.resolve({}),
    steerAgent: () => Promise.resolve({}),
    setAgentStatus: () => undefined,
    replaceAgentTasks: () => undefined,
    queueAgentTerminalInput: () => undefined,
    pasteAgentRuntimeTerminal: (input) => Promise.resolve({ agentId: input.agentId, mode: 'runtime' as const }),
    getAgentLaunchConfig: (agentId) => ({
      id: agentId,
      projectId: 'project-1',
      runtime: 'codex' as const,
      sessionDir: '/tmp/session',
      sessionFile: null,
      model: 'gpt-5.3-codex',
      cwd: '/tmp/project',
      runtimeStateJson: null,
    }),
    terminalControlRequest: () => Promise.resolve({}),
    callerAgentId: () => null,
    listScratchpadBlocks: () => [scratchpadBlock],
    searchKnowledgeEntries: () => [knowledgeEntry],
    addKnowledgeEntry: (input) => ({ ...knowledgeEntry, projectId: input.projectId, title: input.title }),
    markKnowledgeEntrySeen: (input) => ({ ...knowledgeEntry, id: input.id, seenCount: 1 }),
    addScratchpadBlockSummary: (input) => ({ ...scratchpadBlock, body: input.body }),
    deleteScratchpadBlockSummary: (id) => ({ ...scratchpadBlock, id }),
    triggerScratchpadSession: () => Promise.resolve({
      agentId: 'agent-1',
      session: sessionSummary('agent-1'),
      block: scratchpadBlock,
    }),
    listWorkflowRuns: () => [],
    getWorkflowRun: (id) => ({ id }),
    validateWorkflow: () => ({ valid: true }),
    createWorkflowRun: () => ({ id: 'workflow-1' }),
    dispatchWorkflowRun: (input) => Promise.resolve({ id: input.id, status: 'running' }),
    retriggerWorkflowItem: (input) => Promise.resolve({ itemId: input.itemId, status: 'launched' }),
    trackWorkflowItem: (input) => ({ itemId: input.itemId, tracked: true }),
    untrackWorkflowItem: (input) => ({ itemId: input.itemId, tracked: false }),
    archiveWorkflowRun: (input) => ({ id: input.id, status: 'archived' }),
    restoreWorkflowRun: (input) => ({ id: input.id, status: 'running' }),
    ...overrides,
  }
}

function projectSummary(id: string, hidden = false) {
  return {
    id,
    name: 'Project',
    cwd: '/tmp/project',
    hidden,
    sessionCount: 1,
  }
}

function sessionSummary(id: string) {
  return {
    id,
    projectId: 'project-1',
    projectName: 'Project',
    title: 'Session',
    runtime: 'codex' as const,
    interfaceMode: 'gui' as const,
    model: 'gpt-5.3-codex',
    status: 'idle' as const,
    preview: 'Ready',
    messageCount: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
  }
}
