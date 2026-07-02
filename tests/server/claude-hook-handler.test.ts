import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeHookSessionBindingFile,
  handleClaudeHook,
} from '~/server/claude-hook-handler'

describe('Claude hook handler', () => {
  it('records session-start bindings and marks the agent idle', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-claude-hook-'))
    const calls: unknown[] = []

    const result = await handleClaudeHook({
      event: 'session-start',
      stdin: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-1',
        transcript_path: '/tmp/claude.jsonl',
      }),
      env: {
        KIRI_AGENT_ID: 'agent-1',
        KIRI_SESSION_DIR: sessionDir,
        KIRI_PROJECT_CWD: '/tmp/project',
        KIRI_MODEL: 'sonnet',
      },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      runOperation: (request) => {
        calls.push(request)
        return Promise.resolve({ ok: true, result: {} })
      },
    })

    const binding = globalThis.JSON.parse(
      readFileSync(join(sessionDir, claudeHookSessionBindingFile), 'utf8'),
    ) as unknown
    expect(result).toEqual({ ok: true })
    expect(binding).toMatchObject({
      agentId: 'agent-1',
      sessionId: 'claude-session-1',
      cwd: '/tmp/project',
      hookEventName: 'SessionStart',
      transcriptPath: '/tmp/claude.jsonl',
      model: 'sonnet',
      source: 'hook',
      writtenAtMs: 1767225600000,
    })
    expect(calls).toEqual([{
      operation: 'agent.status.set',
      params: { agentId: 'agent-1', status: 'idle' },
    }])
  })

  it('projects Claude lifecycle blockers into agent status', async () => {
    const calls: unknown[] = []
    const runOperation = (request: unknown) => {
      calls.push(request)
      return Promise.resolve({ ok: true, result: {} })
    }
    const env = {
      KIRI_AGENT_ID: 'agent-1',
      KIRI_SESSION_DIR: mkdtempSync(join(tmpdir(), 'kiri-claude-hook-')),
    }

    await handleClaudeHook({
      event: 'user-prompt-submit',
      stdin: '{}',
      env,
      runOperation,
    })
    await handleClaudeHook({
      event: 'pre-tool-use',
      stdin: JSON.stringify({ tool_name: 'AskUserQuestion' }),
      env,
      runOperation,
    })
    await handleClaudeHook({
      event: 'permission-request',
      stdin: '{}',
      env,
      runOperation,
    })
    await handleClaudeHook({
      event: 'session-end',
      stdin: '{}',
      env,
      runOperation,
    })

    expect(calls).toEqual([
      { operation: 'agent.status.set', params: { agentId: 'agent-1', status: 'running' } },
      { operation: 'agent.status.set', params: { agentId: 'agent-1', status: 'blocked' } },
      { operation: 'agent.status.set', params: { agentId: 'agent-1', status: 'blocked' } },
      { operation: 'agent.status.set', params: { agentId: 'agent-1', status: 'idle' } },
    ])
  })

  it('projects TodoWrite payloads into Kiri tasks', async () => {
    const calls: unknown[] = []
    const result = await handleClaudeHook({
      event: 'post-tool-use',
      stdin: JSON.stringify({
        tool_name: 'TodoWrite',
        tool_input: {
          todos: [
            { content: 'Implement hook bundle', status: 'in_progress' },
            { content: 'Run real app', status: 'pending' },
            { content: 'Ship commit', status: 'completed' },
          ],
        },
      }),
      env: {
        KIRI_AGENT_ID: 'agent-1',
        KIRI_SESSION_DIR: mkdtempSync(join(tmpdir(), 'kiri-claude-hook-')),
      },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      runOperation: (request) => {
        calls.push(request)
        return Promise.resolve({ ok: true, result: {} })
      },
    })

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([{
      operation: 'agent.tasks.replace',
      params: {
        agentId: 'agent-1',
        source: 'claude',
        updatedAt: '2026-01-01T00:00:00.000Z',
        tasks: [
          {
            id: 'claude-1',
            title: 'Implement hook bundle',
            status: 'inProgress',
            source: 'claude',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'claude-2',
            title: 'Run real app',
            status: 'pending',
            source: 'claude',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'claude-3',
            title: 'Ship commit',
            status: 'completed',
            source: 'claude',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    }])
  })

  it('renames default Claude titles only after stop', async () => {
    const calls: unknown[] = []
    await handleClaudeHook({
      event: 'stop',
      stdin: JSON.stringify({ title: 'Fix terminal rejoin' }),
      env: {
        KIRI_AGENT_ID: 'agent-1',
        KIRI_SESSION_DIR: mkdtempSync(join(tmpdir(), 'kiri-claude-hook-')),
      },
      runOperation: (request) => {
        calls.push(request)
        if (request.operation === 'agent.detail') {
          return Promise.resolve({ ok: true, result: { title: 'Session 4' } })
        }
        return Promise.resolve({ ok: true, result: {} })
      },
    })

    expect(calls).toEqual([
      { operation: 'agent.status.set', params: { agentId: 'agent-1', status: 'idle' } },
      { operation: 'agent.detail', params: { agentId: 'agent-1', limit: 1 } },
      { operation: 'session.rename', params: { agentId: 'agent-1', title: 'Fix terminal rejoin' } },
    ])
  })

  it('no-ops without Kiri hook environment', async () => {
    const calls: unknown[] = []
    const result = await handleClaudeHook({
      event: 'user-prompt-submit',
      stdin: '{}',
      env: {},
      runOperation: (request) => {
        calls.push(request)
        return Promise.resolve({ ok: true, result: {} })
      },
    })

    expect(result).toEqual({
      ok: true,
      reason: 'KIRI_AGENT_ID or KIRI_SESSION_DIR not set; skipping',
    })
    expect(calls).toEqual([])
  })
})
