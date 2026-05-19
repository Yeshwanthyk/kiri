import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readClaudeSessionFile } from '~/server/claude-jsonl-file'
import { claudeProjectKey, claudeTerminalSessionId } from '~/server/terminal-launch'

function writeClaudeSession(home: string, cwd: string, sessionId: string, content: string) {
  const projectDir = join(home, '.claude', 'projects', claudeProjectKey(cwd))
  mkdirSync(projectDir, { recursive: true })
  const path = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(path, content)
  return path
}

describe('readClaudeSessionFile', () => {
  it('resolves the Claude JSONL file under the configured Claude HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'kiri-claude-home-'))
    const cwd = '/tmp/kiri-project'
    const agentId = 'agent-1'
    const sessionId = claudeTerminalSessionId(agentId)
    const content = '{"type":"assistant"}\n'
    const path = writeClaudeSession(home, cwd, sessionId, content)

    expect(readClaudeSessionFile({
      agentId,
      cwd,
      env: { KIRI_CLAUDE_HOME: home },
    })).toEqual({
      sessionId,
      path,
      content,
      offset: undefined,
    })
  })

  it('uses byte offsets when reading an incremental tail', () => {
    const home = mkdtempSync(join(tmpdir(), 'kiri-claude-home-'))
    const cwd = '/tmp/kiri-project'
    const agentId = 'agent-1'
    const sessionId = claudeTerminalSessionId(agentId)
    const first = '{"type":"assistant","text":"hello 🌕"}\n'
    const second = '{"type":"assistant","text":"after"}\n'
    writeClaudeSession(home, cwd, sessionId, `${first}${second}`)

    const result = readClaudeSessionFile({
      agentId,
      cwd,
      runtimeState: { claudeLastSeenOffset: Buffer.byteLength(first) },
      env: { KIRI_CLAUDE_HOME: home },
    })

    expect(result?.content).toBe(second)
    expect(result?.offset).toBe(Buffer.byteLength(first))
  })

  it('falls back to a full read when the stored offset is past EOF', () => {
    const home = mkdtempSync(join(tmpdir(), 'kiri-claude-home-'))
    const cwd = '/tmp/kiri-project'
    const agentId = 'agent-1'
    const sessionId = claudeTerminalSessionId(agentId)
    const content = '{"type":"assistant","text":"after truncate"}\n'
    writeClaudeSession(home, cwd, sessionId, content)

    const result = readClaudeSessionFile({
      agentId,
      cwd,
      runtimeState: { claudeLastSeenOffset: Buffer.byteLength(content) + 1 },
      env: { KIRI_CLAUDE_HOME: home },
    })

    expect(result?.content).toBe(content)
    expect(result?.offset).toBeUndefined()
  })

  it('uses explicit resume ids before deterministic Kiri ids', () => {
    const home = mkdtempSync(join(tmpdir(), 'kiri-claude-home-'))
    const cwd = '/tmp/kiri-project'
    const content = '{"type":"assistant","text":"resumed"}\n'
    const path = writeClaudeSession(home, cwd, 'claude-resume-session', content)

    expect(readClaudeSessionFile({
      agentId: 'agent-1',
      cwd,
      runtimeState: { resume: 'claude-resume-session' },
      env: { KIRI_CLAUDE_HOME: home },
    })).toEqual({
      sessionId: 'claude-resume-session',
      path,
      content,
      offset: undefined,
    })
  })

  it('rejects unsafe resume ids instead of escaping the project directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'kiri-claude-home-'))

    expect(readClaudeSessionFile({
      agentId: 'agent-1',
      cwd: '/tmp/kiri-project',
      runtimeState: { resume: '../../outside' },
      env: { KIRI_CLAUDE_HOME: home },
    })).toBeNull()
  })

  it('ignores empty Claude HOME env values and falls back to runtime state homePath', () => {
    const envHome = mkdtempSync(join(tmpdir(), 'kiri-empty-env-home-'))
    const stateHome = mkdtempSync(join(tmpdir(), 'kiri-state-home-'))
    const cwd = '/tmp/kiri-project'
    const agentId = 'agent-1'
    const sessionId = claudeTerminalSessionId(agentId)
    const content = '{"type":"assistant","text":"state home"}\n'
    const path = writeClaudeSession(stateHome, cwd, sessionId, content)

    expect(readClaudeSessionFile({
      agentId,
      cwd,
      runtimeState: { homePath: stateHome },
      env: { KIRI_CLAUDE_HOME: '' },
    })).toEqual({
      sessionId,
      path,
      content,
      offset: undefined,
    })
    expect(envHome).not.toBe(stateHome)
  })
})
