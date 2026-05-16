import type { AgentTask } from '~/lib/contracts'

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function numberValue(value: unknown) {
  return typeof value === 'number' ? value : undefined
}

export function normalizeTaskStatus(value: unknown): AgentTask['status'] | undefined {
  if (value === 'in_progress') return 'inProgress'
  if (value === 'pending' || value === 'inProgress' || value === 'completed' || value === 'failed') {
    return value
  }
  return undefined
}

export function timestampFromMs(value: unknown) {
  return typeof value === 'number' ? new Date(value).toISOString() : undefined
}

export function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function commandText(
  item: Record<string, unknown>,
  readString: (value: unknown) => string | undefined,
) {
  const command = readString(item.command) ?? 'Command'
  const output = readString(item.aggregatedOutput)
  return output ? `${command}\n${output}` : command
}
