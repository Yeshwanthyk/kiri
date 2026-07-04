import { delimiter } from 'node:path'
import {
  installTerminalShims,
  type KiriHookInvocation,
  type KiriMcpServerConfig,
  type KirictlInvocation,
} from './terminal-shim'

export function commonTerminalEnv() {
  return {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    CLICOLOR: '1',
    CLICOLOR_FORCE: '1',
  }
}

export function removeColorDisablingEnv(env: NodeJS.ProcessEnv) {
  delete env.NO_COLOR
  delete env.NODE_DISABLE_COLORS
  return env
}

export function withTerminalShimPath(
  env: NodeJS.ProcessEnv,
  input: {
    readonly homeDir: string
    readonly baseInvocation: KirictlInvocation
    readonly hookInvocation?: KiriHookInvocation
    readonly mcpConfig: KiriMcpServerConfig
  },
) {
  let binDir: string
  try {
    binDir = installTerminalShims(input).binDir
  } catch {
    return env
  }
  const entries = [binDir, ...(env.PATH ?? '').split(delimiter).filter(Boolean)]
  return {
    ...env,
    PATH: Array.from(new Set(entries)).join(delimiter),
  }
}
