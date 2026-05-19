import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export function claudeTerminalSessionId(agentId: string, state: Record<string, unknown> = {}) {
  const configured = stringValue(state.sessionId)
  if (configured && isUuid(configured)) return configured
  return deterministicUuid(`kiri:claude:${agentId}`)
}

export function claudeProjectKey(cwd: string) {
  return resolve(cwd).replace(/[\\/]/g, '-')
}

function deterministicUuid(input: string) {
  const bytes = Array.from(createHash('sha256').update(input).digest().subarray(0, 16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}
