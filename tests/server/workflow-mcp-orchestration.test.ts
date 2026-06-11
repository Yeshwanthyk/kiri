import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

// End-to-end agent orchestration over MCP, the way a "main agent" (e.g. a
// Claude Code session inside kiri) would do it:
//   user intent → workflow.create → workflow.dispatch spins out worker agents
//   in real PTYs → the main agent assigns work and reads responses back via
//   terminal.input / terminal.wait-for / terminal.read → an adversarial
//   reviewer agent judges the implementer's output → the verdict round-trips
//   → results are reported back on the shared scratchpad.
// Workers run the fake codex terminal harness (echoes commands), so the loop
// is deterministic and needs no real AI binaries.

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

const workflowDetailSchema = z.object({
  id: z.string(),
  status: z.string(),
  items: z.array(z.object({
    id: z.string(),
    action: z.string(),
    title: z.string(),
    status: z.string(),
    activeAgentId: z.string().nullable(),
    attempts: z.array(z.object({ agentId: z.string().nullable(), status: z.string() })),
  })),
})

const screenSchema = z.object({
  screen: z.object({
    lines: z.array(z.string()),
    cols: z.number(),
    rows: z.number(),
  }),
})

const waitForSchema = z.object({
  matched: z.boolean(),
  match: z.string().optional(),
})

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()))
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeDummyRepo(root: string) {
  const repo = join(root, 'playground-repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), '# Playground\n\nDummy repo for kiri orchestration tests.\n')
  writeFileSync(
    join(repo, 'src', 'greet.js'),
    // Deliberately sloppy: the "implementer" agent's assignment.
    "export function greet(name) { return 'hello ' + name.toUpperCase() }\n",
  )
  execFileSync('git', ['init', '--quiet'], { cwd: repo })
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', [
    '-c', 'user.email=kiri-test@example.com',
    '-c', 'user.name=Kiri Test',
    'commit', '--quiet', '-m', 'init',
  ], { cwd: repo })
  return repo
}

async function startClient() {
  const root = mkdtempSync(join(tmpdir(), 'kiri-workflow-mcp-'))
  tempRoots.push(root)
  const repo = makeDummyRepo(root)
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      KIRI_ROOT_DIR: root,
      KIRI_DB_PATH: join(root, 'kiri.sqlite'),
      KIRI_STATE_DIR: join(root, 'state'),
      KIRI_SETTINGS_PATH: resolve(projectRoot, 'settings.json'),
      KIRI_CODEX_BIN: resolve(projectRoot, 'tests/harness/fake-codex-terminal.mjs'),
      KIRI_CODEX_HOME: join(root, 'codex-home'),
      // Dispatch spawns real PTYs for terminal-mode launch items.
      KIRI_WORKFLOW_SPAWN_TERMINALS: '1',
      KIRI_TERMINAL_CLEANUP_STALE_CLAUDE: '0',
    }).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]),
  )
  const client = new Client({ name: 'kiri-workflow-mcp-test', version: '0.1.0' })
  clients.push(client)
  await client.connect(new StdioClientTransport({
    command: 'pnpm',
    args: ['exec', 'tsx', 'src/cli/kirictl.ts', 'mcp'],
    cwd: projectRoot,
    env,
    stderr: 'pipe',
  }))
  return { client, repo }
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

function screenLine(result: unknown, pattern: RegExp) {
  const { screen } = screenSchema.parse(result)
  const line = screen.lines.find((candidate) => pattern.test(candidate))
  if (!line) throw new Error(`No screen line matching ${pattern} in:\n${screen.lines.join('\n')}`)
  return line.trim()
}

describe('workflow orchestration over MCP', () => {
  it('turns user intent into a workflow, spins out agents, and round-trips an adversarial review', async () => {
    const { client, repo } = await startClient()

    // The main agent registers the dummy repo as a project.
    await call(client, 'kiri_do', {
      operation: 'project.add',
      params: { id: 'playground', name: 'Kiriterm Playground', cwd: repo },
    })

    // User intent: "add slugify to greet.js and have it adversarially
    // reviewed before merge" → the main agent generates this workflow.
    const workflowParams = {
      projectId: 'playground',
      title: 'Implement slugify with adversarial review',
      defaults: {
        runtime: 'codex',
        interfaceMode: 'terminal',
        model: 'gpt-5.5',
        attachScratchpad: false,
      },
      items: [
        {
          action: 'launch',
          title: 'Implementer',
          body: 'implement slugify in src/greet.js',
        },
        {
          action: 'launch',
          title: 'Adversarial reviewer',
          body: 'adversarially review the slugify implementation',
        },
        {
          action: 'scratchpad',
          title: 'Mission context',
          body: 'User asked: add slugify to greet.js; adversarial review required before merge.',
        },
      ],
    }

    const validation = z.object({
      valid: z.boolean(),
      launchCount: z.number(),
      scratchpadCount: z.number(),
    }).parse(await call(client, 'kiri_do', { operation: 'workflow.validate', params: workflowParams }))
    expect(validation).toMatchObject({ valid: true, launchCount: 2, scratchpadCount: 1 })

    const created = workflowDetailSchema.parse(
      await call(client, 'kiri_do', { operation: 'workflow.create', params: workflowParams }),
    )

    // Dispatch spins out the worker agents in real PTYs.
    const dispatched = z.object({
      launched: z.number(),
      scratchpadOnly: z.number(),
      failed: z.number(),
    }).parse(await call(client, 'kiri_do', { operation: 'workflow.dispatch', params: { id: created.id } }))
    expect(dispatched).toMatchObject({ launched: 2, scratchpadOnly: 1, failed: 0 })

    const running = workflowDetailSchema.parse(
      await call(client, 'kiri_get', { operation: 'workflow.show', params: { id: created.id } }),
    )
    const implementer = running.items.find((item) => item.title === 'Implementer')?.activeAgentId
    const reviewer = running.items.find((item) => item.title === 'Adversarial reviewer')?.activeAgentId
    if (!implementer || !reviewer) throw new Error('Workflow dispatch did not record agent ids')
    expect(running.items.filter((item) => item.action === 'launch')
      .every((item) => item.status === 'running')).toBe(true)
    expect(running.items.find((item) => item.title === 'Implementer')?.attempts.at(0)?.status)
      .toBe('launched')

    // Both worker terminals come up (observed the way an agent would: wait-for).
    for (const agentId of [implementer, reviewer]) {
      const ready = waitForSchema.parse(await call(client, 'kiri_do', {
        operation: 'terminal.wait-for',
        params: { agentId, mode: 'runtime', pattern: 'fake-codex-terminal mode:fresh', timeoutMs: 20_000 },
      }))
      expect(ready.matched).toBe(true)
    }

    // The workflow body was handed to the worker at launch (long lines wrap
    // on screen, so match against the raw output window).
    expect(waitForSchema.parse(await call(client, 'kiri_do', {
      operation: 'terminal.wait-for',
      params: {
        agentId: implementer,
        mode: 'runtime',
        pattern: 'implement slugify in src/greet\\.js',
        scope: 'output',
        timeoutMs: 20_000,
      },
    })).matched).toBe(true)

    // Main agent assigns concrete work and waits for the response.
    await call(client, 'kiri_do', {
      operation: 'terminal.input',
      params: { agentId: implementer, text: 'implement slugify --emit-diff', submit: true },
    })
    const implemented = waitForSchema.parse(await call(client, 'kiri_do', {
      operation: 'terminal.wait-for',
      params: {
        agentId: implementer,
        mode: 'runtime',
        pattern: 'echo:implement slugify --emit-diff:session:[a-z0-9-]+',
        timeoutMs: 20_000,
      },
    }))
    expect(implemented.matched).toBe(true)
    const implementerReport = screenLine(
      await call(client, 'kiri_get', {
        operation: 'terminal.read',
        params: { agentId: implementer, mode: 'runtime' },
      }),
      /echo:implement slugify --emit-diff/,
    )

    // Adversarial review: the implementer's response is forwarded verbatim to
    // the reviewer agent, whose verdict the main agent waits on and reads.
    await call(client, 'kiri_do', {
      operation: 'terminal.keys',
      params: {
        agentId: reviewer,
        mode: 'runtime',
        text: `adversarial-review ${implementerReport}`,
        keys: ['enter'],
      },
    })
    const reviewed = waitForSchema.parse(await call(client, 'kiri_do', {
      operation: 'terminal.wait-for',
      params: {
        agentId: reviewer,
        mode: 'runtime',
        pattern: 'echo:adversarial-review echo:implement slugify',
        timeoutMs: 20_000,
      },
    }))
    expect(reviewed.matched).toBe(true)
    const verdict = screenLine(
      await call(client, 'kiri_get', {
        operation: 'terminal.read',
        params: { agentId: reviewer, mode: 'runtime' },
      }),
      /echo:adversarial-review/,
    )

    // The verdict round-trips to the implementer as a revision request.
    await call(client, 'kiri_do', {
      operation: 'terminal.input',
      params: { agentId: implementer, text: 'revise per-review pass-2', submit: true },
    })
    expect(waitForSchema.parse(await call(client, 'kiri_do', {
      operation: 'terminal.wait-for',
      params: {
        agentId: implementer,
        mode: 'runtime',
        pattern: 'echo:revise per-review pass-2',
        timeoutMs: 20_000,
      },
    })).matched).toBe(true)

    // The main agent reports the outcome on the shared scratchpad.
    await call(client, 'kiri_do', {
      operation: 'scratchpad.add',
      params: {
        projectId: 'playground',
        body: `[main-agent] implementer responded; reviewer verdict: ${verdict.slice(0, 200)}`,
      },
    })
    const scratchpad = z.array(z.object({ body: z.string() })).parse(
      await call(client, 'kiri_get', { operation: 'scratchpad.list', params: { projectId: 'playground' } }),
    )
    expect(scratchpad.some((block) => block.body.includes('reviewer verdict'))).toBe(true)
    // The workflow's own scratchpad item landed there too.
    expect(scratchpad.some((block) => block.body.includes('adversarial review required'))).toBe(true)

    // Observability: both workers are visible as live terminal sessions.
    const sessions = z.object({
      sessions: z.array(z.object({ key: z.string(), mode: z.string(), exited: z.boolean() })),
    }).parse(await call(client, 'kiri_get', { operation: 'terminal.list', params: {} }))
    expect(sessions.sessions.filter((session) => session.mode === 'runtime' && !session.exited))
      .toHaveLength(2)

    // Teardown through the same control plane.
    for (const agentId of [implementer, reviewer]) {
      await call(client, 'kiri_do', {
        operation: 'terminal.kill',
        params: { agentId, mode: 'runtime' },
      })
    }
    const after = z.object({ sessions: z.array(z.unknown()) }).parse(
      await call(client, 'kiri_get', { operation: 'terminal.list', params: {} }),
    )
    expect(after.sessions).toHaveLength(0)
  }, 120_000)

  it('spins a single agent from a scratchpad block and reads its terminal back', async () => {
    const { client, repo } = await startClient()
    await call(client, 'kiri_do', {
      operation: 'project.add',
      params: { id: 'playground', name: 'Kiriterm Playground', cwd: repo },
    })

    const block = z.object({ id: z.string() }).parse(await call(client, 'kiri_do', {
      operation: 'scratchpad.add',
      params: { projectId: 'playground', body: 'investigate flaky greet test' },
    }))

    const triggered = z.object({ agentId: z.string() }).parse(await call(client, 'kiri_do', {
      operation: 'scratchpad.trigger',
      params: {
        id: block.id,
        projectId: 'playground',
        runtime: 'codex',
        interfaceMode: 'terminal',
        title: 'Scratchpad investigation',
      },
    }))

    // The trigger queues the block body; terminal.spawn brings the PTY up.
    await call(client, 'kiri_do', {
      operation: 'terminal.spawn',
      params: { agentId: triggered.agentId },
    })
    expect(waitForSchema.parse(await call(client, 'kiri_do', {
      operation: 'terminal.wait-for',
      params: {
        agentId: triggered.agentId,
        mode: 'runtime',
        pattern: 'fake-codex-terminal mode:fresh',
        timeoutMs: 20_000,
      },
    })).matched).toBe(true)
    // The scratchpad body was queued into the spawned terminal at launch.
    expect(waitForSchema.parse(await call(client, 'kiri_do', {
      operation: 'terminal.wait-for',
      params: {
        agentId: triggered.agentId,
        mode: 'runtime',
        pattern: 'investigate flaky greet test',
        scope: 'output',
        timeoutMs: 20_000,
      },
    })).matched).toBe(true)

    await call(client, 'kiri_do', {
      operation: 'terminal.kill',
      params: { agentId: triggered.agentId, mode: 'runtime' },
    })
  }, 120_000)
})
