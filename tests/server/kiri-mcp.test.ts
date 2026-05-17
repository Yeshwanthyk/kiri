import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer, type Server } from 'node:http'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

const projectRoot = process.cwd()
const tempRoots: string[] = []
const clients: Client[] = []

const responseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    operation: z.string(),
    result: z.unknown(),
  }),
  z.object({
    ok: z.literal(false),
    operation: z.string(),
    error: z.object({
      code: z.string(),
      message: z.string(),
      path: z.string().optional(),
    }),
  }),
])
const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  hidden: z.boolean(),
  sessionCount: z.number(),
})
const sessionSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  runtime: z.string(),
  model: z.string(),
  status: z.string(),
  preview: z.string(),
  messageCount: z.number(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
})
const scratchpadBlockSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  triggeredAt: z.string().nullable(),
  triggeredAgentId: z.string().nullable(),
})

describe('kiri MCP server', () => {
  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()))
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes compact read/write tools and routes operations', async () => {
    const client = await startClient()

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual(['kiri_get', 'kiri_do'])

    const operations = z.object({
      read: z.array(z.string()),
      write: z.array(z.string()),
    }).parse(await callResult(client, 'kiri_get', {
      operation: 'operations.list',
    }))
    expect(operations.read).toContain('model.list')
    expect(operations.write).toContain('session.create')

    const primary = projectSummarySchema.parse(await callResult(client, 'kiri_do', {
      operation: 'project.add',
      params: {
        id: 'mcp-primary',
        name: 'MCP Primary',
        cwd: projectRoot,
      },
    }))
    expect(primary.id).toBe('mcp-primary')

    const secondary = projectSummarySchema.parse(await callResult(client, 'kiri_do', {
      operation: 'project.add',
      params: {
        id: 'mcp-secondary',
        name: 'MCP Secondary',
        cwd: projectRoot,
      },
    }))
    expect(secondary.id).toBe('mcp-secondary')
    expect(projectSummarySchema.parse(await callResult(client, 'kiri_do', {
      operation: 'project.hide',
      params: { id: secondary.id },
    })).hidden).toBe(true)
    expect(projectSummarySchema.parse(await callResult(client, 'kiri_do', {
      operation: 'project.unhide',
      params: { id: secondary.id },
    })).hidden).toBe(false)

    const session = sessionSummarySchema.parse(await callResult(client, 'kiri_do', {
      operation: 'session.create',
      params: {
        projectId: primary.id,
        runtime: 'pi',
        model: 'openai-codex/gpt-5.5',
        title: 'MCP Session',
      },
    }))
    expect(session.title).toBe('MCP Session')

    const renamed = sessionSummarySchema.parse(await callResult(client, 'kiri_do', {
      operation: 'session.rename',
      params: {
        agentId: session.id,
        title: 'MCP Session Renamed',
      },
    }))
    expect(renamed.title).toBe('MCP Session Renamed')

    const block = scratchpadBlockSchema.parse(await callResult(client, 'kiri_do', {
      operation: 'scratchpad.add',
      params: {
        projectId: primary.id,
        body: 'MCP scratchpad block',
      },
    }))
    expect(block).toMatchObject({
      projectId: primary.id,
      body: 'MCP scratchpad block',
    })

    const listedBlocks = z.array(scratchpadBlockSchema).parse(await callResult(client, 'kiri_get', {
      operation: 'scratchpad.list',
      params: {
        projectId: primary.id,
      },
    }))
    expect(listedBlocks.map((item) => item.id)).toContain(block.id)

    const archived = sessionSummarySchema.parse(await callResult(client, 'kiri_do', {
      operation: 'session.archive',
      params: { agentId: session.id },
    }))
    expect(archived.archivedAt).toEqual(expect.any(String))
    expect(sessionSummarySchema.parse(await callResult(client, 'kiri_do', {
      operation: 'session.restore',
      params: { agentId: session.id },
    })).archivedAt).toBeNull()

    const contextWrapped = z.object({
      value: scratchpadBlockSchema,
      context: z.object({
        scratchpadCount: z.number().min(0),
      }),
    }).parse(await callResult(client, 'kiri_do', {
      operation: 'scratchpad.delete',
      params: { id: block.id },
      options: { includeContext: true },
    }))
    expect(contextWrapped.value.id).toBe(block.id)

    expect(projectSummarySchema.parse(await callResult(client, 'kiri_do', {
      operation: 'project.delete',
      params: { id: secondary.id },
    })).id).toBe(secondary.id)
  }, 30_000)

  it('routes MCP workflow dispatch through the backend control endpoint when available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-mcp-proxy-'))
    tempRoots.push(root)
    const token = 'mcp-test-token'
    const requests: Array<{ authorization: string | undefined; body: unknown }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += chunk.toString()
      })
      request.on('end', () => {
        requests.push({
          authorization: request.headers.authorization,
          body: JSON.parse(body),
        })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          ok: true,
          operation: 'workflow.dispatch',
          result: {
            id: 'mcp-workflow',
            status: 'running',
            launched: 1,
            scratchpadOnly: 0,
            failed: 0,
            results: [{
              itemId: 'terminal',
              status: 'launched',
              agentId: 'mcp-session',
              terminalPaste: {
                queued: true,
                submitted: false,
                bytes: 18,
              },
              terminalSpawn: {
                agentId: 'mcp-session',
                mode: 'runtime',
              },
            }],
          },
        }))
      })
    })
    const port = await listen(server)
    try {
      const controlPath = join(root, 'backend-control.json')
      writeFileSync(controlPath, JSON.stringify({
        url: `http://127.0.0.1:${port}/`,
        token,
      }))
      const client = await startClient({
        KIRI_BACKEND_CONTROL_PATH: controlPath,
        KIRI_DISABLE_BACKEND_PROXY: '0',
      })
      const dispatch = await callResult(client, 'kiri_do', {
        operation: 'workflow.dispatch',
        params: { id: 'mcp-workflow' },
      })
      expect(dispatch).toMatchObject({
        id: 'mcp-workflow',
        launched: 1,
        results: [{
          terminalPaste: {
            queued: true,
            submitted: false,
            bytes: 18,
          },
          terminalSpawn: {
            agentId: 'mcp-session',
            mode: 'runtime',
          },
        }],
      })
      expect(requests).toEqual([{
        authorization: `Bearer ${token}`,
        body: {
          operation: 'workflow.dispatch',
          params: { id: 'mcp-workflow' },
          options: {
            compact: true,
            includeContext: false,
          },
        },
      }])
    } finally {
      await close(server)
    }
  }, 30_000)

  it('runs the packaged helper through Electron node mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-helper-'))
    tempRoots.push(root)
    const helperPath = join(root, 'kiri.app', 'Contents', 'Resources', 'bin', 'kiri-mcp')
    const electronPath = join(root, 'kiri.app', 'Contents', 'MacOS', 'kiri')
    const capturePath = join(root, 'capture.txt')

    mkdirSync(join(root, 'kiri.app', 'Contents', 'Resources', 'bin'), { recursive: true })
    mkdirSync(join(root, 'kiri.app', 'Contents', 'MacOS'), { recursive: true })
    copyFileSync(resolve(projectRoot, 'resources/bin/kiri-mcp'), helperPath)
    chmodSync(helperPath, 0o755)
    writeFileSync(electronPath, [
      '#!/bin/sh',
      'printf "%s\\n%s\\n%s\\n" "$ELECTRON_RUN_AS_NODE" "$1" "$2" > "$KIRI_HELPER_CAPTURE"',
    ].join('\n'))
    chmodSync(electronPath, 0o755)

    execFileSync(helperPath, ['--probe'], {
      env: { ...process.env, KIRI_HELPER_CAPTURE: capturePath },
    })

    expect(readFileSync(capturePath, 'utf8').trim().split('\n')).toEqual([
      '1',
      join(root, 'kiri.app', 'Contents', 'Resources', 'app.asar', 'dist', 'cli', 'kirictl.mjs'),
      'mcp',
    ])
  })
})

async function startClient(extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kiri-mcp-'))
  tempRoots.push(root)
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      KIRI_ROOT_DIR: root,
      KIRI_DB_PATH: join(root, 'kiri.sqlite'),
      KIRI_STATE_DIR: join(root, 'state'),
      KIRI_SETTINGS_PATH: resolve(projectRoot, 'settings.json'),
      ...extraEnv,
    }).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]),
  )
  const client = new Client({ name: 'kiri-mcp-test', version: '0.1.0' })
  clients.push(client)
  await client.connect(new StdioClientTransport({
    command: 'pnpm',
    args: ['exec', 'tsx', 'src/cli/kirictl.ts', 'mcp'],
    cwd: projectRoot,
    env,
    stderr: 'pipe',
  }))
  return client
}

function listen(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP address'))
        return
      }
      resolve(address.port)
    })
  })
}

function close(server: Server) {
  if (!server.listening) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function callResult(client: Client, tool: 'kiri_get' | 'kiri_do', args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args })
  if ('isError' in result && result.isError) {
    throw new Error(JSON.stringify(result.content))
  }
  const response = responseSchema.parse(result.structuredContent)
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}
