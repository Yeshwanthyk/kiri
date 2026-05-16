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
