import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { TimelineEventTone } from '~/lib/contracts'
import { timelineEventToneSchema } from '~/lib/contracts'
import type { PiRpcEvent } from '../pi-rpc'
import { timelineEventDbRowSchema } from './schema'

export function timelineEventFromDbRow(row: z.infer<typeof timelineEventDbRowSchema>) {
  const payload = parseEventPayload(row.payloadJson)
  const derived = payload && !row.kind.startsWith('fileOperation')
    ? piEventDisplayFields(payload, row.kind)
    : undefined
  const path = eventPath(payload)
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    tone: row.tone,
    label: derived?.label ?? row.label,
    detail: derived?.detail ?? row.detail,
    ...(path ? { path } : {}),
    timestamp: row.timestamp,
  }
}

export function piEventToTimelineEvent(agentId: string, event: PiRpcEvent) {
  const kind = event.type.trim()
  if (!kind || kind === 'agent_end') return null

  const display = piEventDisplayFields(event, kind)
  const timestamp = numberField(event, 'timestamp')
  const createdAt = stringField(event, 'createdAt') ?? stringField(event, 'timestamp')

  return {
    id: eventId(agentId, event),
    kind,
    tone: eventTone(event),
    label: display.label,
    detail: display.detail,
    timestamp: timestamp !== undefined
      ? new Date(normalizeUnixTimestamp(timestamp)).toISOString()
      : parseTimestamp(createdAt) ?? new Date().toISOString(),
  }
}

export function eventId(agentId: string, event: PiRpcEvent) {
  const stableId = stringField(event, 'id') ??
    stringField(event, 'eventId') ??
    stringField(event, 'toolCallId') ??
    stringField(event, 'requestId')
  if (stableId) return `pi-event-${agentId}-${event.type}-${stableId}`
  const hash = createHash('sha256')
    .update(JSON.stringify(event))
    .digest('hex')
    .slice(0, 16)
  return `pi-event-${agentId}-${event.type}-${hash}`
}

export function normalizeUnixTimestamp(value: number) {
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function eventPath(payload: Record<string, unknown> | null | undefined) {
  if (!payload) return undefined
  const path = stringField(payload, 'path')
  return path?.trim() || undefined
}

function piEventDisplayFields(event: Record<string, unknown>, kind: string) {
  const toolName = stringField(event, 'toolName')
  const args = recordField(event, 'args')
  const command = args ? stringField(args, 'command') : undefined
  const label = toolName === 'bash'
    ? 'Ran command'
    : toolName ??
      stringField(event, 'label') ??
      stringField(event, 'title') ??
      stringField(event, 'message') ??
      formatEventKind(kind)
  const detail = command ??
    stringField(event, 'detail') ??
    stringField(event, 'command') ??
    stringField(event, 'rawCommand') ??
    stringField(event, 'error')
  return { label, detail: detail ?? null }
}

function parseEventPayload(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function eventTone(event: PiRpcEvent): TimelineEventTone {
  const explicitTone = stringField(event, 'tone')
  if (explicitTone && timelineEventToneSchema.safeParse(explicitTone).success) {
    return explicitTone as TimelineEventTone
  }

  const type = event.type.toLowerCase()
  if (type.includes('error') || type.includes('failed')) return 'error'
  if (type.includes('tool') || type.includes('bash') || type.includes('exec')) {
    return 'tool'
  }
  if (type.includes('think') || type.includes('plan')) return 'thinking'
  return 'info'
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parseTimestamp(value: string | undefined) {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

function formatEventKind(kind: string) {
  return kind
    .replace(/[_:.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
