import { Effect, Either } from 'effect'
import { describe, expect, it } from 'vitest'
import type { WorkspaceSnapshot } from '~/lib/contracts'
import { defaultUiPreferences } from '~/lib/ui-preferences'
import {
  makeWorkspaceService,
  type WorkspaceServiceDependencies,
} from '~/server/workspace-service'

const snapshot: WorkspaceSnapshot = {
  settings: {
    runtimes: {
      pi: { models: ['sonnet'], defaultModel: 'sonnet' },
      codex: { models: ['gpt-5.3-codex'], defaultModel: 'gpt-5.3-codex' },
      claude: { models: ['sonnet'], defaultModel: 'sonnet' },
    },
  },
  preferences: defaultUiPreferences,
  projects: [],
  hiddenProjects: [],
  archivedSessions: [],
  scratchpadBlocks: [],
  selected: { projectId: '', agentId: '' },
}

describe('WorkspaceService', () => {
  it('returns a fresh snapshot after runtime commands complete', async () => {
    const calls: string[] = []
    const service = makeWorkspaceService(testDependencies({
      promptAgent: (input) => {
        calls.push(`prompt:${input.agentId}:${input.text}`)
        return Promise.resolve()
      },
      getWorkspaceSnapshot: () => {
        calls.push('snapshot')
        return snapshot
      },
    }))

    await expect(Effect.runPromise(service.sendMessage({
      agentId: 'agent-1',
      text: 'hello',
      images: [],
    }))).resolves.toBe(snapshot)

    expect(calls).toEqual(['prompt:agent-1:hello', 'snapshot'])
  })

  it('returns forked agent id with the post-fork snapshot', async () => {
    const calls: string[] = []
    const service = makeWorkspaceService(testDependencies({
      forkAgentSession: (input) => {
        calls.push(`fork:${input.agentId}`)
        return Promise.resolve('agent-2')
      },
      getWorkspaceSnapshot: () => {
        calls.push('snapshot')
        return snapshot
      },
    }))

    const result = await Effect.runPromise(service.forkSession({ agentId: 'agent-1' }))

    expect(result).toEqual({ agentId: 'agent-2', snapshot })
    expect(calls).toEqual(['fork:agent-1', 'snapshot'])
  })

  it('merges terminal server config with runtime launch config', async () => {
    const service = makeWorkspaceService(testDependencies({
      getAgentLaunchConfig: (agentId) => ({
        id: agentId,
        projectId: 'project-1',
        runtime: 'codex',
        sessionDir: '/tmp/session',
        sessionFile: null,
        model: 'gpt-5.3-codex',
        runtimeStateJson: null,
        cwd: '/tmp/project',
      }),
      ensureTerminalServer: () => Promise.resolve({
        host: '127.0.0.1',
        port: 12000,
        path: '/term',
        token: 'token',
      }),
    }))

    await expect(Effect.runPromise(service.terminalConfig({
      agentId: 'agent-1',
      mode: 'runtime',
    }))).resolves.toEqual({
      host: '127.0.0.1',
      port: 12000,
      path: '/term',
      token: 'token',
      mode: 'runtime',
      runtime: 'codex',
      model: 'gpt-5.3-codex',
    })
  })

  it('returns scratchpad trigger id with the post-trigger snapshot', async () => {
    const calls: string[] = []
    const service = makeWorkspaceService(testDependencies({
      triggerScratchpadSession: (input) => {
        calls.push(`trigger:${input.id}:${input.projectId}`)
        return Promise.resolve({ agentId: 'agent-1' })
      },
      getWorkspaceSnapshot: () => {
        calls.push('snapshot')
        return snapshot
      },
    }))

    const result = await Effect.runPromise(service.triggerScratchpadBlock({
      id: 'block-1',
      projectId: 'project-1',
      interfaceMode: 'gui',
      thinkingLevel: 'medium',
    }))

    expect(result).toEqual({ agentId: 'agent-1', snapshot })
    expect(calls).toEqual(['trigger:block-1:project-1', 'snapshot'])
  })

  it('wraps dependency failures while preserving the original cause', async () => {
    const failure = new Error('Prompt failed')
    const service = makeWorkspaceService(testDependencies({
      promptAgent: () => Promise.reject(failure),
    }))

    const result = await Effect.runPromise(
      service.sendMessage({ agentId: 'agent-1', text: 'hello', images: [] }).pipe(Effect.either),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.message).toBe('Prompt failed')
      expect(result.left.cause).toBe(failure)
    }
  })
})

function testDependencies(
  overrides: Partial<WorkspaceServiceDependencies> = {},
): WorkspaceServiceDependencies {
  return {
    getWorkspaceSnapshot: () => snapshot,
    getAgentDetail: () => {
      throw new Error('getAgentDetail not implemented')
    },
    addProject: () => snapshot,
    deleteProject: () => snapshot,
    hideProject: () => snapshot,
    reorderProjects: () => snapshot,
    unhideProject: () => snapshot,
    chooseProjectDirectory: () => '/tmp/project',
    deleteSession: () => snapshot,
    restoreSession: () => snapshot,
    renameSession: () => snapshot,
    promptAgent: () => Promise.resolve(),
    steerAgent: () => Promise.resolve(),
    interruptAgent: () => Promise.resolve(),
    setAgentThinkingLevel: () => Promise.resolve(),
    setThemePreference: () => defaultUiPreferences,
    setKeymapPreference: () => defaultUiPreferences,
    setChatTypographyPreference: () => defaultUiPreferences,
    setAgentByProjectPreference: () => defaultUiPreferences,
    resetAgentSession: () => Promise.resolve(),
    forkAgentSession: () => Promise.resolve('agent-2'),
    reviewAgentSession: () => Promise.resolve(),
    answerAgentQuestion: () => Promise.resolve(),
    getAgentLaunchConfig: () => {
      throw new Error('getAgentLaunchConfig not implemented')
    },
    ensureTerminalServer: () => Promise.resolve({
      host: '127.0.0.1',
      port: 12000,
      path: '/term',
      token: 'token',
    }),
    refreshTerminalSessionDiffs: () => snapshot,
    startSession: () => snapshot,
    addScratchpadBlock: () => snapshot,
    deleteScratchpadBlock: () => snapshot,
    triggerScratchpadSession: () => Promise.resolve({ agentId: 'agent-1' }),
    ...overrides,
  }
}
