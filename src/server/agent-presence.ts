import { Buffer } from 'node:buffer'
import type { RuntimeKind } from '~/lib/contracts'

export type AgentPresenceAgent = RuntimeKind

export type AgentPresenceStatus =
  | 'session_start'
  | 'busy'
  | 'awaiting_input'
  | 'idle'
  | 'session_end'

export type AgentPresenceStatusEvent = {
  readonly agent: AgentPresenceAgent
  readonly event: AgentPresenceStatus
  readonly pid?: number
}

export type AgentPresenceNotifyEvent = {
  readonly agent: AgentPresenceAgent
  readonly kind: 'notify'
  readonly title: string
  readonly body: string
}

export type AgentPresenceEvent = AgentPresenceStatusEvent | AgentPresenceNotifyEvent

const maxPayloadBytes = 8_192
const maxEncodedNotifyBytes = 4_096
const maxDecodedNotifyBytes = 4_096

const allowedAgents = new Set<AgentPresenceAgent>(['claude', 'codex', 'opencode', 'pi'])
const allowedStatuses = new Set<AgentPresenceStatus>([
  'session_start',
  'busy',
  'awaiting_input',
  'idle',
  'session_end',
])

export function parseAgentPresenceOsc(payload: string): AgentPresenceEvent | null {
  if (Buffer.byteLength(payload, 'utf8') > maxPayloadBytes) return null
  const fields = parseFields(payload)
  if (!fields) return null

  const agent = parseAgent(fields.start ?? fields.end)
  if (!agent) return null

  if (fields.kind === 'notify') {
    if (fields.end !== undefined) return null
    const title = decodeNotifyField(fields.title)
    const body = decodeNotifyField(fields.body)
    return title === null || body === null
      ? null
      : { agent, kind: 'notify', title, body }
  }

  const event = parseStatus(fields.event)
  if (!event) return null
  if (fields.end !== undefined && event !== 'session_end') return null
  const pid = parsePid(fields.pid)
  if (pid === null) return null

  return {
    agent,
    event,
    ...(pid === undefined ? {} : { pid }),
  }
}

export function agentPresenceShellCommand(
  agent: AgentPresenceAgent,
  event: AgentPresenceStatus,
) {
  const payload = renderAgentPresenceOscPayload(agent, event)
  return `printf '\\033]3008;${payload};pid=%d\\033\\\\' "$PPID" > /dev/tty 2>/dev/null || true`
}

export function renderAgentPresenceOscPayload(
  agent: AgentPresenceAgent,
  event: AgentPresenceStatus,
) {
  if (!allowedAgents.has(agent)) throw new Error(`Unsupported agent presence runtime: ${agent}`)
  if (!allowedStatuses.has(event)) throw new Error(`Unsupported agent presence event: ${event}`)
  const direction = event === 'session_end' ? 'end' : 'start'
  return `${direction}=${agent};event=${event}`
}

function parseFields(payload: string) {
  const fields: Record<string, string> = {}
  for (const rawPart of payload.split(';')) {
    const part = rawPart.trim()
    if (!part) continue
    const separator = part.indexOf('=')
    if (separator <= 0) return null
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (!key || value === '') return null
    fields[key] = value
  }
  return fields
}

function parseAgent(value: string | undefined): AgentPresenceAgent | null {
  if (!value) return null
  return allowedAgents.has(value as AgentPresenceAgent)
    ? value as AgentPresenceAgent
    : null
}

function parseStatus(value: string | undefined): AgentPresenceStatus | null {
  if (!value) return null
  return allowedStatuses.has(value as AgentPresenceStatus)
    ? value as AgentPresenceStatus
    : null
}

function parsePid(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined
  if (!/^[1-9]\d{0,15}$/.test(value)) return null
  const pid = Number(value)
  return Number.isSafeInteger(pid) ? pid : null
}

function decodeNotifyField(value: string | undefined) {
  if (!value || value.length > maxEncodedNotifyBytes) return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length > maxDecodedNotifyBytes) return null
  return decoded.toString('utf8')
}
