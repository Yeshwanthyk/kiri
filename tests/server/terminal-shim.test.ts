import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  agentPresenceShellCommand,
} from '~/server/agent-presence'
import {
  buildTerminalShimArgsScript,
  installTerminalShims,
  terminalShimBinDir,
} from '~/server/terminal-shim'

describe('terminal PATH shims', () => {
  it('generates codex and claude wrappers idempotently', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kiri-shim-home-'))
    const input = {
      homeDir,
      baseInvocation: {
        command: '/repo/node',
        args: ['/repo/dist/cli/kirictl.mjs'],
      },
      hookInvocation: {
        command: '/repo/node',
        args: ['/repo/dist/cli/kiri-hook.mjs'],
      },
      mcpConfig: {
        type: 'stdio' as const,
        command: '/repo/node',
        args: ['/repo/dist/cli/kirictl.mjs', 'mcp'],
      },
    }

    const first = installTerminalShims(input)
    const codex = readFileSync(first.paths.codex, 'utf8')
    const claude = readFileSync(first.paths.claude, 'utf8')
    const codexMtime = statSync(first.paths.codex).mtimeMs
    const second = installTerminalShims(input)

    expect(first.binDir).toBe(terminalShimBinDir(homeDir))
    expect(first.changed).toEqual({ codex: true, claude: true })
    expect(second.changed).toEqual({ codex: false, claude: false })
    expect(statSync(second.paths.codex).mtimeMs).toBe(codexMtime)
    expect(codex).toContain('KIRI_SHIM_ACTIVE=1')
    expect(codex).toContain('term')
    expect(codex).toContain('shim-args')
    expect(claude).toContain('unset TERMINFO')
  })

  it('rewrites wrappers only when the embedded invocation changes', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kiri-shim-home-'))
    const common = {
      homeDir,
      mcpConfig: { type: 'stdio' as const, command: '/repo/kiri-mcp' },
    }

    installTerminalShims({
      ...common,
      baseInvocation: { command: '/repo/kiri-mcp', args: [] },
      hookInvocation: { command: '/repo/kiri-hook', args: [] },
    })
    const changed = installTerminalShims({
      ...common,
      baseInvocation: { command: '/repo/other-kiri-mcp', args: [] },
      hookInvocation: { command: '/repo/kiri-hook', args: [] },
    }).changed

    expect(changed).toEqual({ codex: true, claude: true })
  })

  it('builds codex argv injection from the wrapper-provided invocations', () => {
    const script = buildTerminalShimArgsScript({
      runtime: 'codex',
      env: {
        KIRI_SHIM_BASE_INVOCATION: JSON.stringify({
          command: '/repo/kiri-mcp',
          args: [],
        }),
        KIRI_SHIM_HOOK_INVOCATION: JSON.stringify({
          command: '/repo/kiri-hook',
          args: [],
        }),
        KIRI_SHIM_MCP_CONFIG: JSON.stringify({
          type: 'stdio',
          command: '/repo/kiri-mcp',
        }),
      },
    })

    expect(script).toContain('set --')
    expect(script).toContain("'--config'")
    expect(script).toContain('mcp_servers.kiri.command')
    expect(script).toContain('codex-hook')
    expect(script).toContain('session-start')
    expect(script).toContain('"$@"')
  })

  it('builds claude settings argv and writes the hook bundle', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kiri-shim-home-'))
    const stateDir = join(homeDir, '.kiri/shim')
    const script = buildTerminalShimArgsScript({
      runtime: 'claude',
      homeDir,
      env: {
        KIRI_SHIM_STATE_DIR: stateDir,
        KIRI_SHIM_BASE_INVOCATION: JSON.stringify({
          command: '/repo/kiri-mcp',
          args: [],
        }),
        KIRI_SHIM_HOOK_INVOCATION: JSON.stringify({
          command: '/repo/kiri-hook',
          args: [],
        }),
      },
    })
    const settings = JSON.parse(readFileSync(join(stateDir, 'claude-hooks-settings.json'), 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; async: boolean }> }>>
    }

    expect(script).toBe(`set -- '--settings' '${join(stateDir, 'claude-hooks-settings.json')}' "$@"`)
    expect(hookCommands(settings, 'SessionStart')).toEqual([
      agentPresenceShellCommand('claude', 'session_start'),
      "KIRI_BACKEND_CONTROL_TIMEOUT_MS=3000 '/repo/kiri-hook' 'claude-hook' 'session-start'",
    ])
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe('AskUserQuestion|ExitPlanMode')
    expect(hookCommands(settings, 'Stop')).toEqual([
      agentPresenceShellCommand('claude', 'idle'),
      "KIRI_BACKEND_CONTROL_TIMEOUT_MS=3000 '/repo/kiri-hook' 'claude-hook' 'stop'",
    ])
    expect(settings.hooks.PostToolUse?.[0]?.matcher).toBeUndefined()
    expect(settings.hooks.PostToolUse?.[1]?.matcher).toBe('TodoWrite')
    expect(settings.hooks.PostToolUse?.[0]?.hooks[0]?.async).toBe(true)
    expect(hookCommands(settings, 'PostToolUse')).toEqual([
      agentPresenceShellCommand('claude', 'busy'),
      "KIRI_BACKEND_CONTROL_TIMEOUT_MS=3000 '/repo/kiri-hook' 'claude-hook' 'post-tool-use'",
    ])
  })
})

function hookCommands(
  settings: { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> },
  event: string,
) {
  return settings.hooks[event]?.flatMap((entry) => entry.hooks.map((hook) => hook.command)) ?? []
}
