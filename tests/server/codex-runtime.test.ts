import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  codexHookSessionBindingPath,
  codexTerminalSessionIdPath,
  writeCodexHookSessionBinding,
  writeCodexTerminalSessionId,
} from '~/server/codex-terminal-session'
import type { TerminalAgentLaunchConfig } from '~/server/terminal-launch'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'

type RpcRequest = {
  id: string | number
  method: string
  params?: unknown
}

const dbMock = vi.hoisted(() => {
  const launchConfigs = new Map<string, TerminalAgentLaunchConfig>()
  const runtimeStates = new Map<string, Record<string, unknown>>()
  return {
    launchConfigs,
    runtimeStates,
    appendUserMessage: vi.fn(),
    clearAgentRuntimeState: vi.fn((agentId: string) => {
      runtimeStates.delete(agentId)
    }),
    clearRuntimeContextUsage: vi.fn(),
    getAgentLaunchConfig: vi.fn((agentId: string) => {
      const config = launchConfigs.get(agentId)
      if (!config) throw new Error(`missing launch config ${agentId}`)
      return config
    }),
    getAgentRuntimeState: vi.fn((agentId: string) => runtimeStates.get(agentId) ?? {}),
    getAgentThinkingLevel: vi.fn(() => null),
    recordAgentInfoEvent: vi.fn(),
    recordRuntimeContextUsage: vi.fn(),
    recordRuntimeMessage: vi.fn(),
    recordRuntimeTimelineEvent: vi.fn(),
    replaceAgentTasks: vi.fn(),
    resetSession: vi.fn(),
    setAgentRuntimeState: vi.fn((agentId: string, state: Record<string, unknown>) => {
      runtimeStates.set(agentId, state)
    }),
    setAgentStatus: vi.fn(),
  }
})

vi.mock('~/server/db', () => dbMock)

describe('Codex runtime', () => {
  afterEach(async () => {
    dbMock.launchConfigs.clear()
    dbMock.runtimeStates.clear()
    for (const mock of [
      dbMock.appendUserMessage,
      dbMock.clearAgentRuntimeState,
      dbMock.clearRuntimeContextUsage,
      dbMock.getAgentLaunchConfig,
      dbMock.getAgentRuntimeState,
      dbMock.getAgentThinkingLevel,
      dbMock.recordAgentInfoEvent,
      dbMock.recordRuntimeContextUsage,
      dbMock.recordRuntimeMessage,
      dbMock.recordRuntimeTimelineEvent,
      dbMock.replaceAgentTasks,
      dbMock.resetSession,
      dbMock.setAgentRuntimeState,
      dbMock.setAgentStatus,
    ]) {
      mock.mockClear()
    }
    const runtime = await import('~/server/codex-runtime')
    runtime.__unsafeClearCodexRuntimeStateForTest()
  })

  it('unlinks on-disk Codex resume bindings during reset', async () => {
    const { resetCodexSession } = await import('~/server/codex-runtime')
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-codex-reset-'))
    dbMock.launchConfigs.set('agent-1', launchConfig({
      id: 'agent-1',
      sessionDir,
    }))
    writeCodexTerminalSessionId(sessionDir, 'plain-session')
    writeCodexHookSessionBinding(sessionDir, {
      agentId: 'agent-1',
      sessionId: 'hook-session',
      cwd: '/tmp/project',
      source: 'startup',
      hookEventName: 'SessionStart',
      writtenAtMs: Date.now(),
    })

    await resetCodexSession({
      agentId: 'agent-1',
      runtimeBinaries: testRuntimeBinaries({}),
    })

    expect(dbMock.clearAgentRuntimeState).toHaveBeenCalledWith('agent-1')
    expect(dbMock.resetSession).toHaveBeenCalledWith('agent-1')
    expect(existsSync(codexTerminalSessionIdPath(sessionDir))).toBe(false)
    expect(existsSync(codexHookSessionBindingPath(sessionDir))).toBe(false)
  })

  it('remembers a thread mapping when prompt takes the active-turn fast path', async () => {
    const harness = await startCodexHarness()
    const { promptCodexAgent, codexRuntimeRetainedStateStats } = await import('~/server/codex-runtime')
    dbMock.launchConfigs.set('agent-1', launchConfig({
      id: 'agent-1',
      runtimeStateJson: JSON.stringify({ threadId: 'thread-1', websocketUrl: harness.url }),
    }))
    dbMock.runtimeStates.set('agent-1', { threadId: 'thread-1', websocketUrl: harness.url })

    try {
      await promptCodexAgent({
        agentId: 'agent-1',
        text: 'continue',
        runtimeBinaries: testRuntimeBinaries({}),
      })

      expect(codexRuntimeRetainedStateStats()).toMatchObject({
        agentThreads: 1,
        threadAgents: 1,
      })
      expect(harness.requests.some((request) => request.method === 'turn/steer')).toBe(true)
    } finally {
      await harness.close()
    }
  })
})

function launchConfig(input: {
  readonly id: string
  readonly sessionDir?: string
  readonly runtimeStateJson?: string
}): TerminalAgentLaunchConfig {
  return {
    id: input.id,
    projectId: 'project-1',
    runtime: 'codex',
    sessionDir: input.sessionDir ?? mkdtempSync(join(tmpdir(), 'kiri-codex-session-')),
    sessionFile: 'session.jsonl',
    model: 'test-model',
    cwd: '/tmp/project',
    runtimeStateJson: input.runtimeStateJson,
  }
}

function testRuntimeBinaries(env: NodeJS.ProcessEnv) {
  return {
    resolveExecutable: () => Effect.succeed('/tmp/codex'),
    processEnv: () => Effect.succeed(env),
  }
}

async function startCodexHarness() {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const requests: RpcRequest[] = []
  const sockets = new Set<WebSocket>()

  wss.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('message', (raw) => {
      const request = JSON.parse(rawDataToString(raw)) as RpcRequest
      requests.push(request)
      if (request.method === 'initialize') {
        socket.send(JSON.stringify({ id: request.id, result: { ok: true } }))
        return
      }
      if (request.method === 'thread/read') {
        socket.send(JSON.stringify({
          id: request.id,
          result: {
            thread: {
              id: 'thread-1',
              status: { type: 'active' },
              turns: [{ id: 'turn-1', status: 'inProgress' }],
            },
          },
        }))
        return
      }
      if (request.method === 'turn/steer') {
        socket.send(JSON.stringify({ id: request.id, result: { ok: true } }))
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo

  return {
    url: `ws://127.0.0.1:${port}`,
    requests,
    close: () => closeHarness(server, wss, sockets),
  }
}

function rawDataToString(raw: RawData) {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  return Buffer.from(raw).toString('utf8')
}

function closeHarness(
  server: Server,
  wss: WebSocketServer,
  sockets: Set<WebSocket>,
) {
  for (const socket of sockets) socket.close()
  return new Promise<void>((resolve, reject) => {
    wss.close((wssError) => {
      if (wssError) {
        reject(wssError)
        return
      }
      server.close((serverError) => {
        if (serverError) reject(serverError)
        else resolve()
      })
    })
  })
}
