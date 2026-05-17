import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod/v4'
import {
  kiriReadOperations,
  kiriWriteOperations,
} from '~/lib/contracts'
import type { KiriControlApi } from './kiri-control'
import { readOperationRequest, runKiriOperation } from './kiri-router'

const version = '0.1.0'

const paramsSchema = z.record(z.string(), z.unknown()).optional()
const optionsSchema = z.object({
  compact: z.boolean().optional(),
  fields: z.array(z.string().trim().min(1)).optional(),
  includeContext: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
}).optional()

export async function runKiriMcpServer(control: KiriControlApi) {
  const server = createKiriMcpServer(control)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

function createKiriMcpServer(control: KiriControlApi) {
  const server = new McpServer({
    name: 'kiri',
    version,
  })

  server.registerTool('kiri_get', {
    title: 'Kiri read operation',
    description: 'Run a compact read-only Kiri operation. Use operation operations.list to discover supported operations.',
    inputSchema: {
      operation: z.enum(kiriReadOperations).describe('Read operation name.'),
      params: paramsSchema.describe('Operation parameters.'),
      options: optionsSchema.describe('Output options; compact defaults to true.'),
    },
    annotations: { readOnlyHint: true },
  }, async (input) => {
    const request = readOperationRequest(input)
    return toolResult(await runKiriOperation(control, request))
  })

  server.registerTool('kiri_do', {
    title: 'Kiri mutation operation',
    description: 'Run a compact mutating Kiri operation.',
    inputSchema: {
      operation: z.enum(kiriWriteOperations).describe('Mutation operation name.'),
      params: paramsSchema.describe('Operation parameters.'),
      options: optionsSchema.describe('Output options; compact defaults to true.'),
    },
  }, async (input) => {
    const request = readOperationRequest(input)
    return toolResult(await runKiriOperation(control, request))
  })

  return server
}

function toolResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: toolText(value),
      },
    ],
    structuredContent: objectContent(value),
  }
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
