import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tempRoot = mkdtempSync(join(tmpdir(), 'kiri-agent-harness-'))
const env = {
  ...process.env,
  KIRI_ROOT_DIR: tempRoot,
  KIRI_DB_PATH: join(tempRoot, 'kiri.sqlite'),
  KIRI_STATE_DIR: join(tempRoot, 'state'),
  KIRI_SETTINGS_PATH: resolve(repoRoot, 'settings.json'),
}

const modelRowsSchema = z.array(z.object({
  runtime: z.string(),
  model: z.string(),
  isDefault: z.boolean(),
  contextWindow: z.number().nullable(),
}))

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  hidden: z.boolean(),
  sessionCount: z.number(),
})
const projectRowsSchema = z.array(projectSchema)

const sessionSchema = z.object({
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
const sessionRowsSchema = z.array(sessionSchema)

try {
  assertSkillTeachesAgents()

  const models = modelRowsSchema.parse(runCtl(['models', 'list', '--runtime', 'pi', '--json']))
  const kiriModels = modelRowsSchema.parse(runKiri(['models', 'list', '--runtime', 'pi', '--json']))
  const kiriCliModels = modelRowsSchema.parse(runKiriCli(['models', 'list', '--runtime', 'pi', '--json']))
  if (models.length !== kiriModels.length || models.length !== kiriCliModels.length) {
    throw new Error('Kiri CLI aliases do not return the same model set')
  }
  const defaultPiModel = models.find((model) => model.runtime === 'pi' && model.isDefault)
  if (!defaultPiModel) throw new Error('No default pi model found')

  const primary = projectSchema.parse(runCtl([
    'projects',
    'add',
    '--name',
    'Agent Harness Primary',
    '--cwd',
    repoRoot,
    '--id',
    'agent-harness-primary',
    '--json',
  ]))
  if (primary.id !== 'agent-harness-primary' || primary.hidden) {
    throw new Error('Primary project was not added as visible')
  }

  const secondary = projectSchema.parse(runCtl([
    'projects',
    'add',
    '--name',
    'Agent Harness Secondary',
    '--cwd',
    repoRoot,
    '--id',
    'agent-harness-secondary',
    '--json',
  ]))
  if (secondary.id !== 'agent-harness-secondary') {
    throw new Error('Secondary project was not added')
  }

  const hidden = projectSchema.parse(runCtl([
    'projects',
    'hide',
    '--id',
    secondary.id,
    '--json',
  ]))
  if (!hidden.hidden) throw new Error('Secondary project was not hidden')

  const unhidden = projectSchema.parse(runCtl([
    'projects',
    'unhide',
    '--id',
    secondary.id,
    '--json',
  ]))
  if (unhidden.hidden) throw new Error('Secondary project was not unhidden')

  const compatProjects = projectRowsSchema.parse(runProjectsCompat(['list', '--all', '--json']))
  if (!compatProjects.some((project) => project.id === primary.id)) {
    throw new Error('pnpm kiri:projects compatibility command did not see CLI-created project')
  }

  const session = sessionSchema.parse(runCtl([
    'sessions',
    'create',
    '--project',
    primary.id,
    '--runtime',
    defaultPiModel.runtime,
    '--model',
    defaultPiModel.model,
    '--title',
    'Agent Harness Session',
    '--json',
  ]))
  if (session.projectId !== primary.id || session.archivedAt !== null) {
    throw new Error('Session was not created as an active primary-project session')
  }

  const renamed = sessionSchema.parse(runCtl([
    'sessions',
    'rename',
    '--agent',
    session.id,
    '--title',
    'Agent Harness Session Renamed',
    '--json',
  ]))
  if (renamed.title !== 'Agent Harness Session Renamed') {
    throw new Error('Session rename did not persist')
  }

  const activeSessions = sessionRowsSchema.parse(runCtl([
    'sessions',
    'list',
    '--project',
    primary.id,
    '--json',
  ]))
  if (!activeSessions.some((candidate) => candidate.id === session.id)) {
    throw new Error('Session list did not include active session')
  }

  const archived = sessionSchema.parse(runCtl([
    'sessions',
    'delete',
    '--agent',
    session.id,
    '--yes',
    '--json',
  ]))
  if (archived.archivedAt === null) throw new Error('Session delete did not archive')

  const restored = sessionSchema.parse(runCtl([
    'sessions',
    'resume',
    '--agent',
    session.id,
    '--json',
  ]))
  if (restored.archivedAt !== null) throw new Error('Session resume did not restore')

  const deleted = projectSchema.parse(runCtl([
    'projects',
    'delete',
    '--id',
    secondary.id,
    '--yes',
    '--json',
  ]))
  if (deleted.id !== secondary.id) throw new Error('Project delete returned the wrong project')

  process.stdout.write(JSON.stringify({
    ok: true,
    checked: [
      'skill',
      'models',
      'kiri alias',
      'kiricli alias',
      'projects:add',
      'projects:hide',
      'projects:unhide',
      'projects:delete',
      'sessions:create',
      'sessions:rename',
      'sessions:delete',
      'sessions:resume',
      'kiri:projects compatibility',
    ],
    projectId: primary.id,
    sessionId: session.id,
  }, null, 2))
  process.stdout.write('\n')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertSkillTeachesAgents() {
  const body = readFileSync(resolve(repoRoot, '.agents/skills/kiri-control/SKILL.md'), 'utf8')
  const required = [
    'pnpm kiri models list --json',
    'pnpm kiricli',
    'pnpm kiri:ctl models list --json',
    'pnpm kiri:ctl projects add',
    'pnpm kiri:ctl sessions create',
    'pnpm kiri:ctl sessions rename',
    'pnpm kiri:ctl sessions delete',
    'pnpm kiri:ctl sessions resume',
  ]
  for (const phrase of required) {
    if (body.search(escapedPhrasePattern(phrase)) === -1) {
      throw new Error(`Kiri control skill is missing agent instruction: ${phrase}`)
    }
  }
}

function escapedPhrasePattern(phrase: string) {
  return new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

function runCtl(args: string[]) {
  return runJson(['kiri:ctl', ...args])
}

function runKiri(args: string[]) {
  return runJson(['kiri', ...args])
}

function runKiriCli(args: string[]) {
  return runJson(['kiricli', ...args])
}

function runProjectsCompat(args: string[]) {
  return runJson(['kiri:projects', ...args])
}

function runJson(args: string[]) {
  const output = execFileSync('pnpm', ['--silent', ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  })
  return JSON.parse(output) as unknown
}
