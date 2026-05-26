import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import packageJson from '../../package.json'
import { makeRuntimeBinariesService, RuntimeBinaryError } from '~/server/runtime-binaries'
import {
  buildTerminalProcessLaunch,
  claudeTerminalSessionId,
  makeTerminalLaunchService,
  TerminalLaunchError,
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
        '- Use the Kiri MCP server, especially kiri_do with operation "session.rename" and agentId "agent-1", when the Kiri session title is generic, stale, or no longer matches the work.',
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

  it('passes queued terminal input to Claude Code as the initial prompt', () => {
    const launch = buildTerminalProcessLaunch({
      ...launchConfig('claude'),
      runtimeStateJson: JSON.stringify({
        pendingTerminalInputs: [{
          text: 'Do the terminal work',
          submit: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        }],
      }),
    }, 'runtime', shell)

    expect(launch.args.at(-1)).toBe('Do the terminal work')
    expect(launch.initialTerminalInput).toEqual({
      text: 'Do the terminal work',
      submit: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('resumes Claude Code when the deterministic session already exists on disk', () => {
    const home = mkdtempSync(join(tmpdir(), 'kiri-claude-home-'))
    vi.stubEnv('KIRI_CLAUDE_HOME', home)
    const config = launchConfig('claude')
    const sessionId = claudeTerminalSessionId(config.id)
    const projectDir = join(home, '.claude/projects', resolve(config.cwd).replace(/[\\/]/g, '-'))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), '')

    const launch = buildTerminalProcessLaunch(config, 'runtime', shell)

    expect(launch.args).toContain('--resume')
    expect(launch.args).toContain(sessionId)
    expect(launch.args).not.toContain('--session-id')
    expect(launch.env.KIRI_CLAUDE_SESSION_ID).toBe(sessionId)
  })

  it('ignores empty Claude HOME env values when checking for existing sessions', () => {
    const home = mkdtempSync(join(tmpdir(), 'kiri-claude-home-'))
    vi.stubEnv('KIRI_CLAUDE_HOME', '')
    const config = {
      ...launchConfig('claude'),
      runtimeStateJson: JSON.stringify({ homePath: home }),
    }
    const sessionId = claudeTerminalSessionId(config.id)
    const projectDir = join(home, '.claude/projects', resolve(config.cwd).replace(/[\\/]/g, '-'))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), '')

    const launch = buildTerminalProcessLaunch(config, 'runtime', shell)

    expect(launch.args).toContain('--resume')
    expect(launch.args).toContain(sessionId)
    expect(launch.env.HOME).toBe(home)
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
      '--no-alt-screen',
      '--model',
      'test-model',
    ])
    expect(launch.env.CODEX_HOME).toBe('/tmp/codex-home')
    expect(launch.env.KIRI_MODEL).toBe('test-model')
  })

  it('passes queued terminal input to new Codex sessions as the initial prompt', () => {
    vi.stubEnv('KIRI_CODEX_BIN', '/tmp/bin/codex')

    const launch = buildTerminalProcessLaunch({
      ...launchConfig('codex'),
      runtimeStateJson: JSON.stringify({
        pendingTerminalInputs: [{
          text: 'Do the Codex terminal work',
          submit: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        }],
      }),
    }, 'runtime', shell)

    expect(launch.command).toBe('/tmp/bin/codex')
    expect(launch.args).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '--model',
      'test-model',
      'Do the Codex terminal work',
    ])
    expect(launch.initialTerminalInput).toEqual({
      text: 'Do the Codex terminal work',
      submit: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('resumes Codex when runtime state carries a Codex session id', () => {
    vi.stubEnv('KIRI_CODEX_BIN', '/tmp/bin/codex')

    const launch = buildTerminalProcessLaunch({
      ...launchConfig('codex'),
      runtimeStateJson: JSON.stringify({ codexSessionId: 'codex-session-id' }),
    }, 'runtime', shell)

    expect(launch.command).toBe('/tmp/bin/codex')
    expect(launch.args).toEqual([
      'resume',
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '--model',
      'test-model',
      'codex-session-id',
    ])
    expect(launch.initialTerminalInput).toBeNull()
  })

  it('prefers an explicit Codex resume state over the discovered session id', () => {
    const launch = buildTerminalProcessLaunch({
      ...launchConfig('codex'),
      runtimeStateJson: JSON.stringify({
        resume: 'explicit-codex-session',
        codexSessionId: 'discovered-codex-session',
      }),
    }, 'runtime', shell)

    expect(launch.args).toEqual([
      'resume',
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '--model',
      'test-model',
      'explicit-codex-session',
    ])
  })

  it('surfaces corrupt runtime state json instead of launching fresh', () => {
    expect(() => buildTerminalProcessLaunch({
      ...launchConfig('codex'),
      runtimeStateJson: '{not-json',
    }, 'runtime', shell)).toThrow('Invalid runtime state JSON')
  })

  it('returns typed terminal launch errors for corrupt runtime state through the service', async () => {
    const service = makeTerminalLaunchService({
      runtimeBinaries: makeRuntimeBinariesService({
        getEnv: () => ({ PATH: '/bin', KIRI_CODEX_BIN: '/injected/codex' }),
        getHomeDir: () => '/injected/home',
        exists: () => false,
      }),
      getEnv: () => ({ PATH: '/bin', KIRI_CODEX_BIN: '/injected/codex' }),
      getHomeDir: () => '/injected/home',
      exists: () => false,
      getProcessCwd: () => '/repo',
      getExecPath: () => '/node',
      getResourcesPath: () => undefined,
    })

    const error = await Effect.runPromise(service.buildProcessLaunch({
      config: {
        ...launchConfig('codex'),
        runtimeStateJson: '[]',
      },
      mode: 'runtime',
      shell,
    }).pipe(Effect.flip))

    expect(error).toBeInstanceOf(TerminalLaunchError)
    expect(error.message).toBe('Invalid runtime state JSON')
  })

  it('launches Pi against the Kiri session directory without Anthropic OAuth env', () => {
    vi.stubEnv('KIRI_PI_BIN', '/tmp/bin/pi')
    vi.stubEnv('ANTHROPIC_API_KEY', 'api-key')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'auth-token')
    vi.stubEnv('ANTHROPIC_OAUTH_TOKEN', 'oauth-token')

    const launch = buildTerminalProcessLaunch(launchConfig('pi'), 'runtime', shell)

    expect(launch.command).toBe('/tmp/bin/pi')
    expect(launch.args).toEqual([
      '--session-dir',
      '/tmp/kiri-session',
      '--session',
      'session.jsonl',
      '--models',
      'openai-codex/gpt-5.5,vibeproxy-anthropic/claude-opus-4-7,deepseek/deepseek-v4-flash',
      '--model',
      'test-model',
    ])
    expect(launch.env.ANTHROPIC_API_KEY).toBe('api-key')
    expect(launch.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(launch.env.ANTHROPIC_OAUTH_TOKEN).toBeUndefined()
  })

  it('can explicitly allow Anthropic OAuth for Pi launches', () => {
    vi.stubEnv('KIRI_PI_ALLOW_ANTHROPIC_OAUTH', '1')
    vi.stubEnv('ANTHROPIC_OAUTH_TOKEN', 'oauth-token')

    const launch = buildTerminalProcessLaunch(launchConfig('pi'), 'runtime', shell)

    expect(launch.env.ANTHROPIC_OAUTH_TOKEN).toBe('oauth-token')
  })

  it('launches OpenCode TUI against the project cwd', () => {
    vi.stubEnv('KIRI_OPENCODE_BIN', '/tmp/bin/opencode')
    vi.stubEnv('KIRI_OPENCODE_HOME', '/tmp/opencode-home')

    const launch = buildTerminalProcessLaunch(launchConfig('opencode'), 'runtime', shell)

    expect(launch.command).toBe('/tmp/bin/opencode')
    expect(launch.args).toEqual([
      '/tmp/project',
      '--model',
      'test-model',
    ])
    expect(launch.cwd).toBe('/tmp/project')
    expect(launch.label).toBe('opencode')
    expect(launch.env.HOME).toBe('/tmp/opencode-home')
    expect(launch.env.KIRI_RUNTIME).toBe('opencode')
    expect(launch.env.KIRI_MODEL).toBe('test-model')
  })

  it('resumes OpenCode when runtime state carries a session id', () => {
    const launch = buildTerminalProcessLaunch({
      ...launchConfig('opencode'),
      runtimeStateJson: JSON.stringify({ resume: 'ses_123' }),
    }, 'runtime', shell)

    expect(launch.args).toEqual([
      '/tmp/project',
      '--model',
      'test-model',
      '--session',
      'ses_123',
    ])
  })

  it('keeps shell mode as a separate terminal profile', () => {
    const launch = buildTerminalProcessLaunch(launchConfig('claude'), 'shell', shell)

    expect(launch.command).toBe('/bin/zsh')
    expect(launch.args).toEqual(['-l', '-i'])
    expect(launch.label).toBe('shell')
    expect(launch.env.KIRI_PROJECT_CWD).toBe('/tmp/project')
    expect(launch.env.KIRI_AGENT_ID).toBeUndefined()
    expect(launch.env.KIRI_RUNTIME).toBeUndefined()
    expect(launch.env.KIRI_SESSION_DIR).toBeUndefined()
  })

  it('removes color-disabling env from terminal sessions', () => {
    vi.stubEnv('NO_COLOR', '1')
    vi.stubEnv('NODE_DISABLE_COLORS', '1')

    const launch = buildTerminalProcessLaunch(launchConfig('codex'), 'runtime', shell)

    expect(launch.env.NO_COLOR).toBeUndefined()
    expect(launch.env.NODE_DISABLE_COLORS).toBeUndefined()
    expect(launch.env.FORCE_COLOR).toBe('3')
  })

  it('advertises Ghostty-compatible terminfo when available', async () => {
    const env = {
      PATH: '/bin',
      KIRI_CODEX_BIN: '/injected/codex',
    }
    const service = makeTerminalLaunchService({
      runtimeBinaries: makeRuntimeBinariesService({
        getEnv: () => env,
        getHomeDir: () => '/injected/home',
        exists: (path) => path === '/app/resources/terminfo' || path === '/injected/codex',
      }),
      getEnv: () => env,
      getHomeDir: () => '/injected/home',
      exists: (path) => path === '/app/resources/terminfo' || path === '/injected/codex',
      getProcessCwd: () => '/repo',
      getExecPath: () => '/node',
      getResourcesPath: () => '/app/resources',
    })

    const launch = await Effect.runPromise(service.buildProcessLaunch({
      config: launchConfig('codex'),
      mode: 'runtime',
      shell,
    }))

    expect(launch.env.TERM).toBe('xterm-ghostty')
    expect(launch.env.TERM_PROGRAM).toBe('kiri')
    expect(launch.env.TERM_PROGRAM_VERSION).toBe(packageJson.version)
    expect(launch.env.TERMINFO).toBe('/app/resources/terminfo')
    expect(launch.env.COLORTERM).toBe('truecolor')
    expect(launch.env.COLORFGBG).toBe('15;0')
  })

  it('builds terminal launches through injected service dependencies', async () => {
    const env = {
      PATH: '/bin',
      KIRI_CLAUDE_BIN: '/injected/claude',
      KIRI_CLAUDE_HOME: '/injected/claude-home',
      KIRI_MCP_BIN: '/injected/kiri-mcp',
      ANTHROPIC_API_KEY: 'outer-token',
    }
    const service = makeTerminalLaunchService({
      runtimeBinaries: makeRuntimeBinariesService({
        getEnv: () => env,
        getHomeDir: () => '/injected/home',
        exists: () => false,
      }),
      getEnv: () => env,
      getHomeDir: () => '/injected/home',
      exists: () => false,
      getProcessCwd: () => '/repo',
      getExecPath: () => '/node',
      getResourcesPath: () => undefined,
    })

    const launch = await Effect.runPromise(service.buildProcessLaunch({
      config: launchConfig('claude'),
      mode: 'runtime',
      shell,
    }))

    expect(launch.command).toBe('/injected/claude')
    expect(launch.env.HOME).toBe('/injected/claude-home')
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(launch.args).toContain(JSON.stringify({
      mcpServers: {
        kiri: { type: 'stdio', command: '/injected/kiri-mcp' },
      },
    }))
  })

  it('preserves Codex, Pi, and shell launch behavior through the injected service', async () => {
    const env = {
      PATH: '/bin',
      KIRI_CODEX_BIN: '/injected/codex',
      KIRI_CODEX_HOME: '/injected/codex-home',
      KIRI_PI_BIN: '/injected/pi',
    }
    const service = makeTerminalLaunchService({
      runtimeBinaries: makeRuntimeBinariesService({
        getEnv: () => env,
        getHomeDir: () => '/injected/home',
        exists: () => false,
      }),
      getEnv: () => env,
      getHomeDir: () => '/injected/home',
      exists: () => false,
      getProcessCwd: () => '/repo',
      getExecPath: () => '/node',
      getResourcesPath: () => undefined,
    })

    const codex = await Effect.runPromise(service.buildProcessLaunch({
      config: launchConfig('codex'),
      mode: 'runtime',
      shell,
    }))
    const pi = await Effect.runPromise(service.buildProcessLaunch({
      config: launchConfig('pi'),
      mode: 'runtime',
      shell,
    }))
    const shellLaunch = await Effect.runPromise(service.buildProcessLaunch({
      config: launchConfig('claude'),
      mode: 'shell',
      shell,
    }))

    expect(codex.command).toBe('/injected/codex')
    expect(codex.args).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '--model',
      'test-model',
    ])
    expect(codex.env.CODEX_HOME).toBe('/injected/codex-home')
    expect(pi.command).toBe('/injected/pi')
    expect(pi.args).toEqual([
      '--session-dir',
      '/tmp/kiri-session',
      '--session',
      'session.jsonl',
      '--models',
      'openai-codex/gpt-5.5,vibeproxy-anthropic/claude-opus-4-7,deepseek/deepseek-v4-flash',
      '--model',
      'test-model',
    ])
    expect(shellLaunch.command).toBe('/bin/zsh')
    expect(shellLaunch.args).toEqual(['-l', '-i'])
    expect(shellLaunch.env.KIRI_AGENT_ID).toBeUndefined()
    expect(shellLaunch.env.KIRI_PROJECT_CWD).toBe('/tmp/project')
  })

  it('wraps injected runtime binary failures as terminal launch errors', async () => {
    const service = makeTerminalLaunchService({
      runtimeBinaries: {
        resolveExecutable: () => Effect.fail(new RuntimeBinaryError({
          message: 'binary lookup failed',
        })),
        processEnv: () => Effect.succeed({}),
      },
      getEnv: () => ({}),
      getHomeDir: () => '/home',
      exists: () => false,
      getProcessCwd: () => '/repo',
      getExecPath: () => '/node',
      getResourcesPath: () => undefined,
    })

    const error = await Effect.runPromise(service.buildProcessLaunch({
      config: launchConfig('codex'),
      mode: 'runtime',
      shell,
    }).pipe(Effect.flip))

    expect(error).toBeInstanceOf(TerminalLaunchError)
    expect(error.message).toBe('binary lookup failed')
  })
})
