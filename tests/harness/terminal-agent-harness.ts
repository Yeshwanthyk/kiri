import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import type { RuntimeKind } from '~/lib/contracts'
import { makeTerminalServerService } from '~/server/terminal-server'

type HarnessCapture = {
  readonly runtime: RuntimeKind | 'shell'
  readonly kind: 'ready' | 'paste'
  readonly session: string
  readonly pid: number
  readonly sequence?: number
  readonly text?: string
}

type PendingPaste = {
  readonly text: string
  readonly submit: boolean
  readonly createdAt: string
}

export type TerminalAgentHarnessResult = {
  readonly runtime: RuntimeKind
  readonly repeatedPasteSameThread: boolean
  readonly firstPaste: HarnessCapture
  readonly secondPaste: HarnessCapture
  readonly tabPastes: readonly HarnessCapture[]
}

export type TerminalShellHarnessResult = {
  readonly cwd: string
  readonly tabPastes: readonly HarnessCapture[]
  readonly splitPastes: readonly HarnessCapture[]
  readonly reconnectPaste: HarnessCapture
  readonly editedFile: string
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export async function runTerminalAgentHarness(runtime: RuntimeKind): Promise<TerminalAgentHarnessResult> {
  const root = mkdtempSync(join(tmpdir(), `kiri-terminal-harness-${runtime}-`))
  const capturePath = join(root, 'capture.log')
  const scriptPath = resolve(repoRoot, 'tests/harness', `fake-${runtime}-terminal.mjs`)
  const session = `${runtime}-session`
  let pending: PendingPaste[] = []
  const service = makeTerminalServerService({
    getAgentLaunchConfig: () => ({
      id: `agent-${runtime}`,
      projectId: 'project-terminal-harness',
      runtime,
      sessionDir: root,
      sessionFile: null,
      model: 'harness-model',
      cwd: root,
    }),
    buildTerminalProcessLaunch: (config, mode, shell) => ({
      command: mode === 'runtime' ? process.execPath : shell.command,
      args: mode === 'runtime' ? [scriptPath] : shell.args,
      cwd: root,
      env: {
        ...process.env,
        KIRI_CAPTURE_PATH: capturePath,
        KIRI_FAKE_TERMINAL_SESSION: session,
      },
      label: runtime,
    }),
    takeAgentTerminalInputs: () => pending.splice(0),
  })

  try {
    pending = [paste('first workflow paste')]
    await service.spawnAgentRuntime({ agentId: `agent-${runtime}` })
    const firstPaste = await waitForPaste(capturePath, 'first workflow paste')

    pending = [paste('second workflow paste')]
    await service.spawnAgentRuntime({ agentId: `agent-${runtime}` })
    const secondPaste = await waitForPaste(capturePath, 'second workflow paste')

    const info = await service.ensure()
    const [tabA, tabB] = await Promise.all([
      pasteThroughWebSocket(info, `agent-${runtime}`, 'tab-a', 'tab-a command'),
      pasteThroughWebSocket(info, `agent-${runtime}`, 'tab-b', 'tab-b command'),
    ])
    await tabA.close()
    await tabB.close()
    const tabPastes = await Promise.all([
      waitForPaste(capturePath, 'tab-a command'),
      waitForPaste(capturePath, 'tab-b command'),
    ])

    return {
      runtime,
      repeatedPasteSameThread: firstPaste.pid === secondPaste.pid && firstPaste.session === secondPaste.session,
      firstPaste,
      secondPaste,
      tabPastes,
    }
  } finally {
    await service.close()
    rmSync(root, { recursive: true, force: true })
  }
}

export async function runTerminalShellHarness(): Promise<TerminalShellHarnessResult> {
  const root = mkdtempSync(join(tmpdir(), 'kiri-terminal-shell-harness-'))
  const capturePath = join(root, 'capture.log')
  const scriptPath = resolve(repoRoot, 'tests/harness/fake-project-shell.mjs')
  const service = makeTerminalServerService({
    getAgentLaunchConfig: () => ({
      id: 'agent-shell',
      projectId: 'project-shell-harness',
      runtime: 'codex',
      sessionDir: root,
      sessionFile: null,
      model: 'harness-model',
      cwd: root,
    }),
    buildTerminalProcessLaunch: (_config, mode, shell) => ({
      command: mode === 'shell' ? process.execPath : shell.command,
      args: mode === 'shell' ? [scriptPath] : shell.args,
      cwd: root,
      env: {
        ...process.env,
        KIRI_CAPTURE_PATH: capturePath,
        KIRI_FAKE_TERMINAL_SESSION: 'project-shell-session',
      },
      label: mode,
    }),
  })

  try {
    const info = await service.ensure()
    const [tabA, tabB] = await Promise.all([
      pasteThroughWebSocket(info, 'agent-shell', 'shell-tab-a', 'edit editor.txt', 'shell'),
      pasteThroughWebSocket(info, 'agent-shell', 'shell-tab-b', 'run long-script', 'shell'),
    ])
    const tabPastes = await Promise.all([
      waitForPaste(capturePath, 'edited:editor.txt'),
      waitForPaste(capturePath, 'running:long-script'),
    ])
    await tabA.close()
    await tabB.close()

    const reconnect = await pasteThroughWebSocket(info, 'agent-shell', 'shell-tab-a', 'after reconnect', 'shell')
    const reconnectPaste = await waitForPaste(capturePath, 'after reconnect')
    await reconnect.close()

    const [splitA, splitB] = await Promise.all([
      pasteThroughWebSocket(info, 'agent-shell', 'split-left', 'left-pane', 'shell'),
      pasteThroughWebSocket(info, 'agent-shell', 'split-right', 'right-pane', 'shell'),
    ])
    const splitPastes = await Promise.all([
      waitForPaste(capturePath, 'left-pane'),
      waitForPaste(capturePath, 'right-pane'),
    ])
    await splitA.close()
    await splitB.close()

    return {
      cwd: root,
      tabPastes,
      splitPastes,
      reconnectPaste,
      editedFile: readFileSync(join(root, 'editor.txt'), 'utf8'),
    }
  } finally {
    await service.close()
    rmSync(root, { recursive: true, force: true })
  }
}

function paste(text: string): PendingPaste {
  return {
    text,
    submit: true,
    createdAt: new Date(0).toISOString(),
  }
}

async function pasteThroughWebSocket(
  info: { readonly host: string; readonly port: number; readonly path: string; readonly token: string },
  agentId: string,
  instanceId: string,
  text: string,
  mode: 'runtime' | 'shell' = 'runtime',
) {
  const url = new URL(`ws://${info.host}:${info.port}${info.path}`)
  url.searchParams.set('token', info.token)
  url.searchParams.set('agentId', agentId)
  url.searchParams.set('mode', mode)
  url.searchParams.set('cols', '100')
  url.searchParams.set('rows', '30')
  url.searchParams.set('instanceId', instanceId)
  const socket = new WebSocket(url)
  await new Promise<void>((resolvePromise, reject) => {
    socket.once('open', resolvePromise)
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({ type: 'paste', text, submit: true }))
  return {
    close: () => new Promise<void>((resolvePromise) => {
      socket.once('close', resolvePromise)
      socket.close()
    }),
  }
}

async function waitForPaste(capturePath: string, text: string) {
  return expectPoll(() => {
    const rows = readCaptures(capturePath)
    return rows.find((row) => row.kind === 'paste' && row.text === text) ?? null
  }, `paste ${text}`)
}

async function expectPoll<T>(read: () => T | null, label: string): Promise<T> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = read()
    if (value !== null) return value
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error(`Timed out waiting for terminal harness ${label}`)
}

function readCaptures(capturePath: string): HarnessCapture[] {
  let content: string
  try {
    content = readFileSync(capturePath, 'utf8')
  } catch {
    return []
  }
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(parseCapture)
}

function parseCapture(line: string): HarnessCapture {
  const [runtime, kind, session, pid, sequence, ...textParts] = line.split(':')
  if (!isRuntimeKind(runtime) && runtime !== 'shell') throw new Error(`Unknown fake runtime ${runtime}`)
  if (kind === 'ready') {
    return {
      runtime,
      kind,
      session: session ?? '',
      pid: Number(pid ?? 0),
    }
  }
  return {
    runtime,
    kind: 'paste',
    session: session ?? '',
    pid: Number(pid ?? 0),
    sequence: Number(sequence ?? 0),
    text: textParts.join(':'),
  }
}

function isRuntimeKind(runtime: string | undefined): runtime is RuntimeKind {
  return runtime === 'pi' || runtime === 'codex' || runtime === 'claude' || runtime === 'opencode'
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runtime = process.argv[2] && isRuntimeKind(process.argv[2]) ? process.argv[2] : 'claude'
  const result = await runTerminalAgentHarness(runtime)
  console.log(JSON.stringify(result, null, 2))
}
