import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

// Guards the session lifecycle flows that were validated against real agents
// (docs/kiriterm-flow-audit.md): new sessions for every runtime, conversation
// continuations across PTY kills (claude --resume, codex rollout remember),
// scratchpad triggers, and workflow retriggers — all through the real MCP
// server with fake runtime binaries.

const projectRoot = process.cwd()
const tempRoots: string[] = []
const clients: Client[] = []

const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), operation: z.string(), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    operation: z.string(),
    error: z.object({ code: z.string(), message: z.string(), path: z.string().optional() }),
  }),
])

const waitSchema = z.object({ matched: z.boolean(), match: z.string().optional() })
const sessionSchema = z.object({ id: z.string(), runtime: z.string(), model: z.string() })

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()))
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function startClient() {
  const root = mkdtempSync(join(tmpdir(), 'kiri-runtime-flows-'))
  tempRoots.push(root)
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      KIRI_ROOT_DIR: root,
      KIRI_DB_PATH: join(root, 'kiri.sqlite'),
      KIRI_STATE_DIR: join(root, 'state'),
      KIRI_SETTINGS_PATH: resolve(projectRoot, 'settings.json'),
      KIRI_CLAUDE_BIN: resolve(projectRoot, 'tests/harness/fake-claude-terminal.mjs'),
      KIRI_CODEX_BIN: resolve(projectRoot, 'tests/harness/fake-codex-terminal.mjs'),
      KIRI_PI_BIN: resolve(projectRoot, 'tests/harness/fake-pi-terminal.mjs'),
      KIRI_OPENCODE_BIN: resolve(projectRoot, 'tests/harness/fake-opencode-terminal.mjs'),
      KIRI_CLAUDE_HOME: join(root, 'claude-home'),
      KIRI_CODEX_HOME: join(root, 'codex-home'),
      KIRI_TERMINAL_CLEANUP_STALE_CLAUDE: '0',
    }).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]),
  )
  const client = new Client({ name: 'kiri-runtime-flows-test', version: '0.1.0' })
  clients.push(client)
  await client.connect(new StdioClientTransport({
    command: 'pnpm',
    args: ['exec', 'tsx', 'src/cli/kirictl.ts', 'mcp'],
    cwd: projectRoot,
    env,
    stderr: 'pipe',
  }))
  await call(client, 'kiri_do', {
    operation: 'project.add',
    params: { id: 'flows', name: 'Runtime Flows', cwd: root },
  })
  return client
}

async function call(client: Client, tool: 'kiri_get' | 'kiri_do', args: Record<string, unknown>) {
  const raw = await client.callTool({ name: tool, arguments: args })
  if ('isError' in raw && raw.isError) throw new Error(JSON.stringify(raw.content))
  const response = responseSchema.parse(raw.structuredContent)
  if (!response.ok) {
    throw new Error(`${response.operation} failed: ${response.error.code} ${response.error.message}`)
  }
  return response.result
}

function createSession(client: Client, runtime: string, title: string) {
  return call(client, 'kiri_do', {
    operation: 'session.create',
    params: { projectId: 'flows', runtime, interfaceMode: 'terminal', title },
  }).then((result) => sessionSchema.parse(result))
}

function sendInput(client: Client, agentId: string, text: string) {
  return call(client, 'kiri_do', {
    operation: 'terminal.input',
    params: { agentId, text, submit: true },
  })
}

async function waitFor(client: Client, agentId: string, pattern: string) {
  return waitSchema.parse(await call(client, 'kiri_do', {
    operation: 'terminal.wait-for',
    params: { agentId, mode: 'runtime', pattern, scope: 'output', timeoutMs: 20_000 },
  }))
}

// Like waitFor, but tolerates the session not existing yet (e.g. a wake
// delivery is still respawning the receiving terminal).
async function waitForEventually(client: Client, agentId: string, pattern: string) {
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      return await waitFor(client, agentId, pattern)
    } catch (error) {
      if (Date.now() > deadline) throw error
      if (!(error instanceof Error) || !error.message.includes('No session')) throw error
      await sleep(250)
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

describe('runtime session flows over MCP', () => {
  it('new sessions respond on every runtime (claude, codex, pi, opencode)', async () => {
    const client = await startClient()
    const expectations: Array<{ runtime: string; boot: string; reply: (text: string) => string }> = [
      { runtime: 'claude', boot: 'fake-claude mode:fresh', reply: (text) => `claude-reply:${text}` },
      { runtime: 'codex', boot: 'fake-codex-terminal mode:fresh', reply: (text) => `echo:${text}` },
      { runtime: 'pi', boot: 'fake-pi ready', reply: (text) => `pi-reply:${text}` },
      { runtime: 'opencode', boot: 'fake-opencode ready mode:fresh', reply: (text) => `opencode-reply:${text}` },
    ]

    for (const expectation of expectations) {
      const session = await createSession(client, expectation.runtime, `Flow ${expectation.runtime}`)
      // First input spawns the terminal (delivered as argv for claude/codex,
      // queued write for pi/opencode).
      await sendInput(client, session.id, `seed-${expectation.runtime}`)
      expect((await waitFor(client, session.id, expectation.boot)).matched).toBe(true)
      // Second input lands in the live terminal and must round-trip.
      await sendInput(client, session.id, `ping-${expectation.runtime}`)
      const replied = await waitFor(client, session.id, expectation.reply(`ping-${expectation.runtime}`))
      expect(replied.matched).toBe(true)
    }

    const listed = z.object({
      sessions: z.array(z.object({ key: z.string(), mode: z.string(), exited: z.boolean() })),
    }).parse(await call(client, 'kiri_get', { operation: 'terminal.list', params: {} }))
    expect(listed.sessions.filter((session) => session.mode === 'runtime' && !session.exited))
      .toHaveLength(4)
  }, 180_000)

  it('claude continues its conversation across a terminal kill (--resume)', async () => {
    const client = await startClient()
    const session = await createSession(client, 'claude', 'Claude continuation')

    await sendInput(client, session.id, 'remember-the-plan')
    expect((await waitFor(client, session.id, 'claude-reply:remember-the-plan')).matched).toBe(true)

    await call(client, 'kiri_do', {
      operation: 'terminal.kill',
      params: { agentId: session.id, mode: 'runtime' },
    })

    // The respawn must detect the existing session file and resume with the
    // prior conversation available.
    await sendInput(client, session.id, 'recall')
    expect((await waitFor(client, session.id, 'fake-claude mode:resume')).matched).toBe(true)
    expect((await waitFor(client, session.id, 'claude-remembers:remember-the-plan')).matched).toBe(true)
    expect((await waitFor(client, session.id, 'claude-reply:recall')).matched).toBe(true)
  }, 120_000)

  it('codex resumes via the remembered rollout session across a terminal kill', async () => {
    const client = await startClient()
    const session = await createSession(client, 'codex', 'Codex continuation')

    await sendInput(client, session.id, 'boot-codex')
    expect((await waitFor(client, session.id, 'fake-codex-terminal mode:fresh')).matched).toBe(true)
    // Store durable state in the fake so resume can prove identity continuity.
    await sendInput(client, session.id, 'remember codex-memory-1')
    expect((await waitFor(client, session.id, 'remembered:codex-memory-1')).matched).toBe(true)
    // Give the async rollout discovery (rememberCodexTerminalSession) time to
    // record the session id in runtime state.
    await sleep(1_500)

    await call(client, 'kiri_do', {
      operation: 'terminal.kill',
      params: { agentId: session.id, mode: 'runtime' },
    })

    await sendInput(client, session.id, 'state')
    expect((await waitFor(client, session.id, 'fake-codex-terminal mode:resume')).matched).toBe(true)
    const state = await waitFor(client, session.id, 'state:codex-memory-1:session:[a-z0-9-]+:mode:resume')
    expect(state.matched).toBe(true)
  }, 120_000)

  it('scratchpad blocks trigger sessions whose terminals receive the body', async () => {
    const client = await startClient()
    const block = z.object({ id: z.string() }).parse(await call(client, 'kiri_do', {
      operation: 'scratchpad.add',
      params: { projectId: 'flows', body: 'scratch-mission-42' },
    }))

    const triggered = z.object({ agentId: z.string() }).parse(await call(client, 'kiri_do', {
      operation: 'scratchpad.trigger',
      params: {
        id: block.id,
        projectId: 'flows',
        runtime: 'claude',
        interfaceMode: 'terminal',
        title: 'Scratch spinout',
      },
    }))

    await call(client, 'kiri_do', {
      operation: 'terminal.spawn',
      params: { agentId: triggered.agentId },
    })
    expect((await waitFor(client, triggered.agentId, 'claude-reply:scratch-mission-42')).matched)
      .toBe(true)

    const blocks = z.array(z.object({
      id: z.string(),
      triggeredAgentId: z.string().nullable(),
      triggeredAt: z.string().nullable(),
    })).parse(await call(client, 'kiri_get', {
      operation: 'scratchpad.list',
      params: { projectId: 'flows' },
    }))
    const triggeredBlock = blocks.find((candidate) => candidate.id === block.id)
    expect(triggeredBlock?.triggeredAgentId).toBe(triggered.agentId)
    expect(triggeredBlock?.triggeredAt).not.toBeNull()
  }, 120_000)

  it('workflow.await deliver:wake injects results into the orchestrator as a fresh turn', async () => {
    const client = await startClient()

    // Orchestrator: a live fake-claude session.
    const orchestrator = await createSession(client, 'claude', 'Orchestrator')
    await sendInput(client, orchestrator.id, 'orchestrator-online')
    expect((await waitFor(client, orchestrator.id, 'claude-reply:orchestrator-online')).matched)
      .toBe(true)

    // Worker: one workflow item on fake-codex.
    const created = z.object({ id: z.string() }).parse(await call(client, 'kiri_do', {
      operation: 'workflow.create',
      params: {
        projectId: 'flows',
        title: 'Wake run',
        defaults: { interfaceMode: 'terminal', attachScratchpad: false },
        items: [{ action: 'launch', runtime: 'codex', title: 'Worker', body: 'boot-task' }],
      },
    }))
    await call(client, 'kiri_do', { operation: 'workflow.dispatch', params: { id: created.id } })
    const shown = z.object({
      items: z.array(z.object({ activeAgentId: z.string().nullable() })),
    }).parse(await call(client, 'kiri_get', { operation: 'workflow.show', params: { id: created.id } }))
    const worker = shown.items[0]?.activeAgentId
    if (!worker) throw new Error('no worker agent')
    await call(client, 'kiri_do', { operation: 'terminal.spawn', params: { agentId: worker } })
    expect((await waitFor(client, worker, 'fake-codex-terminal mode:fresh')).matched).toBe(true)

    // Subscribe in wake mode: returns immediately, no held call.
    const subscribed = z.object({
      subscribed: z.boolean(),
      subscriptionId: z.string().optional(),
      deliverTo: z.string(),
    }).parse(await call(client, 'kiri_do', {
      operation: 'workflow.await',
      params: {
        id: created.id,
        pattern: 'echo:finish-now',
        deliver: 'wake',
        deliverTo: orchestrator.id,
        note: 'read worker output and integrate',
        timeoutMs: 30_000,
      },
    }))
    expect(subscribed).toMatchObject({ subscribed: true, deliverTo: orchestrator.id })

    // Worker reports → wake is typed into the orchestrator, which replies to
    // it like any other user turn.
    await sendInput(client, worker, 'finish-now')
    expect((await waitFor(client, orchestrator.id, 'claude-reply:.*kiri wake')).matched).toBe(true)
    expect((await waitFor(client, orchestrator.id, 'claude-reply:note: read worker output and integrate'))
      .matched).toBe(true)

    // If the orchestrator's terminal is dead at delivery time, the wake
    // respawns it (with conversation resume) and still lands.
    await call(client, 'kiri_do', {
      operation: 'terminal.kill',
      params: { agentId: orchestrator.id, mode: 'runtime' },
    })
    await call(client, 'kiri_do', {
      operation: 'workflow.await',
      params: {
        id: created.id,
        pattern: 'echo:second-round',
        deliver: 'wake',
        deliverTo: orchestrator.id,
        note: 'second wake',
        timeoutMs: 30_000,
      },
    })
    await sendInput(client, worker, 'second-round')
    expect((await waitForEventually(client, orchestrator.id, 'fake-claude mode:resume')).matched)
      .toBe(true)
    expect((await waitForEventually(client, orchestrator.id, 'claude-reply:note: second wake')).matched)
      .toBe(true)

    // The same operation in return mode resolves on worker idleness — no
    // marker engineering needed.
    const idle = z.object({
      matched: z.boolean(),
      matches: z.array(z.object({ agentId: z.string(), idle: z.boolean(), tail: z.array(z.string()) })),
    }).parse(await call(client, 'kiri_do', {
      operation: 'workflow.await',
      params: { id: created.id, idleMs: 1_000, timeoutMs: 20_000 },
    }))
    expect(idle.matched).toBe(true)
    expect(idle.matches[0]).toMatchObject({ agentId: worker, idle: true })
    expect(idle.matches[0]?.tail.join(' ')).toContain('second-round')
  }, 180_000)

  it('workflow items can be retriggered after their terminal dies', async () => {
    const client = await startClient()
    const detailSchema = z.object({
      id: z.string(),
      items: z.array(z.object({
        id: z.string(),
        action: z.string(),
        activeAgentId: z.string().nullable(),
        attempts: z.array(z.object({ agentId: z.string().nullable(), status: z.string() })),
      })),
    })

    const created = detailSchema.parse(await call(client, 'kiri_do', {
      operation: 'workflow.create',
      params: {
        projectId: 'flows',
        title: 'Retrigger flow',
        defaults: { interfaceMode: 'terminal', attachScratchpad: false },
        items: [{ action: 'launch', runtime: 'claude', title: 'Worker', body: 'wf-task-7' }],
      },
    }))
    await call(client, 'kiri_do', { operation: 'workflow.dispatch', params: { id: created.id } })

    const afterDispatch = detailSchema.parse(
      await call(client, 'kiri_get', { operation: 'workflow.show', params: { id: created.id } }),
    )
    const firstAgent = afterDispatch.items[0]?.activeAgentId
    if (!firstAgent) throw new Error('dispatch did not record an agent')
    // KIRI_WORKFLOW_SPAWN_TERMINALS is unset here: dispatch queues the body
    // without spawning. terminal.spawn delivers it.
    await call(client, 'kiri_do', { operation: 'terminal.spawn', params: { agentId: firstAgent } })
    expect((await waitFor(client, firstAgent, 'claude-reply:wf-task-7')).matched).toBe(true)

    await call(client, 'kiri_do', {
      operation: 'terminal.kill',
      params: { agentId: firstAgent, mode: 'runtime' },
    })
    const itemId = afterDispatch.items[0]?.id
    if (!itemId) throw new Error('missing workflow item id')
    await call(client, 'kiri_do', { operation: 'workflow.retrigger', params: { itemId } })

    const afterRetrigger = detailSchema.parse(
      await call(client, 'kiri_get', { operation: 'workflow.show', params: { id: created.id } }),
    )
    const secondAgent = afterRetrigger.items[0]?.activeAgentId
    if (!secondAgent) throw new Error('retrigger did not record an agent')
    expect(secondAgent).not.toBe(firstAgent)
    expect(afterRetrigger.items[0]?.attempts.length).toBeGreaterThanOrEqual(2)

    await call(client, 'kiri_do', { operation: 'terminal.spawn', params: { agentId: secondAgent } })
    expect((await waitFor(client, secondAgent, 'claude-reply:wf-task-7')).matched).toBe(true)
  }, 120_000)
})
