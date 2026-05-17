import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
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
    expect(responseSchema.parse(runTsxJsonWithArgs(
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
    ))).toMatchObject({
      ok: false,
      operation: 'workflow.retrigger',
      error: { message: expect.stringContaining('not launchable') },
    })

    expect(workflowRunSchema.parse(callResult(env, {
      operation: 'workflow.archive',
      params: { id: workflow.id },
    })).archivedAt).toEqual(expect.any(String))
    expect(responseSchema.parse(runTsxJsonWithArgs(
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
    ))).toMatchObject({
      ok: false,
      operation: 'workflow.dispatch',
      error: { message: expect.stringContaining('archived') },
    })
    expect(workflowRunSchema.parse(callResult(env, {
      operation: 'workflow.restore',
      params: { id: workflow.id },
    })).archivedAt).toBeNull()

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
