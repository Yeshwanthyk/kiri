import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

const projectRoot = process.cwd()
const tempRoots: string[] = []
const clients: Client[] = []

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

  it('exposes CLI parity tools and manages project/session/scratchpad state', async () => {
    const client = await startClient()

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'kiri_get_context',
      'kiri_list_models',
      'kiri_list_projects',
      'kiri_add_project',
      'kiri_hide_project',
      'kiri_unhide_project',
      'kiri_delete_project',
      'kiri_list_sessions',
      'kiri_start_session',
      'kiri_rename_session',
      'kiri_delete_session',
      'kiri_restore_session',
      'kiri_resume_session',
      'kiri_list_scratchpad',
      'kiri_add_scratchpad',
      'kiri_delete_scratchpad',
      'kiri_trigger_scratchpad',
      'kiri_describe_capabilities',
    ]))

    const primary = projectSummarySchema.parse(await callResult(client, 'kiri_add_project', {
      id: 'mcp-primary',
      name: 'MCP Primary',
      cwd: projectRoot,
    }))
    expect(primary.id).toBe('mcp-primary')

    const secondary = projectSummarySchema.parse(await callResult(client, 'kiri_add_project', {
      id: 'mcp-secondary',
      name: 'MCP Secondary',
      cwd: projectRoot,
    }))
    expect(secondary.id).toBe('mcp-secondary')

    expect(projectSummarySchema.parse(await callResult(client, 'kiri_hide_project', {
      id: secondary.id,
    })).hidden).toBe(true)
    expect(projectSummarySchema.parse(await callResult(client, 'kiri_unhide_project', {
      id: secondary.id,
    })).hidden).toBe(false)

    const session = sessionSummarySchema.parse(await callResult(client, 'kiri_start_session', {
      projectId: primary.id,
      runtime: 'pi',
      model: 'openai-codex/gpt-5.5',
      title: 'MCP Session',
    }))
    expect(session.title).toBe('MCP Session')

    const renamed = sessionSummarySchema.parse(await callResult(client, 'kiri_rename_session', {
      agentId: session.id,
      title: 'MCP Session Renamed',
    }))
    expect(renamed.title).toBe('MCP Session Renamed')

    const defaultRenamed = sessionSummarySchema.parse(await callResult(client, 'kiri_rename_session', {
      title: 'MCP Session Default Rename',
    }))
    expect(defaultRenamed).toMatchObject({
      id: session.id,
      title: 'MCP Session Default Rename',
    })

    const scratchpadContent = await callStructured(client, 'kiri_add_scratchpad', {
      body: 'MCP scratchpad block',
    })
    const block = scratchpadBlockSchema.parse(resultContent(scratchpadContent))
    expect(block).toMatchObject({
      projectId: primary.id,
      body: 'MCP scratchpad block',
    })
    expect(z.object({
      context: z.object({ scratchpadCount: z.number().min(1) }),
    }).parse(scratchpadContent).context.scratchpadCount).toBeGreaterThanOrEqual(1)

    const listedBlocks = z.array(scratchpadBlockSchema).parse(await callItems(client, 'kiri_list_scratchpad', {
      projectId: primary.id,
    }))
    expect(listedBlocks.map((item) => item.id)).toContain(block.id)

    expect(scratchpadBlockSchema.parse(await callResult(client, 'kiri_delete_scratchpad', {
      id: block.id,
    })).id).toBe(block.id)

    expect(sessionSummarySchema.parse(await callResult(client, 'kiri_delete_session', {
      agentId: session.id,
    })).archivedAt).toEqual(expect.any(String))
    expect(sessionSummarySchema.parse(await callResult(client, 'kiri_resume_session', {
      agentId: session.id,
    })).archivedAt).toBeNull()

    expect(projectSummarySchema.parse(await callResult(client, 'kiri_delete_project', {
      id: secondary.id,
    })).id).toBe(secondary.id)
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

async function startClient() {
  const root = mkdtempSync(join(tmpdir(), 'kiri-mcp-'))
  tempRoots.push(root)
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      KIRI_ROOT_DIR: root,
      KIRI_DB_PATH: join(root, 'kiri.sqlite'),
      KIRI_STATE_DIR: join(root, 'state'),
      KIRI_SETTINGS_PATH: resolve(projectRoot, 'settings.json'),
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

async function callResult(client: Client, name: string, args: Record<string, unknown>) {
  const content = await callStructured(client, name, args)
  return resultContent(content)
}

async function callItems(client: Client, name: string, args: Record<string, unknown>) {
  const content = await callStructured(client, name, args)
  return z.object({ items: z.array(z.unknown()) }).parse(content).items
}

async function callStructured(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  if ('isError' in result && result.isError) {
    throw new Error(JSON.stringify(result.content))
  }
  return result.structuredContent
}

function resultContent(content: unknown) {
  return z.object({ result: z.unknown() }).parse(content).result
}
