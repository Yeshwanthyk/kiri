import * as pty from 'node-pty'
import { encodeTerminalKeys } from '../../src/lib/terminal-keys'
import {
  makeTerminalRegistry,
  type TerminalRegistrySession,
  type TerminalScreen,
} from '../../src/server/terminal-registry'

export type TerminalHarness = {
  readonly registry: ReturnType<typeof makeTerminalRegistry>
  readonly session: TerminalRegistrySession
  /** Type raw text into the pty, exactly as a human keyboard would. */
  readonly input: (text: string) => void
  /** Press named keys: enter, tab, esc, up/down/left/right, c-c, f1... */
  readonly keys: (...names: string[]) => void
  /** The parsed screen after all pending output has been applied. */
  readonly screen: () => Promise<TerminalScreen>
  /** Visible screen text (trimmed lines joined by newlines). */
  readonly text: () => Promise<string>
  /** Resolves when `pattern` appears on screen (or in raw output). */
  readonly waitFor: (
    pattern: RegExp,
    options?: { timeoutMs?: number; scope?: 'screen' | 'output' },
  ) => Promise<{ match: string }>
  /** Serialized emulator state, replayable into a fresh terminal. */
  readonly snapshot: () => string
  readonly resize: (cols: number, rows: number) => void
  readonly dispose: () => void
}

export type TerminalHarnessOptions = {
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly cols?: number
  readonly rows?: number
}

// Spawns a real PTY wired through the terminal registry, exposing the same
// observe/drive surface the MCP control plane offers agents. Anything a human
// can do in a terminal, this harness can script and assert on.
export function startTerminalHarness(options: TerminalHarnessOptions = {}): TerminalHarness {
  const cols = options.cols ?? 100
  const rows = options.rows ?? 30
  const cwd = options.cwd ?? process.cwd()
  const command = options.command ?? '/bin/bash'
  const args = options.args ?? ['--noprofile', '--norc', '-i']
  const registry = makeTerminalRegistry({
    idleKillMs: 60_000,
    socketOpenState: 1,
  })
  const proc = pty.spawn(command, [...args], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      PS1: 'KIRI$ ',
      ...options.env,
    },
  })
  const session = registry.register({
    key: 'harness:runtime',
    cwd,
    mode: 'runtime',
    label: 'harness',
    proc,
    cols,
    rows,
  })
  proc.onData((data) => {
    registry.append(session, data)
    registry.broadcast(session, data)
  })
  proc.onExit(({ exitCode }) => {
    if (!session.exited) registry.exit(session, `\r\n[harness exited: ${exitCode}]\r\n`)
  })

  const drained = () =>
    new Promise<void>((resolve) => {
      session.headless.write('', () => {
        resolve()
      })
    })

  return {
    registry,
    session,
    input: (text) => proc.write(text),
    keys: (...names) => proc.write(encodeTerminalKeys(names)),
    screen: async () => {
      await drained()
      return registry.readScreen(session)
    },
    text: async () => {
      await drained()
      return registry.readScreen(session).lines.join('\n').trimEnd()
    },
    waitFor: (pattern, waitOptions) =>
      registry.waitForScreen(session, {
        pattern,
        timeoutMs: waitOptions?.timeoutMs ?? 5_000,
        scope: waitOptions?.scope,
      }),
    snapshot: () => registry.snapshot(session),
    resize: (nextCols, nextRows) => registry.resize(session, nextCols, nextRows),
    dispose: () => registry.closeAll(),
  }
}
