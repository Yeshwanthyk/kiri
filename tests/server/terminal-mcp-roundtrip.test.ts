import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeKiriControl, type KiriControlDependencies } from '~/server/kiri-control'
import { runKiriOperation } from '~/server/kiri-router'
import {
  startKiritermDaemon,
  type KiritermDaemonHandle,
} from '~/server/kiriterm-daemon'

// End-to-end agent parity through the MCP operation surface: a control plane
// built like kirictl's drives a REAL shell session owned by a REAL kiriterm
// daemon — typing, pressing keys, waiting on output, and reading the screen,
// exactly the way a human at the keyboard would.

const agentId = 'agent-rt'
const projectId = 'proj-rt'
const shellKey = `${projectId}:shell`

let stateDir = ''
let daemon: KiritermDaemonHandle | null = null
let socket: WebSocket | null = null

function launchConfig() {
  return {
    id: agentId,
    projectId,
    runtime: 'codex' as const,
    sessionDir: stateDir,
    sessionFile: null,
    model: '',
    cwd: stateDir,
    runtimeStateJson: null,
  }
}

function notUsed(name: string): never {
  throw new Error(`${name} should not be called by terminal operations`)
}

function dependencies(handle: KiritermDaemonHandle): KiriControlDependencies {
  return {
    getWorkspaceSnapshot: () => notUsed('getWorkspaceSnapshot'),
    getSettings: () => notUsed('getSettings'),
    listProjectSummaries: () => notUsed('listProjectSummaries'),
    addProjectSummary: () => notUsed('addProjectSummary'),
    hideProjectSummary: () => notUsed('hideProjectSummary'),
    unhideProjectSummary: () => notUsed('unhideProjectSummary'),
    deleteProjectSummary: () => notUsed('deleteProjectSummary'),
    listSessionSummaries: () => notUsed('listSessionSummaries'),
    getAgentDetail: () => notUsed('getAgentDetail'),
    listAgentEvents: () => notUsed('listAgentEvents'),
    startSessionSummary: () => notUsed('startSessionSummary'),
    renameSessionSummary: () => notUsed('renameSessionSummary'),
    deleteSessionSummary: () => notUsed('deleteSessionSummary'),
    restoreSessionSummary: () => notUsed('restoreSessionSummary'),
    promptAgent: () => notUsed('promptAgent'),
    steerAgent: () => notUsed('steerAgent'),
    queueAgentTerminalInput: () => undefined,
    pasteAgentRuntimeTerminal: (input) =>
      Promise.resolve({ agentId: input.agentId, mode: 'runtime' as const }),
    getAgentLaunchConfig: () => launchConfig(),
    callerAgentId: () => null,
    terminalControlRequest: async (route, body) => {
      const response = await fetch(
        `http://${handle.info.host}:${handle.info.port}/api/${route}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            authorization: `Bearer ${handle.info.token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      )
      const payload: unknown = await response.json()
      if (!response.ok) throw new Error(JSON.stringify(payload))
      return payload
    },
    listScratchpadBlocks: () => notUsed('listScratchpadBlocks'),
    searchKnowledgeEntries: () => notUsed('searchKnowledgeEntries'),
    addKnowledgeEntry: () => notUsed('addKnowledgeEntry'),
    markKnowledgeEntrySeen: () => notUsed('markKnowledgeEntrySeen'),
    addScratchpadBlockSummary: () => notUsed('addScratchpadBlockSummary'),
    deleteScratchpadBlockSummary: () => notUsed('deleteScratchpadBlockSummary'),
    triggerScratchpadSession: () => notUsed('triggerScratchpadSession'),
    listWorkflowRuns: () => notUsed('listWorkflowRuns'),
    getWorkflowRun: () => notUsed('getWorkflowRun'),
    validateWorkflow: () => notUsed('validateWorkflow'),
    createWorkflowRun: () => notUsed('createWorkflowRun'),
    dispatchWorkflowRun: () => notUsed('dispatchWorkflowRun'),
    retriggerWorkflowItem: () => notUsed('retriggerWorkflowItem'),
    trackWorkflowItem: () => notUsed('trackWorkflowItem'),
    untrackWorkflowItem: () => notUsed('untrackWorkflowItem'),
    archiveWorkflowRun: () => notUsed('archiveWorkflowRun'),
    restoreWorkflowRun: () => notUsed('restoreWorkflowRun'),
  }
}

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'kiriterm-mcp-'))
  daemon = await startKiritermDaemon({ stateDir, version: 'test' })

  // Register the agent and open a shell session the way the kiri UI would.
  const upsert = await fetch(
    `http://${daemon.info.host}:${daemon.info.port}/api/agents/upsert`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${daemon.info.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ config: launchConfig() }),
    },
  )
  expect(upsert.ok).toBe(true)

  const url = `ws://${daemon.info.host}:${daemon.info.port}${daemon.info.path}` +
    `?agentId=${agentId}&mode=shell&cols=100&rows=28&token=${daemon.info.token}`
  socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket?.once('open', () => resolve())
    socket?.once('error', reject)
  })
}, 30_000)

afterAll(async () => {
  socket?.close()
  await daemon?.close()
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

describe('terminal operations end to end (MCP surface → daemon → real pty)', () => {
  it('types, waits, reads, lists, and kills through kiri operations', async () => {
    if (!daemon) throw new Error('daemon missing')
    const control = makeKiriControl(dependencies(daemon))
    const operate = async (operation: string, params: Record<string, unknown>) => {
      const response = await runKiriOperation(control, { operation, params })
      if (!response.ok) throw new Error(`${operation} failed: ${JSON.stringify(response.error)}`)
      return response.result
    }

    await operate('terminal.keys', {
      agentId,
      mode: 'shell',
      text: "printf 'mcp-%s\\n' ok",
      keys: ['enter'],
    })

    const waited = await operate('terminal.wait-for', {
      agentId,
      mode: 'shell',
      pattern: 'mcp-ok',
      timeoutMs: 10_000,
    })
    expect(waited).toMatchObject({ matched: true, match: 'mcp-ok' })

    const read = await operate('terminal.read', { agentId, mode: 'shell' })
    expect(JSON.stringify(read)).toContain('mcp-ok')

    const listed = await operate('terminal.list', {})
    expect(JSON.stringify(listed)).toContain(shellKey)

    await operate('terminal.kill', { agentId, mode: 'shell' })
    const relisted = await operate('terminal.list', {})
    expect(JSON.stringify(relisted)).not.toContain(shellKey)
  }, 30_000)
})
