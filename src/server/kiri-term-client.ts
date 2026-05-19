import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

type TerminalProcOptions = {
  readonly name: string
  readonly cols: number
  readonly rows: number
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

export type KiriTermClientTransport = {
  readonly spawnProc: (
    command: string,
    args: readonly string[],
    options: TerminalProcOptions,
  ) => KiriTermProc
  readonly close: () => Promise<void>
}

export type KiriTermProc = {
  readonly terminalId: string
  readonly resize: (cols: number, rows: number) => void
  readonly write: (data: string) => void
  readonly paste: (text: string, submit: boolean) => void
  readonly snapshot: () => void
  readonly kill: () => void
  readonly onData: (handler: (data: string) => void) => void
  readonly onExit: (handler: (exit: { readonly exitCode: number; readonly signal?: string }) => void) => void
}

type KiriTermFrame = {
  readonly type: string
  readonly terminalId?: string
  readonly status?: string
  readonly exitCode?: number
}

type SidecarCommand = Record<string, unknown> & {
  readonly type: string
  readonly terminalId?: string
}

class KiriTermProcess implements KiriTermProc {
  readonly dataHandlers = new Set<(data: string) => void>()
  readonly exitHandlers = new Set<(exit: { readonly exitCode: number; readonly signal?: string }) => void>()
  readonly pendingFrames: string[] = []
  exited = false

  constructor(
    readonly terminalId: string,
    private readonly sendCommand: (command: SidecarCommand) => void,
  ) {}

  resize(cols: number, rows: number) {
    this.sendCommand({ type: 'resize', terminalId: this.terminalId, cols, rows })
  }

  write(data: string) {
    this.sendCommand({ type: 'input', terminalId: this.terminalId, data })
  }

  paste(text: string, submit: boolean) {
    this.sendCommand({ type: 'paste', terminalId: this.terminalId, text, submit, bracketed: 'auto' })
  }

  snapshot() {
    this.sendCommand({ type: 'snapshot', terminalId: this.terminalId })
  }

  kill() {
    if (this.exited) return
    this.exited = true
    this.sendCommand({ type: 'kill', terminalId: this.terminalId })
  }

  onData(handler: (data: string) => void) {
    this.dataHandlers.add(handler)
    while (this.pendingFrames.length > 0) {
      handler(this.pendingFrames.shift() ?? '')
    }
  }

  onExit(handler: (exit: { readonly exitCode: number; readonly signal?: string }) => void) {
    this.exitHandlers.add(handler)
  }

  pushFrame(frameText: string, frame: KiriTermFrame) {
    const payload = `${frameText}\n`
    let ended = false
    if (frame.type === 'status' && (frame.status === 'exited' || frame.status === 'failed')) {
      this.exited = true
      ended = true
      for (const handler of this.exitHandlers) {
        handler({ exitCode: frame.exitCode ?? 0 })
      }
    }
    if (this.dataHandlers.size === 0) {
      this.pendingFrames.push(payload)
      return
    }
    for (const handler of this.dataHandlers) {
      handler(payload)
    }
    return ended
  }
}

class KiriTermClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly procs = new Map<string, KiriTermProcess>()
  private stdoutBuffer = ''
  private starting = false

  spawnProc(command: string, args: readonly string[], options: TerminalProcOptions): KiriTermProc {
    const terminalId = `term-${randomBytes(8).toString('hex')}`
    const proc = new KiriTermProcess(terminalId, (frame) => this.send(frame))
    this.procs.set(terminalId, proc)
    this.send({
      type: 'create',
      terminalId,
      launch: {
        command,
        args,
        cwd: options.cwd,
        env: stringEnv(options.env),
        cols: options.cols,
        rows: options.rows,
      },
    })
    return proc
  }

  close() {
    if (!this.child) return Promise.resolve()
    const child = this.child
    this.child = null
    this.procs.clear()
    return new Promise<void>((resolve) => {
      const done = () => resolve()
      child.once('exit', done)
      try {
        child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
        child.stdin.end()
      } catch {
        child.kill()
      }
      setTimeout(() => {
        if (!child.killed) child.kill()
        resolve()
      }, 500).unref?.()
    })
  }

  private send(command: SidecarCommand) {
    const child = this.ensureChild()
    child.stdin.write(`${JSON.stringify(command)}\n`)
  }

  private ensureChild() {
    if (this.child) return this.child
    const launch = resolveKiriTermLaunch()
    this.starting = true
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      stdio: 'pipe',
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.handleStdout(chunk)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (process.env.KIRI_TERMINAL_DEBUG === '1') {
        console.error('[kiri-term]', chunk.trimEnd())
      }
    })
    child.on('spawn', () => {
      this.starting = false
    })
    child.on('error', (error) => {
      this.starting = false
      this.failAll(`kiri-term failed to start: ${error.message}`)
    })
    child.on('exit', () => {
      this.child = null
      if (!this.starting) this.failAll('kiri-term exited')
    })
    this.child = child
    return child
  }

  private handleStdout(chunk: string) {
    this.stdoutBuffer += chunk
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      this.handleLine(line)
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  private handleLine(line: string) {
    if (!line.trim()) return
    let frame: KiriTermFrame
    try {
      frame = JSON.parse(line) as KiriTermFrame
    } catch {
      return
    }
    if (!frame.terminalId) return
    const proc = this.procs.get(frame.terminalId)
    if (proc?.pushFrame(line, frame)) this.procs.delete(frame.terminalId)
  }

  private failAll(message: string) {
    for (const proc of this.procs.values()) {
      proc.pushFrame(JSON.stringify({
        type: 'error',
        terminalId: proc.terminalId,
        message,
      }), {
        type: 'error',
        terminalId: proc.terminalId,
      })
      proc.pushFrame(JSON.stringify({
        type: 'status',
        terminalId: proc.terminalId,
        status: 'failed',
        exitCode: 1,
      }), {
        type: 'status',
        terminalId: proc.terminalId,
        status: 'failed',
        exitCode: 1,
      })
    }
    this.procs.clear()
  }
}

export function makeKiriTermClient(): KiriTermClientTransport {
  return new KiriTermClient()
}

function stringEnv(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function resolveKiriTermLaunch() {
  const override = process.env.KIRI_TERM_BIN?.trim()
  if (override) return { command: override, args: ['serve'], cwd: process.cwd() }

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resourcesPath ? join(resourcesPath, 'bin', 'kiri-term') : null
  if (packaged && existsSync(packaged)) return { command: packaged, args: ['serve'], cwd: process.cwd() }

  const releaseBinary = resolve('target/release/kiri-term')
  if (existsSync(releaseBinary)) return { command: releaseBinary, args: ['serve'], cwd: process.cwd() }

  const devBinary = resolve('target/debug/kiri-term')
  if (existsSync(devBinary)) return { command: devBinary, args: ['serve'], cwd: process.cwd() }

  return {
    command: 'cargo',
    args: ['run', '--quiet', '-p', 'kiri-term', '--', 'serve'],
    cwd: process.cwd(),
  }
}
