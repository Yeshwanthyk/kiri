import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import packageJson from '../../package.json'
import { describe, expect, it } from 'vitest'

type AsarHeaderNode = {
  readonly files?: Record<string, AsarHeaderNode>
}

type DaemonRecord = {
  readonly host: string
  readonly port: number
  readonly path: string
  readonly token: string
}

type TerminalFrame =
  | { readonly type: 'snapshot'; readonly data: string }
  | { readonly type: 'data'; readonly data: string }
  | { readonly type: string }

describe('desktop package contract', () => {
  it('ships runtime app assets without build-only packaging scripts', () => {
    expect(packageJson.build.files).toEqual(expect.arrayContaining([
      'dist/client/**',
      'dist/server/**',
      'dist/cli/**',
      'src/desktop/**',
      'scripts/kiri-desktop-backend.mjs',
      'settings.json',
      'package.json',
    ]))
    expect(packageJson.build.files.filter((entry) =>
      entry.startsWith('scripts/') && entry !== 'scripts/kiri-desktop-backend.mjs'
    )).toEqual([])
    expect(packageJson.build.files).not.toContain('scripts/create-desktop-dmg.mjs')
    expect(packageJson.build.files).not.toContain('scripts/normalize-desktop-app.mjs')
  })

  it('ships native helpers as extra resources next to the packaged app', () => {
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'resources/bin/kiri-mcp',
      to: 'bin/kiri-mcp',
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'dist/bin/kiri-read-model-indexer',
      to: 'bin/kiri-read-model-indexer',
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'dist/bin/kiri-termd',
      to: 'bin/kiri-termd',
    })
    expect(isExecutable(join(process.cwd(), 'resources/bin/kiri-mcp'))).toBe(true)
  })

  it('defers built app-server import until after desktop readiness', () => {
    const backendScript = readFileSync(join(process.cwd(), 'scripts/kiri-desktop-backend.mjs'), 'utf8')

    expect(backendScript).toContain('async function loadAppFetch()')
    expect(backendScript).not.toContain('const serverEntry = await import')
  })

  it('keeps built packaged app contents runnable when a desktop package assertion is requested', async () => {
    if (process.env.KIRI_ASSERT_PACKAGED_APP !== '1') return

    const appRoots = [
      join(process.cwd(), 'dist/mac/kiri.app'),
      join(process.cwd(), 'dist/mac-arm64/kiri.app'),
      join(process.cwd(), 'dist/mac-universal/kiri.app'),
    ].filter((appRoot) => existsSync(appRoot))
    expect(appRoots.length, 'fresh packaged app output exists').toBeGreaterThan(0)

    for (const appRoot of appRoots) {
      const resourcesRoot = join(appRoot, 'Contents/Resources')
      const appAsar = join(resourcesRoot, 'app.asar')
      expect(existsSync(appAsar), `${appRoot} has app.asar`).toBe(true)
      expect(isExecutable(join(resourcesRoot, 'bin/kiri-mcp')), `${appRoot} has executable kiri-mcp`)
        .toBe(true)
      expect(
        isExecutable(join(resourcesRoot, 'bin/kiri-read-model-indexer')),
        `${appRoot} has executable kiri-read-model-indexer`,
      ).toBe(true)
      expect(
        isExecutable(join(resourcesRoot, 'bin/kiri-termd')),
        `${appRoot} has executable kiri-termd`,
      ).toBe(true)
      await expectKiriTermdRuns(join(resourcesRoot, 'bin/kiri-termd'))
      const header = readAsarHeader(appAsar)
      expect(hasAsarPath(header, ['scripts', 'kiri-desktop-backend.mjs'])).toBe(true)
      expect(hasAsarPath(header, ['dist', 'client'])).toBe(true)
      expect(hasAsarPath(header, ['dist', 'server'])).toBe(true)
      expect(hasAsarPath(header, ['dist', 'cli', 'kirictl.mjs'])).toBe(true)
      expect(hasAsarPath(header, ['src', 'desktop', 'main.mjs'])).toBe(true)
      expect(hasAsarPath(header, ['settings.json'])).toBe(true)
      expect(hasAsarPath(header, ['package.json'])).toBe(true)
      expect(hasAsarPath(header, ['scripts', 'create-desktop-dmg.mjs'])).toBe(false)
      expect(hasAsarPath(header, ['scripts', 'normalize-desktop-app.mjs'])).toBe(false)
    }
  })
})

function isExecutable(path: string) {
  return existsSync(path) && (statSync(path).mode & 0o111) !== 0
}

async function expectKiriTermdRuns(binary: string) {
  const version = (await runCommand(binary, ['--version'])).trim()
  expect(version, `${binary} --version`).toMatch(/^\d+\.\d+\.\d+$/)

  const stateDir = mkdtempSync(join(tmpdir(), 'kiri-termd-package-'))
  let child: ChildProcess | null = null
  try {
    child = spawn(binary, [], {
      env: { ...process.env, KIRI_TERM_STATE_DIR: stateDir },
      stdio: 'ignore',
    })
    const record = await waitForDaemonRecord(stateDir)
    const health = await fetch(`http://${record.host}:${record.port}/api/health`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(5_000),
    })
    expect(health.ok, `${binary} health status`).toBe(true)
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      pid: expect.any(Number),
      version,
      sessions: 0,
    })
    await expectPackagedShellEcho(record)
    await fetch(`http://${record.host}:${record.port}/api/shutdown`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${record.token}`,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(5_000),
    })
    await waitForExit(child, 5_000)
    child = null
  } finally {
    if (child) {
      child.kill()
      await waitForExit(child, 5_000).catch(() => {})
    }
    rmSync(stateDir, { recursive: true, force: true })
  }
}

function runCommand(command: string, args: readonly string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal}): ${stderr}`))
    })
  })
}

async function waitForDaemonRecord(stateDir: string) {
  const recordPath = join(stateDir, 'daemon.json')
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (existsSync(recordPath)) {
      return JSON.parse(readFileSync(recordPath, 'utf8')) as DaemonRecord
    }
    await sleep(50)
  }
  throw new Error(`timed out waiting for daemon record at ${recordPath}`)
}

async function expectPackagedShellEcho(record: DaemonRecord) {
  const socket = new WebSocket(
    `ws://${record.host}:${record.port}${record.path}?agentId=package-smoke&mode=shell&cols=80&rows=24&token=${record.token}`,
  )
  try {
    await waitForSocketOpen(socket)
    const snapshot = await waitForFrame(socket, (frame) => frame.type === 'snapshot')
    expect(snapshot).toMatchObject({ type: 'snapshot' })

    socket.send(JSON.stringify({
      type: 'input',
      data: "printf 'packaged-rust-shell-%s\\n' ok\r",
    }))
    const echo = await waitForFrame(socket, (frame) =>
      frame.type === 'data' && 'data' in frame && frame.data.includes('packaged-rust-shell-ok'),
    )
    expect(echo).toMatchObject({ type: 'data' })
  } finally {
    socket.close()
  }
}

function waitForSocketOpen(socket: WebSocket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for packaged kiri-termd websocket to open'))
    }, 5_000)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('open', onOpen)
      socket.off('error', onError)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
  })
}

function waitForFrame(socket: WebSocket, predicate: (frame: TerminalFrame) => boolean) {
  return new Promise<TerminalFrame>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for packaged kiri-termd terminal frame'))
    }, 5_000)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    const onMessage = (raw: WebSocket.RawData) => {
      const frame = parseTerminalFrame(raw)
      if (!frame || !predicate(frame)) return
      cleanup()
      resolve(frame)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    socket.on('message', onMessage)
    socket.once('error', onError)
  })
}

function parseTerminalFrame(raw: WebSocket.RawData): TerminalFrame | null {
  const text = Buffer.isBuffer(raw)
    ? raw.toString('utf8')
    : Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf8')
      : Buffer.from(new Uint8Array(raw)).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return null
  return parsed as TerminalFrame
}

function waitForExit(child: ChildProcess, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for child process ${child.pid ?? '<unknown>'} to exit`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = () => {
      cleanup()
      resolve()
    }
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readAsarHeader(path: string): AsarHeaderNode {
  const archive = readFileSync(path)
  expect(archive.byteLength, `${path} has enough bytes for ASAR header`).toBeGreaterThanOrEqual(16)
  const headerJsonLength = archive.readUInt32LE(12)
  const headerEnd = 16 + headerJsonLength
  expect(headerJsonLength, `${path} ASAR header length`).toBeGreaterThan(0)
  expect(headerEnd, `${path} ASAR header bounds`).toBeLessThanOrEqual(archive.byteLength)
  const header: unknown = JSON.parse(archive.subarray(16, headerEnd).toString())
  if (!isAsarHeaderNode(header)) {
    throw new Error(`${path} ASAR header is missing files`)
  }
  return header
}

function hasAsarPath(header: AsarHeaderNode, pathParts: readonly string[]) {
  let node: AsarHeaderNode | undefined = header
  for (const part of pathParts) {
    node = node.files?.[part]
    if (!node) return false
  }
  return true
}

function isAsarHeaderNode(value: unknown): value is AsarHeaderNode {
  return typeof value === 'object' && value !== null && 'files' in value
}
