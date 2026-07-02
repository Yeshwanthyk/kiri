import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalAgentLaunchConfig } from '~/server/terminal-launch'
import {
  readCodexTerminalSessionId,
  writeCodexHookSessionBinding,
} from '~/server/codex-terminal-session'

const dbMock = vi.hoisted(() => {
  const state = new Map<string, Record<string, unknown>>()
  return {
    state,
    getAgentRuntimeState: vi.fn((agentId: string) => state.get(agentId) ?? {}),
    setAgentRuntimeState: vi.fn((agentId: string, runtimeState: Record<string, unknown>) => {
      state.set(agentId, runtimeState)
    }),
  }
})

vi.mock('~/server/db', () => ({
  getAgentRuntimeState: dbMock.getAgentRuntimeState,
  setAgentRuntimeState: dbMock.setAgentRuntimeState,
}))

describe('Codex terminal session memory', () => {
  afterEach(() => {
    dbMock.state.clear()
    dbMock.getAgentRuntimeState.mockClear()
    dbMock.setAgentRuntimeState.mockClear()
  })

  it('does not let stale launch discovery overwrite the newer launch token', async () => {
    const { rememberCodexTerminalSession } = await import('~/server/codex-cli-sessions')
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = '/tmp/project'
    const config = launchConfig({ id: 'agent-race', cwd })

    const staleLaunch = rememberCodexTerminalSession(config, { CODEX_HOME: codexHome }, {
      launchedAtMs: 1_000,
      launchToken: 'stale-token',
      hookWaitMs: 0,
    })
    const currentLaunch = rememberCodexTerminalSession(config, { CODEX_HOME: codexHome }, {
      launchedAtMs: 1_000,
      launchToken: 'current-token',
      hookWaitMs: 0,
    })

    setTimeout(() => {
      writeCodexSession(codexHome, '2026/05/15/rollout-current.jsonl', 'current-session', cwd, 2)
    }, 10)

    await Promise.all([staleLaunch, currentLaunch])

    expect(dbMock.setAgentRuntimeState).toHaveBeenCalledTimes(1)
    expect(dbMock.state.get(config.id)).toEqual({ codexSessionId: 'current-session' })
    expect(readCodexTerminalSessionId(config.sessionDir)).toBe('current-session')
  })

  it('does not replace an existing explicit Codex resume state', async () => {
    const { rememberCodexTerminalSession } = await import('~/server/codex-cli-sessions')
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = '/tmp/project'
    const config = launchConfig({ id: 'agent-explicit-resume', cwd })
    dbMock.state.set(config.id, { resume: 'explicit-session' })
    writeCodexSession(codexHome, '2026/05/15/rollout-discovered.jsonl', 'discovered-session', cwd, 2)

    await rememberCodexTerminalSession(config, { CODEX_HOME: codexHome }, {
      launchedAtMs: 1_000,
      launchToken: 'launch-token',
      hookWaitMs: 0,
    })

    expect(dbMock.setAgentRuntimeState).not.toHaveBeenCalled()
    expect(dbMock.state.get(config.id)).toEqual({ resume: 'explicit-session' })
  })

  it('keeps watching for real Codex session metadata that appears after startup', async () => {
    const { rememberCodexTerminalSession } = await import('~/server/codex-cli-sessions')
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = '/tmp/project'
    const config = launchConfig({ id: 'agent-delayed', cwd })
    const launchedAtMs = Date.now()

    const remembered = rememberCodexTerminalSession(config, { CODEX_HOME: codexHome }, {
      launchedAtMs,
      launchToken: 'launch-token',
      hookWaitMs: 0,
    })

    setTimeout(() => {
      writeCodexSession(
        codexHome,
        '2026/05/15/rollout-delayed.jsonl',
        'delayed-session',
        cwd,
        (launchedAtMs + 10_000) / 1000,
      )
    }, 2_200)

    await expect(remembered).resolves.toBe(true)
    expect(dbMock.state.get(config.id)).toEqual({ codexSessionId: 'delayed-session' })
    expect(readCodexTerminalSessionId(config.sessionDir)).toBe('delayed-session')
  }, 10_000)

  it('reports when no Codex session metadata appears within the configured window', async () => {
    const { rememberCodexTerminalSession } = await import('~/server/codex-cli-sessions')
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const config = launchConfig({ id: 'agent-missing', cwd: '/tmp/project' })

    await expect(rememberCodexTerminalSession(config, { CODEX_HOME: codexHome }, {
      launchedAtMs: Date.now(),
      launchToken: 'launch-token',
      attempts: 2,
      hookWaitMs: 0,
      intervalMs: 5,
    })).resolves.toBe(false)

    expect(dbMock.setAgentRuntimeState).not.toHaveBeenCalled()
    expect(readCodexTerminalSessionId(config.sessionDir)).toBeUndefined()
  })

  it('fails closed when scan fallback sees multiple same-cwd candidates', async () => {
    const { rememberCodexTerminalSession } = await import('~/server/codex-cli-sessions')
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = '/tmp/project'
    const config = launchConfig({ id: 'agent-ambiguous', cwd })
    writeCodexSession(codexHome, '2026/05/15/rollout-original.jsonl', 'original-session', cwd, 10)
    writeCodexSession(codexHome, '2026/05/15/rollout-reopen.jsonl', 'reopen-session', cwd, 40)

    await expect(rememberCodexTerminalSession(config, { CODEX_HOME: codexHome }, {
      launchedAtMs: 9_500,
      launchToken: 'launch-token',
      hookWaitMs: 0,
      attempts: 1,
      intervalMs: 5,
    })).resolves.toBe(false)

    expect(dbMock.state.get(config.id)).toBeUndefined()
    expect(readCodexTerminalSessionId(config.sessionDir)).toBeUndefined()
  })

  it('remembers a fresh hook binding before scanning shared Codex sessions', async () => {
    const { rememberCodexTerminalSession } = await import('~/server/codex-cli-sessions')
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = '/tmp/project'
    const config = launchConfig({ id: 'agent-hook', cwd })
    const launchedAtMs = Date.now()
    writeCodexSession(codexHome, '2026/05/15/rollout-competitor.jsonl', 'wrong-scan-session', cwd, launchedAtMs / 1000)

    const remembered = rememberCodexTerminalSession(config, { CODEX_HOME: codexHome }, {
      launchedAtMs,
      launchToken: 'launch-token',
      hookWaitMs: 50,
      intervalMs: 5,
    })
    setTimeout(() => writeHookBinding(config.sessionDir, config.id, 'hook-session'), 10)

    await expect(remembered).resolves.toBe(true)
    expect(dbMock.state.get(config.id)).toEqual({ codexSessionId: 'hook-session' })
    expect(readCodexTerminalSessionId(config.sessionDir)).toBe('hook-session')
  })

  it('ignores stale and mismatched hook bindings before using scan fallback', async () => {
    const { rememberCodexTerminalSession } = await import('~/server/codex-cli-sessions')
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = '/tmp/project'
    const staleConfig = launchConfig({ id: 'agent-stale-hook', cwd })
    const mismatchedConfig = launchConfig({ id: 'agent-mismatch-hook', cwd })
    writeHookBinding(staleConfig.sessionDir, staleConfig.id, 'stale-hook-session', 1)
    writeHookBinding(mismatchedConfig.sessionDir, 'other-agent', 'wrong-hook-session')
    writeCodexSession(codexHome, '2026/05/15/rollout-fallback.jsonl', 'fallback-session', cwd, 10)

    await expect(rememberCodexTerminalSession(staleConfig, { CODEX_HOME: codexHome }, {
      launchedAtMs: 9_500,
      launchToken: 'stale-token',
      hookWaitMs: 0,
    })).resolves.toBe(true)
    await expect(rememberCodexTerminalSession(mismatchedConfig, { CODEX_HOME: codexHome }, {
      launchedAtMs: 9_500,
      launchToken: 'mismatch-token',
      hookWaitMs: 0,
    })).resolves.toBe(true)

    expect(dbMock.state.get(staleConfig.id)).toEqual({ codexSessionId: 'fallback-session' })
    expect(dbMock.state.get(mismatchedConfig.id)).toEqual({ codexSessionId: 'fallback-session' })
  })

  it('ignores wrong-cwd hook bindings and matching persisted ids before using scan fallback', async () => {
    const { rememberCodexTerminalSession } = await import('~/server/codex-cli-sessions')
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = '/tmp/project'
    const config = launchConfig({ id: 'agent-wrong-cwd-hook', cwd })
    writeHookBinding(config.sessionDir, config.id, 'wrong-cwd-session', Date.now(), '/tmp/other-project')
    dbMock.state.set(config.id, { codexSessionId: 'wrong-cwd-session' })
    writeCodexSession(codexHome, '2026/05/15/rollout-fallback.jsonl', 'fallback-session', cwd, 10)

    await expect(rememberCodexTerminalSession(config, { CODEX_HOME: codexHome }, {
      launchedAtMs: 9_500,
      launchToken: 'wrong-cwd-token',
      hookWaitMs: 0,
    })).resolves.toBe(true)

    expect(dbMock.state.get(config.id)).toEqual({ codexSessionId: 'fallback-session' })
    expect(readCodexTerminalSessionId(config.sessionDir)).toBe('fallback-session')
  })

  it('does not let JSONL scan overwrite a binding that appears during fallback', async () => {
    const { rememberCodexTerminalSession } = await import('~/server/codex-cli-sessions')
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = '/tmp/project'
    const config = launchConfig({ id: 'agent-late-hook', cwd })
    const launchedAtMs = Date.now()

    const remembered = rememberCodexTerminalSession(config, { CODEX_HOME: codexHome }, {
      launchedAtMs,
      launchToken: 'launch-token',
      hookWaitMs: 0,
      attempts: 10,
      intervalMs: 5,
    })
    setTimeout(() => {
      writeCodexSession(codexHome, '2026/05/15/rollout-scan.jsonl', 'scan-session', cwd, launchedAtMs / 1000)
      writeHookBinding(config.sessionDir, config.id, 'late-hook-session')
    }, 10)

    await expect(remembered).resolves.toBe(true)
    expect(dbMock.state.get(config.id)).toEqual({ codexSessionId: 'late-hook-session' })
    expect(readCodexTerminalSessionId(config.sessionDir)).toBe('late-hook-session')
  })

  it('skips subagent scan candidates and rejects sessions created before launch', async () => {
    const { rememberCodexTerminalSession } = await import('~/server/codex-cli-sessions')
    const subagentCodexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const oldCodexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = '/tmp/project'
    const subagentConfig = launchConfig({ id: 'agent-subagent', cwd })
    const oldConfig = launchConfig({ id: 'agent-old-created', cwd })
    writeCodexSession(subagentCodexHome, '2026/05/15/rollout-subagent.jsonl', 'subagent-session', cwd, Date.now() / 1000, 'subagent')
    const oldPath = writeCodexSession(oldCodexHome, '2026/05/15/rollout-old-created.jsonl', 'old-created-session', cwd, Date.now() / 1000)
    const launchedAtMs = Date.now() + 10_000
    appendFileSync(oldPath, `${JSON.stringify({ type: 'response_item', payload: { text: 'new write' } })}\n`)

    await expect(rememberCodexTerminalSession(subagentConfig, { CODEX_HOME: subagentCodexHome }, {
      launchedAtMs: Date.now() - 1_000,
      launchToken: 'subagent-token',
      hookWaitMs: 0,
      attempts: 1,
      intervalMs: 5,
    })).resolves.toBe(false)
    await expect(rememberCodexTerminalSession(oldConfig, { CODEX_HOME: oldCodexHome }, {
      launchedAtMs,
      launchToken: 'old-token',
      hookWaitMs: 0,
      attempts: 1,
      intervalMs: 5,
    })).resolves.toBe(false)
  })
})

function launchConfig(input: { id: string; cwd: string }): TerminalAgentLaunchConfig {
  return {
    id: input.id,
    projectId: 'project-1',
    runtime: 'codex',
    sessionDir: mkdtempSync(join(tmpdir(), 'kiri-session-')),
    sessionFile: 'session.jsonl',
    model: 'test-model',
    cwd: input.cwd,
  }
}

function writeCodexSession(
  codexHome: string,
  relativePath: string,
  id: string,
  cwd: string,
  mtimeSeconds: number,
  threadSource?: string,
) {
  const path = join(codexHome, 'sessions', relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id,
      cwd,
      ...(threadSource ? { thread_source: threadSource } : {}),
    },
  })}\n`)
  const date = new Date(mtimeSeconds * 1000)
  utimesSync(path, date, date)
  return path
}

function writeHookBinding(
  sessionDir: string,
  agentId: string,
  sessionId: string,
  writtenAtMs = Date.now(),
  cwd = '/tmp/project',
) {
  writeCodexHookSessionBinding(sessionDir, {
    agentId,
    sessionId,
    cwd,
    source: 'startup',
    hookEventName: 'SessionStart',
    writtenAtMs,
  })
}
