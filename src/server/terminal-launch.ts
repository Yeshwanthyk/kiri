import { createHash } from 'node:crypto'
import type { RuntimeKind, TerminalMode } from '~/lib/contracts'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveRuntimeExecutable, runtimeProcessEnv } from './runtime-binaries'

export type TerminalAgentLaunchConfig = {
  id: string
  projectId: string
  runtime: RuntimeKind
  sessionDir: string
  sessionFile: string | null
  model: string
  cwd: string
  runtimeStateJson?: string | null
}

export type TerminalProcessLaunch = {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  label: string
}

export function buildTerminalProcessLaunch(
  config: TerminalAgentLaunchConfig,
  mode: TerminalMode,
  shell: { command: string; args: string[] },
): TerminalProcessLaunch {
  if (mode === 'shell') {
    return {
      command: shell.command,
      args: shell.args,
      cwd: config.cwd,
      env: shellTerminalEnv(config.cwd),
      label: 'shell',
    }
  }

  if (config.runtime === 'claude') return claudeLaunch(config)
  if (config.runtime === 'codex') return codexLaunch(config)
  return piLaunch(config)
}

function claudeLaunch(config: TerminalAgentLaunchConfig): TerminalProcessLaunch {
  const state = objectState(config.runtimeStateJson)
  const homePath = process.env.KIRI_CLAUDE_HOME ?? stringValue(state.homePath)
  const args = [
    '--dangerously-skip-permissions',
    '--mcp-config',
    buildKiriMcpConfigJson(),
    '--append-system-prompt',
    claudeKiriTerminalPrompt(config.id),
  ]
  if (config.model) args.push('--model', config.model)
  const resume = stringValue(state.resume)
  let sessionId: string | undefined
  if (resume) {
    args.push('--resume', resume)
  } else {
    sessionId = claudeTerminalSessionId(config.id, state)
    if (claudeSessionExists(config.cwd, sessionId, homePath)) {
      args.push('--resume', sessionId)
    } else {
      args.push('--session-id', sessionId)
    }
  }

  const env = baseTerminalEnv(config)
  if (sessionId) env.KIRI_CLAUDE_SESSION_ID = sessionId
  if (process.env.KIRI_CLAUDE_USE_EXTERNAL_API_KEY !== '1') {
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.ANTHROPIC_OAUTH_TOKEN
  }
  if (homePath) env.HOME = homePath

  return {
    command: resolveRuntimeExecutable('claude', process.env.KIRI_CLAUDE_BIN ?? stringValue(state.binaryPath)),
    args,
    cwd: config.cwd,
    env,
    label: 'claude',
  }
}

function buildKiriMcpConfigJson() {
  return JSON.stringify({
    mcpServers: {
      kiri: buildKiriMcpServerConfig(),
    },
  })
}

function buildKiriMcpServerConfig() {
  const override = process.env.KIRI_MCP_BIN?.trim()
  if (override) return { type: 'stdio', command: override }

  const resourcesPath = stringValue((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath)
  const packagedBin = resourcesPath ? join(resourcesPath, 'bin', 'kiri-mcp') : undefined
  if (packagedBin && existsSync(packagedBin)) return { type: 'stdio', command: packagedBin }

  const builtCli = resolve(process.cwd(), 'dist/cli/kirictl.mjs')
  if (existsSync(builtCli)) {
    return { type: 'stdio', command: process.execPath, args: [builtCli, 'mcp'] }
  }

  return {
    type: 'stdio',
    command: resolveRuntimeExecutable('pnpm'),
    args: ['exec', 'tsx', resolve(process.cwd(), 'src/cli/kirictl.ts'), 'mcp'],
  }
}

function claudeKiriTerminalPrompt(agentId: string) {
  return [
    'Kiri integration:',
    `- This terminal Claude Code session is Kiri session ${agentId}.`,
    '- Keep TodoWrite current for multi-step work; Kiri projects TodoWrite into its Tasks view where supported.',
    `- Use the Kiri MCP server, especially kiri_rename_session with agentId "${agentId}", when the Kiri session title is generic, stale, or no longer matches the work.`,
  ].join('\n')
}

export function claudeTerminalSessionId(agentId: string, state: Record<string, unknown> = {}) {
  const configured = stringValue(state.sessionId)
  if (configured && isUuid(configured)) return configured
  return deterministicUuid(`kiri:claude:${agentId}`)
}

function deterministicUuid(input: string) {
  const bytes = Array.from(createHash('sha256').update(input).digest().subarray(0, 16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function claudeSessionExists(cwd: string, sessionId: string, homePath: string | undefined) {
  const claudeHome = join(homePath ?? homedir(), '.claude')
  const projectDir = join(claudeHome, 'projects', claudeProjectKey(cwd))
  return existsSync(join(projectDir, `${sessionId}.jsonl`))
    || existsSync(join(projectDir, sessionId))
}

function claudeProjectKey(cwd: string) {
  return resolve(cwd).replace(/[\\/]/g, '-')
}

function codexLaunch(config: TerminalAgentLaunchConfig): TerminalProcessLaunch {
  const args = ['--dangerously-bypass-approvals-and-sandbox']
  if (config.model) args.push('--model', config.model)
  const env = baseTerminalEnv(config, process.env.KIRI_CODEX_HOME ? { CODEX_HOME: process.env.KIRI_CODEX_HOME } : undefined)
  return {
    command: resolveRuntimeExecutable('codex', process.env.KIRI_CODEX_BIN),
    args,
    cwd: config.cwd,
    env,
    label: 'codex',
  }
}

function piLaunch(config: TerminalAgentLaunchConfig): TerminalProcessLaunch {
  const args = ['--session-dir', config.sessionDir]
  if (config.sessionFile) args.push('--session', config.sessionFile)
  if (config.model) args.push('--model', config.model)
  return {
    command: resolveRuntimeExecutable('pi', process.env.KIRI_PI_BIN),
    args,
    cwd: config.cwd,
    env: baseTerminalEnv(config),
    label: 'pi',
  }
}

function baseTerminalEnv(config: TerminalAgentLaunchConfig, extra?: NodeJS.ProcessEnv) {
  const env = runtimeProcessEnv({
    ...extra,
    ...commonTerminalEnv(),
    KIRI_AGENT_ID: config.id,
    KIRI_PROJECT_CWD: config.cwd,
    KIRI_RUNTIME: config.runtime,
    KIRI_MODEL: config.model,
    KIRI_SESSION_DIR: config.sessionDir,
    ...(config.sessionFile ? { KIRI_SESSION_FILE: config.sessionFile } : {}),
  })
  delete env.NO_COLOR
  delete env.NODE_DISABLE_COLORS
  return env
}

function shellTerminalEnv(cwd: string) {
  const env = runtimeProcessEnv({
    ...commonTerminalEnv(),
    KIRI_PROJECT_CWD: cwd,
  })
  delete env.NO_COLOR
  delete env.NODE_DISABLE_COLORS
  return env
}

function commonTerminalEnv() {
  return {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    CLICOLOR: '1',
    CLICOLOR_FORCE: '1',
  }
}

function objectState(value: string | null | undefined) {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}
