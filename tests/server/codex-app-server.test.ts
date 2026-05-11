import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { CodexAppServerAdapter } from '../../src/server/codex-app-server'

type RpcRequest = {
  id: string | number
  method: string
  params?: unknown
}

type Harness = {
  url: string
  requests: RpcRequest[]
  send: (message: unknown) => void
  sendRaw: (message: string) => void
  closeSockets: () => void
  close: () => Promise<void>
}

describe('CodexAppServerAdapter', () => {
  it('clears timed out requests and keeps the connection usable', async () => {
    const harness = await startHarness((socket, request) => {
      if (request.method === 'ping') {
        socket.send(JSON.stringify({ id: request.id, result: 'pong' }))
      }
    })
    const adapter = new CodexAppServerAdapter({
      websocketUrl: harness.url,
      spawnIfMissing: false,
    })

    try {
      await expect(adapter.request('slow', undefined, 20)).rejects.toThrow(
        'Timed out waiting for Codex app-server slow',
      )
      await expect(adapter.request('ping')).resolves.toBe('pong')
    } finally {
      adapter.close()
      await harness.close()
    }
  })

  it('rejects pending requests when closed', async () => {
    const harness = await startHarness()
    const adapter = new CodexAppServerAdapter({
      websocketUrl: harness.url,
      spawnIfMissing: false,
    })

    try {
      const pending = adapter.request('slow')
      await waitForRequest(harness, 'slow')
      adapter.close()
      await expect(pending).rejects.toThrow('Codex app-server adapter closed')
    } finally {
      adapter.close()
      await harness.close()
    }
  })

  it('preserves Codex RPC error details as the adapter error cause', async () => {
    const harness = await startHarness((socket, request) => {
      if (request.method === 'boom') {
        socket.send(JSON.stringify({
          id: request.id,
          error: {
            code: -32099,
            message: 'bad codex thing',
            data: { reason: 'shape drift' },
          },
        }))
      }
    })
    const adapter = new CodexAppServerAdapter({
      websocketUrl: harness.url,
      spawnIfMissing: false,
    })

    try {
      await expect(adapter.request('boom')).rejects.toMatchObject({
        message: 'bad codex thing',
        cause: {
          code: -32099,
          message: 'bad codex thing',
          data: { reason: 'shape drift' },
        },
      })
    } finally {
      adapter.close()
      await harness.close()
    }
  })

  it('rejects decoded method responses with invalid result shapes', async () => {
    const harness = await startHarness((socket, request) => {
      if (request.method === 'thread/start') {
        socket.send(JSON.stringify({ id: request.id, result: {} }))
      }
    })
    const adapter = new CodexAppServerAdapter({
      websocketUrl: harness.url,
      spawnIfMissing: false,
    })

    try {
      await expect(adapter.startThread({
        cwd: '/tmp/project',
        model: 'gpt-5.5',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      })).rejects.toThrow('Invalid Codex app-server thread/start response')
    } finally {
      adapter.close()
      await harness.close()
    }
  })

  it('returns completed turns that arrived before a waiter was registered', async () => {
    const harness = await startHarness()
    const adapter = new CodexAppServerAdapter({
      websocketUrl: harness.url,
      spawnIfMissing: false,
    })

    try {
      await adapter.connect()
      harness.send({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', items: [] },
        },
      })

      await expect(
        adapter.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'turn-1' }),
      ).resolves.toEqual({ id: 'turn-1', status: 'completed', items: [] })
    } finally {
      adapter.close()
      await harness.close()
    }
  })

  it('ignores malformed websocket payloads before valid notifications', async () => {
    const harness = await startHarness()
    const adapter = new CodexAppServerAdapter({
      websocketUrl: harness.url,
      spawnIfMissing: false,
    })

    try {
      await adapter.connect()
      harness.sendRaw('{')
      harness.send({ id: 'server-request-without-method', params: {} })
      harness.send({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', items: [] },
        },
      })

      await expect(
        adapter.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'turn-1' }),
      ).resolves.toEqual({ id: 'turn-1', status: 'completed', items: [] })
    } finally {
      adapter.close()
      await harness.close()
    }
  })

  it('ignores malformed turn completions instead of poisoning the cache', async () => {
    const harness = await startHarness()
    const adapter = new CodexAppServerAdapter({
      websocketUrl: harness.url,
      spawnIfMissing: false,
    })

    try {
      await adapter.connect()
      harness.send({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { status: 'completed', items: [] },
        },
      })
      harness.send({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', items: [] },
        },
      })

      await expect(
        adapter.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'turn-1' }),
      ).resolves.toEqual({ id: 'turn-1', status: 'completed', items: [] })
    } finally {
      adapter.close()
      await harness.close()
    }
  })

  it('rejects cached failed and interrupted turns', async () => {
    const harness = await startHarness()
    const adapter = new CodexAppServerAdapter({
      websocketUrl: harness.url,
      spawnIfMissing: false,
    })

    try {
      await adapter.connect()
      harness.send({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'failed-turn', status: 'failed' },
        },
      })
      harness.send({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'interrupted-turn', status: 'interrupted' },
        },
      })

      await expect(
        adapter.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'failed-turn' }),
      ).rejects.toThrow('Codex turn failed')
      await expect(
        adapter.waitForTurnCompleted({ threadId: 'thread-1', turnId: 'interrupted-turn' }),
      ).rejects.toThrow('Codex turn interrupted')
    } finally {
      adapter.close()
      await harness.close()
    }
  })

  it('rejects pending turn waiters on socket close', async () => {
    const harness = await startHarness()
    const adapter = new CodexAppServerAdapter({
      websocketUrl: harness.url,
      spawnIfMissing: false,
    })

    try {
      await adapter.connect()
      const pending = adapter.waitForTurnCompleted({
        threadId: 'thread-1',
        turnId: 'turn-1',
      })
      harness.closeSockets()
      await expect(pending).rejects.toThrow('Codex app-server websocket closed')
    } finally {
      adapter.close()
      await harness.close()
    }
  })
})

async function startHarness(
  onRequest: (socket: WebSocket, request: RpcRequest) => void = () => {},
): Promise<Harness> {
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
      onRequest(socket, request)
    })
  })

  await listen(server)
  const { port } = server.address() as AddressInfo

  return {
    url: `ws://127.0.0.1:${port}`,
    requests,
    send: (message) => {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(message))
        }
      }
    },
    sendRaw: (message) => {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(message)
        }
      }
    },
    closeSockets: () => {
      for (const socket of sockets) socket.close()
    },
    close: async () => {
      for (const socket of sockets) socket.close()
      await new Promise<void>((resolve, reject) => {
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
    },
  }
}

function rawDataToString(raw: Parameters<WebSocket['on']>[1] extends (data: infer Data) => void
  ? Data
  : never) {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  return Buffer.from(new Uint8Array(raw as ArrayBuffer)).toString('utf8')
}

function listen(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

async function waitForRequest(harness: Harness, method: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (harness.requests.some((request) => request.method === method)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${method}`)
}
