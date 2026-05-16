import type { ThinkingLevel } from '~/lib/contracts'
import { defaultCodexWebsocketUrl } from './codex-app-server'

export type CodexRuntimeState = {
  threadId?: string
  websocketUrl?: string
  userAgent?: string
}

export function parseCodexRuntimeStateJson(value: string | null | undefined) {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    throw new Error('Invalid runtime state JSON')
  }
  throw new Error('Invalid runtime state JSON')
}

export function codexState(value: Record<string, unknown>): CodexRuntimeState {
  return {
    threadId: stringValue(value.threadId),
    websocketUrl: stringValue(value.websocketUrl),
    userAgent: stringValue(value.userAgent),
  }
}

export function adapterUrl(value: string | undefined, env?: NodeJS.ProcessEnv) {
  return value ?? defaultCodexWebsocketUrl(env)
}

export function codexReasoningOptions(level: ThinkingLevel | null) {
  if (!level) return {}
  return { effort: level === 'off' ? 'none' : level }
}

export function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined
}
