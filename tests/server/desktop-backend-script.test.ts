import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

const children: ChildProcess[] = []

describe('desktop backend script', () => {
  afterEach(() => {
    for (const child of children.splice(0)) {
      if (!child.killed) child.kill()
    }
  })

  it('serves readiness, control, and static assets before importing the app server', async () => {
    const fixture = createDesktopBackendFixture()
    const child = spawn(process.execPath, ['scripts/kiri-desktop-backend.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        KIRI_ROOT_DIR: fixture.root,
        KIRI_STATE_DIR: fixture.stateDir,
        KIRI_SETTINGS_PATH: fixture.settingsPath,
        KIRI_BACKEND_HOST: '127.0.0.1',
        KIRI_BACKEND_PORT: '0',
        KIRI_BACKEND_BROWSER_HOST: '127.0.0.1',
        KIRI_IMPORT_MARKER: fixture.importMarker,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)

    const ready = await waitForReady(child)

    expect(existsSync(fixture.importMarker)).toBe(false)

    const environment = await fetch(new URL('/.well-known/kiri/environment', ready.url))
    expect(environment.status).toBe(200)
    await expect(environment.json()).resolves.toMatchObject({
      name: 'kiri',
      mode: 'desktop',
    })
    expect(existsSync(fixture.importMarker)).toBe(false)

    const shell = await fetch(new URL('/index.html', ready.url))
    expect(shell.status).toBe(200)
    expect(shell.headers.get('cache-control')).toBe('no-store')
    expect(await shell.text()).toContain('desktop shell')
    expect(existsSync(fixture.importMarker)).toBe(false)

    const asset = await fetch(new URL('/assets/app-test.js', ready.url))
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toBe('no-store')
    expect(await asset.text()).toContain('desktop asset')

    const controlInfo = JSON.parse(readFileSync(join(fixture.stateDir, 'backend-control.json'), 'utf8')) as {
      readonly token: string
    }
    const control = await fetch(new URL('/.well-known/kiri/control', ready.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${controlInfo.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ operation: 'operations.list' }),
    })
    expect(control.status).toBe(200)
    await expect(control.json()).resolves.toMatchObject({
      ok: true,
      operation: 'operations.list',
      result: { source: 'fake-control' },
    })
    expect(existsSync(fixture.importMarker)).toBe(false)

    const app = await fetch(ownerUrl('/app-route', ready.url))
    expect(app.status).toBe(200)
    expect(await app.text()).toBe('app:/app-route')
    expect(existsSync(fixture.importMarker)).toBe(true)

    child.kill()
    rmSync(fixture.root, { recursive: true, force: true })
  }, 15_000)

  it('reconciles missing packaged runtime settings before readiness', async () => {
    const fixture = createDesktopBackendFixture({
      userSettings: {
        runtimes: {
          pi: { models: ['pi-model'], defaultModel: 'pi-model' },
          codex: { models: ['codex-model'], defaultModel: 'codex-model' },
          claude: { models: ['claude-model'], defaultModel: 'claude-model' },
        },
      },
    })
    const child = spawn(process.execPath, ['scripts/kiri-desktop-backend.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        KIRI_ROOT_DIR: fixture.root,
        KIRI_STATE_DIR: fixture.stateDir,
        KIRI_SETTINGS_PATH: fixture.settingsPath,
        KIRI_BACKEND_HOST: '127.0.0.1',
        KIRI_BACKEND_PORT: '0',
        KIRI_BACKEND_BROWSER_HOST: '127.0.0.1',
        KIRI_IMPORT_MARKER: fixture.importMarker,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)

    await waitForReady(child)

    const settings = JSON.parse(readFileSync(fixture.settingsPath, 'utf8')) as {
      readonly runtimes?: Record<string, unknown>
    }
    expect(settings.runtimes?.opencode).toEqual({
      models: ['opencode-model'],
      defaultModel: 'opencode-model',
    })

    child.kill()
    rmSync(fixture.root, { recursive: true, force: true })
  }, 15_000)

  it('proxies same-origin terminal websocket upgrades to the private terminal port', async () => {
    const targetServer = createServer((request, response) => {
      if (
        request.url === '/api/health' &&
        request.headers.authorization === 'Bearer terminal-token'
      ) {
        response.end(JSON.stringify({ ok: true }))
        return
      }
      response.writeHead(404)
      response.end()
    })
    const targetWs = new WebSocketServer({ server: targetServer, path: '/terminal' })
    targetWs.on('connection', (socket) => {
      socket.on('message', (message) => {
        socket.send(`target:${webSocketDataText(message)}`)
      })
    })
    const targetPort = await listen(targetServer)
    const fixture = createDesktopBackendFixture()
    const child = spawn(process.execPath, ['scripts/kiri-desktop-backend.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        KIRI_ROOT_DIR: fixture.root,
        KIRI_STATE_DIR: fixture.stateDir,
        KIRI_SETTINGS_PATH: fixture.settingsPath,
        KIRI_BACKEND_HOST: '127.0.0.1',
        KIRI_BACKEND_PORT: '0',
        KIRI_BACKEND_BROWSER_HOST: '127.0.0.1',
        KIRI_IMPORT_MARKER: fixture.importMarker,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)

    try {
      const ready = await waitForReady(child)
      const url = new URL('/terminal', ready.url)
      url.protocol = 'ws:'
      url.searchParams.set('kiri_terminal_port', String(targetPort))
      url.searchParams.set('token', 'terminal-token')
      url.searchParams.set('kiri_owner_token', new URL(ready.url).searchParams.get('kiri_owner_token') ?? '')

      const socket = await openSocket(url.toString())
      try {
        const message = await new Promise<string>((resolve, reject) => {
          socket.once('message', (data) => resolve(webSocketDataText(data)))
          socket.once('error', reject)
          socket.send('ping')
        })
        expect(message).toBe('target:ping')
      } finally {
        socket.close()
      }
    } finally {
      child.kill()
      await close(targetServer)
      targetWs.close()
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }, 15_000)
})

function createDesktopBackendFixture(options: {
  readonly userSettings?: unknown
  readonly packagedSettings?: unknown
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kiri-desktop-backend-'))
  const stateDir = join(root, 'state')
  const importMarker = join(root, 'server-imported')
  const settingsPath = join(stateDir, 'settings.json')
  mkdirSync(join(root, 'dist', 'client'), { recursive: true })
  mkdirSync(join(root, 'dist', 'client', 'assets'), { recursive: true })
  mkdirSync(join(root, 'dist', 'server'), { recursive: true })
  mkdirSync(join(root, 'dist', 'cli'), { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(root, 'dist', 'client', 'index.html'), '<main>desktop shell</main>')
  writeFileSync(join(root, 'dist', 'client', 'assets', 'app-test.js'), 'console.log("desktop asset")')
  writeFileSync(join(root, 'dist', 'server', 'server.js'), `
    import { writeFileSync } from 'node:fs'
    writeFileSync(process.env.KIRI_IMPORT_MARKER, 'imported')
    export default {
      fetch: (request) => new Response(\`app:\${new URL(request.url).pathname}\`)
    }
  `)
  writeFileSync(join(root, 'dist', 'cli', 'kirictl.mjs'), `
    export async function runKiriOperationRequest(request) {
      return {
        ok: true,
        operation: request.operation,
        result: { source: 'fake-control' }
      }
    }
  `)
  const packagedSettings = options.packagedSettings ?? {
    runtimes: {
      pi: { models: ['pi-model'], defaultModel: 'pi-model' },
      codex: { models: ['codex-model'], defaultModel: 'codex-model' },
      claude: { models: ['claude-model'], defaultModel: 'claude-model' },
      opencode: { models: ['opencode-model'], defaultModel: 'opencode-model' },
    },
  }
  writeFileSync(join(root, 'settings.json'), JSON.stringify(packagedSettings))
  writeFileSync(settingsPath, JSON.stringify(options.userSettings ?? packagedSettings))
  return { root, stateDir, importMarker, settingsPath }
}

function waitForReady(child: ChildProcess) {
  return new Promise<{ readonly url: string }>((resolve, reject) => {
    let output = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      reject(new Error(`desktop backend did not become ready\n${stderr}`))
    }, 10_000)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_000)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`desktop backend exited before ready: ${code}\n${stderr}`))
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const lines = output.split('\n')
      output = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const parsed: unknown = JSON.parse(line)
        if (isReadyMessage(parsed)) {
          clearTimeout(timeout)
          resolve({ url: parsed.url })
        }
      }
    })
  })
}

function ownerUrl(pathname: string, readyUrl: string) {
  const url = new URL(readyUrl)
  url.pathname = pathname
  return url
}

function webSocketDataText(data: RawData) {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return data.toString('utf8')
}

function openSocket(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function listen(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Server did not listen on a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}

function close(server: Server) {
  if (!server.listening) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function isReadyMessage(value: unknown): value is { readonly url: string } {
  return Boolean(
    value
      && typeof value === 'object'
      && (value as { type?: unknown }).type === 'ready'
      && typeof (value as { url?: unknown }).url === 'string',
  )
}
