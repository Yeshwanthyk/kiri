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
  }, 20_000)
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
