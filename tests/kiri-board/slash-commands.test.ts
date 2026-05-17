import { describe, expect, it, vi } from 'vitest'
import type { AgentCell } from '~/lib/contracts'
import {
  parseSlashCommand,
  runSlashCommand,
  supportsThinking,
} from '~/components/kiri-board/slash-commands'

function agent(runtime: AgentCell['runtime']): AgentCell {
  return {
    id: 'agent-1',
    projectId: 'project-1',
    slot: 'session-1',
    title: 'Agent',
    runtime,
    interfaceMode: 'gui',
    model: 'model',
    status: 'idle',
    sessionDir: '/tmp/session',
    sessionFile: null,
    preview: '',
    messageCount: 0,
    diffCount: 0,
    contextUsage: null,
    pendingQuestion: null,
    updatedAt: '2026-05-11T12:00:00.000Z',
    isSession: true,
    messages: [],
    timelineEvents: [],
    timeline: [],
    diffs: [],
    tasks: [],
  }
}

describe('parseSlashCommand', () => {
  it('parses session commands', () => {
    expect(parseSlashCommand('/new')).toEqual({ name: 'new' })
    expect(parseSlashCommand('/fork')).toEqual({ name: 'fork' })
  })

  it('parses thinking commands', () => {
    expect(parseSlashCommand('/thinking')).toEqual({ name: 'thinking' })
    expect(parseSlashCommand('/thinking high')).toEqual({ name: 'thinking', level: 'high' })
    expect(parseSlashCommand('/thinking cycle')).toEqual({ name: 'thinking' })
  })

  it('parses review targets', () => {
    expect(parseSlashCommand('/review')).toEqual({
      name: 'review',
      reviewTarget: { type: 'uncommittedChanges' },
    })
    expect(parseSlashCommand('/review base main')).toEqual({
      name: 'review',
      reviewTarget: { type: 'baseBranch', branch: 'main' },
    })
  })

  it('returns null for normal prompts and throws on invalid usage', () => {
    expect(parseSlashCommand('hello')).toBeNull()
    expect(() => parseSlashCommand('/thinking huge')).toThrow(
      'Usage: /thinking [off|minimal|low|medium|high|xhigh]',
    )
    expect(() => parseSlashCommand('/review now')).toThrow(
      'Usage: /review or /review base <branch>',
    )
  })
})

describe('runSlashCommand', () => {
  it('dispatches supported commands to the supplied actions', async () => {
    const actions = {
      onThinkingCommand: vi.fn().mockResolvedValue(undefined),
      onResetSession: vi.fn().mockResolvedValue(undefined),
      onForkSession: vi.fn().mockResolvedValue(undefined),
      onReviewSession: vi.fn().mockResolvedValue(undefined),
    }

    await runSlashCommand({ name: 'thinking', level: 'low' }, agent('codex'), actions)
    await runSlashCommand({ name: 'new' }, agent('codex'), actions)
    await runSlashCommand({ name: 'fork' }, agent('codex'), actions)
    await runSlashCommand(
      { name: 'review', reviewTarget: { type: 'baseBranch', branch: 'main' } },
      agent('codex'),
      actions,
    )

    expect(actions.onThinkingCommand).toHaveBeenCalledWith('agent-1', 'low')
    expect(actions.onResetSession).toHaveBeenCalledWith('agent-1')
    expect(actions.onForkSession).toHaveBeenCalledWith('agent-1')
    expect(actions.onReviewSession).toHaveBeenCalledWith('agent-1', {
      type: 'baseBranch',
      branch: 'main',
    })
  })

  it('rejects runtime-specific unsupported commands', async () => {
    const actions = {
      onThinkingCommand: vi.fn().mockResolvedValue(undefined),
      onResetSession: vi.fn().mockResolvedValue(undefined),
      onForkSession: vi.fn().mockResolvedValue(undefined),
      onReviewSession: vi.fn().mockResolvedValue(undefined),
    }

    await expect(runSlashCommand({ name: 'review' }, agent('pi'), actions))
      .rejects.toThrow('pi sessions do not support /review yet')
  })
})

describe('supportsThinking', () => {
  it('tracks runtimes with thinking controls', () => {
    expect(supportsThinking('pi')).toBe(true)
    expect(supportsThinking('codex')).toBe(true)
    expect(supportsThinking('claude')).toBe(true)
    expect(supportsThinking('opencode')).toBe(false)
  })
})
