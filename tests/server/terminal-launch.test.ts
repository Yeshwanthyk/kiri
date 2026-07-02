import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeRuntimeBinariesService, RuntimeBinaryError } from '~/server/runtime-binaries'
import {
  buildTerminalProcessLaunch,
  claudeTerminalSessionId,
  makeTerminalLaunchService,
  TerminalLaunchError,
  type TerminalAgentLaunchConfig,
} from '~/server/terminal-launch'
import {
  writeCodexHookSessionBinding,
  writeCodexTerminalSessionId,
} from '~/server/codex-terminal-session'

const shell = { command: '/bin/zsh', args: ['-l', '-i'] }
const codexKiriPrompt = [
  'Kiri integration:',
  '- This terminal Codex session is Kiri session agent-1.',
  '- Keep the Kiri session title accurate. When the title is generic, stale, or the current work changes, call kiri_do with operation "session.rename" and params {"agentId":"agent-1","title":"Short action title"}.',
  '- Use Kiri MCP operations through kiri_get and kiri_do; there are no separate kiri_rename_session, kiri_list_projects, or kiri_list_sessions tools.',
].join('\n')

function codexKiriArgs(kiriMcpBin = '/tmp/bin/kiri-mcp') {
  return [
    '--config',
    `developer_instructions=${JSON.stringify(codexKiriPrompt)}`,
    '--config',
    `mcp_servers.kiri.command=${JSON.stringify(kiriMcpBin)}`,
  ]
}

function codexHookArgs(kiriMcpBin = '/tmp/bin/kiri-mcp') {
  const invocation = `'${kiriMcpBin}' 'codex-hook' 'session-start'`
  const script = `f="$(mktemp -t kiri-codex-hook)"; cat > "$f"; (${invocation} --stdin-file "$f" >> /tmp/kiri-codex-hook.log 2>&1; rm -f "$f") & printf '{}'`
  const command = `/bin/sh -c '${script.replaceAll("'", "'\\''")}'`
  return [
    '--enable',
    'hooks',
    '--dangerously-bypass-hook-trust',
    '--config',
    `hooks.SessionStart=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}]`,
  ]
}

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

function stubCodexTerminalEnv() {
  vi.stubEnv('KIRI_CODEX_BIN', '/tmp/bin/codex')
  vi.stubEnv('KIRI_MCP_BIN', '/tmp/bin/kiri-mcp')
}

function writeCodexHelpScript(path: string, supportsHooks: boolean) {
  writeFileSync(path, [
    '#!/bin/sh',
    supportsHooks ? 'printf "%s\\n" "dangerously-bypass-hook-trust"' : 'printf "%s\\n" "codex help"',
  ].join('\n'))
  chmodSync(path, 0o755)
}

describe('buildTerminalProcessLaunch', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('launches Claude Code in yolo mode and preserves Kiri runtime metadata', () => {
    vi.stubEnv('KIRI_CLAUDE_BIN', '/tmp/bin/claude')
    vi.stubEnv('KIRI_CLAUDE_HOME', '/tmp/claude-home')
    vi.stubEnv('KIRI_MCP_BIN', '/tmp/bin/kiri-mcp')
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-outer-shell')
    vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/outer/claude')

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
      '--settings',
      '/tmp/kiri-session/claude-hooks-settings.json',
      '--append-system-prompt',
      [
        'Kiri integration:',
        '- This terminal Claude Code session is Kiri session agent-1.',
        '- Keep TodoWrite current for multi-step work; Kiri projects TodoWrite into its Tasks view where supported.',
        '- Use the Kiri MCP server, especially kiri_do with operation "session.rename" and agentId "agent-1", when the Kiri session title is generic, stale, or no longer matches the work.',
        '- When stuck, try kiri_get "knowledge.search"; save reusable answers with kiri_do "knowledge.add", then mark helpful ones with "knowledge.markSeen".',
        '- Kiri terminals are fully drivable over MCP: kiri_get "terminal.read" returns the screen of this session\'s shell (mode "shell") or another agent\'s terminal; kiri_do "terminal.input", "terminal.keys" (enter, up, c-c, ...), and "terminal.wait-for" (regex over screen/output) let you type, press keys, and wait like a human would.',
      ].join('\n'),
      '--model',
      'test-model',
      '--session-id',
      sessionId,
    ])
    expect(launch.cwd).toBe('/tmp/project')
    expect(launch.env.HOME).toBe('/tmp/claude-home')
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-home/.claude')
    expect(launch.env.CLAUDECODE).toBeUndefined()
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(launch.env.FORCE_COLOR).toBe('3')
    expect(launch.env.CLICOLOR_FORCE).toBe('1')
    expect(launch.env.KIRI_AGENT_ID).toBe('agent-1')
    expect(launch.env.KIRI_RUNTIME).toBe('claude')
    expect(launch.env.KIRI_CLAUDE_SESSION_ID).toBe(sessionId)
  })

  it('writes one Claude hook settings file for lifecycle and TodoWrite projection', () => {
    vi.stubEnv('KIRI_CLAUDE_BIN', '/tmp/bin/claude')
    vi.stubEnv('KIRI_MCP_BIN', '/tmp/bin/kiri-mcp')
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-claude-hooks-'))

    const launch = buildTerminalProcessLaunch({
      ...launchConfig('claude'),
      sessionDir,
    }, 'runtime', shell)
    const settingsPath = join(sessionDir, 'claude-hooks-settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; async: boolean }> }>>
    }

    expect(launch.args.filter((arg) => arg === '--settings')).toHaveLength(1)
    expect(launch.args).toContain(settingsPath)
    expect(settings.hooks.SessionStart?.[0]?.hooks[0]?.command)
      .toBe("'/tmp/bin/kiri-mcp' 'claude-hook' 'session-start'")
    expect(settings.hooks.UserPromptSubmit?.[0]?.hooks[0]?.async).toBe(true)
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command)
      .toBe("'/tmp/bin/kiri-mcp' 'claude-hook' 'stop'")
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe('AskUserQuestion|ExitPlanMode')
    expect(settings.hooks.PostToolUse?.[0]?.matcher).toBe('TodoWrite')
    expect(settings.hooks.PostToolUse?.[0]?.hooks[0]?.command)
      .toBe("'/tmp/bin/kiri-mcp' 'claude-hook' 'post-tool-use'")
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
    stubCodexTerminalEnv()
    vi.stubEnv('KIRI_CODEX_HOME', '/tmp/codex-home')

    const launch = buildTerminalProcessLaunch(launchConfig('codex'), 'runtime', shell)

    expect(launch.command).toBe('/tmp/bin/codex')
    expect(launch.args).toEqual([
      ...codexKiriArgs(),
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '--model',
      'test-model',
    ])
    expect(launch.env.CODEX_HOME).toBe('/tmp/codex-home')
    expect(launch.env.KIRI_MODEL).toBe('test-model')
  })

  it('adds Codex SessionStart hook args when hook support is enabled', () => {
    stubCodexTerminalEnv()
    vi.stubEnv('KIRI_CODEX_HOOKS', '1')

    const launch = buildTerminalProcessLaunch(launchConfig('codex'), 'runtime', shell)

    expect(launch.args).toEqual([
      ...codexKiriArgs(),
      ...codexHookArgs(),
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '--model',
      'test-model',
    ])
  })

  it('omits Codex SessionStart hook args when hooks are disabled', () => {
    stubCodexTerminalEnv()
    vi.stubEnv('KIRI_CODEX_HOOKS', '0')

    const launch = buildTerminalProcessLaunch(launchConfig('codex'), 'runtime', shell)

    expect(launch.args).not.toContain('--dangerously-bypass-hook-trust')
    expect(launch.args).not.toContain('--enable')
  })

  it('re-probes Codex hook support after the cache TTL expires', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const binDir = mkdtempSync(join(tmpdir(), 'kiri-codex-bin-'))
    const codexBin = join(binDir, 'codex')
    writeCodexHelpScript(codexBin, false)
    vi.stubEnv('KIRI_CODEX_BIN', codexBin)
    vi.stubEnv('KIRI_MCP_BIN', '/tmp/bin/kiri-mcp')

    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    expect(buildTerminalProcessLaunch(launchConfig('codex'), 'runtime', shell).args)
      .not.toContain('--dangerously-bypass-hook-trust')

    writeCodexHelpScript(codexBin, true)
    vi.setSystemTime(new Date('2026-01-01T01:00:01.000Z'))
    expect(buildTerminalProcessLaunch(launchConfig('codex'), 'runtime', shell).args)
      .toContain('--dangerously-bypass-hook-trust')
  })

  it('passes queued terminal input to new Codex sessions as the initial prompt', () => {
    stubCodexTerminalEnv()

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
      ...codexKiriArgs(),
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
    stubCodexTerminalEnv()

    const launch = buildTerminalProcessLaunch({
      ...launchConfig('codex'),
      runtimeStateJson: JSON.stringify({ codexSessionId: 'codex-session-id' }),
    }, 'runtime', shell)

    expect(launch.command).toBe('/tmp/bin/codex')
    expect(launch.args).toEqual([
      'resume',
      ...codexKiriArgs(),
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '--model',
      'test-model',
      'codex-session-id',
    ])
    expect(launch.initialTerminalInput).toBeNull()
  })

  it('adds Codex SessionStart hook args when resuming', () => {
    stubCodexTerminalEnv()
    vi.stubEnv('KIRI_CODEX_HOOKS', '1')

    const launch = buildTerminalProcessLaunch({
      ...launchConfig('codex'),
      runtimeStateJson: JSON.stringify({ codexSessionId: 'codex-session-id' }),
    }, 'runtime', shell)

    expect(launch.args).toEqual([
      'resume',
      ...codexKiriArgs(),
      ...codexHookArgs(),
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '--model',
      'test-model',
      'codex-session-id',
    ])
  })

  it('resumes Codex from the Kiri session directory when runtime state is missing', () => {
    stubCodexTerminalEnv()
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-codex-session-'))
    writeCodexTerminalSessionId(sessionDir, 'sidecar-codex-session')

    const launch = buildTerminalProcessLaunch({
      ...launchConfig('codex'),
      sessionDir,
    }, 'runtime', shell)

    expect(launch.command).toBe('/tmp/bin/codex')
    expect(launch.args).toEqual([
      'resume',
      ...codexKiriArgs(),
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '--model',
      'test-model',
      'sidecar-codex-session',
    ])
    expect(launch.initialTerminalInput).toBeNull()
  })

  it('prefers the Kiri session directory over stale Codex runtime state', () => {
    stubCodexTerminalEnv()
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-codex-session-'))
    writeCodexTerminalSessionId(sessionDir, 'sidecar-codex-session')

    const launch = buildTerminalProcessLaunch({
      ...launchConfig('codex'),
      sessionDir,
      runtimeStateJson: JSON.stringify({ codexSessionId: 'stale-db-session' }),
    }, 'runtime', shell)

    expect(launch.args.at(-1)).toBe('sidecar-codex-session')
  })

  it('prefers a Codex-specific runtime session id over generic resume state', () => {
    vi.stubEnv('KIRI_MCP_BIN', '/tmp/bin/kiri-mcp')
    vi.stubEnv('KIRI_CODEX_HOOKS', '0')

    const launch = buildTerminalProcessLaunch({
      ...launchConfig('codex'),
      runtimeStateJson: JSON.stringify({
        resume: 'explicit-codex-session',
        codexSessionId: 'discovered-codex-session',
      }),
    }, 'runtime', shell)

    expect(launch.args).toEqual([
      'resume',
      ...codexKiriArgs(),
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '--model',
      'test-model',
      'discovered-codex-session',
    ])
  })

  it('ignores Codex ids written by a mismatched hook binding', () => {
    stubCodexTerminalEnv()
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-codex-session-'))
    writeCodexTerminalSessionId(sessionDir, 'wrong-hook-session')
    writeCodexHookSessionBinding(sessionDir, {
      agentId: 'agent-1',
      sessionId: 'wrong-hook-session',
      cwd: '/tmp/other-project',
      source: 'startup',
      hookEventName: 'SessionStart',
      writtenAtMs: Date.now(),
    })

    const launch = buildTerminalProcessLaunch({
      ...launchConfig('codex'),
      sessionDir,
      runtimeStateJson: JSON.stringify({ codexSessionId: 'wrong-hook-session' }),
    }, 'runtime', shell)

    expect(launch.args).not.toContain('resume')
    expect(launch.args).not.toContain('wrong-hook-session')
  })

  it('uses the packaged helper wrapper for Codex hook commands', async () => {
    const resourcesPath = '/app/Contents/Resources'
    const packagedHelper = `${resourcesPath}/bin/kiri-mcp`
    const service = makeTerminalLaunchService({
      runtimeBinaries: makeRuntimeBinariesService({
        getEnv: () => ({ PATH: '/bin', KIRI_CODEX_BIN: '/injected/codex' }),
        getHomeDir: () => '/injected/home',
        exists: () => false,
      }),
      getEnv: () => ({
        PATH: '/bin',
        KIRI_CODEX_BIN: '/injected/codex',
        KIRI_CODEX_HOOKS: '1',
      }),
      getHomeDir: () => '/injected/home',
      exists: (path) => path === packagedHelper,
      getProcessCwd: () => '/repo',
      getExecPath: () => '/node',
      getResourcesPath: () => resourcesPath,
    })

    const launch = await Effect.runPromise(service.buildProcessLaunch({
      config: launchConfig('codex'),
      mode: 'runtime',
      shell,
    }))

    expect(launch.args).toContain(`mcp_servers.kiri.command=${JSON.stringify(packagedHelper)}`)
    expect(launch.args).toContain(
      codexHookArgs(packagedHelper).at(-1),
    )
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

  it('keeps shell mode project-scoped and prepends the terminal shim path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kiri-shell-home-'))
    const service = makeTerminalLaunchService({
      runtimeBinaries: makeRuntimeBinariesService({
        getEnv: () => ({ PATH: '/usr/bin', KIRI_MCP_BIN: '/tmp/bin/kiri-mcp' }),
        getHomeDir: () => home,
        exists: () => false,
      }),
      getEnv: () => ({ PATH: '/usr/bin', KIRI_MCP_BIN: '/tmp/bin/kiri-mcp' }),
      getHomeDir: () => home,
      exists: () => false,
      getProcessCwd: () => '/repo',
      getExecPath: () => '/node',
      getResourcesPath: () => undefined,
    })

    const launch = await Effect.runPromise(service.buildProcessLaunch({
      config: launchConfig('claude'),
      mode: 'shell',
      shell,
    }))
    const shimDir = join(home, '.kiri/shim/bin')

    expect(launch.command).toBe('/bin/zsh')
    expect(launch.args).toEqual(['-l', '-i'])
    expect(launch.label).toBe('shell')
    expect(launch.env.PATH?.split(delimiter)[0]).toBe(shimDir)
    expect(readFileSync(join(shimDir, 'codex'), 'utf8')).toContain("'term' 'shim-args'")
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
    const home = mkdtempSync(join(tmpdir(), 'kiri-service-home-'))
    const env = {
      PATH: '/bin',
      KIRI_CODEX_BIN: '/injected/codex',
      KIRI_CODEX_HOME: '/injected/codex-home',
      KIRI_MCP_BIN: '/injected/kiri-mcp',
      KIRI_PI_BIN: '/injected/pi',
    }
    const service = makeTerminalLaunchService({
      runtimeBinaries: makeRuntimeBinariesService({
        getEnv: () => env,
        getHomeDir: () => home,
        exists: () => false,
      }),
      getEnv: () => env,
      getHomeDir: () => home,
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
      ...codexKiriArgs('/injected/kiri-mcp'),
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
      '--model',
      'test-model',
    ])
    expect(shellLaunch.command).toBe('/bin/zsh')
    expect(shellLaunch.args).toEqual(['-l', '-i'])
    expect(shellLaunch.env.KIRI_AGENT_ID).toBeUndefined()
    expect(shellLaunch.env.KIRI_PROJECT_CWD).toBe('/tmp/project')
    expect(shellLaunch.env.PATH?.split(delimiter)[0]).toBe(join(home, '.kiri/shim/bin'))
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
