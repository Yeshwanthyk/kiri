import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AgentTask,
  BoardMessage,
  MessageRole,
  TimelineEventTone,
} from '~/lib/contracts'
import {
  agentTaskSchema,
  messageRoleSchema,
} from '~/lib/contracts'
import { appendAgentEvent } from './agent-events'
import { deriveSessionTitleFrom } from './session-title'
import type { PiSessionProjection } from '../pi-jsonl'
import type { PiRpcEvent, PiRpcMessage } from '../pi-rpc'
import { isAgentArchived, upsertAgentContextUsage } from './runtime-state'
import {
  eventId,
  normalizeUnixTimestamp,
  piEventToTimelineEvent,
} from './timeline-format'
import { withTransaction } from './transaction'

export function appendUserMessageRow(
  database: DatabaseSync,
  input: { readonly agentId: string; readonly text: string },
) {
  const text = input.text.trim()
  if (!text) throw new Error('Message text is required')

  const thread = database
    .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
    .get(input.agentId) as { id: string } | undefined
  if (!thread) throw new Error(`No active thread for agent: ${input.agentId}`)

  const timestamp = new Date().toISOString()
  const hash = createHash('sha256')
    .update(`${input.agentId}\n${timestamp}\n${text}`)
    .digest('hex')
    .slice(0, 16)
  const id = `user-${input.agentId}-${hash}`
  withTransaction(database, () => {
    database
      .prepare(
        `
          INSERT INTO messages (id, thread_id, role, text, timestamp)
          VALUES (?, ?, 'user', ?, ?)
        `,
      )
      .run(id, thread.id, text, timestamp)
    appendAgentEvent(database, {
      agentId: input.agentId,
      type: 'agent.message.created',
      payload: {
        messageId: id,
        role: 'user',
        text,
        format: 'markdown',
        final: true,
      },
      timestamp,
    })
    updateThreadSummary(database, thread.id, text, timestamp)
    maybeAutoTitleSession(database, {
      agentId: input.agentId,
      preview: text,
      tasks: [],
    })
  })
}

export function recordRuntimeMessageRow(
  database: DatabaseSync,
  input: {
    readonly agentId: string
    readonly id: string
    readonly role: BoardMessage['role']
    readonly text: string
    readonly timestamp?: string
  },
) {
  const text = input.text.trim()
  if (!text) return
  if (isAgentArchived(database, input.agentId)) return

  const threadId = ensureThreadForAgent(database, input.agentId, undefined)
  const timestamp = input.timestamp ?? new Date().toISOString()
  const existing = readMessage(database, input.id)
  const shouldAutoTitle = input.role === 'assistant' &&
    existing === undefined &&
    !hasAssistantMessage(database, threadId)
  withTransaction(database, () => {
    database
      .prepare(
        `
          INSERT INTO messages (id, thread_id, role, text, timestamp)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            role = excluded.role,
            text = excluded.text,
            timestamp = excluded.timestamp
        `,
      )
      .run(input.id, threadId, input.role, text, timestamp)
    recordMessageEvent(database, input.agentId, {
      id: input.id,
      role: input.role,
      text,
      timestamp,
      existing,
    })
    updateThreadSummary(database, threadId, input.role === 'assistant' ? text : null, timestamp)
    if (input.role === 'user' && existing === undefined) {
      maybeAutoTitleSession(database, {
        agentId: input.agentId,
        preview: text,
        tasks: [],
      })
    } else if (shouldAutoTitle) {
      maybeAutoTitleSession(database, {
        agentId: input.agentId,
        preview: text,
        tasks: [],
      })
    }
  })
}

export function recordRuntimeMessages(
  database: DatabaseSync,
  input: {
    readonly agentId: string
    readonly messages: BoardMessage[]
    readonly sessionFile?: string
  },
) {
  withTransaction(database, () => {
    recordRuntimeMessagesInTransaction(database, input)
  })
}

export function recordRuntimeMessagesInTransaction(
  database: DatabaseSync,
  input: {
    readonly agentId: string
    readonly messages: BoardMessage[]
    readonly sessionFile?: string
  },
) {
  if (isAgentArchived(database, input.agentId)) return
  if (input.messages.length === 0) {
    if (!input.sessionFile) return
    database
      .prepare('UPDATE agent_slots SET session_file = ? WHERE id = ?')
      .run(input.sessionFile, input.agentId)
    return
  }
  const threadId = ensureThreadForAgent(database, input.agentId, {
    preview: input.messages.at(-1)?.text ?? '',
    messages: input.messages,
    updatedAt: input.messages.at(-1)?.timestamp,
  })
  const hadAssistantMessage = hasAssistantMessage(database, threadId)
  const insertMessage = database.prepare(`
    INSERT INTO messages (id, thread_id, role, text, timestamp)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      role = excluded.role,
      text = excluded.text,
      timestamp = excluded.timestamp
  `)
  let firstAssistantPreview: string | undefined
  let latestNewUserPrompt: string | undefined
  for (const message of input.messages) {
    const text = message.text.trim()
    if (!text) continue
    const existing = readMessage(database, message.id)
    insertMessage.run(message.id, threadId, message.role, text, message.timestamp)
    recordMessageEvent(database, input.agentId, {
      id: message.id,
      role: message.role,
      text,
      timestamp: message.timestamp,
      existing,
    })
    if (!hadAssistantMessage && firstAssistantPreview === undefined && message.role === 'assistant') {
      firstAssistantPreview = text
    }
    if (existing === undefined && message.role === 'user') latestNewUserPrompt = text
  }
  updateThreadSummary(
    database,
    threadId,
    lastMessageText(input.messages, 'assistant') ?? input.messages.at(-1)?.text ?? null,
    input.messages.at(-1)?.timestamp,
  )
  if (input.sessionFile) {
    database
      .prepare('UPDATE agent_slots SET session_file = ? WHERE id = ?')
      .run(input.sessionFile, input.agentId)
  }
  if (latestNewUserPrompt) {
    maybeAutoTitleSession(database, {
      agentId: input.agentId,
      preview: latestNewUserPrompt,
      tasks: [],
    })
  } else if (firstAssistantPreview) {
    maybeAutoTitleSession(database, {
      agentId: input.agentId,
      preview: firstAssistantPreview,
      tasks: [],
    })
  }
}

export function recordRuntimeTimelineEventRow(
  database: DatabaseSync,
  input: {
    readonly agentId: string
    readonly kind: string
    readonly tone: TimelineEventTone
    readonly label: string
    readonly detail?: string | null
    readonly payload?: unknown
    readonly timestamp?: string
  },
) {
  if (isAgentArchived(database, input.agentId)) return
  const threadId = ensureThreadForAgent(database, input.agentId, undefined)
  const timestamp = input.timestamp ?? new Date().toISOString()
  const payload = {
    ...(input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
      ? input.payload as Record<string, unknown>
      : {}),
    type: input.kind,
    label: input.label,
    detail: input.detail ?? null,
    timestamp,
  } as Record<string, unknown> & { type: string }
  database
    .prepare(
      `
        INSERT OR IGNORE INTO timeline_events (
          id, thread_id, kind, tone, label, detail, timestamp, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      eventId(input.agentId, payload),
      threadId,
      input.kind,
      input.tone,
      input.label,
      input.detail ?? null,
      timestamp,
      JSON.stringify(payload),
    )
}

export function replaceAgentTasksRows(
  database: DatabaseSync,
  input: {
    readonly agentId: string
    readonly source: AgentTask['source']
    readonly tasks: AgentTask[]
    readonly updatedAt?: string
  },
) {
  if (isAgentArchived(database, input.agentId)) return
  const threadId = ensureThreadForAgent(database, input.agentId, undefined)
  const updatedAt = input.updatedAt ?? new Date().toISOString()
  withTransaction(database, () => {
    replaceAgentTasksForThread(database, {
      threadId,
      source: input.source,
      tasks: input.tasks,
      updatedAt,
    })
    maybeAutoTitleSession(database, {
      agentId: input.agentId,
      preview: currentThreadPreview(database, threadId),
      tasks: input.tasks,
    })
    database
      .prepare('UPDATE threads SET updated_at = ? WHERE id = ?')
      .run(updatedAt, threadId)
  })
}

export function recordPiProjectionMessages(
  database: DatabaseSync,
  input: {
    readonly agentId: string
    readonly promptText: string
    readonly sessionFile: string
    readonly projection: PiSessionProjection
  },
) {
  if (isAgentArchived(database, input.agentId)) return
  const thread = requireActiveThread(database, input.agentId)
  const hadAssistantMessage = hasAssistantMessage(database, thread.id)
  withTransaction(database, () => {
    database
      .prepare('UPDATE agent_slots SET session_file = ? WHERE id = ?')
      .run(input.sessionFile, input.agentId)
    database
      .prepare(
        `
          DELETE FROM messages
          WHERE thread_id = ?
            AND role = 'user'
            AND text = ?
            AND id LIKE ?
        `,
      )
      .run(thread.id, input.promptText.trim(), `user-${input.agentId}-%`)
    hydrateProjectionMessages(database, input.agentId, input.projection)
    replaceAgentTasksForThread(database, {
      threadId: thread.id,
      source: 'pi',
      tasks: input.projection.tasks,
      updatedAt: input.projection.updatedAt ?? new Date().toISOString(),
    })
    if (!hadAssistantMessage) {
      maybeAutoTitleSession(database, {
        agentId: input.agentId,
        preview: input.projection.preview,
        tasks: input.projection.tasks,
      })
    }
    upsertAgentContextUsage(database, {
      agentId: input.agentId,
      usedTokens: input.projection.contextUsedTokens,
      sessionFile: input.sessionFile,
      updatedAt: input.projection.updatedAt,
    })
  })
}

export function recordPiLiveMessages(
  database: DatabaseSync,
  input: {
    readonly agentId: string
    readonly promptText: string
    readonly messages: PiRpcMessage[]
    readonly turnStartedAt: number
    readonly turnCompletedAt: number
    readonly sessionFile?: string
  },
) {
  if (isAgentArchived(database, input.agentId)) return
  const thread = requireActiveThread(database, input.agentId)
  const hadAssistantMessage = hasAssistantMessage(database, thread.id)
  const insertMessage = database.prepare(`
    INSERT OR IGNORE INTO messages (id, thread_id, role, text, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `)
  const currentTurn = currentPiTurn(input.messages, input.promptText)
  const rows = currentTurn
    .flatMap((message, index) => {
      const role = normalizePiRole(message.role)
      const text = piMessageToText(message)
      if (!role || !text) return []
      if (role === 'user' && text === input.promptText.trim()) return []
      const timestamp = new Date(
        piMessageTimestamp({
          message,
          index,
          role,
          text,
          promptText: input.promptText,
          turnStartedAt: input.turnStartedAt,
          turnCompletedAt: input.turnCompletedAt,
        }),
      ).toISOString()
      return [{
        id: liveMessageId(input.agentId, role, text, timestamp),
        role,
        text,
        timestamp,
      }]
    })
  const preview = lastMessageText(rows, 'assistant') ?? rows[rows.length - 1]?.text

  withTransaction(database, () => {
    for (const row of rows) {
      const result = insertMessage.run(row.id, thread.id, row.role, row.text, row.timestamp)
      if (result.changes > 0) {
        appendAgentEvent(database, {
          agentId: input.agentId,
          type: 'agent.message.created',
          payload: {
            messageId: row.id,
            role: row.role,
            text: row.text,
            format: 'markdown',
            final: true,
          },
          timestamp: row.timestamp,
        })
      }
    }
    const count = database
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?')
      .get(thread.id) as { count: number }
    database
      .prepare('UPDATE threads SET preview = COALESCE(?, preview), message_count = ?, updated_at = ? WHERE id = ?')
      .run(preview ?? null, count.count, new Date().toISOString(), thread.id)
    if (input.sessionFile) {
      database
        .prepare('UPDATE agent_slots SET session_file = ? WHERE id = ?')
        .run(input.sessionFile, input.agentId)
    }
    if (!hadAssistantMessage && preview) {
      maybeAutoTitleSession(database, {
        agentId: input.agentId,
        preview,
        tasks: [],
      })
    }
  })
}

export function recordPiTimelineEventRow(
  database: DatabaseSync,
  input: {
    readonly agentId: string
    readonly event: PiRpcEvent
  },
) {
  if (isAgentArchived(database, input.agentId)) return
  const thread = requireActiveThread(database, input.agentId)
  const event = piEventToTimelineEvent(input.agentId, input.event)
  if (!event) return

  database
    .prepare(
      `
        INSERT OR IGNORE INTO timeline_events (
          id, thread_id, kind, tone, label, detail, timestamp, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      event.id,
      thread.id,
      event.kind,
      event.tone,
      event.label,
      event.detail,
      event.timestamp,
      JSON.stringify(input.event),
    )
}

export function recordAgentInfoEventRow(
  database: DatabaseSync,
  input: {
    readonly agentId: string
    readonly kind: string
    readonly label: string
    readonly detail?: string | null
    readonly timestamp?: string
  },
) {
  if (isAgentArchived(database, input.agentId)) return
  const timestamp = input.timestamp ?? new Date().toISOString()
  const thread = requireActiveThread(database, input.agentId)
  const payload = {
    type: input.kind,
    label: input.label,
    detail: input.detail ?? null,
    timestamp,
  }
  database
    .prepare(
      `
        INSERT OR IGNORE INTO timeline_events (
          id, thread_id, kind, tone, label, detail, timestamp, payload_json
        )
        VALUES (?, ?, ?, 'info', ?, ?, ?, ?)
      `,
    )
    .run(
      eventId(input.agentId, payload),
      thread.id,
      input.kind,
      input.label,
      input.detail ?? null,
      timestamp,
      JSON.stringify(payload),
    )
}

export function ensureThreadForAgent(
  database: DatabaseSync,
  agentId: string,
  projection:
    | {
        readonly preview: string
        readonly messages: ReadonlyArray<{ readonly timestamp: string }>
        readonly updatedAt?: string
      }
    | undefined,
) {
  const existing = database
    .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
    .get(agentId) as { id: string } | undefined
  if (existing) return existing.id

  const updatedAt = projection?.updatedAt ??
    projection?.messages.at(-1)?.timestamp ??
    new Date().toISOString()
  database
    .prepare(
      `
        INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
        VALUES (?, ?, 1, ?, 0, ?)
      `,
    )
    .run(`thread-${agentId}`, agentId, projection?.preview || 'Ready.', updatedAt)
  return `thread-${agentId}`
}

export function hydrateProjectionMessages(
  database: DatabaseSync,
  agentId: string,
  projection: Pick<PiSessionProjection, 'preview' | 'updatedAt' | 'messages'>,
) {
  if (isAgentArchived(database, agentId)) return
  const threadId = ensureThreadForAgent(database, agentId, projection)
  const hadAssistantMessage = hasAssistantMessage(database, threadId)
  const projectedPrefix = `pi-jsonl-${agentId}-`
  const existingMessages = existingThreadMessages(database, threadId, agentId)
  const existingById = new Map(existingMessages.map((message) => [message.id, message]))
  const liveMessageCounts = new Map<string, number>()
  for (const message of existingMessages) {
    if (message.id.startsWith(projectedPrefix)) continue
    const key = messageContentKey(message)
    liveMessageCounts.set(key, (liveMessageCounts.get(key) ?? 0) + 1)
  }
  database
    .prepare('DELETE FROM messages WHERE thread_id = ? AND id NOT LIKE ?')
    .run(threadId, `user-${agentId}-%`)
  const insertMessage = database.prepare(`
    INSERT INTO messages (id, thread_id, role, text, timestamp)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
  for (const message of projection.messages) {
    if (!message.text.trim()) continue
    const id = jsonlMessageId(agentId, message.id)
    const result = insertMessage.run(
      id,
      threadId,
      message.role,
      message.text,
      message.timestamp,
    )
    if (result.changes > 0) {
      recordMessageEvent(database, agentId, {
        id,
        role: message.role,
        text: message.text,
        timestamp: message.timestamp,
        existing: existingById.get(id) ?? consumeLiveProjectionMatch(liveMessageCounts, message),
      })
    }
  }
  updateThreadSummary(
    database,
    threadId,
    projection.preview || projection.messages.at(-1)?.text || null,
    projection.updatedAt ?? projection.messages.at(-1)?.timestamp,
  )
  if (!hadAssistantMessage) {
    maybeAutoTitleSession(database, {
      agentId,
      preview: projection.preview || projection.messages.at(-1)?.text,
      tasks: [],
    })
  }
}

function maybeAutoTitleSession(
  database: DatabaseSync,
  input: {
    readonly agentId: string
    readonly preview: string | undefined
    readonly tasks: readonly AgentTask[]
  },
) {
  const row = database
    .prepare('SELECT title, title_set_manually AS titleSetManually FROM agent_slots WHERE id = ?')
    .get(input.agentId) as { title: string; titleSetManually: number } | undefined
  if (!row || row.titleSetManually === 1) return
  const title = deriveSessionTitleFrom(input.preview, input.tasks, row.title)
  if (!title || title === row.title) return
  database.prepare('UPDATE agent_slots SET title = ? WHERE id = ?').run(title, input.agentId)
}

function hasAssistantMessage(database: DatabaseSync, threadId: string) {
  return Boolean(database
    .prepare("SELECT 1 AS present FROM messages WHERE thread_id = ? AND role = 'assistant' LIMIT 1")
    .get(threadId))
}

function currentThreadPreview(database: DatabaseSync, threadId: string) {
  return (database
    .prepare('SELECT preview FROM threads WHERE id = ?')
    .get(threadId) as { preview: string } | undefined)?.preview
}

function readMessage(database: DatabaseSync, id: string) {
  return database
    .prepare('SELECT role, text FROM messages WHERE id = ?')
    .get(id) as { role: MessageRole; text: string } | undefined
}

function existingThreadMessages(
  database: DatabaseSync,
  threadId: string,
  agentId: string,
) {
  return database
    .prepare('SELECT id, role, text FROM messages WHERE thread_id = ? AND id NOT LIKE ?')
    .all(threadId, `user-${agentId}-%`) as Array<{ id: string; role: MessageRole; text: string }>
}

function consumeLiveProjectionMatch(
  counts: Map<string, number>,
  message: { readonly role: MessageRole; readonly text: string },
) {
  const key = messageContentKey(message)
  const count = counts.get(key) ?? 0
  if (count <= 0) return undefined
  if (count === 1) {
    counts.delete(key)
  } else {
    counts.set(key, count - 1)
  }
  return {
    role: message.role,
    text: message.text,
  }
}

function messageContentKey(message: { readonly role: MessageRole; readonly text: string }) {
  return `${message.role}\0${message.text}`
}

function recordMessageEvent(
  database: DatabaseSync,
  agentId: string,
  input: {
    readonly id: string
    readonly role: MessageRole
    readonly text: string
    readonly timestamp: string
    readonly existing: { readonly role: MessageRole; readonly text: string } | undefined
  },
) {
  const changed = input.existing && (
    input.existing.role !== input.role ||
    input.existing.text !== input.text
  )
  if (input.existing && !changed) return
  appendAgentEvent(database, {
    agentId,
    type: input.existing ? 'agent.message.updated' : 'agent.message.created',
    payload: {
      messageId: input.id,
      role: input.role,
      text: input.text,
      format: 'markdown',
      final: true,
    },
    timestamp: input.timestamp,
  })
}

export function replaceAgentTasksForThread(
  database: DatabaseSync,
  input: {
    readonly threadId: string
    readonly source: AgentTask['source']
    readonly tasks: AgentTask[]
    readonly updatedAt: string
  },
) {
  const parsedTasks = input.tasks.map((task) => agentTaskSchema.parse(task))
  database
    .prepare('DELETE FROM agent_tasks WHERE thread_id = ? AND source = ?')
    .run(input.threadId, input.source)
  const insertTask = database.prepare(`
    INSERT OR REPLACE INTO agent_tasks (
      thread_id, source, task_id, position, title, status, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  parsedTasks.forEach((task, index) => {
    insertTask.run(
      input.threadId,
      input.source,
      task.id,
      index,
      task.title,
      task.status,
      task.updatedAt || input.updatedAt,
    )
  })
}

function requireActiveThread(database: DatabaseSync, agentId: string) {
  const thread = database
    .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
    .get(agentId) as { id: string } | undefined
  if (!thread) throw new Error(`No active thread for agent: ${agentId}`)
  return thread
}

function updateThreadSummary(
  database: DatabaseSync,
  threadId: string,
  preview: string | null | undefined,
  updatedAt: string | undefined,
) {
  const count = database
    .prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?')
    .get(threadId) as { count: number }
  database
    .prepare(
      'UPDATE threads SET preview = COALESCE(?, preview), message_count = ?, updated_at = COALESCE(?, updated_at) WHERE id = ?',
    )
    .run(preview ?? null, count.count, updatedAt ?? null, threadId)
}

function jsonlMessageId(agentId: string, messageId: string) {
  return `pi-jsonl-${agentId}-${messageId}`
}

function liveMessageId(
  agentId: string,
  role: MessageRole,
  text: string,
  timestamp: string,
) {
  const hash = createHash('sha256')
    .update(`${agentId}\n${role}\n${timestamp}\n${text}`)
    .digest('hex')
    .slice(0, 16)
  return `pi-live-${agentId}-${hash}`
}

function piMessageTimestamp(input: {
  readonly message: PiRpcMessage
  readonly index: number
  readonly role: MessageRole
  readonly text: string
  readonly promptText: string
  readonly turnStartedAt: number
  readonly turnCompletedAt: number
}) {
  if (input.message.timestamp !== undefined) {
    return normalizeUnixTimestamp(input.message.timestamp)
  }

  if (input.role === 'user' && input.text === input.promptText.trim()) {
    return input.turnStartedAt
  }

  if (input.role === 'assistant') {
    return input.turnCompletedAt + input.index
  }

  return input.turnStartedAt + input.index
}

function normalizePiRole(role: string): MessageRole | null {
  const parsed = messageRoleSchema.safeParse(role)
  if (parsed.success && parsed.data !== 'summary' && parsed.data !== 'tool') {
    return parsed.data
  }
  if (role === 'toolResult' || role === 'bashExecution') return 'tool'
  return null
}

function currentPiTurn(messages: PiRpcMessage[], promptText: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && piMessageToText(message) === promptText.trim()) {
      return messages.slice(index)
    }
  }
  return messages
}

function lastMessageText(
  rows: ReadonlyArray<{ readonly role: MessageRole; readonly text: string }>,
  role: MessageRole,
) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.role === role) return rows[index]?.text
  }
  return undefined
}

function piMessageToText(message: PiRpcMessage) {
  if (typeof message.content === 'string') return message.content.trim()
  if (!Array.isArray(message.content)) return ''
  return (message.content as readonly unknown[])
    .flatMap(piContentPartText)
    .join('\n')
    .trim()
}

function piContentPartText(part: unknown) {
  if (!part || typeof part !== 'object') return []
  const record = part as Record<string, unknown>
  if (typeof record.text === 'string') return [record.text]
  if (typeof record.thinking === 'string') return [record.thinking]
  return []
}
