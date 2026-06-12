import { Effect, Either, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import type { AgentDetail, WorkspaceSnapshot } from '~/lib/contracts'
import { defaultUiPreferences } from '~/lib/ui-preferences'
import {
  makeWorkspaceService,
  WorkspaceService,
  type WorkspaceServiceDependencies,
} from '~/server/workspace-service'
import { UiPreferencesService } from '~/server/preferences'
import { TerminalServerService } from '~/server/terminal-server'

const snapshot: WorkspaceSnapshot = {
  settings: {
    runtimes: {
      pi: { models: ['sonnet'], defaultModel: 'sonnet' },
      codex: { models: ['gpt-5.3-codex'], defaultModel: 'gpt-5.3-codex' },
      claude: { models: ['sonnet'], defaultModel: 'sonnet' },
      opencode: { models: ['opencode/gpt-5.5'], defaultModel: 'opencode/gpt-5.5' },
    },
  },
  preferences: defaultUiPreferences,
  projects: [],
  hiddenProjects: [],
  archivedSessions: [],
  scratchpadBlocks: [],
  selected: { projectId: '', agentId: '' },
}

const agentDetail: AgentDetail = {
  id: 'agent-1',
  projectId: 'project-1',
  slot: 'session-a-aaaaaa',
  title: 'Agent',
  runtime: 'pi',
  interfaceMode: 'gui',
  model: 'sonnet',
  status: 'idle',
  sessionDir: '/tmp/session',
  sessionFile: null,
  preview: 'Ready.',
  messageCount: 0,
  diffCount: 0,
  contextUsage: null,
  pendingQuestion: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  isSession: true,
  messages: [],
  timelineEvents: [],
  timeline: [],
  diffs: [],
  tasks: [],
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
      refreshReadModels: () => {
        calls.push('read-models')
        return []
      },
    }))

    await expect(Effect.runPromise(service.sendMessage({
      agentId: 'agent-1',
      text: 'hello',
      images: [],
    }))).resolves.toBe(snapshot)

    expect(calls).toEqual(['prompt:agent-1:hello', 'read-models', 'snapshot'])
  })

  it('returns a cheap workspace revision without hydrating the full snapshot', async () => {
    const calls: string[] = []
    const service = makeWorkspaceService(testDependencies({
      getWorkspaceRevision: () => {
        calls.push('revision')
        return { revision: 'rev-1' }
      },
      getWorkspaceSnapshot: () => {
        calls.push('snapshot')
        return snapshot
      },
    }))

    await expect(Effect.runPromise(service.revision())).resolves.toEqual({ revision: 'rev-1' })

    expect(calls).toEqual(['revision'])
  })

  it('does not refresh read models before full snapshot hydration', async () => {
    const calls: string[] = []
    const service = makeWorkspaceService(testDependencies({
      refreshReadModels: () => {
        calls.push('read-models')
        return []
      },
      getWorkspaceSnapshot: () => {
        calls.push('snapshot')
        return snapshot
      },
    }))

    await expect(Effect.runPromise(service.snapshot())).resolves.toBe(snapshot)

    expect(calls).toEqual(['snapshot'])
  })

  it('does not refresh read models before agent detail hydration', async () => {
    const calls: string[] = []
    const service = makeWorkspaceService(testDependencies({
      refreshReadModels: () => {
        calls.push('read-models')
        return []
      },
      getAgentDetail: (input) => {
        calls.push(`detail:${input.agentId}`)
        return agentDetail
      },
    }))

    await expect(Effect.runPromise(
      service.agentDetail({ agentId: 'agent-1', limit: 500, offset: 0 }),
    )).resolves.toBe(agentDetail)

    expect(calls).toEqual(['detail:agent-1'])
  })

  it('refreshes read models after sync snapshot mutations', async () => {
    const calls: string[] = []
    const service = makeWorkspaceService(testDependencies({
      addProject: (input) => {
        calls.push(`add:${input.name}`)
        return snapshot
      },
      refreshReadModels: () => {
        calls.push('read-models')
        return []
      },
    }))

    await expect(Effect.runPromise(service.addProject({
      name: 'Project',
      cwd: '/tmp/project',
    }))).resolves.toBe(snapshot)

    expect(calls).toEqual(['add:Project', 'read-models'])
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
      prepareTerminalAgent: () => Promise.resolve(),
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

  it('runs preference writes through Effect dependencies', async () => {
    const calls: string[] = []
    const preferences = {
      ...defaultUiPreferences,
      theme: { name: 'rosepine', mode: 'light' } as const,
    }
    const service = makeWorkspaceService(testDependencies({
      setThemePreference: (theme) =>
        Effect.sync(() => {
          calls.push(`${theme.name}:${theme.mode}`)
          return preferences
        }),
    }))

    await expect(Effect.runPromise(service.setThemePreference({
      name: 'rosepine',
      mode: 'light',
    }))).resolves.toBe(preferences)

    expect(calls).toEqual(['rosepine:light'])
  })

  it('lets callers provide workspace terminal and preference services', async () => {
    const calls: string[] = []
    const terminalLayer = Layer.succeed(TerminalServerService, {
      ensure: () => {
        calls.push('terminal')
        return Promise.resolve({
          host: '127.0.0.1',
          port: 12345,
          path: '/provided',
          token: 'provided-token',
        })
      },
      spawnAgentRuntime: () => Promise.resolve({
        agentId: 'agent-1',
        mode: 'runtime' as const,
      }),
      closeAgentRuntime: () => undefined,
      prepareAgent: () => Promise.resolve(),
      close: () => Promise.resolve(),
    })
    const preferencesLayer = Layer.succeed(UiPreferencesService, {
      get: Effect.succeed(defaultUiPreferences),
      setTheme: (theme) => Effect.sync(() => {
        calls.push(`theme:${theme.name}`)
        return { ...defaultUiPreferences, theme }
      }),
      setKeymap: () => Effect.succeed(defaultUiPreferences),
      setChatTypography: () => Effect.succeed(defaultUiPreferences),
      setAgentByProject: () => Effect.succeed(defaultUiPreferences),
    })
    const layer = WorkspaceService.layer.pipe(
      Layer.provide(Layer.mergeAll(terminalLayer, preferencesLayer)),
    )

    const preferences = await Effect.runPromise(Effect.gen(function* () {
      const workspace = yield* WorkspaceService
      return yield* workspace.setThemePreference({ name: 'tokyonight', mode: 'dark' })
    }).pipe(Effect.provide(layer)))

    expect(preferences.theme).toEqual({ name: 'tokyonight', mode: 'dark' })
    expect(calls).toEqual(['theme:tokyonight'])
  })
})

function testDependencies(
  overrides: Partial<WorkspaceServiceDependencies> = {},
): WorkspaceServiceDependencies {
  return {
    getWorkspaceSnapshot: () => snapshot,
    getWorkspaceRevision: () => ({ revision: 'rev-1' }),
    refreshReadModels: () => [],
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
    setThemePreference: () => Effect.succeed(defaultUiPreferences),
    setKeymapPreference: () => Effect.succeed(defaultUiPreferences),
    setChatTypographyPreference: () => Effect.succeed(defaultUiPreferences),
    setAgentByProjectPreference: () => Effect.succeed(defaultUiPreferences),
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
    prepareTerminalAgent: () => Promise.resolve(),
    refreshTerminalSessionDiffs: () => snapshot,
    startSession: () => snapshot,
    addScratchpadBlock: () => snapshot,
    deleteScratchpadBlock: () => snapshot,
    triggerScratchpadSession: () => Promise.resolve({ agentId: 'agent-1' }),
    ...overrides,
  }
}
