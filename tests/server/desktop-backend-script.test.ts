import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

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
    expect(await shell.text()).toContain('desktop shell')
    expect(existsSync(fixture.importMarker)).toBe(false)

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

    const app = await fetch(new URL('/app-route', ready.url))
    expect(app.status).toBe(200)
    expect(await app.text()).toBe('app:/app-route')
    expect(existsSync(fixture.importMarker)).toBe(true)

    child.kill()
    rmSync(fixture.root, { recursive: true, force: true })
  }, 15_000)
})

function createDesktopBackendFixture() {
  const root = mkdtempSync(join(tmpdir(), 'kiri-desktop-backend-'))
  const stateDir = join(root, 'state')
  const importMarker = join(root, 'server-imported')
  const settingsPath = join(root, 'settings.json')
  mkdirSync(join(root, 'dist', 'client'), { recursive: true })
  mkdirSync(join(root, 'dist', 'server'), { recursive: true })
  mkdirSync(join(root, 'dist', 'cli'), { recursive: true })
  writeFileSync(join(root, 'dist', 'client', 'index.html'), '<main>desktop shell</main>')
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
  writeFileSync(settingsPath, JSON.stringify({
    runtimes: {
      pi: { models: ['pi-model'], defaultModel: 'pi-model' },
      codex: { models: ['codex-model'], defaultModel: 'codex-model' },
      claude: { models: ['claude-model'], defaultModel: 'claude-model' },
    },
  }))
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

function isReadyMessage(value: unknown): value is { readonly url: string } {
  return Boolean(
    value
      && typeof value === 'object'
      && (value as { type?: unknown }).type === 'ready'
      && typeof (value as { url?: unknown }).url === 'string',
  )
}
