import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildTerminalProcessLaunch,
  claudeTerminalSessionId,
  type TerminalAgentLaunchConfig,
} from '~/server/terminal-launch'

const shell = { command: '/bin/zsh', args: ['-l', '-i'] }

function launchConfig(runtime: TerminalAgentLaunchConfig['runtime']): TerminalAgentLaunchConfig {
  return {
    id: 'agent-1',
    projectId: 'project-1',
    runtime,
    sessionDir: '/tmp/kiri-session',
    sessionFile: 'session.jsonl',
    model: 'test-model',
    cwd: '/tmp/project',
  }
}

describe('buildTerminalProcessLaunch', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('launches Claude Code in yolo mode and preserves Kiri runtime metadata', () => {
    vi.stubEnv('KIRI_CLAUDE_BIN', '/tmp/bin/claude')
    vi.stubEnv('KIRI_CLAUDE_HOME', '/tmp/claude-home')
    vi.stubEnv('KIRI_MCP_BIN', '/tmp/bin/kiri-mcp')
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-outer-shell')

    const config = launchConfig('claude')
    const sessionId = claudeTerminalSessionId(config.id)
    const launch = buildTerminalProcessLaunch(config, 'runtime', shell)

    expect(launch.command).toBe('/tmp/bin/claude')
    expect(launch.args).toEqual([
      '--dangerously-skip-permissions',
      '--mcp-config',
      JSON.stringify({
        mcpServers: {
          kiri: { type: 'stdio', command: '/tmp/bin/kiri-mcp' },
        },
      }),
      '--append-system-prompt',
      [
        'Kiri integration:',
        '- This terminal Claude Code session is Kiri session agent-1.',
        '- Keep TodoWrite current for multi-step work; Kiri projects TodoWrite into its Tasks view where supported.',
        '- Use the Kiri MCP server, especially kiri_rename_session with agentId "agent-1", when the Kiri session title is generic, stale, or no longer matches the work.',
      ].join('\n'),
      '--model',
      'test-model',
      '--session-id',
      sessionId,
    ])
    expect(launch.cwd).toBe('/tmp/project')
    expect(launch.env.HOME).toBe('/tmp/claude-home')
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(launch.env.FORCE_COLOR).toBe('3')
    expect(launch.env.CLICOLOR_FORCE).toBe('1')
    expect(launch.env.KIRI_AGENT_ID).toBe('agent-1')
    expect(launch.env.KIRI_RUNTIME).toBe('claude')
    expect(launch.env.KIRI_CLAUDE_SESSION_ID).toBe(sessionId)
  })

  it('reuses the same Claude Code session id for the same Kiri session', () => {
    const first = buildTerminalProcessLaunch(launchConfig('claude'), 'runtime', shell)
    const second = buildTerminalProcessLaunch(launchConfig('claude'), 'runtime', shell)

    expect(first.args).toContain('--session-id')
    expect(first.env.KIRI_CLAUDE_SESSION_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(first.env.KIRI_CLAUDE_SESSION_ID).toBe(second.env.KIRI_CLAUDE_SESSION_ID)
  })

  it('preserves an explicit Claude resume state when one already exists', () => {
    const launch = buildTerminalProcessLaunch({
      ...launchConfig('claude'),
      runtimeStateJson: JSON.stringify({ resume: 'claude-session-id' }),
    }, 'runtime', shell)

    expect(launch.args).toContain('--resume')
    expect(launch.args).toContain('claude-session-id')
    expect(launch.args).not.toContain('--session-id')
  })

  it('launches Codex in yolo mode with isolated Codex home when configured', () => {
    vi.stubEnv('KIRI_CODEX_BIN', '/tmp/bin/codex')
    vi.stubEnv('KIRI_CODEX_HOME', '/tmp/codex-home')

    const launch = buildTerminalProcessLaunch(launchConfig('codex'), 'runtime', shell)

    expect(launch.command).toBe('/tmp/bin/codex')
    expect(launch.args).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '--model',
      'test-model',
    ])
    expect(launch.env.CODEX_HOME).toBe('/tmp/codex-home')
    expect(launch.env.KIRI_MODEL).toBe('test-model')
  })

  it('launches Pi against the Kiri session directory', () => {
    vi.stubEnv('KIRI_PI_BIN', '/tmp/bin/pi')

    const launch = buildTerminalProcessLaunch(launchConfig('pi'), 'runtime', shell)

    expect(launch.command).toBe('/tmp/bin/pi')
    expect(launch.args).toEqual([
      '--session-dir',
      '/tmp/kiri-session',
      '--session',
      'session.jsonl',
      '--model',
      'test-model',
    ])
  })

  it('keeps shell mode as a separate terminal profile', () => {
    const launch = buildTerminalProcessLaunch(launchConfig('claude'), 'shell', shell)

    expect(launch.command).toBe('/bin/zsh')
    expect(launch.args).toEqual(['-l', '-i'])
    expect(launch.label).toBe('shell')
    expect(launch.env.KIRI_RUNTIME).toBe('claude')
  })

  it('removes color-disabling env from terminal sessions', () => {
    vi.stubEnv('NO_COLOR', '1')
    vi.stubEnv('NODE_DISABLE_COLORS', '1')

    const launch = buildTerminalProcessLaunch(launchConfig('codex'), 'runtime', shell)

    expect(launch.env.NO_COLOR).toBeUndefined()
    expect(launch.env.NODE_DISABLE_COLORS).toBeUndefined()
    expect(launch.env.FORCE_COLOR).toBe('3')
  })
})
