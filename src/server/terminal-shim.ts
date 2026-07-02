import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type TerminalShimRuntime = 'codex' | 'claude'

export type KirictlInvocation = {
  readonly command: string
  readonly args: readonly string[]
}

export type KiriMcpServerConfig = {
  readonly type: 'stdio'
  readonly command: string
  readonly args?: readonly string[]
}

export type TerminalShimInstallResult = {
  readonly binDir: string
  readonly paths: Record<TerminalShimRuntime, string>
  readonly changed: Record<TerminalShimRuntime, boolean>
}

export function terminalShimBinDir(homeDir: string) {
  return join(homeDir, '.kiri', 'shim', 'bin')
}

export function terminalShimStateDir(homeDir: string) {
  return join(homeDir, '.kiri', 'shim')
}

export function installTerminalShims(input: {
  readonly homeDir: string
  readonly baseInvocation: KirictlInvocation
  readonly mcpConfig: KiriMcpServerConfig
  readonly exists?: (path: string) => boolean
  readonly readFile?: (path: string) => string
  readonly writeFile?: (path: string, contents: string, mode: number) => void
  readonly mkdir?: (path: string) => void
  readonly chmod?: (path: string, mode: number) => void
}): TerminalShimInstallResult {
  const exists = input.exists ?? existsSync
  const readFile = input.readFile ?? ((path) => readFileSync(path, 'utf8'))
  const writeFile = input.writeFile ?? ((path, contents, mode) => writeFileSync(path, contents, { mode }))
  const mkdir = input.mkdir ?? ((path) => mkdirSync(path, { recursive: true }))
  const chmod = input.chmod ?? chmodSync
  const binDir = terminalShimBinDir(input.homeDir)
  mkdir(binDir)

  const runtimes: TerminalShimRuntime[] = ['codex', 'claude']
  const changed = Object.fromEntries(runtimes.map((runtime) => {
    const path = join(binDir, runtime)
    const contents = terminalShimScript({
      runtime,
      binDir,
      stateDir: terminalShimStateDir(input.homeDir),
      baseInvocation: input.baseInvocation,
      mcpConfig: input.mcpConfig,
    })
    const didChange = !exists(path) || readFile(path) !== contents
    if (didChange) writeFile(path, contents, 0o755)
    chmod(path, 0o755)
    return [runtime, didChange]
  })) as Record<TerminalShimRuntime, boolean>

  return {
    binDir,
    paths: {
      codex: join(binDir, 'codex'),
      claude: join(binDir, 'claude'),
    },
    changed,
  }
}

export function buildTerminalShimArgsScript(input: {
  readonly runtime: TerminalShimRuntime
  readonly env?: NodeJS.ProcessEnv
  readonly homeDir?: string
}) {
  const env = input.env ?? process.env
  const baseInvocation = invocationFromEnv(env.KIRI_SHIM_BASE_INVOCATION)
    ?? { command: 'kirictl', args: [] }
  const mcpConfig = mcpConfigFromEnv(env.KIRI_SHIM_MCP_CONFIG)
    ?? { type: 'stdio' as const, command: baseInvocation.command, args: [...baseInvocation.args, 'mcp'] }
  const agentId = env.KIRI_AGENT_ID?.trim() || 'shell'

  if (input.runtime === 'codex') {
    return shellSetArgv([
      ...codexKiriConfigArgs(agentId, mcpConfig),
      ...codexSessionStartHookArgs({
        command: baseInvocation.command,
        args: [...baseInvocation.args, 'codex-hook', 'session-start'],
      }),
    ])
  }

  const stateDir = env.KIRI_SHIM_STATE_DIR?.trim()
    || terminalShimStateDir(input.homeDir ?? homedir())
  const settingsPath = join(stateDir, 'claude-hooks-settings.json')
  mkdirSync(stateDir, { recursive: true })
  writeFileIfChanged(settingsPath, `${globalThis.JSON.stringify(claudeHookSettings({
    SessionStart: kirictlCommand({
      command: baseInvocation.command,
      args: [...baseInvocation.args, 'claude-hook', 'session-start'],
    }),
    UserPromptSubmit: kirictlCommand({
      command: baseInvocation.command,
      args: [...baseInvocation.args, 'claude-hook', 'user-prompt-submit'],
    }),
    Stop: kirictlCommand({
      command: baseInvocation.command,
      args: [...baseInvocation.args, 'claude-hook', 'stop'],
    }),
    SessionEnd: kirictlCommand({
      command: baseInvocation.command,
      args: [...baseInvocation.args, 'claude-hook', 'session-end'],
    }),
    PreToolUse: kirictlCommand({
      command: baseInvocation.command,
      args: [...baseInvocation.args, 'claude-hook', 'pre-tool-use'],
    }),
    PermissionRequest: kirictlCommand({
      command: baseInvocation.command,
      args: [...baseInvocation.args, 'claude-hook', 'permission-request'],
    }),
    PostToolUse: kirictlCommand({
      command: baseInvocation.command,
      args: [...baseInvocation.args, 'claude-hook', 'post-tool-use'],
    }),
  }), null, 2)}\n`)
  return shellSetArgv(['--settings', settingsPath])
}

export function codexSessionStartHookArgs(invocation: KirictlInvocation) {
  const command = codexSessionStartHookCommand(invocation)
  return [
    '--enable',
    'hooks',
    '--dangerously-bypass-hook-trust',
    '--config',
    `hooks.SessionStart=[{hooks=[{type="command",command=${tomlString(command)},timeout=5}]}]`,
  ]
}

export function codexKiriConfigArgs(agentId: string, config: KiriMcpServerConfig) {
  // Keep Codex config ephemeral: do not write ~/.codex/config.toml or clobber notify.
  const args = [
    '--config',
    `developer_instructions=${tomlString(codexKiriTerminalPrompt(agentId))}`,
    '--config',
    `mcp_servers.kiri.command=${tomlString(config.command)}`,
  ]
  if (config.args?.length) {
    args.push(
      '--config',
      `mcp_servers.kiri.args=${tomlStringArray(config.args)}`,
    )
  }
  return args
}

export function claudeHookSettings(commandByEvent: {
  readonly SessionStart: string
  readonly UserPromptSubmit: string
  readonly Stop: string
  readonly SessionEnd: string
  readonly PreToolUse: string
  readonly PermissionRequest: string
  readonly PostToolUse: string
}) {
  return {
    hooks: {
      SessionStart: [claudeHookConfigEntry(commandByEvent.SessionStart)],
      UserPromptSubmit: [claudeHookConfigEntry(commandByEvent.UserPromptSubmit)],
      Stop: [claudeHookConfigEntry(commandByEvent.Stop)],
      SessionEnd: [claudeHookConfigEntry(commandByEvent.SessionEnd)],
      PreToolUse: [claudeHookConfigEntry(commandByEvent.PreToolUse, 'AskUserQuestion|ExitPlanMode')],
      PermissionRequest: [claudeHookConfigEntry(commandByEvent.PermissionRequest)],
      PostToolUse: [claudeHookConfigEntry(commandByEvent.PostToolUse, 'TodoWrite')],
    },
  }
}

export function kirictlCommand(invocation: KirictlInvocation) {
  return [invocation.command, ...invocation.args].map(shellQuote).join(' ')
}

export function parseTerminalShimRuntime(value: string): TerminalShimRuntime | null {
  return value === 'codex' || value === 'claude' ? value : null
}

function terminalShimScript(input: {
  readonly runtime: TerminalShimRuntime
  readonly binDir: string
  readonly stateDir: string
  readonly baseInvocation: KirictlInvocation
  readonly mcpConfig: KiriMcpServerConfig
}) {
  const command = `${kirictlCommand({
    command: input.baseInvocation.command,
    args: [...input.baseInvocation.args, 'term', 'shim-args', input.runtime],
  })}`
  return `#!/bin/sh
shim_dir=${shellQuote(input.binDir)}
runtime=${shellQuote(input.runtime)}

remove_shim_dir() {
  old_ifs=$IFS
  IFS=:
  out=
  for entry in $1; do
    [ -z "$entry" ] && continue
    [ "$entry" = "$shim_dir" ] && continue
    if [ -z "$out" ]; then
      out=$entry
    else
      out=$out:$entry
    fi
  done
  IFS=$old_ifs
  printf '%s' "$out"
}

path_without_shim=$(remove_shim_dir "\${PATH:-}")
PATH=$path_without_shim
export PATH
real=$(command -v "$runtime" 2>/dev/null || true)
[ -n "$real" ] || real=$runtime

if [ "\${KIRI_SHIM_ACTIVE:-}" = "1" ]; then
  exec "$real" "$@"
fi

for name in $(env | sed -n 's/^\\(KIRI_[A-Za-z0-9_]*\\)=.*/\\1/p'); do
  case "$name" in
    KIRI_PROJECT_CWD) ;;
    *) unset "$name" ;;
  esac
done
unset TERMINFO

KIRI_SHIM_ACTIVE=1
KIRI_SHIM_STATE_DIR=${shellQuote(input.stateDir)}
KIRI_SHIM_BASE_INVOCATION=${shellQuote(globalThis.JSON.stringify(input.baseInvocation))}
KIRI_SHIM_MCP_CONFIG=${shellQuote(globalThis.JSON.stringify(input.mcpConfig))}
export KIRI_SHIM_ACTIVE KIRI_SHIM_STATE_DIR KIRI_SHIM_BASE_INVOCATION KIRI_SHIM_MCP_CONFIG

if shim_args=$(${command} 2>/dev/null); then
  if [ -n "$shim_args" ]; then
    eval "$shim_args"
  fi
fi

unset KIRI_SHIM_BASE_INVOCATION KIRI_SHIM_MCP_CONFIG KIRI_SHIM_STATE_DIR
exec "$real" "$@"
`
}

function codexSessionStartHookCommand(invocation: KirictlInvocation) {
  const command = kirictlCommand(invocation)
  const script = `f="$(mktemp -t kiri-codex-hook)"; cat > "$f"; (${command} --stdin-file "$f" >> /tmp/kiri-codex-hook.log 2>&1; rm -f "$f") & printf '{}'`
  return `/bin/sh -c ${shellQuote(script)}`
}

function codexKiriTerminalPrompt(agentId: string) {
  return [
    'Kiri integration:',
    `- This terminal Codex session is Kiri session ${agentId}.`,
    `- Keep the Kiri session title accurate. When the title is generic, stale, or the current work changes, call kiri_do with operation "session.rename" and params {"agentId":"${agentId}","title":"Short action title"}.`,
    '- Use Kiri MCP operations through kiri_get and kiri_do; there are no separate kiri_rename_session, kiri_list_projects, or kiri_list_sessions tools.',
  ].join('\n')
}

function claudeHookConfigEntry(command: string, matcher?: string) {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [{
      type: 'command' as const,
      command,
      async: true as const,
    }],
  }
}

function shellSetArgv(args: readonly string[]) {
  return `set -- ${args.map(shellQuote).join(' ')} "$@"`
}

function writeFileIfChanged(path: string, contents: string) {
  if (existsSync(path) && readFileSync(path, 'utf8') === contents) return
  writeFileSync(path, contents)
}

function invocationFromEnv(value: string | undefined): KirictlInvocation | null {
  const parsed = parseJsonRecord(value)
  if (!parsed) return null
  const command = typeof parsed.command === 'string' ? parsed.command : null
  const args = Array.isArray(parsed.args)
    ? parsed.args.filter((arg): arg is string => typeof arg === 'string')
    : []
  return command ? { command, args } : null
}

function mcpConfigFromEnv(value: string | undefined): KiriMcpServerConfig | null {
  const parsed = parseJsonRecord(value)
  if (!parsed) return null
  const command = typeof parsed.command === 'string' ? parsed.command : null
  const args = Array.isArray(parsed.args)
    ? parsed.args.filter((arg): arg is string => typeof arg === 'string')
    : []
  return command ? {
    type: 'stdio',
    command,
    ...(args.length ? { args } : {}),
  } : null
}

function parseJsonRecord(value: string | undefined) {
  if (!value) return null
  try {
    const parsed: unknown = globalThis.JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function tomlString(value: string) {
  return globalThis.JSON.stringify(value)
}

function tomlStringArray(values: readonly string[]) {
  return `[${values.map(tomlString).join(', ')}]`
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
