import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import type { RuntimeKind } from '~/lib/contracts'
import { makeTerminalServerService } from '~/server/terminal-server'

type HarnessCapture = {
  readonly runtime: RuntimeKind
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
) {
  const url = new URL(`ws://${info.host}:${info.port}${info.path}`)
  url.searchParams.set('token', info.token)
  url.searchParams.set('agentId', agentId)
  url.searchParams.set('mode', 'runtime')
  url.searchParams.set('cols', '100')
  url.searchParams.set('rows', '30')
  url.searchParams.set('instanceId', instanceId)
  const socket = new WebSocket(url)
  await new Promise<void>((resolvePromise, reject) => {
    socket.once('open', resolvePromise)
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({ type: 'input', data: `${text}\r` }))
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
  if (!isRuntimeKind(runtime)) throw new Error(`Unknown fake runtime ${runtime}`)
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
