import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Effect } from 'effect'
import { z } from 'zod/v4'
import {
  runtimeKinds,
  sessionInterfaceModes,
  thinkingLevels,
  type RuntimeKind,
  type SessionInterfaceMode,
  type ThinkingLevel,
} from '~/lib/contracts'
import type { KiriControlApi } from './kiri-control'

const version = '0.1.0'

const optionalProjectIdSchema = {
  projectId: z.string().trim().min(1).optional().describe('Project id. Defaults only where the tool says it can.'),
}
const runtimeSchema = z.enum(runtimeKinds).optional()
const interfaceModeSchema = z.enum(sessionInterfaceModes).optional()
const thinkingSchema = z.enum(thinkingLevels).optional()

export async function runKiriMcpServer(control: KiriControlApi) {
  const server = createKiriMcpServer(control)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

export function createKiriMcpServer(control: KiriControlApi) {
  const server = new McpServer({
    name: 'kiri',
    version,
  })

  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)
  const context = () => run(control.getContext())
  const withContext = async <A>(result: A) => ({
    result,
    context: await context(),
  })

  server.registerTool('kiri_get_context', {
    title: 'Get Kiri context',
    description: 'Return compact current Kiri board context: selected project, selected session, projects, sessions, and scratchpad count.',
    annotations: { readOnlyHint: true },
  }, async () => toolResult(await context()))

  server.registerTool('kiri_describe_capabilities', {
    title: 'Describe Kiri capabilities',
    description: 'Describe the Kiri MCP tools and matching kiricli commands.',
    inputSchema: {
      filter: z.string().trim().optional().describe('Optional capability filter such as projects, sessions, scratchpad, models.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ filter }) => toolResult(describeCapabilities(filter)))

  server.registerTool('kiri_list_models', {
    title: 'List Kiri models',
    description: 'List configured runtime models from settings.json.',
    inputSchema: {
      runtime: runtimeSchema.describe('Optional runtime/provider filter.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ runtime }) => toolResult(await run(control.listModels(runtime))))

  server.registerTool('kiri_list_projects', {
    title: 'List Kiri projects',
    description: 'List Kiri project registry rows.',
    inputSchema: {
      includeHidden: z.boolean().optional().describe('Include hidden projects.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ includeHidden }) => toolResult(await run(control.listProjects(includeHidden ?? false))))

  server.registerTool('kiri_add_project', {
    title: 'Add Kiri project',
    description: 'Add a project registry row. This does not create a session.',
    inputSchema: {
      id: z.string().trim().min(1).optional().describe('Stable project id.'),
      name: z.string().trim().min(1).describe('Project display name.'),
      cwd: z.string().trim().min(1).describe('Absolute project directory.'),
    },
  }, async (input) => toolResult(await withContext(await run(control.addProject(input)))))

  server.registerTool('kiri_hide_project', {
    title: 'Hide Kiri project',
    description: 'Hide a project from the board without deleting project metadata or sessions.',
    inputSchema: {
      id: z.string().trim().min(1).describe('Project id.'),
    },
  }, async ({ id }) => toolResult(await withContext(await run(control.hideProject(id)))))

  server.registerTool('kiri_unhide_project', {
    title: 'Unhide Kiri project',
    description: 'Unhide a project row.',
    inputSchema: {
      id: z.string().trim().min(1).describe('Project id.'),
    },
  }, async ({ id }) => toolResult(await withContext(await run(control.unhideProject(id)))))

  server.registerTool('kiri_delete_project', {
    title: 'Delete Kiri project metadata',
    description: 'Delete Kiri project metadata. This does not delete the repo directory.',
    inputSchema: {
      id: z.string().trim().min(1).describe('Project id.'),
    },
    annotations: { destructiveHint: true },
  }, async ({ id }) => toolResult(await withContext(await run(control.deleteProject(id)))))

  server.registerTool('kiri_list_sessions', {
    title: 'List Kiri sessions',
    description: 'List Kiri sessions.',
    inputSchema: {
      projectId: z.string().trim().min(1).optional().describe('Optional project id filter.'),
      includeArchived: z.boolean().optional().describe('Include archived sessions.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ projectId, includeArchived }) =>
    toolResult(await run(control.listSessions({ projectId, includeArchived: includeArchived ?? false }))))

  server.registerTool('kiri_start_session', {
    title: 'Start Kiri session',
    description: 'Create an idle Kiri session in a project.',
    inputSchema: {
      projectId: z.string().trim().min(1).describe('Project id.'),
      runtime: runtimeSchema.describe('Runtime/provider. Defaults to Kiri runtime default.'),
      interfaceMode: interfaceModeSchema.describe('Chat tab interface. Defaults to gui; Claude sessions are always terminal.'),
      model: z.string().trim().min(1).optional().describe('Model id from settings.json.'),
      title: z.string().trim().min(1).optional().describe('Session title.'),
      thinkingLevel: thinkingSchema.describe('Thinking level. Defaults to medium.'),
    },
  }, async (input) => toolResult(await withContext(await run(control.startSession({
    ...input,
    runtime: input.runtime as RuntimeKind | undefined,
    interfaceMode: (input.interfaceMode as SessionInterfaceMode | undefined) ?? 'gui',
    thinkingLevel: (input.thinkingLevel as ThinkingLevel | undefined) ?? 'medium',
  })))))

  server.registerTool('kiri_rename_session', {
    title: 'Rename Kiri session',
    description: 'Rename a Kiri session. If agentId is omitted, renames the selected session.',
    inputSchema: {
      agentId: z.string().trim().min(1).optional().describe('Agent/session id. Defaults to selected session.'),
      title: z.string().trim().min(1).max(160).describe('New session title.'),
    },
  }, async ({ agentId, title }) => {
    const sessionId = agentId ?? await selectedSessionId(context)
    return toolResult(await withContext(await run(control.renameSession({ agentId: sessionId, title }))))
  })

  server.registerTool('kiri_delete_session', {
    title: 'Archive Kiri session',
    description: 'Archive a Kiri session.',
    inputSchema: {
      agentId: z.string().trim().min(1).describe('Agent/session id.'),
    },
    annotations: { destructiveHint: true },
  }, async ({ agentId }) => toolResult(await withContext(await run(control.deleteSession(agentId)))))

  server.registerTool('kiri_restore_session', {
    title: 'Restore Kiri session',
    description: 'Restore an archived Kiri session.',
    inputSchema: {
      agentId: z.string().trim().min(1).describe('Agent/session id.'),
    },
  }, async ({ agentId }) => toolResult(await withContext(await run(control.restoreSession({ agentId })))))

  server.registerTool('kiri_resume_session', {
    title: 'Resume Kiri session',
    description: 'Alias for restoring an archived Kiri session.',
    inputSchema: {
      agentId: z.string().trim().min(1).describe('Agent/session id.'),
    },
  }, async ({ agentId }) => toolResult(await withContext(await run(control.restoreSession({ agentId })))))

  server.registerTool('kiri_list_scratchpad', {
    title: 'List Kiri scratchpad',
    description: 'List scratchpad blocks.',
    inputSchema: optionalProjectIdSchema,
    annotations: { readOnlyHint: true },
  }, async ({ projectId }) => toolResult(await run(control.listScratchpad({ projectId }))))

  server.registerTool('kiri_add_scratchpad', {
    title: 'Add Kiri scratchpad block',
    description: 'Add a scratchpad block. If projectId is omitted, uses the selected project.',
    inputSchema: {
      projectId: z.string().trim().min(1).optional().describe('Project id. Defaults to selected project.'),
      body: z.string().trim().min(1).max(4000).describe('Scratchpad body.'),
    },
  }, async ({ projectId, body }) => {
    const contextValue = await context()
    const selectedProjectId = projectId ?? contextValue.selectedProject?.id
    if (!selectedProjectId) throw new Error('No selected project available')
    return toolResult(await withContext(await run(control.addScratchpad({
      projectId: selectedProjectId,
      body,
    }))))
  })

  server.registerTool('kiri_delete_scratchpad', {
    title: 'Delete Kiri scratchpad block',
    description: 'Delete a scratchpad block.',
    inputSchema: {
      id: z.string().trim().min(1).describe('Scratchpad block id.'),
    },
    annotations: { destructiveHint: true },
  }, async ({ id }) => toolResult(await withContext(await run(control.deleteScratchpad(id)))))

  server.registerTool('kiri_trigger_scratchpad', {
    title: 'Trigger Kiri scratchpad block',
    description: 'Start a session from a scratchpad block and send the block body as the first prompt.',
    inputSchema: {
      id: z.string().trim().min(1).describe('Scratchpad block id.'),
      projectId: z.string().trim().min(1).optional().describe('Project id. Defaults to selected project.'),
      runtime: runtimeSchema.describe('Runtime/provider. Defaults to Kiri runtime default.'),
      interfaceMode: interfaceModeSchema.describe('Chat tab interface. Defaults to gui; Claude sessions are always terminal.'),
      model: z.string().trim().min(1).optional().describe('Model id from settings.json.'),
      title: z.string().trim().min(1).optional().describe('Session title.'),
      thinkingLevel: thinkingSchema.describe('Thinking level. Defaults to medium.'),
    },
  }, async (input) => {
    const contextValue = await context()
    const projectId = input.projectId ?? contextValue.selectedProject?.id
    if (!projectId) throw new Error('No selected project available')
    return toolResult(await withContext(await run(control.triggerScratchpad({
      id: input.id,
      projectId,
      runtime: input.runtime as RuntimeKind | undefined,
      interfaceMode: (input.interfaceMode as SessionInterfaceMode | undefined) ?? 'gui',
      model: input.model,
      title: input.title,
      thinkingLevel: (input.thinkingLevel as ThinkingLevel | undefined) ?? 'medium',
    }))))
  })

  return server
}

function toolResult(value: unknown) {
  const structuredContent = Array.isArray(value) ? { items: value } : objectContent(value)
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent,
  }
}

function objectContent(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return { result: value }
}

async function selectedSessionId(context: () => Promise<{ selectedSession: { id: string } | null }>) {
  const contextValue = await context()
  const agentId = contextValue.selectedSession?.id
  if (!agentId) throw new Error('No selected session available')
  return agentId
}

function describeCapabilities(filter?: string) {
  const rows = [
    ['kiri_get_context', 'pnpm kiricli mcp', 'Read compact current board context through MCP.'],
    ['kiri_list_models', 'pnpm kiricli models list --json', 'List configured runtime models.'],
    ['kiri_list_projects', 'pnpm kiricli projects list --all --json', 'List project registry rows.'],
    ['kiri_add_project', 'pnpm kiricli projects add --name ... --cwd ... --id ...', 'Add a project row.'],
    ['kiri_hide_project', 'pnpm kiricli projects hide --id ...', 'Hide a project row.'],
    ['kiri_unhide_project', 'pnpm kiricli projects unhide --id ...', 'Unhide a project row.'],
    ['kiri_delete_project', 'pnpm kiricli projects delete --id ... --yes', 'Delete Kiri metadata for a project.'],
    ['kiri_list_sessions', 'pnpm kiricli sessions list --project ... --all --json', 'List sessions.'],
    ['kiri_start_session', 'pnpm kiricli sessions create --project ...', 'Create an idle session.'],
    ['kiri_rename_session', 'pnpm kiricli sessions rename --agent ... --title ...', 'Rename a session.'],
    ['kiri_delete_session', 'pnpm kiricli sessions delete --agent ... --yes', 'Archive a session.'],
    ['kiri_restore_session', 'pnpm kiricli sessions restore --agent ...', 'Restore an archived session.'],
    ['kiri_resume_session', 'pnpm kiricli sessions resume --agent ...', 'Alias for restore.'],
    ['kiri_list_scratchpad', 'pnpm kiricli scratchpad list --project ... --json', 'List scratchpad blocks.'],
    ['kiri_add_scratchpad', 'pnpm kiricli scratchpad add --project ... --body ...', 'Add a scratchpad block.'],
    ['kiri_delete_scratchpad', 'pnpm kiricli scratchpad delete --id ...', 'Delete a scratchpad block.'],
    ['kiri_trigger_scratchpad', 'pnpm kiricli scratchpad trigger --id ... --project ...', 'Start a session from a scratchpad block.'],
  ].map(([tool, cli, description]) => ({ tool, cli, description }))
  const needle = filter?.trim().toLowerCase()
  return {
    tools: needle
      ? rows.filter((row) => `${row.tool} ${row.cli} ${row.description}`.toLowerCase().includes(needle))
      : rows,
  }
}
