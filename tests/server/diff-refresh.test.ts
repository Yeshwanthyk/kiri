import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from '@effect/vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import type { WorkspaceSnapshot } from '../../src/lib/contracts'
import { defaultUiPreferences } from '../../src/lib/ui-preferences'
import {
  DiffRefreshError,
  makeDiffRefreshService,
} from '../../src/server/diff-refresh'
import { GitDiffError } from '../../src/server/git-diff'

function workspaceSnapshot(): WorkspaceSnapshot {
  return {
    settings: {
      runtimes: {
        pi: { models: ['pi-model'], defaultModel: 'pi-model' },
        codex: { models: ['codex-model'], defaultModel: 'codex-model' },
        claude: { models: ['claude-model'], defaultModel: 'claude-model' },
      },
    },
    preferences: defaultUiPreferences,
    projects: [],
    hiddenProjects: [],
    archivedSessions: [],
    scratchpadBlocks: [],
    selected: {
      projectId: '',
      agentId: '',
    },
  }
}

describe('diff refresh service', () => {
  it('keeps the public sync export wired to the live service layer', () => {
    const output = execFileSync(
      'pnpm',
      ['exec', 'tsx', 'tests/harness/diff-refresh-public-harness.ts'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 10_000,
      },
    )
    const result = z.object({
      ok: z.literal(true),
      sessionId: z.string(),
      diffCount: z.literal(1),
      diffPath: z.literal('app.ts'),
      snapshotAgentDiffCount: z.literal(1),
    }).parse(JSON.parse(output))

    expect(result.sessionId).toContain('diff-project-session-')
  })

  it.effect('refreshes terminal session diffs through the injected git service', () =>
    Effect.gen(function* () {
      const replacementCalls: unknown[] = []
      const snapshot = workspaceSnapshot()
      const service = makeDiffRefreshService({
        gitDiff: {
          collectArtifacts: (cwd) => Effect.succeed([{
            title: 'app.ts',
            path: `${cwd}/app.ts`,
            patch: 'diff --git a/app.ts b/app.ts',
          }]),
          artifactsFromPatch: () => Effect.succeed([]),
        },
        getAgentDetail: () => ({ interfaceMode: 'terminal' }),
        getAgentLaunchConfig: () => ({ cwd: 'src' }),
        replaceAgentDiffArtifacts: (input) => {
          replacementCalls.push(input)
        },
        getWorkspaceSnapshot: () => snapshot,
      })

      const result = yield* service.refreshTerminalSession({ agentId: 'agent-1' })

      expect(result).toBe(snapshot)
      expect(replacementCalls).toEqual([{
        agentId: 'agent-1',
        diffs: [{
          title: 'app.ts',
          path: 'src/app.ts',
          patch: 'diff --git a/app.ts b/app.ts',
        }],
      }])
    }),
  )

  it.effect('rejects non-terminal sessions before collecting diffs', () =>
    Effect.gen(function* () {
      const collectArtifacts = vi.fn(() => Effect.succeed([]))
      const service = makeDiffRefreshService({
        gitDiff: {
          collectArtifacts,
          artifactsFromPatch: () => Effect.succeed([]),
        },
        getAgentDetail: () => ({ interfaceMode: 'gui' }),
        getAgentLaunchConfig: () => ({ cwd: 'src' }),
        replaceAgentDiffArtifacts: () => undefined,
        getWorkspaceSnapshot: workspaceSnapshot,
      })

      const error = yield* service.refreshTerminalSession({ agentId: 'agent-1' }).pipe(
        Effect.flip,
      )

      expect(error).toBeInstanceOf(DiffRefreshError)
      expect(error.message).toBe('Diff refresh is only available for terminal sessions: agent-1')
      expect(collectArtifacts).not.toHaveBeenCalled()
    }),
  )

  it.effect('wraps git collection failures with agent context', () =>
    Effect.gen(function* () {
      const cause = new Error('git exploded')
      const service = makeDiffRefreshService({
        gitDiff: {
          collectArtifacts: () => Effect.fail(new GitDiffError({
            message: cause.message,
            cwd: 'src',
            cause,
          })),
          artifactsFromPatch: () => Effect.succeed([]),
        },
        getAgentDetail: () => ({ interfaceMode: 'terminal' }),
        getAgentLaunchConfig: () => ({ cwd: 'src' }),
        replaceAgentDiffArtifacts: () => undefined,
        getWorkspaceSnapshot: workspaceSnapshot,
      })

      const error = yield* service.refreshTerminalSession({ agentId: 'agent-1' }).pipe(
        Effect.flip,
      )

      expect(error).toBeInstanceOf(DiffRefreshError)
      expect(error.agentId).toBe('agent-1')
      expect(error.message).toBe('git exploded')
    }),
  )
})
