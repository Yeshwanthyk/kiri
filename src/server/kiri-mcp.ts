import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod/v4'
import {
  kiriReadOperations,
  kiriWriteOperations,
} from '~/lib/contracts'
import { kiriVersion } from '~/lib/version'
import type { KiriControlApi } from './kiri-control'
import { readOperationRequest, runKiriOperation } from './kiri-router'

const version = kiriVersion
type OperationRunner = (request: unknown) => Promise<unknown>

const paramsSchema = z.record(z.string(), z.unknown()).optional()
const optionsSchema = z.object({
  fields: z.array(z.string().trim().min(1)).optional(),
  includeContext: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
}).optional()
const outputSchema = {
  ok: z.boolean(),
  operation: z.enum([...kiriReadOperations, ...kiriWriteOperations]),
  result: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    path: z.string().optional(),
  }).optional(),
}

export async function runKiriMcpServer(control: KiriControlApi, runOperation?: OperationRunner) {
  const server = createKiriMcpServer(control, runOperation)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

function createKiriMcpServer(control: KiriControlApi, runOperation: OperationRunner = (request) => runKiriOperation(control, request)) {
  const server = new McpServer({
    name: 'kiri',
    version,
  })

  server.registerTool('kiri_get', {
    title: 'Kiri read operation',
    description: 'Run a read-only Kiri operation. Use operation operations.list to discover supported operations.',
    inputSchema: {
      operation: z.enum(kiriReadOperations).describe('Read operation name.'),
      params: paramsSchema.describe('Operation parameters.'),
      options: optionsSchema.describe('Output options.'),
    },
    outputSchema,
    annotations: { readOnlyHint: true },
  }, async (input) => {
    const request = readOperationRequest(input)
    return toolResult(await runOperation(request))
  })

  server.registerTool('kiri_do', {
    title: 'Kiri mutation operation',
    description: 'Run a mutating Kiri operation.',
    inputSchema: {
      operation: z.enum(kiriWriteOperations).describe('Mutation operation name.'),
      params: paramsSchema.describe('Operation parameters.'),
      options: optionsSchema.describe('Output options.'),
    },
    outputSchema,
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async (input) => {
    const request = readOperationRequest(input)
    return toolResult(await runOperation(request))
  })

  return server
}

function toolResult(value: unknown) {
  const isError = isOperationError(value)
  return {
    content: [
      {
        type: 'text' as const,
        text: toolText(value),
      },
    ],
    structuredContent: objectContent(value),
    ...(isError ? { isError } : {}),
  }
}

function isOperationError(value: unknown) {
  return !!value && typeof value === 'object' && 'ok' in value && value.ok === false
}

function toolText(value: unknown) {
  if (!value || typeof value !== 'object') return String(value)
  const response = value as { ok?: unknown; operation?: unknown; error?: { message?: unknown } }
  if (response.ok === true) return `ok ${String(response.operation ?? '')}`.trim()
  if (response.ok === false) return `error ${String(response.operation ?? '')}: ${String(response.error?.message ?? 'failed')}`.trim()
  return 'ok'
}

function objectContent(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return { result: value }
}
