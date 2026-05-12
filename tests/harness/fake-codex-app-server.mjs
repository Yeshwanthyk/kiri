import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const websocketGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function startFakeCodexAppServer({ port = 39111 } = {}) {
  let nextThread = 0
  let nextTurn = 0
  const threads = new Map()
  const requests = []
  const sockets = new Set()

  const server = createServer()
  server.on('upgrade', (request, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }

    const accept = createHash('sha1')
      .update(`${key}${websocketGuid}`)
      .digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'))

    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      let decoded
      while ((decoded = readFrame(buffer))) {
        buffer = buffer.subarray(decoded.bytesRead)
        if (decoded.opcode === 8) {
          socket.end()
          return
        }
        if (decoded.opcode !== 1) continue
        const message = JSON.parse(decoded.payload.toString('utf8'))
        requests.push(message)
        handleMessage(socket, message)
      }
    })
  })

  function handleMessage(socket, message) {
    if (message.method === 'initialize') {
      send(socket, {
        id: message.id,
        result: {
          userAgent: 'codex-test/0.125.0',
          codexHome: '/tmp/fake-codex-home',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      })
      return
    }
    if (message.method === 'initialized') return
    if (message.method === 'thread/start') {
      const thread = makeThread(`fake-thread-${++nextThread}`, message.params?.cwd)
      threads.set(thread.id, thread)
      send(socket, {
        id: message.id,
        result: {
          thread,
          model: message.params?.model ?? 'gpt-5.5',
          modelProvider: 'openai',
          serviceTier: null,
          cwd: thread.cwd,
          instructionSources: [],
          approvalPolicy: message.params?.approvalPolicy ?? 'never',
          approvalsReviewer: 'user',
          sandbox: sandboxPolicy(message.params?.sandbox, thread.cwd),
          reasoningEffort: 'medium',
        },
      })
      send(socket, { method: 'thread/started', params: { thread } })
      return
    }
    if (message.method === 'thread/resume') {
      if (missingRolloutThreadId(message.params?.threadId)) {
        send(socket, {
          id: message.id,
          error: {
            code: -32000,
            message: `no rollout found for thread id ${message.params?.threadId}`,
          },
        })
        return
      }
      const thread = threads.get(message.params?.threadId) ??
        makeThread(message.params?.threadId ?? `fake-thread-${++nextThread}`, message.params?.cwd)
      threads.set(thread.id, thread)
      send(socket, {
        id: message.id,
        result: {
          thread,
          model: message.params?.model ?? 'gpt-5.5',
          modelProvider: 'openai',
          serviceTier: null,
          cwd: thread.cwd,
          instructionSources: [],
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandbox: sandboxPolicy(message.params?.sandbox, thread.cwd),
          reasoningEffort: 'medium',
        },
      })
      return
    }
    if (message.method === 'thread/read') {
      if (missingRolloutThreadId(message.params?.threadId)) {
        send(socket, {
          id: message.id,
          error: {
            code: -32000,
            message: `no rollout found for thread id ${message.params?.threadId}`,
          },
        })
        return
      }
      const thread = threads.get(message.params?.threadId)
      if (!thread) {
        send(socket, {
          id: message.id,
          error: { code: -32000, message: `unknown thread ${message.params?.threadId}` },
        })
        return
      }
      if (message.params?.includeTurns !== false && thread.turns.length === 0) {
        send(socket, {
          id: message.id,
          error: {
            code: -32000,
            message: `thread ${thread.id} is not materialized yet; includeTurns is unavailable before first user message`,
          },
        })
        return
      }
      send(socket, {
        id: message.id,
        result: {
          thread: {
            ...thread,
            turns: message.params?.includeTurns === false ? [] : thread.turns,
          },
        },
      })
      return
    }
    if (message.method === 'thread/list') {
      const data = [...threads.values()].filter((thread) => {
        if (message.params?.archived === true) return thread.archived === true
        if (message.params?.archived === false || message.params?.archived == null) {
          return thread.archived !== true
        }
        return true
      })
      send(socket, { id: message.id, result: { data, nextCursor: null, backwardsCursor: null } })
      return
    }
    if (message.method === 'thread/fork') {
      const source = threads.get(message.params?.threadId)
      if (!source) {
        send(socket, {
          id: message.id,
          error: { code: -32000, message: `unknown thread ${message.params?.threadId}` },
        })
        return
      }
      const thread = {
        ...makeThread(`fake-thread-${++nextThread}`, message.params?.cwd ?? source.cwd),
        sessionId: source.sessionId,
        forkedFromId: source.id,
        turns: source.turns.map((turn) => ({ ...turn })),
      }
      threads.set(thread.id, thread)
      send(socket, { id: message.id, result: { thread } })
      return
    }
    if (message.method === 'thread/rollback') {
      const thread = threads.get(message.params?.threadId)
      if (thread) {
        thread.turns.splice(Math.max(0, thread.turns.length - message.params.numTurns))
        thread.updatedAt = Math.floor(Date.now() / 1000)
      }
      send(socket, { id: message.id, result: { thread } })
      return
    }
    if (message.method === 'thread/compact/start') {
      send(socket, { id: message.id, result: {} })
      send(socket, {
        method: 'thread/compacted',
        params: { threadId: message.params?.threadId, turnId: null },
      })
      return
    }
    if (message.method === 'thread/name/set') {
      const thread = threads.get(message.params?.threadId)
      if (thread) thread.name = message.params?.name
      send(socket, { id: message.id, result: {} })
      return
    }
    if (message.method === 'thread/archive' || message.method === 'thread/unarchive') {
      const thread = threads.get(message.params?.threadId)
      if (thread) thread.archived = message.method === 'thread/archive'
      send(socket, { id: message.id, result: {} })
      return
    }
    if (message.method === 'thread/metadata/update') {
      send(socket, { id: message.id, result: {} })
      return
    }
    if (message.method === 'turn/start') {
      const threadId = message.params?.threadId
      const thread = threads.get(threadId)
      const turnId = `fake-turn-${++nextTurn}`
      const prompt = message.params?.input?.[0]?.text ?? ''
      const shouldCompact = prompt.toLowerCase().includes('compact')
      const shouldSkipUsageUpdate = prompt.toLowerCase().includes('without usage')
      const shouldEmitFileOperation = prompt.toLowerCase().includes('file operation')
      const isTitleGeneration = prompt.includes('AETHER_SESSION_TITLE_GENERATION')
      const usedTokens = shouldCompact ? 42 : 123
      const inputTokens = shouldCompact ? 18 : 45
      const outputTokens = usedTokens - inputTokens
      const responseText = isTitleGeneration
        ? 'Generated Codex Title'
        : `fake codex received: ${prompt}`
      const item = {
        type: 'agentMessage',
        id: `fake-item-${nextTurn}`,
        text: responseText,
        phase: null,
        memoryCitation: null,
      }
      const fileItem = {
        type: 'fileChange',
        id: `fake-file-${nextTurn}`,
        path: 'src/aether-file-operation-e2e.tmp',
      }
      const turn = {
        id: turnId,
        items: [],
        itemsView: { type: 'full' },
        status: 'completed',
        error: null,
        startedAt: Math.floor(Date.now() / 1000),
        completedAt: Math.floor(Date.now() / 1000),
        durationMs: 1,
      }
      const inProgressTurn = { ...turn, status: 'inProgress', completedAt: null }
      if (thread) {
        thread.status = { type: 'active', activeFlags: [] }
        thread.turns.push(inProgressTurn)
        thread.updatedAt = Math.floor(Date.now() / 1000)
      }
      send(socket, { id: message.id, result: { turn: { ...turn, items: [] } } })
      send(socket, {
        method: 'turn/started',
        params: { threadId, turn: inProgressTurn },
      })
      if (shouldEmitFileOperation) {
        if (thread?.cwd) {
          writeFileSync(
            join(thread.cwd, fileItem.path),
            `fake codex edit ${Date.now()}\n`,
          )
        }
        send(socket, {
          method: 'item/started',
          params: {
            threadId,
            turnId,
            item: fileItem,
            startedAtMs: Date.now(),
          },
        })
      }
      send(socket, {
        method: 'item/started',
        params: {
          threadId,
          turnId,
          item: { ...item, text: '' },
          startedAtMs: Date.now(),
        },
      })
      send(socket, {
        method: 'item/agentMessage/delta',
        params: { threadId, turnId, itemId: item.id, delta: responseText },
      })
      send(socket, {
        method: 'item/completed',
        params: { threadId, turnId, item, completedAtMs: Date.now() },
      })
      if (shouldEmitFileOperation) {
        send(socket, {
          method: 'item/completed',
          params: { threadId, turnId, item: fileItem, completedAtMs: Date.now() },
        })
      }
      if (shouldCompact) {
        send(socket, {
          method: 'thread/compacted',
          params: { threadId, turnId },
        })
      }
      if (!shouldSkipUsageUpdate) {
        send(socket, {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId,
            turnId,
            tokenUsage: {
              total: {
                totalTokens: usedTokens,
                inputTokens,
                cachedInputTokens: 0,
                outputTokens,
                reasoningOutputTokens: 0,
              },
              last: {
                totalTokens: usedTokens,
                inputTokens,
                cachedInputTokens: 0,
                outputTokens,
                reasoningOutputTokens: 0,
              },
              modelContextWindow: 258000,
            },
          },
        })
      }
      send(socket, {
        method: 'turn/diff/updated',
        params: { threadId, diff: '' },
      })
      if (thread) {
        const index = thread.turns.findIndex((entry) => entry.id === turnId)
        if (index >= 0) thread.turns[index] = { ...turn, items: [item] }
        thread.status = { type: 'idle' }
        thread.updatedAt = Math.floor(Date.now() / 1000)
      }
      send(socket, { method: 'turn/completed', params: { threadId, turn: { ...turn, items: [item] } } })
      send(socket, {
        method: 'thread/status/changed',
        params: { threadId, status: { type: 'idle' } },
      })
      return
    }
    if (message.method === 'review/start') {
      const threadId = message.params?.threadId
      const thread = threads.get(threadId)
      const turnId = `fake-review-${++nextTurn}`
      const target = message.params?.target ?? { type: 'uncommittedChanges' }
      const label = target.type === 'baseBranch'
        ? `base ${target.branch}`
        : 'uncommitted changes'
      const responseText = `fake codex reviewed: ${label}`
      const item = {
        type: 'agentMessage',
        id: `fake-review-item-${nextTurn}`,
        text: responseText,
        phase: null,
        memoryCitation: null,
      }
      const turn = {
        id: turnId,
        items: [],
        itemsView: { type: 'full' },
        status: 'completed',
        error: null,
        startedAt: Math.floor(Date.now() / 1000),
        completedAt: Math.floor(Date.now() / 1000),
        durationMs: 1,
      }
      const inProgressTurn = { ...turn, status: 'inProgress', completedAt: null }
      if (thread) {
        thread.status = { type: 'active', activeFlags: [] }
        thread.turns.push(inProgressTurn)
        thread.updatedAt = Math.floor(Date.now() / 1000)
      }
      send(socket, {
        id: message.id,
        result: { turn: { ...turn, items: [] }, reviewThreadId: threadId },
      })
      send(socket, {
        method: 'turn/started',
        params: { threadId, turn: inProgressTurn },
      })
      send(socket, {
        method: 'item/completed',
        params: { threadId, turnId, item, completedAtMs: Date.now() },
      })
      send(socket, {
        method: 'turn/diff/updated',
        params: { threadId, turnId, diff: '' },
      })
      if (thread) {
        const index = thread.turns.findIndex((entry) => entry.id === turnId)
        if (index >= 0) thread.turns[index] = { ...turn, items: [item] }
        thread.status = { type: 'idle' }
        thread.updatedAt = Math.floor(Date.now() / 1000)
      }
      send(socket, {
        method: 'turn/completed',
        params: { threadId, turn: { ...turn, items: [item] } },
      })
      send(socket, {
        method: 'thread/status/changed',
        params: { threadId, status: { type: 'idle' } },
      })
      return
    }
    if (message.method === 'turn/interrupt') {
      send(socket, { id: message.id, result: {} })
      return
    }
    if (message.method === 'turn/steer') {
      send(socket, { id: message.id, result: {} })
      return
    }
    send(socket, {
      id: message.id,
      error: { code: -32601, message: `unsupported method ${message.method}` },
    })
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve({
        port,
        url: `ws://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy()
          server.close(done)
        }),
      })
    })
  })
}

function sandboxPolicy(mode, cwd) {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

function missingRolloutThreadId(threadId) {
  return typeof threadId === 'string' && threadId.includes('missing-rollout')
}

function makeThread(id, cwd = '/') {
  const now = Math.floor(Date.now() / 1000)
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    preview: '',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: now,
    updatedAt: now,
    status: { type: 'idle' },
    path: null,
    cwd,
    cliVersion: 'test',
    source: { type: 'appServer' },
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  }
}

function send(socket, value) {
  const payload = Buffer.from(JSON.stringify(value))
  const header = []
  header.push(0x81)
  if (payload.length < 126) {
    header.push(payload.length)
  } else if (payload.length <= 0xffff) {
    header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff)
  } else {
    header.push(127, 0, 0, 0, 0, (payload.length >> 24) & 0xff, (payload.length >> 16) & 0xff, (payload.length >> 8) & 0xff, payload.length & 0xff)
  }
  socket.write(Buffer.concat([Buffer.from(header), payload]))
}

function readFrame(buffer) {
  if (buffer.length < 2) return null
  const first = buffer[0]
  const second = buffer[1]
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < offset + 2) return null
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null
    const high = buffer.readUInt32BE(offset)
    const low = buffer.readUInt32BE(offset + 4)
    if (high !== 0) throw new Error('large websocket frames are not supported by test harness')
    length = low
    offset += 8
  }
  const maskLength = masked ? 4 : 0
  if (buffer.length < offset + maskLength + length) return null
  const mask = masked ? buffer.subarray(offset, offset + 4) : null
  offset += maskLength
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4]
    }
  }
  return { opcode, payload, bytesRead: offset + length }
}
