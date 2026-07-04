import { createServer, type Server } from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { backendControlTimeoutMsForTests, runKiriOperationRequest, runKiriOperationWithBackendFallback } from '~/cli/kirictl'
import { closeTerminalServerForTests } from '~/server/terminal-server'
import { runTsxJsonWithArgs } from '../harness/run-tsx'

const projectRoot = process.cwd()
const tempRoots: string[] = []

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
const modelRowsSchema = z.array(z.object({
  runtime: z.string(),
  model: z.string(),
  isDefault: z.boolean(),
  contextWindow: z.number().nullable(),
}))
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
const spawnResultSchema = z.object({
  session: sessionSummarySchema,
  delivery: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('agentPrompt'),
      accepted: z.literal(true),
      agentId: z.string(),
      mode: z.string(),
    }),
    z.object({
      kind: z.literal('terminal'),
      accepted: z.literal(true),
      agentId: z.string(),
      queued: z.literal(true),
      spawned: z.boolean(),
    }),
  ]),
})
const workflowItemSchema = z.object({
  id: z.string(),
  runId: z.string(),
  clientId: z.string().nullable(),
  action: z.string(),
  title: z.string(),
  body: z.string(),
  runtime: z.string().nullable(),
  interfaceMode: z.string().nullable(),
  model: z.string().nullable(),
  terminalPaste: z.object({ submit: z.boolean() }).nullable(),
  scratchpadBlockId: z.string().nullable(),
  activeAgentId: z.string().nullable(),
  tracked: z.boolean(),
  status: z.string(),
  attempts: z.array(z.object({
    id: z.string(),
    agentId: z.string().nullable(),
    status: z.string(),
  })),
})
const workflowRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  status: z.string(),
  itemCount: z.number(),
  launchedCount: z.number(),
  failedCount: z.number(),
  archivedAt: z.string().nullable(),
  items: z.array(workflowItemSchema),
})
const workflowSummarySchema = workflowRunSchema.omit({ items: true })

describe('kirictl call', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('routes workflow dispatch through a running backend control endpoint when available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kirictl-proxy-'))
    tempRoots.push(root)
    const token = 'test-token'
    const requests: Array<{
      authorization: string | undefined
      controlVersion: string | undefined
      body: unknown
    }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk: Buffer) => {
        body += String(chunk)
      })
      request.on('end', () => {
        const parsedBody: unknown = JSON.parse(body)
        requests.push({
          authorization: request.headers.authorization,
          controlVersion: request.headers['x-kiri-control-version'] as string | undefined,
          body: parsedBody,
        })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          ok: true,
          operation: 'workflow.dispatch',
          result: {
            id: 'workflow-proxy',
            status: 'running',
            launched: 1,
            scratchpadOnly: 0,
            failed: 0,
            results: [{
              itemId: 'terminal-build',
              status: 'launched',
              agentId: 'session-proxy',
              terminalPaste: {
                queued: true,
                submitted: false,
                bytes: 13,
              },
              terminalSpawn: {
                agentId: 'session-proxy',
                mode: 'runtime',
              },
            }],
          },
        }))
      })
    })
    const port = await listen(server)
    try {
      writeFileSync(join(root, 'backend-control.json'), JSON.stringify({
        url: `http://127.0.0.1:${port}/`,
        token,
      }))
      const previousEnv = {
        KIRI_DISABLE_BACKEND_PROXY: process.env.KIRI_DISABLE_BACKEND_PROXY,
        KIRI_BACKEND_CONTROL_PATH: process.env.KIRI_BACKEND_CONTROL_PATH,
      }
      process.env.KIRI_DISABLE_BACKEND_PROXY = '0'
      process.env.KIRI_BACKEND_CONTROL_PATH = join(root, 'backend-control.json')
      const response = responseSchema.parse(
        await runKiriOperationWithBackendFallback({} as never, {
          operation: 'workflow.dispatch',
          params: { id: 'workflow-proxy' },
        }).finally(() => {
          restoreEnv('KIRI_DISABLE_BACKEND_PROXY', previousEnv.KIRI_DISABLE_BACKEND_PROXY)
          restoreEnv('KIRI_BACKEND_CONTROL_PATH', previousEnv.KIRI_BACKEND_CONTROL_PATH)
        }),
      )
      if (!response.ok) throw new Error(response.error.message)
      expect(response.result).toMatchObject({
        id: 'workflow-proxy',
        status: 'running',
        launched: 1,
        results: [{
          terminalPaste: {
            queued: true,
            submitted: false,
            bytes: 13,
          },
          terminalSpawn: {
            agentId: 'session-proxy',
            mode: 'runtime',
          },
        }],
      })
      expect(requests).toEqual([{
        authorization: `Bearer ${token}`,
        controlVersion: '1',
        body: {
          operation: 'workflow.dispatch',
          params: { id: 'workflow-proxy' },
        },
      }])
    } finally {
      await close(server)
    }
  })

  it('does not fall back to local execution when backend control rejects auth', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kirictl-proxy-auth-'))
    tempRoots.push(root)
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
    })
    const port = await listen(server)
    try {
      writeFileSync(join(root, 'backend-control.json'), JSON.stringify({
        url: `http://127.0.0.1:${port}/`,
        token: 'stale-token',
      }))
      const previousEnv = {
        KIRI_DISABLE_BACKEND_PROXY: process.env.KIRI_DISABLE_BACKEND_PROXY,
        KIRI_BACKEND_CONTROL_PATH: process.env.KIRI_BACKEND_CONTROL_PATH,
      }
      process.env.KIRI_DISABLE_BACKEND_PROXY = '0'
      process.env.KIRI_BACKEND_CONTROL_PATH = join(root, 'backend-control.json')
      const response = responseSchema.parse(
        await runKiriOperationWithBackendFallback({} as never, {
          operation: 'workflow.dispatch',
          params: { id: 'workflow-proxy' },
        }).finally(() => {
          restoreEnv('KIRI_DISABLE_BACKEND_PROXY', previousEnv.KIRI_DISABLE_BACKEND_PROXY)
          restoreEnv('KIRI_BACKEND_CONTROL_PATH', previousEnv.KIRI_BACKEND_CONTROL_PATH)
        }),
      )
      expect(response.ok).toBe(false)
      expect(response.operation).toBe('workflow.dispatch')
      if (!response.ok) {
        expect(response.error.code).toBe('BACKEND_CONTROL_UNAUTHORIZED')
        expect(response.error.message).toContain('401')
      }
    } finally {
      await close(server)
    }
  })

  it('falls back to local reads when configured backend control is unreachable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kirictl-proxy-unreachable-'))
    tempRoots.push(root)
    writeFileSync(join(root, 'backend-control.json'), JSON.stringify({
      url: 'http://127.0.0.1:1/',
      token: 'missing-backend',
    }))
    const previousEnv = {
      KIRI_DISABLE_BACKEND_PROXY: process.env.KIRI_DISABLE_BACKEND_PROXY,
      KIRI_BACKEND_CONTROL_PATH: process.env.KIRI_BACKEND_CONTROL_PATH,
    }
    process.env.KIRI_DISABLE_BACKEND_PROXY = '0'
    process.env.KIRI_BACKEND_CONTROL_PATH = join(root, 'backend-control.json')
    const response = responseSchema.parse(
      await runKiriOperationWithBackendFallback({} as never, {
        operation: 'operations.list',
      }).finally(() => {
        restoreEnv('KIRI_DISABLE_BACKEND_PROXY', previousEnv.KIRI_DISABLE_BACKEND_PROXY)
        restoreEnv('KIRI_BACKEND_CONTROL_PATH', previousEnv.KIRI_BACKEND_CONTROL_PATH)
      }),
    )
    expect(response.ok).toBe(true)
    expect(response.operation).toBe('operations.list')
  })

  it('falls back locally and removes a stale backend control file when its pid is dead', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kirictl-proxy-stale-pid-'))
    tempRoots.push(root)
    const controlPath = join(root, 'backend-control.json')
    writeFileSync(controlPath, JSON.stringify({
      url: 'http://127.0.0.1:1/',
      token: 'missing-backend',
      pid: 999_999_999,
    }))
    const previousEnv = {
      KIRI_DISABLE_BACKEND_PROXY: process.env.KIRI_DISABLE_BACKEND_PROXY,
      KIRI_BACKEND_CONTROL_PATH: process.env.KIRI_BACKEND_CONTROL_PATH,
    }
    process.env.KIRI_DISABLE_BACKEND_PROXY = '0'
    process.env.KIRI_BACKEND_CONTROL_PATH = controlPath
    const response = responseSchema.parse(
      await runKiriOperationWithBackendFallback({} as never, {
        operation: 'operations.list',
      }).finally(() => {
        restoreEnv('KIRI_DISABLE_BACKEND_PROXY', previousEnv.KIRI_DISABLE_BACKEND_PROXY)
        restoreEnv('KIRI_BACKEND_CONTROL_PATH', previousEnv.KIRI_BACKEND_CONTROL_PATH)
      }),
    )
    expect(response.ok).toBe(true)
    expect(response.operation).toBe('operations.list')
    expect(() => readFileSync(controlPath, 'utf8')).toThrow()
  })

  it('refuses local writes when a live backend pid has an unreachable endpoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kirictl-proxy-live-pid-'))
    tempRoots.push(root)
    writeFileSync(join(root, 'backend-control.json'), JSON.stringify({
      url: 'http://127.0.0.1:1/',
      token: 'missing-backend',
      pid: process.pid,
    }))
    const previousEnv = {
      KIRI_DISABLE_BACKEND_PROXY: process.env.KIRI_DISABLE_BACKEND_PROXY,
      KIRI_BACKEND_CONTROL_PATH: process.env.KIRI_BACKEND_CONTROL_PATH,
    }
    process.env.KIRI_DISABLE_BACKEND_PROXY = '0'
    process.env.KIRI_BACKEND_CONTROL_PATH = join(root, 'backend-control.json')
    const response = responseSchema.parse(
      await runKiriOperationWithBackendFallback({} as never, {
        operation: 'workflow.dispatch',
        params: { id: 'workflow-proxy' },
      }).finally(() => {
        restoreEnv('KIRI_DISABLE_BACKEND_PROXY', previousEnv.KIRI_DISABLE_BACKEND_PROXY)
        restoreEnv('KIRI_BACKEND_CONTROL_PATH', previousEnv.KIRI_BACKEND_CONTROL_PATH)
      }),
    )
    expect(response).toMatchObject({
      ok: false,
      operation: 'workflow.dispatch',
      error: {
        code: 'BACKEND_ALIVE_LOCAL_WRITE_REFUSED',
      },
    })
  })

  it('refuses local writes when backend liveness is unknown and the endpoint is unreachable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kirictl-proxy-unknown-pid-'))
    tempRoots.push(root)
    writeFileSync(join(root, 'backend-control.json'), JSON.stringify({
      url: 'http://127.0.0.1:1/',
      token: 'missing-backend',
    }))
    const previousEnv = {
      KIRI_DISABLE_BACKEND_PROXY: process.env.KIRI_DISABLE_BACKEND_PROXY,
      KIRI_BACKEND_CONTROL_PATH: process.env.KIRI_BACKEND_CONTROL_PATH,
    }
    process.env.KIRI_DISABLE_BACKEND_PROXY = '0'
    process.env.KIRI_BACKEND_CONTROL_PATH = join(root, 'backend-control.json')
    const response = responseSchema.parse(
      await runKiriOperationWithBackendFallback({} as never, {
        operation: 'workflow.dispatch',
        params: { id: 'workflow-proxy' },
      }).finally(() => {
        restoreEnv('KIRI_DISABLE_BACKEND_PROXY', previousEnv.KIRI_DISABLE_BACKEND_PROXY)
        restoreEnv('KIRI_BACKEND_CONTROL_PATH', previousEnv.KIRI_BACKEND_CONTROL_PATH)
      }),
    )
    expect(response).toMatchObject({
      ok: false,
      operation: 'workflow.dispatch',
      error: {
        code: 'BACKEND_ALIVE_LOCAL_WRITE_REFUSED',
      },
    })
  })

  it('reports a timeout instead of unreachable when backend control is slow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kirictl-proxy-timeout-'))
    tempRoots.push(root)
    const server = createServer(() => {
      // Never respond; the client must abort via its own timeout.
    })
    const port = await listen(server)
    try {
      writeFileSync(join(root, 'backend-control.json'), JSON.stringify({
        url: `http://127.0.0.1:${port}/`,
        token: 'slow-backend',
      }))
      const previousEnv = snapshotEnv([
        'KIRI_DISABLE_BACKEND_PROXY',
        'KIRI_BACKEND_CONTROL_PATH',
        'KIRI_BACKEND_CONTROL_TIMEOUT_MS',
      ])
      process.env.KIRI_DISABLE_BACKEND_PROXY = '0'
      process.env.KIRI_BACKEND_CONTROL_PATH = join(root, 'backend-control.json')
      process.env.KIRI_BACKEND_CONTROL_TIMEOUT_MS = '100'
      const response = responseSchema.parse(
        await runKiriOperationWithBackendFallback({} as never, {
          operation: 'agent.prompt',
          params: { agentId: 'agent-1', text: 'hello' },
        }).finally(() => {
          restoreEnvSnapshot(previousEnv)
        }),
      )
      expect(response).toMatchObject({
        ok: false,
        operation: 'agent.prompt',
        error: {
          code: 'BACKEND_CONTROL_TIMEOUT',
        },
      })
      if (!response.ok) {
        expect(response.error.message).toContain('may still be running')
      }
    } finally {
      server.closeAllConnections?.()
      await close(server)
    }
  })

  it('adds wait-operation timeout grace unless an explicit proxy timeout is set', () => {
    const previousEnv = process.env.KIRI_BACKEND_CONTROL_TIMEOUT_MS
    try {
      delete process.env.KIRI_BACKEND_CONTROL_TIMEOUT_MS
      expect(backendControlTimeoutMsForTests({
        operation: 'terminal.wait-for',
        params: { timeoutMs: 30_000 },
      })).toBe(35_000)
      expect(backendControlTimeoutMsForTests({
        operation: 'workflow.await',
        params: { timeoutMs: 600_000 },
      })).toBe(605_000)
      process.env.KIRI_BACKEND_CONTROL_TIMEOUT_MS = '1234'
      expect(backendControlTimeoutMsForTests({
        operation: 'terminal.wait-for',
        params: { timeoutMs: 30_000 },
      })).toBe(1234)
    } finally {
      restoreEnv('KIRI_BACKEND_CONTROL_TIMEOUT_MS', previousEnv)
    }
  })

  it('spawns and pastes terminal workflow input through a real PTY when backend-owned spawning is enabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kirictl-terminal-spawn-'))
    tempRoots.push(root)
    const capturePath = join(root, 'terminal-capture.txt')
    const fakePiPath = join(root, 'fake-pi.sh')
    writeFileSync(fakePiPath, [
      '#!/bin/sh',
      'IFS= read -r line',
      'printf "%s" "$line" > "$KIRI_TERMINAL_CAPTURE"',
      'sleep 20',
    ].join('\n'))
    chmodSync(fakePiPath, 0o755)
    const previousEnv = snapshotEnv([
      'KIRI_ROOT_DIR',
      'KIRI_DB_PATH',
      'KIRI_STATE_DIR',
      'KIRI_SETTINGS_PATH',
      'KIRI_PI_BIN',
      'KIRI_TERMINAL_CAPTURE',
      'KIRI_WORKFLOW_SPAWN_TERMINALS',
    ])

    try {
      process.env.KIRI_ROOT_DIR = root
      process.env.KIRI_DB_PATH = join(root, 'kiri.sqlite')
      process.env.KIRI_STATE_DIR = join(root, 'state')
      process.env.KIRI_SETTINGS_PATH = resolve(projectRoot, 'settings.json')
      process.env.KIRI_PI_BIN = fakePiPath
      process.env.KIRI_TERMINAL_CAPTURE = capturePath
      process.env.KIRI_WORKFLOW_SPAWN_TERMINALS = '1'

      const project = projectSummarySchema.parse(await operationResult({
        operation: 'project.add',
        params: {
          id: 'spawn-project',
          name: 'Spawn Project',
          cwd: projectRoot,
        },
      }))
      const workflow = workflowRunSchema.parse(await operationResult({
        operation: 'workflow.create',
        params: {
          projectId: project.id,
          title: 'Spawn Workflow',
          defaults: {
            runtime: 'pi',
            interfaceMode: 'terminal',
            model: 'openai-codex/gpt-5.5',
            attachScratchpad: false,
            terminalPaste: { submit: true },
          },
          items: [{
            id: 'terminal',
            action: 'launch',
            title: 'Spawn Terminal',
            body: 'spawn terminal workflow',
          }],
        },
      }))
      const dispatch = z.object({
        launched: z.number(),
        results: z.array(z.object({
          terminalPaste: z.object({
            queued: z.boolean(),
            submitted: z.boolean(),
            bytes: z.number(),
          }),
          terminalSpawn: z.object({
            agentId: z.string(),
            mode: z.literal('runtime'),
          }),
        }).passthrough()),
      }).parse(await operationResult({
        operation: 'workflow.dispatch',
        params: { id: workflow.id },
      }))

      expect(dispatch).toMatchObject({
        launched: 1,
        results: [{
          terminalPaste: {
            queued: true,
            submitted: true,
            bytes: 'spawn terminal workflow'.length + 1,
          },
          terminalSpawn: {
            mode: 'runtime',
          },
        }],
      })
      await expect.poll(() => readFileSync(capturePath, 'utf8')).toBe('spawn terminal workflow')
    } finally {
      await closeTerminalServerForTests()
      restoreEnvSnapshot(previousEnv)
    }
  })

  it('runs compact JSON operations for models, projects, sessions, and scratchpad', () => {
    const root = mkdtempSync(join(tmpdir(), 'kirictl-'))
    tempRoots.push(root)
    const env = {
      ...process.env,
      KIRI_ROOT_DIR: root,
      KIRI_DB_PATH: join(root, 'kiri.sqlite'),
      KIRI_STATE_DIR: join(root, 'state'),
      KIRI_SETTINGS_PATH: resolve(projectRoot, 'settings.json'),
    }

    const models = modelRowsSchema.parse(callResult(env, {
      operation: 'model.list',
      params: { runtime: 'pi' },
    }))
    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runtime: 'pi',
        model: 'openai-codex/gpt-5.5',
        isDefault: true,
      }),
    ]))

    const project = projectSummarySchema.parse(callResult(env, {
      operation: 'project.add',
      params: {
        id: 'cli-project',
        name: 'CLI Project',
        cwd: projectRoot,
      },
    }))
    expect(project).toMatchObject({
      id: 'cli-project',
      hidden: false,
      sessionCount: 0,
    })

    const session = sessionSummarySchema.parse(callResult(env, {
      operation: 'session.create',
      params: {
        projectId: project.id,
        runtime: 'pi',
        model: 'openai-codex/gpt-5.5',
        title: 'CLI Session',
      },
    }))
    expect(session).toMatchObject({
      projectId: project.id,
      title: 'CLI Session',
      runtime: 'pi',
      archivedAt: null,
    })

    expect(spawnResultSchema.parse(callResult(env, {
      operation: 'session.spawn',
      params: {
        projectId: project.id,
        runtime: 'pi',
        model: 'openai-codex/gpt-5.5',
        title: 'CLI Spawn',
        text: 'spawn from cli',
        terminalSpawn: false,
      },
    }))).toMatchObject({
      session: {
        projectId: project.id,
        title: 'CLI Spawn',
        runtime: 'pi',
      },
      delivery: {
        kind: 'terminal',
        accepted: true,
        queued: true,
        spawned: false,
      },
    })

    const renamed = sessionSummarySchema.parse(callResult(env, {
      operation: 'session.rename',
      params: {
        agentId: session.id,
        title: 'Renamed Session',
      },
    }))
    expect(renamed.title).toBe('Renamed Session')

    const block = scratchpadBlockSchema.parse(callResult(env, {
      operation: 'scratchpad.add',
      params: {
        projectId: project.id,
        body: 'CLI scratchpad block',
      },
    }))
    expect(block).toMatchObject({
      projectId: project.id,
      body: 'CLI scratchpad block',
      triggeredAt: null,
    })

    const listedBlocks = z.array(scratchpadBlockSchema).parse(callResult(env, {
      operation: 'scratchpad.list',
      params: { projectId: project.id },
    }))
    expect(listedBlocks.map((item) => item.id)).toContain(block.id)

    expect(callResult(env, {
      operation: 'workflow.validate',
      params: {
        projectId: project.id,
        title: 'CLI Workflow',
        defaults: {
          runtime: 'pi',
          model: 'openai-codex/gpt-5.5',
          attachScratchpad: true,
        },
        items: [{
          id: 'build',
          action: 'launch',
          title: 'Build',
          body: 'Build this in parallel',
        }, {
          id: 'note',
          action: 'scratchpad',
          title: 'Note',
          body: 'Track this note',
        }],
      },
    })).toMatchObject({
      valid: true,
      launchCount: 1,
      scratchpadCount: 2,
    })

    const workflow = workflowRunSchema.parse(callResult(env, {
      operation: 'workflow.create',
      params: {
        projectId: project.id,
        title: 'CLI Workflow',
        defaults: {
          runtime: 'pi',
          model: 'openai-codex/gpt-5.5',
          attachScratchpad: true,
        },
        items: [{
          id: 'build',
          action: 'launch',
          title: 'Build',
          body: 'Build this in parallel',
        }, {
          id: 'note',
          action: 'scratchpad',
          title: 'Note',
          body: 'Track this note',
        }],
      },
    }))
    expect(workflow).toMatchObject({
      projectId: project.id,
      status: 'validated',
      itemCount: 2,
      launchedCount: 0,
    })
    expect(workflow.items.map((item) => item.scratchpadBlockId)).toEqual([
      expect.any(String),
      expect.any(String),
    ])

    const dispatch = z.object({
      id: z.string(),
      status: z.string(),
      launched: z.number(),
      scratchpadOnly: z.number(),
      failed: z.number(),
      results: z.array(z.object({
        itemId: z.string(),
        status: z.string(),
        agentId: z.string().optional(),
      }).passthrough()),
    }).parse(callResult(env, {
      operation: 'workflow.dispatch',
      params: { id: workflow.id },
    }))
    expect(dispatch).toMatchObject({
      id: workflow.id,
      status: 'running',
      launched: 1,
      scratchpadOnly: 1,
      failed: 0,
    })

    const shownWorkflow = workflowRunSchema.parse(callResult(env, {
      operation: 'workflow.show',
      params: { id: workflow.id },
    }))
    expect(shownWorkflow.launchedCount).toBe(1)
    expect(shownWorkflow.items.find((item) => item.action === 'launch')?.activeAgentId)
      .toEqual(expect.any(String))
    expect(shownWorkflow.items.find((item) => item.action === 'scratchpad')?.status)
      .toBe('completed')

    const workflows = z.array(workflowSummarySchema).parse(callResult(env, {
      operation: 'workflow.list',
      params: { projectId: project.id },
    }))
    expect(workflows.map((item) => item.id)).toContain(workflow.id)

    expect(workflowItemSchema.parse(callResult(env, {
      operation: 'workflow.untrack',
      params: { itemId: shownWorkflow.items[0]?.id },
    }))).toMatchObject({
      tracked: false,
      status: 'untracked',
    })
    expect(workflowItemSchema.parse(callResult(env, {
      operation: 'workflow.track',
      params: { itemId: shownWorkflow.items[0]?.id },
    }))).toMatchObject({
      tracked: true,
      status: 'running',
    })
    const scratchpadItem = shownWorkflow.items.find((item) => item.action === 'scratchpad')
    const scratchpadRetrigger = responseSchema.parse(runTsxJsonWithArgs(
      'src/cli/kirictl.ts',
      ['call', JSON.stringify({
        operation: 'workflow.retrigger',
        params: { itemId: scratchpadItem?.id },
      })],
      (output) => output,
      {
        cwd: projectRoot,
        env,
      },
    ))
    expect(scratchpadRetrigger.ok).toBe(false)
    expect(scratchpadRetrigger.operation).toBe('workflow.retrigger')
    if (!scratchpadRetrigger.ok) {
      expect(scratchpadRetrigger.error.message).toContain('not launchable')
    }

    const archivedWorkflow = workflowRunSchema.parse(callResult(env, {
      operation: 'workflow.archive',
      params: { id: workflow.id },
    }))
    expect(typeof archivedWorkflow.archivedAt).toBe('string')
    const archivedDispatch = responseSchema.parse(runTsxJsonWithArgs(
      'src/cli/kirictl.ts',
      ['call', JSON.stringify({
        operation: 'workflow.dispatch',
        params: { id: workflow.id },
      })],
      (output) => output,
      {
        cwd: projectRoot,
        env,
      },
    ))
    expect(archivedDispatch.ok).toBe(false)
    expect(archivedDispatch.operation).toBe('workflow.dispatch')
    if (!archivedDispatch.ok) {
      expect(archivedDispatch.error.message).toContain('archived')
    }
    expect(workflowRunSchema.parse(callResult(env, {
      operation: 'workflow.restore',
      params: { id: workflow.id },
    })).archivedAt).toBeNull()

    const terminalWorkflow = workflowRunSchema.parse(callResult(env, {
      operation: 'workflow.create',
      params: {
        projectId: project.id,
        title: 'CLI Terminal Workflow',
        defaults: {
          runtime: 'pi',
          interfaceMode: 'terminal',
          model: 'openai-codex/gpt-5.5',
          attachScratchpad: false,
          terminalPaste: { submit: false },
        },
        items: [{
          id: 'terminal-build',
          action: 'launch',
          title: 'Terminal Build',
          body: 'run terminal workflow',
        }],
      },
    }))
    const terminalDispatch = z.object({
      launched: z.number(),
      results: z.array(z.object({
        status: z.string(),
        terminalPaste: z.object({
          queued: z.boolean(),
          submitted: z.boolean(),
          bytes: z.number(),
        }).nullable(),
      }).passthrough()),
    }).parse(callResult(env, {
      operation: 'workflow.dispatch',
      params: { id: terminalWorkflow.id },
    }))
    expect(terminalDispatch).toMatchObject({
      launched: 1,
      results: [{
        status: 'launched',
        terminalPaste: {
          queued: true,
          submitted: false,
          bytes: 'run terminal workflow'.length,
        },
      }],
    })

    const archived = sessionSummarySchema.parse(callResult(env, {
      operation: 'session.archive',
      params: { agentId: session.id },
    }))
    expect(archived.archivedAt).toEqual(expect.any(String))

    const restored = sessionSummarySchema.parse(callResult(env, {
      operation: 'session.restore',
      params: { agentId: session.id },
    }))
    expect(restored.archivedAt).toBeNull()

    const operations = z.object({
      read: z.array(z.string()),
      write: z.array(z.string()),
      schemas: z.record(z.string(), z.unknown()),
    }).parse(callResult(env, {
      operation: 'operations.list',
    }))
    expect(operations.write).toContain('agent.interrupt')
    expect(operations.write).toContain('session.delete')
    expect(operations.schemas['session.spawn']).toEqual(expect.objectContaining({
      type: 'object',
    }))

    const missingConfirmDelete = responseSchema.parse(runTsxJsonWithArgs(
      'src/cli/kirictl.ts',
      ['call', JSON.stringify({
        operation: 'session.delete',
        params: { agentId: session.id },
      })],
      (output) => output,
      {
        cwd: projectRoot,
        env,
      },
    ))
    expect(missingConfirmDelete.ok).toBe(false)
    expect(missingConfirmDelete.operation).toBe('session.delete')

    const unarchivedDelete = responseSchema.parse(runTsxJsonWithArgs(
      'src/cli/kirictl.ts',
      ['call', JSON.stringify({
        operation: 'session.delete',
        params: { agentId: session.id, confirm: true },
      })],
      (output) => output,
      {
        cwd: projectRoot,
        env,
      },
    ))
    expect(unarchivedDelete.ok).toBe(false)
    if (!unarchivedDelete.ok) {
      expect(unarchivedDelete.error.message).toContain('must be archived')
    }

    sessionSummarySchema.parse(callResult(env, {
      operation: 'session.archive',
      params: { agentId: session.id },
    }))
    expect(z.object({
      agentId: z.string(),
      deleted: z.literal(true),
    }).parse(callResult(env, {
      operation: 'session.delete',
      params: { agentId: session.id, confirm: true },
    }))).toEqual({ agentId: session.id, deleted: true })
    const sessionsAfterHardDelete = z.array(sessionSummarySchema).parse(callResult(env, {
      operation: 'session.list',
      params: { includeArchived: true },
    }))
    expect(sessionsAfterHardDelete.map((item) => item.id)).not.toContain(session.id)

    const malformed = responseSchema.parse(runTsxJsonWithArgs(
      'src/cli/kirictl.ts',
      ['call', '{nope'],
      (output) => output,
      {
        cwd: projectRoot,
        env,
      },
    ))
    expect(malformed).toMatchObject({
      ok: false,
      operation: 'operations.list',
      error: { code: 'INVALID_JSON' },
    })
  }, 40_000)
})

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

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

function snapshotEnv(names: readonly string[]) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]))
}

function restoreEnvSnapshot(snapshot: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(snapshot)) {
    restoreEnv(name, value)
  }
}

async function operationResult(request: unknown) {
  const response = responseSchema.parse(await runKiriOperationRequest(request))
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}

function callResult(env: NodeJS.ProcessEnv, request: unknown) {
  const response = responseSchema.parse(runTsxJsonWithArgs(
    'src/cli/kirictl.ts',
    ['call', JSON.stringify(request)],
    (output) => output,
    {
      cwd: projectRoot,
      env,
    },
  ))
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}
