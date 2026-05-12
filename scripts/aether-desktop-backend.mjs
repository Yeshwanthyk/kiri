import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { serve } from 'srvx/node'
import { serveStatic } from 'srvx/static'

const rootDir = resolve(process.env.AETHER_ROOT_DIR ?? process.cwd())
const aetherHome = resolve(process.env.AETHER_HOME ?? join(homedir(), '.aether'))
const stateDir = resolve(process.env.AETHER_STATE_DIR ?? join(aetherHome, 'userdata'))
const settingsPath = resolve(process.env.AETHER_SETTINGS_PATH ?? join(rootDir, 'settings.json'))
const dbPath = resolve(process.env.AETHER_DB_PATH ?? join(stateDir, 'aether.sqlite'))
const host = process.env.AETHER_BACKEND_HOST ?? '127.0.0.1'
const port = Number(process.env.AETHER_BACKEND_PORT ?? 0)
const environmentPath = '/.well-known/aether/environment'
let appReady = false

const serverEntryPath = join(rootDir, 'dist', 'server', 'server.js')
const staticDir = join(rootDir, 'dist', 'client')

if (!existsSync(serverEntryPath)) throw new Error(`Built server entry not found: ${serverEntryPath}`)
if (!existsSync(staticDir)) throw new Error(`Built client directory not found: ${staticDir}`)

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
            name: 'aether',
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
    return appFetch(request)
  },
})

await server.ready()
const readyResponse = await fetch(new URL(environmentPath, server.url))
if (!readyResponse.ok) {
  throw new Error(`Backend readiness failed: ${await readyResponse.text()}`)
}
process.stdout.write(`${JSON.stringify({ type: 'ready', url: server.url })}\n`)

async function checkReadiness(request) {
  if (!existsSync(settingsPath)) throw new Error(`settings.json not found: ${settingsPath}`)
  validateSettings(JSON.parse(readFileSync(settingsPath, 'utf8')))
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.close()
  if (appReady) return

  const response = await appFetch(new Request(new URL('/', request.url)))
  const body = await response.text()
  if (response.status >= 500) {
    throw new Error(`SSR readiness failed with ${response.status}: ${body.slice(0, 300)}`)
  }
  appReady = true
}

function validateSettings(settings) {
  const runtimes = settings?.runtimes
  if (!runtimes || typeof runtimes !== 'object') throw new Error('settings.json missing runtimes')
  for (const runtime of ['pi', 'codex', 'claude', 'opencode']) {
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
    name: 'aether',
    mode: 'desktop',
    rootDir,
    stateDir,
    dbPath,
  }
}
