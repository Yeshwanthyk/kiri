import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import type {
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
      diffCount: 0,
      contextUsage: null,
      pendingQuestion: null,
      messages: [],
      timelineEvents: [],
      timeline: [],
      diffs: [],
      tasks: [],
    }],
  }],
  hiddenProjects: [],
  archivedSessions: [],
  scratchpadBlocks: [scratchpadBlock],
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
      deleteSessionSummary: (input) => {
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
    startSessionSummary: () => sessionSummary('agent-1'),
    renameSessionSummary: (input) => ({ ...sessionSummary(input.agentId), title: input.title }),
    deleteSessionSummary: (input) => ({ ...sessionSummary(input.agentId), archivedAt: '2026-01-01T00:00:01.000Z' }),
    restoreSessionSummary: (input) => sessionSummary(input.agentId),
    listScratchpadBlocks: () => [scratchpadBlock],
    addScratchpadBlockSummary: (input) => ({ ...scratchpadBlock, body: input.body }),
    deleteScratchpadBlockSummary: (id) => ({ ...scratchpadBlock, id }),
    triggerScratchpadSession: () => Promise.resolve({
      agentId: 'agent-1',
      session: sessionSummary('agent-1'),
      block: scratchpadBlock,
    }),
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
