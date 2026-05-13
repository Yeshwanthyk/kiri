import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

const projectRoot = process.cwd()
const tempRoots: string[] = []
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
const scratchpadRowsSchema = z.array(scratchpadBlockSchema)

describe('kirictl', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('manages models, projects, and sessions through JSON commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'kirictl-'))
    tempRoots.push(root)
    const env = {
      ...process.env,
      KIRI_ROOT_DIR: root,
      KIRI_DB_PATH: join(root, 'kiri.sqlite'),
      KIRI_STATE_DIR: join(root, 'state'),
      KIRI_SETTINGS_PATH: resolve(projectRoot, 'settings.json'),
    }

    const models = modelRowsSchema.parse(runJson(env, ['models', 'list', '--runtime', 'pi', '--json']))
    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runtime: 'pi',
        model: 'openai-codex/gpt-5.5',
        isDefault: true,
      }),
    ]))

    const project = projectSummarySchema.parse(runJson(env, [
      'projects',
      'add',
      '--name',
      'CLI Project',
      '--cwd',
      projectRoot,
      '--id',
      'cli-project',
      '--json',
    ]))
    expect(project).toMatchObject({
      id: 'cli-project',
      name: 'CLI Project',
      hidden: false,
      sessionCount: 0,
    })

    const session = sessionSummarySchema.parse(runJson(env, [
      'sessions',
      'create',
      '--project',
      'cli-project',
      '--runtime',
      'pi',
      '--model',
      'openai-codex/gpt-5.5',
      '--title',
      'CLI Session',
      '--json',
    ]))
    expect(session).toMatchObject({
      projectId: 'cli-project',
      title: 'CLI Session',
      runtime: 'pi',
      model: 'openai-codex/gpt-5.5',
      archivedAt: null,
    })

    const renamed = sessionSummarySchema.parse(runJson(env, [
      'sessions',
      'rename',
      '--agent',
      session.id,
      '--title',
      'Renamed Session',
      '--json',
    ]))
    expect(renamed.title).toBe('Renamed Session')

    const archived = sessionSummarySchema.parse(runJson(env, [
      'sessions',
      'delete',
      '--agent',
      session.id,
      '--yes',
      '--json',
    ]))
    expect(archived.archivedAt).toEqual(expect.any(String))

    const restored = sessionSummarySchema.parse(runJson(env, [
      'sessions',
      'resume',
      '--agent',
      session.id,
      '--json',
    ]))
    expect(restored.archivedAt).toBeNull()

    const block = scratchpadBlockSchema.parse(runJson(env, [
      'scratchpad',
      'add',
      '--project',
      project.id,
      '--body',
      'CLI scratchpad block',
      '--json',
    ]))
    expect(block).toMatchObject({
      projectId: project.id,
      body: 'CLI scratchpad block',
      triggeredAt: null,
    })

    const blocks = scratchpadRowsSchema.parse(runJson(env, [
      'scratchpad',
      'list',
      '--project',
      project.id,
      '--json',
    ]))
    expect(blocks.map((item) => item.id)).toContain(block.id)

    const deletedBlock = scratchpadBlockSchema.parse(runJson(env, [
      'scratchpad',
      'delete',
      '--id',
      block.id,
      '--json',
    ]))
    expect(deletedBlock.id).toBe(block.id)
  }, 20_000)

})

function runJson(env: NodeJS.ProcessEnv, args: string[]) {
  const output = execFileSync(
    'pnpm',
    ['exec', 'tsx', 'src/cli/kirictl.ts', ...args],
    {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
    },
  )
  return JSON.parse(output) as unknown
}
