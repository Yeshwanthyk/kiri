export function commonTerminalEnv(input: {
  readonly terminfoPath?: string | null
} = {}) {
  const terminalName = input.terminfoPath ? 'xterm-ghostty' : 'xterm-256color'
  return {
    TERM: terminalName,
    TERM_PROGRAM: 'kiri',
    ...(input.terminfoPath ? { TERMINFO: input.terminfoPath } : {}),
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    COLORFGBG: '15;0',
    CLICOLOR: '1',
    CLICOLOR_FORCE: '1',
  }
}

export function terminalSizeEnv(cols: number, rows: number): NodeJS.ProcessEnv {
  return {
    COLUMNS: String(cols),
    LINES: String(rows),
  }
}

export function removeColorDisablingEnv(env: NodeJS.ProcessEnv) {
  delete env.NO_COLOR
  delete env.NODE_DISABLE_COLORS
  return env
}
