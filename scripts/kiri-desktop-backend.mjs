import { randomBytes } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { serve } from 'srvx/node'
import { serveStatic } from 'srvx/static'

const execFile = promisify(execFileCallback)
// Desktop sessions default to the detached kiriterm daemon so terminals and
// background agents survive backend/UI restarts. Set 0 to force embedded.
process.env.KIRI_TERMINAL_DAEMON ??= '1'
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
const connectPath = '/.well-known/kiri/connect'
const pairingTokenPath = '/.well-known/kiri/connect/pairing-token'
const authBootstrapPath = '/.well-known/kiri/auth/bootstrap'
const tailscaleServePath = '/.well-known/kiri/connect/tailscale-serve'
const pairPath = '/pair'
const controlToken = process.env.KIRI_BACKEND_CONTROL_TOKEN ?? randomBytes(32).toString('base64url')
const controlInfoPath = resolve(process.env.KIRI_BACKEND_CONTROL_PATH ?? join(stateDir, 'backend-control.json'))
const tailscalePath = resolve(process.env.KIRI_TAILSCALE_PATH ?? '/Applications/Tailscale.app/Contents/MacOS/Tailscale')
const ownerToken = process.env.KIRI_BACKEND_OWNER_TOKEN ?? randomBytes(32).toString('base64url')
const ownerTokenParam = 'kiri_owner_token'
const ownerTokenHeader = 'x-kiri-owner-token'
const ownerCookieName = 'kiri_owner_session'
const sessionCookieName = 'kiri_remote_session'
const pairingTtlMs = 10 * 60 * 1000
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000
const pairingTokens = new Map()
const remoteSessions = new Map()
let publicBrowserUrl

const serverEntryPath = join(rootDir, 'dist', 'server', 'server.js')
const staticDir = join(rootDir, 'dist', 'client')
let appFetchPromise

if (!existsSync(serverEntryPath)) throw new Error(`Built server entry not found: ${serverEntryPath}`)
if (!existsSync(staticDir)) throw new Error(`Built client directory not found: ${staticDir}`)

process.env.KIRI_WORKFLOW_SPAWN_TERMINALS = '1'
process.env.KIRI_TERMINAL_HOST ??= host

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
        return Response.json(environmentInfo(!hasOwnerAccess(request)), {
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
    if (url.pathname === connectPath) {
      return handleConnectRequest(request)
    }
    if (url.pathname === pairingTokenPath) {
      return handlePairingTokenRequest(request)
    }
    if (url.pathname === authBootstrapPath) {
      return handleAuthBootstrapRequest(request)
    }
    if (url.pathname === tailscaleServePath) {
      return handleTailscaleServeRequest(request)
    }
    if (url.pathname === pairPath) {
      return pairPageResponse()
    }
    if (!isTrustedRequest(request)) {
      return unauthorizedResponse(request)
    }
    const appFetch = await loadAppFetch()
    return appResponseWithOwnerCookie(request, await appFetch(request))
  },
})

await server.ready()
const browserUrl = new URL(server.url)
browserUrl.hostname = browserHost
publicBrowserUrl = browserUrl
const ownerBrowserUrl = new URL(browserUrl)
ownerBrowserUrl.searchParams.set(ownerTokenParam, ownerToken)
const readyResponse = await fetch(new URL(environmentPath, browserUrl))
if (!readyResponse.ok) {
  throw new Error(`Backend readiness failed: ${await readyResponse.text()}`)
}
writeControlInfo(ownerBrowserUrl.toString())
process.stdout.write(`${JSON.stringify({ type: 'ready', url: ownerBrowserUrl.toString() })}\n`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanupControlInfo()
    process.kill(process.pid, signal)
  })
}
process.once('exit', cleanupControlInfo)

async function loadAppFetch() {
  appFetchPromise ??= import(pathToFileURL(serverEntryPath).href).then((serverEntry) => {
    const appFetch = serverEntry.default?.fetch
    if (typeof appFetch !== 'function') {
      throw new Error(`Built server entry does not export default.fetch: ${serverEntryPath}`)
    }
    return appFetch
  })
  return appFetchPromise
}

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

function environmentInfo(publicInfo = false) {
  if (publicInfo) {
    return {
      name: 'kiri',
      mode: 'desktop',
      ready: true,
    }
  }
  return {
    name: 'kiri',
    mode: 'desktop',
    rootDir,
    stateDir,
    dbPath,
  }
}

async function handleConnectRequest(request) {
  if (request.method !== 'GET') return methodNotAllowed('GET')
  if (!canManageConnect(request)) return unauthorizedJson()
  return Response.json(await connectInfo(), { headers: { 'cache-control': 'no-store' } })
}

async function handlePairingTokenRequest(request) {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  if (!canManageConnect(request)) return unauthorizedJson()
  if (!isJsonRequest(request)) return unsupportedMediaType()
  const body = await readJsonBody(request)
  const requestedBaseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl : undefined
  const baseUrl = normalizeRemoteBaseUrl(requestedBaseUrl) ?? new URL(request.url).origin
  const token = randomBytes(32).toString('base64url')
  const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim() : 'phone'
  const expiresAt = Date.now() + pairingTtlMs
  pairingTokens.set(token, { label, expiresAt })
  const pairingUrl = new URL(pairPath, baseUrl)
  pairingUrl.hash = `token=${encodeURIComponent(token)}`
  return Response.json({
    token,
    label,
    expiresAt: new Date(expiresAt).toISOString(),
    pairingUrl: pairingUrl.toString(),
  }, { headers: { 'cache-control': 'no-store' } })
}

async function handleAuthBootstrapRequest(request) {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  const body = await readJsonBody(request)
  const token = typeof body?.token === 'string' ? body.token : ''
  const credential = pairingTokens.get(token)
  if (!credential || credential.expiresAt < Date.now()) {
    pairingTokens.delete(token)
    return Response.json({ ok: false, error: 'PAIRING_TOKEN_INVALID' }, { status: 401 })
  }
  pairingTokens.delete(token)
  const session = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + sessionTtlMs
  remoteSessions.set(session, { label: credential.label, expiresAt })
  return Response.json(
    { ok: true, expiresAt: new Date(expiresAt).toISOString() },
    {
      headers: {
        'cache-control': 'no-store',
        'set-cookie': `${sessionCookieName}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
      },
    },
  )
}

async function handleTailscaleServeRequest(request) {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  if (!canManageConnect(request)) return unauthorizedJson()
  if (!isJsonRequest(request)) return unsupportedMediaType()
  const body = await readJsonBody(request)
  const enabled = body?.enabled === true
  const localPort = publicBrowserUrl?.port
  if (!localPort) {
    return Response.json({ ok: false, error: 'SERVER_NOT_READY' }, { status: 503 })
  }
  try {
    if (enabled) {
      await execFile(tailscaleCommand(), ['serve', '--bg', '--https=443', `http://127.0.0.1:${localPort}`], { timeout: 10_000 })
    } else {
      await execFile(tailscaleCommand(), ['serve', 'reset'], { timeout: 10_000 })
    }
    return Response.json({ ok: true, enabled }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500, headers: { 'cache-control': 'no-store' } })
  }
}

async function connectInfo() {
  const baseUrl = publicBrowserUrl?.toString() ?? ''
  const tailscale = await tailscaleInfo()
  return {
    baseUrl,
    auth: {
      policy: 'remote-cookie-pairing',
      pairingTtlMs,
      sessionTtlMs,
      pendingPairingTokens: livePairingTokenCount(),
      activeSessions: liveSessionCount(),
    },
    endpoints: [
      { kind: 'local', label: 'This Mac', url: baseUrl },
      ...tailscale.endpoints,
    ].filter((endpoint) => endpoint.url),
    tailscale,
  }
}

async function tailscaleInfo() {
  try {
    const { stdout } = await execFile(tailscaleCommand(), ['status', '--json'], { timeout: 5_000 })
    const status = JSON.parse(stdout)
    const self = status?.Self
    const dnsName = typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : ''
    const ips = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs.filter((ip) => typeof ip === 'string') : []
    const endpoints = []
    if (isNetworkBoundHost(host)) {
      for (const ip of ips) {
        if (isTailscaleIpv4(ip)) endpoints.push({ kind: 'tailscale-http', label: 'Tailscale IP', url: `http://${ip}:${publicBrowserUrl?.port ?? ''}` })
      }
    }
    if (dnsName) endpoints.push({ kind: 'tailscale-https', label: 'Tailscale Serve HTTPS', url: `https://${dnsName}` })
    return { available: true, dnsName, ips, endpoints }
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      endpoints: [],
    }
  }
}

function canManageConnect(request) {
  return request.headers.get(ownerTokenHeader) === ownerToken
}

function isTrustedRequest(request) {
  return hasOwnerAccess(request) || Boolean(readValidSession(request))
}

function hasOwnerAccess(request) {
  return requestOwnerToken(request) === ownerToken ||
    readCookie(request.headers.get('cookie') ?? '', ownerCookieName) === ownerToken
}

function readValidSession(request) {
  const session = readCookie(request.headers.get('cookie') ?? '', sessionCookieName)
  if (!session) return undefined
  const record = remoteSessions.get(session)
  if (!record || record.expiresAt < Date.now()) {
    remoteSessions.delete(session)
    return undefined
  }
  return record
}

function unauthorizedResponse(request) {
  const accept = request.headers.get('accept') ?? ''
  if (accept.includes('text/html')) {
    const pairUrl = new URL(pairPath, request.url)
    return Response.redirect(pairUrl, 302)
  }
  return unauthorizedJson()
}

function unauthorizedJson() {
  return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401, headers: { 'cache-control': 'no-store' } })
}

function methodNotAllowed(method) {
  return Response.json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, {
    status: 405,
    headers: { allow: method, 'cache-control': 'no-store' },
  })
}

function unsupportedMediaType() {
  return Response.json({ ok: false, error: 'UNSUPPORTED_MEDIA_TYPE' }, {
    status: 415,
    headers: { 'cache-control': 'no-store' },
  })
}

function isJsonRequest(request) {
  return (request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')
}

async function readJsonBody(request) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

function normalizeRemoteBaseUrl(value) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    url.search = ''
    url.pathname = '/'
    return url.toString()
  } catch {
    return undefined
  }
}

function readCookie(header, name) {
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return undefined
}

function isLoopbackRequest(request) {
  return isLoopbackAddress(request.ip)
}

function isLocalOwnerRequest(request) {
  if (!isLoopbackRequest(request)) return false
  return isLoopbackHost(new URL(request.url).hostname)
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
}

function isTailscaleIpv4(ip) {
  const parts = ip.split('.').map((part) => Number(part))
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

function isNetworkBoundHost(value) {
  return value === '0.0.0.0' || value === '::' || value === '[::]'
}

function tailscaleCommand() {
  return existsSync(tailscalePath) ? tailscalePath : 'tailscale'
}

function requestOwnerToken(request) {
  const url = new URL(request.url)
  return url.searchParams.get(ownerTokenParam) ?? request.headers.get(ownerTokenHeader)
}

function appResponseWithOwnerCookie(request, response) {
  if (requestOwnerToken(request) !== ownerToken) return response
  const headers = new Headers(response.headers)
  headers.append(
    'set-cookie',
    `${ownerCookieName}=${ownerToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
  )
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function livePairingTokenCount() {
  const now = Date.now()
  for (const [token, record] of pairingTokens) {
    if (record.expiresAt < now) pairingTokens.delete(token)
  }
  return pairingTokens.size
}

function liveSessionCount() {
  const now = Date.now()
  for (const [session, record] of remoteSessions) {
    if (record.expiresAt < now) remoteSessions.delete(session)
  }
  return remoteSessions.size
}

function pairPageResponse() {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pair kiri</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #11110f; color: #f4efe7; }
    body { min-height: 100dvh; margin: 0; display: grid; place-items: center; padding: 24px; }
    main { width: min(420px, 100%); border: 1px solid rgb(244 239 231 / 14%); border-radius: 10px; background: #1a1916; padding: 22px; box-shadow: 0 24px 80px rgb(0 0 0 / 32%); }
    h1 { margin: 0 0 8px; font-size: 22px; letter-spacing: 0; }
    p { margin: 0; color: rgb(244 239 231 / 70%); line-height: 1.45; }
    button { width: 100%; margin-top: 18px; border: 0; border-radius: 8px; padding: 13px 14px; font: inherit; font-weight: 650; color: #11110f; background: #e8c468; }
    small { display: block; margin-top: 14px; color: rgb(244 239 231 / 52%); overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <h1>Pair kiri</h1>
    <p id="status">Use the button below to pair this browser with your desktop board.</p>
    <button id="pair" type="button">Pair this phone</button>
    <small id="detail"></small>
  </main>
  <script>
    const statusEl = document.getElementById('status')
    const detailEl = document.getElementById('detail')
    const button = document.getElementById('pair')
    const token = new URLSearchParams(location.hash.slice(1)).get('token')
    if (!token) {
      statusEl.textContent = 'This pairing link is missing its token.'
      button.disabled = true
    }
    button.addEventListener('click', async () => {
      button.disabled = true
      statusEl.textContent = 'Pairing...'
      const response = await fetch('${authBootstrapPath}', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!response.ok) {
        statusEl.textContent = 'Pairing failed.'
        detailEl.textContent = await response.text()
        button.disabled = false
        return
      }
      location.hash = ''
      location.href = '/'
    })
  </script>
</body>
</html>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
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
