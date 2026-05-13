import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { AgentTask, BoardMessage, MessageRole } from '~/lib/contracts'
import { agentTaskSchema, boardMessageSchema, messageRoleSchema } from '~/lib/contracts'

const piSessionHeaderSchema = z.object({
  type: z.literal('session'),
  id: z.string().optional(),
  cwd: z.string().optional(),
  timestamp: z.string().optional(),
})

const piMessageEntrySchema = z.object({
  type: z.literal('message'),
  id: z.string(),
  timestamp: z.string().optional(),
  message: z.object({
    role: z.string(),
    content: z.unknown(),
    stopReason: z.string().optional(),
    usage: z
      .object({
        input: z.number().int().nonnegative().optional(),
        output: z.number().int().nonnegative().optional(),
        cacheRead: z.number().int().nonnegative().optional(),
        cacheWrite: z.number().int().nonnegative().optional(),
        totalTokens: z.number().int().nonnegative().optional(),
      })
      .optional(),
  }),
})

const piBranchSummaryEntrySchema = z.object({
  type: z.literal('branch_summary'),
  id: z.string(),
  timestamp: z.string().optional(),
  summary: z.string(),
})

export type PiSessionProjection = {
  sessionId?: string
  cwd?: string
  messages: BoardMessage[]
  tasks: AgentTask[]
  preview: string
  contextUsedTokens?: number
  updatedAt?: string
}

export function projectPiSessionFile(path: string): PiSessionProjection {
  return projectPiSessionJsonl(readFileSync(path, 'utf8'))
}

export function projectPiSessionJsonl(content: string): PiSessionProjection {
  const projection: PiSessionProjection = {
    messages: [],
    tasks: [],
    preview: '',
  }
  const taskState = new Map<string, AgentTask>()
  let nextTaskId = 1

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let value: unknown
    try {
      value = JSON.parse(trimmed)
    } catch {
      continue
    }

    const header = piSessionHeaderSchema.safeParse(value)
    if (header.success) {
      projection.sessionId = header.data.id
      projection.cwd = header.data.cwd
      projection.updatedAt = header.data.timestamp
      continue
    }

    const messageEntry = piMessageEntrySchema.safeParse(value)
    if (messageEntry.success) {
      const timestamp = messageEntry.data.timestamp ?? new Date(0).toISOString()
      const taskEvents = taskEventsFromContent(messageEntry.data.message.content, timestamp, nextTaskId)
      nextTaskId += taskEvents.createdCount
      applyTaskEvents(taskState, taskEvents.events)
      const message = toBoardMessage(messageEntry.data)
      if (message) {
        projection.messages.push(message)
        projection.updatedAt = message.timestamp
        if (message.role === 'assistant') {
          projection.contextUsedTokens =
            usageContextTokens(messageEntry.data.message) ?? projection.contextUsedTokens
        }
        if (!projection.preview && message.role === 'user') {
          projection.preview = message.text
        }
      }
      continue
    }

    const branchSummary = piBranchSummaryEntrySchema.safeParse(value)
    if (branchSummary.success) {
      projection.messages.push({
        id: branchSummary.data.id,
        role: 'summary',
        text: branchSummary.data.summary,
        timestamp: branchSummary.data.timestamp ?? new Date(0).toISOString(),
      })
      projection.updatedAt = branchSummary.data.timestamp
    }
  }

  if (!projection.preview) {
    projection.preview = projection.messages[0]?.text ?? ''
  }
  projection.tasks = Array.from(taskState.values())

  return projection
}

function toBoardMessage(entry: z.infer<typeof piMessageEntrySchema>): BoardMessage | null {
  const role = normalizeRole(entry.message.role)
  if (!role) return null
  const text = contentToText(entry.message.content)
  if (!text) return null

  return boardMessageSchema.parse({
    id: entry.id,
    role,
    text,
    timestamp: entry.timestamp ?? new Date(0).toISOString(),
  })
}

function normalizeRole(role: string): MessageRole | null {
  const parsed = messageRoleSchema.safeParse(role)
  if (parsed.success && parsed.data !== 'summary' && parsed.data !== 'tool') {
    return parsed.data
  }
  if (role === 'toolResult' || role === 'bashExecution') return 'tool'
  return null
}

function usageContextTokens(message: z.infer<typeof piMessageEntrySchema>['message']) {
  if (message.stopReason === 'aborted' || message.stopReason === 'error') return undefined

  const usage = message.usage
  if (!usage) return undefined
  if (usage.totalTokens !== undefined && usage.totalTokens > 0) return usage.totalTokens

  const total =
    (usage.input ?? 0) +
    (usage.output ?? 0) +
    (usage.cacheRead ?? 0) +
    (usage.cacheWrite ?? 0)
  return total > 0 ? total : undefined
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''

  return content
    .flatMap((part) => {
      if (!part || typeof part !== 'object') return []
      if ('text' in part && typeof part.text === 'string') return [part.text]
      if ('thinking' in part && typeof part.thinking === 'string') {
        return [part.thinking]
      }
      return []
    })
    .join('\n')
    .trim()
}

type ParsedTaskEvent =
  | {
      type: 'create'
      id: string
      title: string
      status: AgentTask['status']
      updatedAt: string
    }
  | {
      type: 'update'
      id: string
      status: AgentTask['status']
      updatedAt: string
    }
  | {
      type: 'replace'
      tasks: AgentTask[]
    }

function taskEventsFromContent(
  content: unknown,
  updatedAt: string,
  nextTaskId: number,
) {
  const events: ParsedTaskEvent[] = []
  let createdCount = 0
  if (!Array.isArray(content)) return { events, createdCount }

  for (const part of content) {
    const tool = toolCallPart(part)
    if (!tool) continue
    if (tool.name === 'TaskCreate') {
      const title = stringField(tool.arguments, 'subject') ??
        stringField(tool.arguments, 'title') ??
        stringField(tool.arguments, 'description') ??
        'Task'
      const id = stringField(tool.arguments, 'taskId') ??
        stringField(tool.arguments, 'id') ??
        String(nextTaskId + createdCount)
      createdCount += 1
      events.push({
        type: 'create',
        id,
        title,
        status: normalizeTaskStatus(stringField(tool.arguments, 'status')) ?? 'pending',
        updatedAt,
      })
      continue
    }
    if (tool.name === 'TaskUpdate') {
      const id = stringField(tool.arguments, 'taskId') ?? stringField(tool.arguments, 'id')
      const status = normalizeTaskStatus(stringField(tool.arguments, 'status'))
      if (id && status) events.push({ type: 'update', id, status, updatedAt })
      continue
    }
    if (tool.name === 'TaskList') {
      const tasks = arrayField(tool.arguments, 'tasks')
        .flatMap((task, index) => {
          if (!task || typeof task !== 'object' || Array.isArray(task)) return []
          const record = task as Record<string, unknown>
          const title = stringField(record, 'subject') ??
            stringField(record, 'title') ??
            stringField(record, 'description')
          if (!title) return []
          return [agentTaskSchema.parse({
            id: stringField(record, 'taskId') ?? stringField(record, 'id') ?? String(index + 1),
            title,
            status: normalizeTaskStatus(stringField(record, 'status')) ?? 'pending',
            source: 'pi',
            updatedAt,
          })]
        })
      events.push({ type: 'replace', tasks })
    }
  }
  return { events, createdCount }
}

function applyTaskEvents(
  state: Map<string, AgentTask>,
  events: ParsedTaskEvent[],
) {
  for (const event of events) {
    if (event.type === 'replace') {
      state.clear()
      for (const task of event.tasks) state.set(task.id, task)
      continue
    }
    if (event.type === 'create') {
      state.set(event.id, agentTaskSchema.parse({
        id: event.id,
        title: event.title,
        status: event.status,
        source: 'pi',
        updatedAt: event.updatedAt,
      }))
      continue
    }
    const existing = state.get(event.id)
    if (!existing) continue
    state.set(event.id, {
      ...existing,
      status: event.status,
      updatedAt: event.updatedAt,
    })
  }
}

function toolCallPart(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.type !== 'toolCall') return null
  const name = stringField(record, 'name')
  const args = record.arguments
  if (!name || !args || typeof args !== 'object' || Array.isArray(args)) return null
  return { name, arguments: args as Record<string, unknown> }
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function arrayField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return Array.isArray(value) ? value : []
}

function normalizeTaskStatus(value: string | undefined): AgentTask['status'] | undefined {
  if (value === 'in_progress') return 'inProgress'
  if (value === 'pending' || value === 'inProgress' || value === 'completed' || value === 'failed') {
    return value
  }
  return undefined
}
