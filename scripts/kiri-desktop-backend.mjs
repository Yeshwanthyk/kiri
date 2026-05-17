import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { serve } from 'srvx/node'
import { serveStatic } from 'srvx/static'

const rootDir = resolve(process.env.KIRI_ROOT_DIR ?? process.cwd())
const kiriHome = resolve(process.env.KIRI_HOME ?? join(homedir(), '.kiri'))
const stateDir = resolve(process.env.KIRI_STATE_DIR ?? join(kiriHome, 'userdata'))
const settingsPath = resolve(process.env.KIRI_SETTINGS_PATH ?? join(rootDir, 'settings.json'))
const dbPath = resolve(process.env.KIRI_DB_PATH ?? join(stateDir, 'kiri.sqlite'))
const host = process.env.KIRI_BACKEND_HOST ?? '127.0.0.1'
const port = Number(process.env.KIRI_BACKEND_PORT ?? 0)
const browserHost = process.env.KIRI_BACKEND_BROWSER_HOST ?? (host === '0.0.0.0' ? '127.0.0.1' : host)
const environmentPath = '/.well-known/kiri/environment'
const controlPath = '/.well-known/kiri/control'
const controlToken = process.env.KIRI_BACKEND_CONTROL_TOKEN ?? randomBytes(32).toString('base64url')
const controlInfoPath = resolve(process.env.KIRI_BACKEND_CONTROL_PATH ?? join(stateDir, 'backend-control.json'))

const serverEntryPath = join(rootDir, 'dist', 'server', 'server.js')
const staticDir = join(rootDir, 'dist', 'client')

if (!existsSync(serverEntryPath)) throw new Error(`Built server entry not found: ${serverEntryPath}`)
if (!existsSync(staticDir)) throw new Error(`Built client directory not found: ${staticDir}`)

process.env.KIRI_WORKFLOW_SPAWN_TERMINALS = '1'
const serverEntry = await import(pathToFileURL(serverEntryPath).href)
const appFetch = serverEntry.default?.fetch
if (typeof appFetch !== 'function') {
  throw new Error(`Built server entry does not export default.fetch: ${serverEntryPath}`)
}

const server = serve({
  hostname: host,
  port: Number.isInteger(port) && port >= 0 ? port : 0,
  silent: true,
  middleware: [serveStatic({ dir: staticDir })],
  fetch: async (request) => {
    const url = new URL(request.url)
    if (url.pathname === environmentPath) {
      try {
        await checkReadiness(request)
        return Response.json(environmentInfo(), {
          headers: { 'cache-control': 'no-store' },
        })
      } catch (error) {
        return Response.json(
          {
            name: 'kiri',
            ready: false,
            error: error instanceof Error ? error.message : String(error),
          },
          {
            status: 503,
            headers: { 'cache-control': 'no-store' },
          },
        )
      }
    }
    if (url.pathname === controlPath) {
      return handleControlRequest(request)
    }
    return appFetch(request)
  },
})

await server.ready()
const browserUrl = new URL(server.url)
browserUrl.hostname = browserHost
const readyResponse = await fetch(new URL(environmentPath, browserUrl))
if (!readyResponse.ok) {
  throw new Error(`Backend readiness failed: ${await readyResponse.text()}`)
}
writeControlInfo(browserUrl.toString())
process.stdout.write(`${JSON.stringify({ type: 'ready', url: browserUrl.toString() })}\n`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanupControlInfo()
    process.kill(process.pid, signal)
  })
}
process.once('exit', cleanupControlInfo)

async function checkReadiness() {
  if (!existsSync(settingsPath)) throw new Error(`settings.json not found: ${settingsPath}`)
  validateSettings(JSON.parse(readFileSync(settingsPath, 'utf8')))
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.close()
}

function validateSettings(settings) {
  const runtimes = settings?.runtimes
  if (!runtimes || typeof runtimes !== 'object') throw new Error('settings.json missing runtimes')
  for (const runtime of ['pi', 'codex', 'claude']) {
    const config = runtimes[runtime]
    if (!config || !Array.isArray(config.models) || config.models.length === 0) {
      throw new Error(`settings.json ${runtime}.models must be a non-empty array`)
    }
    if (typeof config.defaultModel !== 'string' || !config.models.includes(config.defaultModel)) {
      throw new Error(`settings.json ${runtime}.defaultModel must be listed in ${runtime}.models`)
    }
  }
}

function environmentInfo() {
  return {
    name: 'kiri',
    mode: 'desktop',
    rootDir,
    stateDir,
    dbPath,
  }
}

async function handleControlRequest(request) {
  if (request.method !== 'POST') {
    return Response.json({
      ok: false,
      operation: 'operations.list',
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'Kiri backend control endpoint only accepts POST',
      },
    }, { status: 405 })
  }
  const authorization = request.headers.get('authorization') ?? ''
  if (authorization !== `Bearer ${controlToken}`) {
    return Response.json({
      ok: false,
      operation: 'operations.list',
      error: {
        code: 'UNAUTHORIZED',
        message: 'Kiri backend control token is invalid',
      },
    }, { status: 401 })
  }
  try {
    const operation = await import(pathToFileURL(join(rootDir, 'dist', 'cli', 'kirictl.mjs')).href)
    const run = operation.runKiriOperationRequest
    if (typeof run !== 'function') throw new Error('kirictl control export missing')
    return Response.json(await run(await request.json()), {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return Response.json(
      {
        ok: false,
        operation: 'operations.list',
        error: {
          code: 'FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    )
  }
}

function writeControlInfo(url) {
  mkdirSync(dirname(controlInfoPath), { recursive: true })
  writeFileSync(controlInfoPath, `${JSON.stringify({
    url,
    token: controlToken,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 })
  chmodSync(controlInfoPath, 0o600)
}

function cleanupControlInfo() {
  try {
    const parsed = JSON.parse(readFileSync(controlInfoPath, 'utf8'))
    if (parsed?.pid !== process.pid) return
    rmSync(controlInfoPath, { force: true })
  } catch {
    // Nothing to clean up.
  }
}
