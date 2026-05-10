import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { BoardMessage, MessageRole } from '~/lib/contracts'
import { boardMessageSchema, messageRoleSchema } from '~/lib/contracts'

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
  preview: string
  updatedAt?: string
}

export function projectPiSessionFile(path: string): PiSessionProjection {
  return projectPiSessionJsonl(readFileSync(path, 'utf8'))
}

export function projectPiSessionJsonl(content: string): PiSessionProjection {
  const projection: PiSessionProjection = {
    messages: [],
    preview: '',
  }

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
      const message = toBoardMessage(messageEntry.data)
      if (message) {
        projection.messages.push(message)
        projection.updatedAt = message.timestamp
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

  return projection
}

function toBoardMessage(entry: z.infer<typeof piMessageEntrySchema>): BoardMessage | null {
  const role = normalizeRole(entry.message.role)
  if (!role) return null

  return boardMessageSchema.parse({
    id: entry.id,
    role,
    text: contentToText(entry.message.content),
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

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      if ('text' in part && typeof part.text === 'string') return part.text
      if ('thinking' in part && typeof part.thinking === 'string') {
        return part.thinking
      }
      if ('name' in part && typeof part.name === 'string') {
        return `tool call: ${part.name}`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}
