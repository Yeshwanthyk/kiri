import { describe, expect, it, vi } from 'vitest'
import type { AgentCell, ProjectRow, WorkspaceSnapshot } from '~/lib/contracts'
import {
  createWorkspaceDedupe,
  workspaceFingerprint,
} from '~/components/kiri-board/workspace-fingerprint'

describe('workspaceFingerprint', () => {
  it('returns the same fingerprint for content-equal snapshots with different references', () => {
    const first = buildSnapshot()
    const second = buildSnapshot()
    expect(first).not.toBe(second)
    expect(workspaceFingerprint(first)).toBe(workspaceFingerprint(second))
  })

  it('changes when an agent status flips', () => {
    const before = buildSnapshot()
    const after = buildSnapshot({ agentStatus: 'running' })
    expect(workspaceFingerprint(before)).not.toBe(workspaceFingerprint(after))
  })

  it('changes when an agent updatedAt advances even if other fields are stable', () => {
    const before = buildSnapshot()
    const after = buildSnapshot({ agentUpdatedAt: '2026-01-01T00:00:01.000Z' })
    expect(workspaceFingerprint(before)).not.toBe(workspaceFingerprint(after))
  })

  it('changes when scratchpad blocks change', () => {
    const before = buildSnapshot()
    const after = buildSnapshot({ scratchpadBody: 'updated body' })
    expect(workspaceFingerprint(before)).not.toBe(workspaceFingerprint(after))
  })
})

describe('createWorkspaceDedupe', () => {
  it('skips onChange when the next snapshot matches the initial fingerprint', () => {
    const dedupe = createWorkspaceDedupe(buildSnapshot())
    const onChange = vi.fn()
    expect(dedupe.apply(buildSnapshot(), onChange)).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    expect(dedupe.didChange()).toBe(false)
  })

  it('forwards onChange when the snapshot content differs', () => {
    const dedupe = createWorkspaceDedupe(buildSnapshot())
    const onChange = vi.fn()
    const next = buildSnapshot({ agentStatus: 'running' })
    expect(dedupe.apply(next, onChange)).toBe(true)
    expect(onChange).toHaveBeenCalledWith(next)
    expect(dedupe.didChange()).toBe(true)
  })

  it('tracks the last applied snapshot so repeated identical updates are deduped', () => {
    const dedupe = createWorkspaceDedupe(buildSnapshot())
    const onChange = vi.fn()
    const next = buildSnapshot({ agentStatus: 'running' })
    dedupe.apply(next, onChange)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(dedupe.didChange()).toBe(true)

    expect(dedupe.apply(buildSnapshot({ agentStatus: 'running' }), onChange)).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(dedupe.didChange()).toBe(false)
  })
})

function buildSnapshot(overrides: {
  agentStatus?: AgentCell['status']
  agentUpdatedAt?: string
  scratchpadBody?: string
} = {}): WorkspaceSnapshot {
  return {
    settings: {
      runtimes: {
        pi: { models: ['pi-model'], defaultModel: 'pi-model' },
        codex: { models: ['codex-model'], defaultModel: 'codex-model' },
        claude: { models: ['claude-model'], defaultModel: 'claude-model' },
        opencode: { models: ['opencode-model'], defaultModel: 'opencode-model' },
      },
    },
    preferences: {
      theme: { mode: 'dark', name: 'kiri' },
      keymap: {
        projectPrev: 'k',
        projectNext: 'j',
        agentPrev: 'h',
        agentNext: 'l',
        focusChat: 'i',
        openDiffs: 'd',
        openTerminal: 't',
        openScratchpad: 's',
        startSession: 'n',
        deleteSession: 'backspace',
        toggleTerminalFocus: 'f',
      },
      chatTypography: {
        fontSize: 'comfortable',
        monoFont: 'fira',
      },
      agentByProject: {},
    },
    projects: [project('alpha', [
      agent('alpha-a', 'alpha', {
        status: overrides.agentStatus ?? 'idle',
        updatedAt: overrides.agentUpdatedAt ?? '2026-01-01T00:00:00.000Z',
      }),
    ])],
    hiddenProjects: [],
    archivedSessions: [],
    scratchpadBlocks: [{
      id: 'block-1',
      projectId: 'alpha',
      projectName: 'alpha',
      body: overrides.scratchpadBody ?? 'first block',
      createdAt: '2026-01-01T00:00:00.000Z',
      triggeredAt: null,
      triggeredAgentId: null,
    }],
    selected: { projectId: 'alpha', agentId: 'alpha-a' },
  }
}

function project(id: string, agents: AgentCell[]): ProjectRow {
  return {
    id,
    name: id,
    cwd: `/tmp/${id}`,
    position: 0,
    hiddenAt: null,
    agents,
  }
}

function agent(
  id: string,
  projectId: string,
  override: { status: AgentCell['status']; updatedAt: string },
): AgentCell {
  return {
    id,
    projectId,
    slot: id,
    title: id,
    runtime: 'pi',
    interfaceMode: 'gui',
    model: 'pi-model',
    status: override.status,
    sessionDir: `/tmp/${projectId}`,
    sessionFile: null,
    preview: '',
    messageCount: 0,
    diffCount: 0,
    contextUsage: null,
    pendingQuestion: null,
    updatedAt: override.updatedAt,
    isSession: true,
    messages: [],
    timelineEvents: [],
    timeline: [],
    diffs: [],
    tasks: [],
  }
}
