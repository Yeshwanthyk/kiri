import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalAgentLaunchConfig } from '~/server/terminal-launch'
import { readCodexTerminalSessionId } from '~/server/codex-terminal-session'

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
    })
    const currentLaunch = rememberCodexTerminalSession(config, { CODEX_HOME: codexHome }, {
      launchedAtMs: 1_000,
      launchToken: 'current-token',
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
    })

    expect(dbMock.setAgentRuntimeState).not.toHaveBeenCalled()
    expect(dbMock.state.get(config.id)).toEqual({ resume: 'explicit-session' })
  })

  it('remembers the launch-local Codex session when later same-cwd sessions already exist', async () => {
    const { rememberCodexTerminalSession } = await import('~/server/codex-cli-sessions')
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = '/tmp/project'
    const config = launchConfig({ id: 'agent-reopen', cwd })
    writeCodexSession(codexHome, '2026/05/15/rollout-original.jsonl', 'original-session', cwd, 10)
    writeCodexSession(codexHome, '2026/05/15/rollout-reopen.jsonl', 'reopen-session', cwd, 40)

    await rememberCodexTerminalSession(config, { CODEX_HOME: codexHome }, {
      launchedAtMs: 9_500,
      launchToken: 'launch-token',
    })

    expect(dbMock.state.get(config.id)).toEqual({ codexSessionId: 'original-session' })
    expect(readCodexTerminalSessionId(config.sessionDir)).toBe('original-session')
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
) {
  const path = join(codexHome, 'sessions', relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({
    type: 'session_meta',
    payload: { id, cwd },
  })}\n`)
  const date = new Date(mtimeSeconds * 1000)
  utimesSync(path, date, date)
}
