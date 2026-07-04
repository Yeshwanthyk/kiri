import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentTask } from '~/lib/contracts'
import type { AgentPresenceStatus } from './agent-presence'
import { objectValue } from './codex-value-helpers'

export const claudeHookSessionBindingFile = 'claude-hook-session.json'

export const claudeHookEvents = [
  'session-start',
  'user-prompt-submit',
  'stop',
  'session-end',
  'pre-tool-use',
  'permission-request',
  'post-tool-use',
] as const
export type ClaudeHookEvent = typeof claudeHookEvents[number]

export type ClaudeHookSettingsEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SessionEnd'
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'

export type ClaudeHookCommandSpec =
  | {
    readonly kind: 'kirictl'
    readonly event: ClaudeHookEvent
    readonly matcher?: string
  }
  | {
    readonly kind: 'presence'
    readonly status: AgentPresenceStatus
    readonly matcher?: string
  }

export type ClaudeHookSettingsSpec = {
  readonly event: ClaudeHookSettingsEvent
  readonly commands: readonly ClaudeHookCommandSpec[]
}

export const claudeHookSettingsSpecs: readonly ClaudeHookSettingsSpec[] = [
  {
    event: 'SessionStart',
    commands: [
      { kind: 'presence', status: 'session_start' },
      { kind: 'kirictl', event: 'session-start' },
    ],
  },
  {
    event: 'UserPromptSubmit',
    commands: [
      { kind: 'presence', status: 'busy' },
      { kind: 'kirictl', event: 'user-prompt-submit' },
    ],
  },
  {
    event: 'Stop',
    commands: [
      { kind: 'presence', status: 'idle' },
      { kind: 'kirictl', event: 'stop' },
    ],
  },
  {
    event: 'SessionEnd',
    commands: [
      { kind: 'presence', status: 'session_end' },
      { kind: 'kirictl', event: 'session-end' },
    ],
  },
  {
    event: 'PreToolUse',
    commands: [
      { kind: 'presence', status: 'awaiting_input', matcher: 'AskUserQuestion|ExitPlanMode' },
      { kind: 'kirictl', event: 'pre-tool-use', matcher: 'AskUserQuestion|ExitPlanMode' },
    ],
  },
  {
    event: 'PermissionRequest',
    commands: [
      { kind: 'presence', status: 'awaiting_input' },
      { kind: 'kirictl', event: 'permission-request' },
    ],
  },
  {
    event: 'PostToolUse',
    commands: [
      { kind: 'presence', status: 'busy' },
      { kind: 'kirictl', event: 'post-tool-use', matcher: 'TodoWrite' },
    ],
  },
]

export type ClaudeHookSessionBinding = {
  readonly agentId: string
  readonly sessionId?: string
  readonly cwd?: string
  readonly source: 'hook'
  readonly hookEventName: string
  readonly transcriptPath?: string
  readonly model?: string
  readonly writtenAtMs: number
}

type KiriOperationRunner = (request: {
  readonly operation: string
  readonly params: Record<string, unknown>
}) => Promise<unknown>

type HandleClaudeHookInput = {
  readonly event: ClaudeHookEvent
  readonly stdin: string
  readonly env: NodeJS.ProcessEnv
  readonly runOperation: KiriOperationRunner
  readonly now?: () => Date
}

export type ClaudeHookResult = {
  readonly ok: boolean
  readonly reason?: string
}

export async function handleClaudeHook(input: HandleClaudeHookInput): Promise<ClaudeHookResult> {
  const agentId = input.env.KIRI_AGENT_ID?.trim()
  const sessionDir = input.env.KIRI_SESSION_DIR?.trim()
  if (!agentId || !sessionDir) {
    return { ok: true, reason: 'KIRI_AGENT_ID or KIRI_SESSION_DIR not set; skipping' }
  }

  let payload: Record<string, unknown>
  try {
    payload = parseHookPayload(input.stdin)
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Invalid Claude hook payload',
    }
  }

  const now = input.now?.() ?? new Date()
  try {
    switch (input.event) {
      case 'session-start':
        if (isSubagentPayload(payload)) return { ok: true, reason: 'Ignored Claude subagent hook payload' }
        writeClaudeHookSessionBinding(sessionDir, claudeHookSessionBinding({
          agentId,
          payload,
          env: input.env,
          now,
        }))
        await checkedRunOperation(input.runOperation, {
          operation: 'agent.status.set',
          params: { agentId, status: 'idle' },
        })
        return { ok: true }
      case 'user-prompt-submit':
        if (isSubagentPayload(payload)) return { ok: true, reason: 'Ignored Claude subagent hook payload' }
        if (!sessionMatchesBinding(sessionDir, payload)) return { ok: true, reason: 'Ignored Claude hook for a different session' }
        await checkedRunOperation(input.runOperation, {
          operation: 'agent.status.set',
          params: { agentId, status: 'running' },
        })
        return { ok: true }
      case 'stop':
        if (isSubagentPayload(payload)) return { ok: true, reason: 'Ignored Claude subagent hook payload' }
        if (!sessionMatchesBinding(sessionDir, payload)) return { ok: true, reason: 'Ignored Claude hook for a different session' }
        await checkedRunOperation(input.runOperation, {
          operation: 'agent.status.set',
          params: { agentId, status: 'idle' },
        })
        await maybeRenameDefaultTitle({ agentId, payload, runOperation: input.runOperation })
        return { ok: true }
      case 'session-end':
        if (isSubagentPayload(payload)) return { ok: true, reason: 'Ignored Claude subagent hook payload' }
        if (!sessionMatchesBinding(sessionDir, payload)) return { ok: true, reason: 'Ignored Claude hook for a different session' }
        await checkedRunOperation(input.runOperation, {
          operation: 'agent.status.set',
          params: { agentId, status: 'idle' },
        })
        return { ok: true }
      case 'pre-tool-use':
        if (isSubagentPayload(payload)) return { ok: true, reason: 'Ignored Claude subagent hook payload' }
        if (!sessionMatchesBinding(sessionDir, payload)) return { ok: true, reason: 'Ignored Claude hook for a different session' }
        if (toolNameMatches(payload, ['AskUserQuestion', 'ExitPlanMode'])) {
          await checkedRunOperation(input.runOperation, {
            operation: 'agent.status.set',
            params: { agentId, status: 'blocked' },
          })
          return { ok: true }
        }
        return { ok: true, reason: 'tool did not require status projection' }
      case 'permission-request':
        if (isSubagentPayload(payload)) return { ok: true, reason: 'Ignored Claude subagent hook payload' }
        if (!sessionMatchesBinding(sessionDir, payload)) return { ok: true, reason: 'Ignored Claude hook for a different session' }
        await checkedRunOperation(input.runOperation, {
          operation: 'agent.status.set',
          params: { agentId, status: 'blocked' },
        })
        return { ok: true }
      case 'post-tool-use':
        if (isSubagentPayload(payload)) return { ok: true, reason: 'Ignored Claude subagent hook payload' }
        if (!sessionMatchesBinding(sessionDir, payload)) return { ok: true, reason: 'Ignored Claude hook for a different session' }
        await checkedRunOperation(input.runOperation, {
          operation: 'agent.status.set',
          params: { agentId, status: 'running' },
        })
        if (!toolNameMatches(payload, ['TodoWrite'])) {
          return { ok: true, reason: 'tool did not require task projection' }
        }
        await checkedRunOperation(input.runOperation, {
          operation: 'agent.tasks.replace',
          params: {
            agentId,
            source: 'claude',
            tasks: claudeTodoTasks(payload, now),
            updatedAt: now.toISOString(),
          },
        })
        return { ok: true }
      default:
        return unreachable(input.event)
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export function writeClaudeHookSessionBinding(
  sessionDir: string,
  binding: ClaudeHookSessionBinding,
) {
  mkdirSync(sessionDir, { recursive: true })
  const path = join(sessionDir, claudeHookSessionBindingFile)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${globalThis.JSON.stringify(binding, null, 2)}\n`)
  renameSync(tmp, path)
}

export function readClaudeHookSessionBinding(sessionDir: string): ClaudeHookSessionBinding | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(sessionDir, claudeHookSessionBindingFile), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    const agentId = stringValue(record.agentId)
    const writtenAtMs = typeof record.writtenAtMs === 'number' ? record.writtenAtMs : NaN
    if (!agentId || !Number.isFinite(writtenAtMs) || record.source !== 'hook') return undefined
    return {
      agentId,
      sessionId: stringValue(record.sessionId),
      cwd: stringValue(record.cwd),
      source: 'hook',
      hookEventName: stringValue(record.hookEventName) ?? 'SessionStart',
      transcriptPath: stringValue(record.transcriptPath),
      model: stringValue(record.model),
      writtenAtMs,
    }
  } catch {
    return undefined
  }
}

function claudeHookSessionBinding(input: {
  readonly agentId: string
  readonly payload: Record<string, unknown>
  readonly env: NodeJS.ProcessEnv
  readonly now: Date
}): ClaudeHookSessionBinding {
  const transcriptPath = stringValue(input.payload.transcript_path)
    ?? stringValue(input.payload.transcriptPath)
  const model = stringValue(input.env.KIRI_MODEL) ?? stringValue(input.payload.model)
  const sessionId = stringValue(input.payload.session_id)
    ?? stringValue(input.payload.sessionId)
    ?? stringValue(input.env.KIRI_CLAUDE_SESSION_ID)
  const cwd = stringValue(input.env.KIRI_PROJECT_CWD) ?? stringValue(input.payload.cwd)
  return {
    agentId: input.agentId,
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
    source: 'hook',
    hookEventName: stringValue(input.payload.hook_event_name)
      ?? stringValue(input.payload.hookEventName)
      ?? 'SessionStart',
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(model ? { model } : {}),
    writtenAtMs: input.now.getTime(),
  }
}

function parseHookPayload(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return {}
  const parsed: unknown = globalThis.JSON.parse(trimmed)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Claude hook payload must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

async function checkedRunOperation(
  runOperation: KiriOperationRunner,
  request: {
    readonly operation: string
    readonly params: Record<string, unknown>
  },
) {
  const response = await runOperation(request)
  const record = objectValue(response)
  if (!record || record.ok !== false) return response
  const error = objectValue(record.error)
  const message = stringValue(error.message) ?? `${request.operation} returned ok:false`
  const code = stringValue(error.code)
  throw new Error(code ? `${code}: ${message}` : message)
}

function isSubagentPayload(payload: Record<string, unknown>) {
  return stringValue(payload.parent_tool_use_id) !== undefined ||
    stringValue(payload.parentToolUseId) !== undefined ||
    stringValue(payload.agent_type)?.toLowerCase() === 'subagent' ||
    stringValue(payload.agentType)?.toLowerCase() === 'subagent'
}

function sessionMatchesBinding(sessionDir: string, payload: Record<string, unknown>) {
  const binding = readClaudeHookSessionBinding(sessionDir)
  const payloadSessionId = stringValue(payload.session_id) ?? stringValue(payload.sessionId)
  if (!binding?.sessionId || !payloadSessionId) return true
  return binding.sessionId === payloadSessionId
}

function toolNameMatches(payload: Record<string, unknown>, names: readonly string[]) {
  const expected = new Set(names)
  return toolNameCandidates(payload).some((name) => expected.has(name))
}

function toolNameCandidates(payload: Record<string, unknown>) {
  return [
    stringValue(payload.tool_name),
    stringValue(payload.toolName),
    stringValue(payload.matcher),
    stringValue(objectValue(payload.tool).name),
    stringValue(objectValue(payload.tool_use).name),
    stringValue(objectValue(payload.toolUse).name),
  ].filter((value): value is string => Boolean(value))
}

function claudeTodoTasks(payload: Record<string, unknown>, now: Date): AgentTask[] {
  const updatedAt = now.toISOString()
  return todoArray(payload)
    .map((todo, index): AgentTask | null => {
      const title = stringValue(todo.content)
        ?? stringValue(todo.title)
        ?? stringValue(todo.text)
      if (!title) return null
      return {
        id: stringValue(todo.id) ?? `claude-${index + 1}`,
        title,
        status: normalizeClaudeTodoStatus(todo.status),
        source: 'claude',
        updatedAt,
      }
    })
    .filter((task): task is AgentTask => task !== null)
}

function todoArray(payload: Record<string, unknown>) {
  const sources = [
    objectFromMaybeJson(payload.tool_input),
    objectFromMaybeJson(payload.toolInput),
    objectValue(payload.input),
    objectValue(objectValue(payload.tool).input),
  ]
  for (const source of sources) {
    if (Array.isArray(source.todos)) {
      return source.todos.filter((todo): todo is Record<string, unknown> =>
        Boolean(todo && typeof todo === 'object' && !Array.isArray(todo)))
    }
  }
  return []
}

function objectFromMaybeJson(value: unknown) {
  if (typeof value === 'string') {
    try {
      return objectValue(globalThis.JSON.parse(value) as unknown)
    } catch {
      return {}
    }
  }
  return objectValue(value)
}

function normalizeClaudeTodoStatus(value: unknown): AgentTask['status'] {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : ''
  switch (status) {
    case 'completed':
    case 'complete':
    case 'done':
    case 'success':
      return 'completed'
    case 'failed':
    case 'failure':
    case 'error':
    case 'cancelled':
    case 'canceled':
      return 'failed'
    case 'in_progress':
    case 'in-progress':
    case 'inprogress':
    case 'active':
    case 'running':
    case 'doing':
      return 'inProgress'
    case 'pending':
    case 'todo':
    default:
      return 'pending'
  }
}

async function maybeRenameDefaultTitle(input: {
  readonly agentId: string
  readonly payload: Record<string, unknown>
  readonly runOperation: KiriOperationRunner
}) {
  const title = titleCandidate(input.payload)
  if (!title || isDefaultTitle(title)) return
  const detail = await checkedRunOperation(input.runOperation, {
    operation: 'agent.detail',
    params: { agentId: input.agentId, limit: 1 },
  })
  const currentTitle = operationResultTitle(detail)
  if (!currentTitle || !isDefaultTitle(currentTitle)) return
  await checkedRunOperation(input.runOperation, {
    operation: 'session.rename',
    params: { agentId: input.agentId, title },
  })
}

function titleCandidate(payload: Record<string, unknown>) {
  const raw = stringValue(payload.title)
    ?? stringValue(payload.session_title)
    ?? stringValue(payload.sessionTitle)
    ?? stringValue(payload.summary)
  if (!raw) return undefined
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  return trimmed.length > 80 ? trimmed.slice(0, 80).trim() : trimmed
}

function operationResultTitle(value: unknown) {
  const response = objectValue(value)
  const result = objectValue(response.result)
  return stringValue(result.title)
}

function isDefaultTitle(value: string) {
  return /^Session(?: \d+)?$/i.test(value.trim())
    || /^Claude(?: Code)?(?: Session)?(?: \d+)?$/i.test(value.trim())
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function unreachable(value: never): never {
  throw new Error(`Unsupported Claude hook event: ${String(value)}`)
}
