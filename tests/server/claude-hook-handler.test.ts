import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeHookSessionBindingFile,
  handleClaudeHook,
} from '~/server/claude-hook-handler'

const projectRoot = process.cwd()

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
      event: 'post-tool-use',
      stdin: JSON.stringify({ tool_name: 'AskUserQuestion' }),
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
      { operation: 'agent.status.set', params: { agentId: 'agent-1', status: 'running' } },
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
    expect(calls).toEqual([
      {
        operation: 'agent.status.set',
        params: { agentId: 'agent-1', status: 'running' },
      },
      {
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
      },
    ])
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

  it('ignores Claude subagent and mismatched-session hook writes', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-claude-hook-'))
    writeFileSync(join(sessionDir, claudeHookSessionBindingFile), `${JSON.stringify({
      agentId: 'agent-1',
      sessionId: 'parent-session',
      source: 'hook',
      hookEventName: 'SessionStart',
      writtenAtMs: 1767225600000,
    })}\n`)
    const calls: unknown[] = []
    const env = {
      KIRI_AGENT_ID: 'agent-1',
      KIRI_SESSION_DIR: sessionDir,
    }
    const runOperation = (request: unknown) => {
      calls.push(request)
      return Promise.resolve({ ok: true, result: {} })
    }

    await expect(handleClaudeHook({
      event: 'session-start',
      stdin: JSON.stringify({ session_id: 'subagent-session', parent_tool_use_id: 'parent-tool' }),
      env,
      runOperation,
    })).resolves.toEqual({ ok: true, reason: 'Ignored Claude subagent hook payload' })
    await expect(handleClaudeHook({
      event: 'post-tool-use',
      stdin: JSON.stringify({ tool_name: 'TodoWrite', parent_tool_use_id: 'parent-tool' }),
      env,
      runOperation,
    })).resolves.toEqual({ ok: true, reason: 'Ignored Claude subagent hook payload' })
    await expect(handleClaudeHook({
      event: 'permission-request',
      stdin: JSON.stringify({ session_id: 'other-session' }),
      env,
      runOperation,
    })).resolves.toEqual({ ok: true, reason: 'Ignored Claude hook for a different session' })
    expect(calls).toEqual([])
  })

  it('returns a failed hook result when an operation envelope is not ok', async () => {
    const result = await handleClaudeHook({
      event: 'user-prompt-submit',
      stdin: '{}',
      env: {
        KIRI_AGENT_ID: 'agent-1',
        KIRI_SESSION_DIR: mkdtempSync(join(tmpdir(), 'kiri-claude-hook-')),
      },
      runOperation: () => Promise.resolve({
        ok: false,
        error: {
          code: 'BACKEND_ALIVE_LOCAL_WRITE_REFUSED',
          message: 'refused write',
        },
      }),
    })

    expect(result).toEqual({
      ok: false,
      reason: 'BACKEND_ALIVE_LOCAL_WRITE_REFUSED: refused write',
    })
  })

  it('retains --stdin-file payloads when the CLI hook handler fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-claude-hook-cli-'))
    const stdinFile = join(root, 'hook.json')
    writeFileSync(stdinFile, '{not-json')

    execFileSync('pnpm', [
      'exec',
      'tsx',
      'src/cli/kirictl.ts',
      'claude-hook',
      'user-prompt-submit',
      '--stdin-file',
      stdinFile,
    ], {
      cwd: projectRoot,
      stdio: 'ignore',
      env: {
        ...process.env,
        KIRI_ROOT_DIR: root,
        KIRI_DB_PATH: join(root, 'kiri.sqlite'),
        KIRI_STATE_DIR: join(root, 'state'),
        KIRI_AGENT_ID: 'agent-cli-file',
        KIRI_SESSION_DIR: root,
      },
    })

    expect(existsSync(stdinFile)).toBe(true)
  }, 20_000)
})
