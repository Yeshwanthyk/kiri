import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  controlProtocolVersion,
  controlProtocolVersionHeader,
  parseControlProtocolVersion,
  type ControlProtocolWarning,
} from './control-protocol'
import {
  isKiriOperation,
  isKiriWriteOperation,
  type KiriOperation,
} from './operation-names'

export type KiriOperationErrorLike = {
  readonly code: string
  readonly message: string
  readonly path?: string
}

export type KiriOperationResponseLike =
  | {
    readonly ok: true
    readonly operation: KiriOperation
    readonly result: unknown
    readonly warning?: ControlProtocolWarning
  }
  | {
    readonly ok: false
    readonly operation: KiriOperation
    readonly error: KiriOperationErrorLike
    readonly warning?: ControlProtocolWarning
  }

export type BackendControlInfo = {
  readonly path: string
  readonly url: string
  readonly token: string
  readonly pid: number | null
  readonly controlProtocolVersion: number | null
}

export type BackendOperationResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'handled'; readonly response: KiriOperationResponseLike }

export async function tryRunBackendOperation(request: unknown): Promise<BackendOperationResult> {
  const info = readBackendControlInfo()
  if (!info) return { kind: 'none' }
  if (info.pid !== null && !isProcessAlive(info.pid)) {
    removeStaleBackendControlFile(info.path)
    return { kind: 'none' }
  }
  const timeoutMs = backendControlTimeoutMs(request)
  try {
    const response = await fetch(new URL('/.well-known/kiri/control', info.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${info.token}`,
        [controlProtocolVersionHeader]: String(controlProtocolVersion),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) {
      const parsed = await parseBackendResponseBody(response)
      return {
        kind: 'handled',
        response: parsed ?? backendInvalidResponse(request),
      }
    }
    return {
      kind: 'handled',
      response: await backendErrorResponse(response, request),
    }
  } catch (error) {
    if (isTimeoutAbort(error)) {
      return {
        kind: 'handled',
        response: {
          ok: false,
          operation: operationName(request),
          error: {
            code: 'BACKEND_CONTROL_TIMEOUT',
            message: `Kiri backend did not respond within ${timeoutMs}ms; the operation may still be running (set KIRI_BACKEND_CONTROL_TIMEOUT_MS to wait longer)`,
          },
        },
      }
    }
    if (isLocalWriteRefused(request, info)) {
      return {
        kind: 'handled',
        response: {
          ok: false,
          operation: operationName(request),
          error: {
            code: 'BACKEND_ALIVE_LOCAL_WRITE_REFUSED',
            message: backendAliveLocalWriteRefusedMessage(info),
          },
        },
      }
    }
    return { kind: 'none' }
  }
}

export function readBackendControlInfo(): BackendControlInfo | null {
  if (process.env.KIRI_DISABLE_BACKEND_PROXY === '1') return null
  const path = backendControlPath()
  if (!path || !existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const url = typeof record.url === 'string' ? record.url : null
    const token = typeof record.token === 'string' ? record.token : null
    const pid = typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0
      ? record.pid
      : null
    if (!url || !token) return null
    return {
      path,
      url,
      token,
      pid,
      controlProtocolVersion: parseControlProtocolVersion(record.controlProtocolVersion),
    }
  } catch {
    return null
  }
}

export function backendControlTimeoutMsForTests(request: unknown) {
  return backendControlTimeoutMs(request)
}

export function backendControlTimeoutMs(request: unknown) {
  const value = Number.parseInt(process.env.KIRI_BACKEND_CONTROL_TIMEOUT_MS ?? '', 10)
  if (Number.isFinite(value) && value > 0) return value
  const waitTimeoutMs = operationWaitTimeoutMs(request)
  return waitTimeoutMs === null ? 15_000 : waitTimeoutMs + 5_000
}

async function backendErrorResponse(response: Response, request: unknown): Promise<KiriOperationResponseLike> {
  const parsed = await parseBackendErrorBody(response)
  if (parsed) return parsed
  return {
    ok: false,
    operation: operationName(request),
    error: {
      code: response.status === 401 || response.status === 403
        ? 'BACKEND_CONTROL_UNAUTHORIZED'
        : 'BACKEND_CONTROL_FAILED',
      message: `Kiri backend control endpoint rejected the operation: ${response.status} ${response.statusText}`.trim(),
    },
  }
}

async function parseBackendErrorBody(response: Response) {
  try {
    return parseOperationResponse(await response.json())
  } catch {
    return null
  }
}

async function parseBackendResponseBody(response: Response) {
  try {
    return parseOperationResponse(await response.json())
  } catch {
    return null
  }
}

function parseOperationResponse(value: unknown): KiriOperationResponseLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const operation = isKiriOperation(record.operation) ? record.operation : null
  if (!operation) return null
  const warning = parseWarning(record.warning)
  if (record.ok === true) {
    return {
      ok: true,
      operation,
      result: record.result,
      ...(warning ? { warning } : {}),
    }
  }
  if (record.ok === false) {
    const error = parseError(record.error)
    if (!error) return null
    return {
      ok: false,
      operation,
      error,
      ...(warning ? { warning } : {}),
    }
  }
  return null
}

function parseError(value: unknown): KiriOperationErrorLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.code !== 'string' || typeof record.message !== 'string') return null
  return {
    code: record.code,
    message: record.message,
    ...(typeof record.path === 'string' ? { path: record.path } : {}),
  }
}

function parseWarning(value: unknown): ControlProtocolWarning | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.code !== 'CONTROL_PROTOCOL_VERSION_MISMATCH') return null
  if (typeof record.message !== 'string') return null
  const expectedVersion = parseControlProtocolVersion(record.expectedVersion)
  if (expectedVersion === null) return null
  return {
    code: 'CONTROL_PROTOCOL_VERSION_MISMATCH',
    message: record.message,
    expectedVersion,
    receivedVersion: parseControlProtocolVersion(record.receivedVersion),
  }
}

function backendInvalidResponse(request: unknown): KiriOperationResponseLike {
  return {
    ok: false,
    operation: operationName(request),
    error: {
      code: 'BACKEND_CONTROL_FAILED',
      message: 'Kiri backend control endpoint returned an invalid operation response',
    },
  }
}

function operationName(request: unknown): KiriOperation {
  if (request && typeof request === 'object' && 'operation' in request) {
    const operation = (request as { readonly operation?: unknown }).operation
    if (isKiriOperation(operation)) return operation
  }
  return 'operations.list'
}

function operationWaitTimeoutMs(request: unknown) {
  if (!request || typeof request !== 'object') return null
  const operation = 'operation' in request && typeof request.operation === 'string'
    ? request.operation
    : null
  if (operation !== 'terminal.wait-for' && operation !== 'workflow.await') return null
  const params = 'params' in request && request.params && typeof request.params === 'object'
    ? request.params
    : null
  if (!params || !('timeoutMs' in params)) return null
  const timeoutMs = params.timeoutMs
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : null
}

function isTimeoutAbort(error: unknown) {
  if (!error || typeof error !== 'object') return false
  return 'name' in error && error.name === 'TimeoutError'
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
  }
}

function removeStaleBackendControlFile(path: string) {
  try {
    unlinkSync(path)
  } catch {
    // Best effort: stale control files should not block local fallback.
  }
}

function isLocalWriteRefused(request: unknown, info: { readonly pid: number | null }) {
  if (!isKiriWriteOperation(operationName(request))) return false
  return info.pid === null || isProcessAlive(info.pid)
}

function backendAliveLocalWriteRefusedMessage(info: { readonly pid: number | null }) {
  if (info.pid !== null) {
    return `Kiri backend pid ${info.pid} is alive, but its control endpoint was unavailable; refusing local write execution`
  }
  return 'Kiri backend control file has no pid and its endpoint was unavailable; refusing local write execution'
}

function backendControlPath() {
  const explicit = process.env.KIRI_BACKEND_CONTROL_PATH?.trim()
  if (explicit) return resolve(explicit)
  const stateDir = process.env.KIRI_STATE_DIR?.trim()
    ? resolve(process.env.KIRI_STATE_DIR)
    : resolve(process.env.KIRI_HOME?.trim() || join(homedir(), '.kiri'), 'userdata')
  return join(stateDir, 'backend-control.json')
}
