import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleCodexSessionStartHook } from '~/server/codex-hook-handler'
import {
  codexHookSessionBindingPath,
  codexTerminalSessionIdPath,
  readCodexHookSessionBinding,
  readCodexTerminalSessionId,
} from '~/server/codex-terminal-session'

const projectRoot = process.cwd()

describe('Codex SessionStart hook handler', () => {
  it('writes the resume id and rich hook binding', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-codex-hook-'))

    const result = handleCodexSessionStartHook({
      stdin: hookPayload({ session_id: '  hook-session-1  ', source: 'startup' }),
      env: {
        KIRI_SESSION_DIR: sessionDir,
        KIRI_AGENT_ID: 'agent-hook',
      },
    })

    expect(result).toEqual({ ok: true })
    expect(readCodexTerminalSessionId(sessionDir)).toBe('hook-session-1')
    expect(readCodexHookSessionBinding(sessionDir)).toMatchObject({
      agentId: 'agent-hook',
      sessionId: 'hook-session-1',
      source: 'startup',
      cwd: '/tmp/project',
      transcriptPath: '/tmp/codex.jsonl',
      model: 'gpt-test',
      hookEventName: 'SessionStart',
    })
  })

  it('no-ops when Kiri env is absent', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-codex-hook-'))

    const result = handleCodexSessionStartHook({
      stdin: hookPayload({ session_id: 'hook-session-1' }),
      env: { KIRI_SESSION_DIR: sessionDir },
    })

    expect(result).toEqual({ ok: true, reason: 'KIRI_SESSION_DIR/KIRI_AGENT_ID not set; skipping' })
    expect(existsSync(codexTerminalSessionIdPath(sessionDir))).toBe(false)
    expect(existsSync(codexHookSessionBindingPath(sessionDir))).toBe(false)
  })

  it('reports bad payloads without writing files', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-codex-hook-'))

    const malformed = handleCodexSessionStartHook({
      stdin: '{not-json',
      env: { KIRI_SESSION_DIR: sessionDir, KIRI_AGENT_ID: 'agent-hook' },
    })
    const wrongEvent = handleCodexSessionStartHook({
      stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 'hook-session-1' }),
      env: { KIRI_SESSION_DIR: sessionDir, KIRI_AGENT_ID: 'agent-hook' },
    })
    const missingSession = handleCodexSessionStartHook({
      stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: ' ' }),
      env: { KIRI_SESSION_DIR: sessionDir, KIRI_AGENT_ID: 'agent-hook' },
    })

    expect(malformed.ok).toBe(false)
    expect(wrongEvent).toEqual({ ok: false, reason: 'Unsupported hook event' })
    expect(missingSession).toEqual({ ok: false, reason: 'Missing session_id' })
    expect(existsSync(codexTerminalSessionIdPath(sessionDir))).toBe(false)
    expect(existsSync(codexHookSessionBindingPath(sessionDir))).toBe(false)
  })

  it('rejects subagent SessionStart payloads without overwriting bindings', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-codex-hook-'))

    const result = handleCodexSessionStartHook({
      stdin: hookPayload({ session_id: 'subagent-session', thread_source: 'subagent' }),
      env: {
        KIRI_SESSION_DIR: sessionDir,
        KIRI_AGENT_ID: 'agent-hook',
      },
    })

    expect(result).toEqual({ ok: false, reason: 'Ignored SessionStart hook for a subagent thread' })
    expect(existsSync(codexTerminalSessionIdPath(sessionDir))).toBe(false)
    expect(existsSync(codexHookSessionBindingPath(sessionDir))).toBe(false)
  })

  it('ignores SessionStart payloads from a different cwd', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-codex-hook-'))

    const result = handleCodexSessionStartHook({
      stdin: hookPayload({ session_id: 'wrong-cwd-session' }),
      env: {
        KIRI_SESSION_DIR: sessionDir,
        KIRI_AGENT_ID: 'agent-hook',
        KIRI_PROJECT_CWD: '/tmp/other-project',
      },
    })

    expect(result).toEqual({ ok: true, reason: 'Ignored SessionStart hook for a different cwd' })
    expect(existsSync(codexTerminalSessionIdPath(sessionDir))).toBe(false)
    expect(existsSync(codexHookSessionBindingPath(sessionDir))).toBe(false)
  })

  it('overwrites both files when Codex starts a replacement session', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-codex-hook-'))

    handleCodexSessionStartHook({
      stdin: hookPayload({ session_id: 'first-session', source: 'startup' }),
      env: { KIRI_SESSION_DIR: sessionDir, KIRI_AGENT_ID: 'agent-hook' },
    })
    handleCodexSessionStartHook({
      stdin: hookPayload({ session_id: 'second-session', source: 'clear' }),
      env: { KIRI_SESSION_DIR: sessionDir, KIRI_AGENT_ID: 'agent-hook' },
    })

    expect(readCodexTerminalSessionId(sessionDir)).toBe('second-session')
    expect(readCodexHookSessionBinding(sessionDir)).toMatchObject({
      agentId: 'agent-hook',
      sessionId: 'second-session',
      source: 'clear',
    })
  })

  it('runs through the kirictl hook command without stdout', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-codex-hook-cli-'))

    const stdout = execFileSync('pnpm', ['exec', 'tsx', 'src/cli/kirictl.ts', 'codex-hook', 'session-start'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        KIRI_SESSION_DIR: sessionDir,
        KIRI_AGENT_ID: 'agent-cli',
      },
      input: hookPayload({ session_id: 'cli-session', source: 'startup' }),
    })

    expect(stdout).toBe('')
    expect(readFileSync(codexTerminalSessionIdPath(sessionDir), 'utf8')).toBe('cli-session\n')
    expect(readCodexHookSessionBinding(sessionDir)).toMatchObject({
      agentId: 'agent-cli',
      sessionId: 'cli-session',
    })
  }, 20_000)

  it('runs through the kirictl hook command with --stdin-file and unlinks it', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-codex-hook-cli-file-'))
    const stdinFile = join(sessionDir, 'hook.json')
    writeFileSync(stdinFile, hookPayload({ session_id: 'cli-file-session', source: 'startup' }))

    const stdout = execFileSync('pnpm', [
      'exec',
      'tsx',
      'src/cli/kirictl.ts',
      'codex-hook',
      'session-start',
      '--stdin-file',
      stdinFile,
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        KIRI_SESSION_DIR: sessionDir,
        KIRI_AGENT_ID: 'agent-cli-file',
      },
    })

    expect(stdout).toBe('')
    expect(existsSync(stdinFile)).toBe(false)
    expect(readCodexHookSessionBinding(sessionDir)).toMatchObject({
      agentId: 'agent-cli-file',
      sessionId: 'cli-file-session',
    })
  }, 20_000)
})

function hookPayload(overrides: {
  readonly session_id: string
  readonly source?: string
  readonly thread_source?: string
}) {
  return `${JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: overrides.session_id,
    source: overrides.source ?? 'startup',
    ...(overrides.thread_source ? { thread_source: overrides.thread_source } : {}),
    cwd: '/tmp/project',
    transcript_path: '/tmp/codex.jsonl',
    model: 'gpt-test',
  })}\n`
}
