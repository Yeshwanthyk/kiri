import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tempRoot = mkdtempSync(join(tmpdir(), 'aether-agent-harness-'))
const env = {
  ...process.env,
  AETHER_ROOT_DIR: repoRoot,
  AETHER_DB_PATH: join(tempRoot, 'aether.sqlite'),
  AETHER_STATE_DIR: join(tempRoot, 'state'),
  AETHER_SETTINGS_PATH: resolve(repoRoot, 'settings.json'),
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
  const aetherModels = modelRowsSchema.parse(runAether(['models', 'list', '--runtime', 'pi', '--json']))
  const aetherCliModels = modelRowsSchema.parse(runAetherCli(['models', 'list', '--runtime', 'pi', '--json']))
  if (models.length !== aetherModels.length || models.length !== aetherCliModels.length) {
    throw new Error('Aether CLI aliases do not return the same model set')
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
    throw new Error('pnpm aether:projects compatibility command did not see CLI-created project')
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
      'aether alias',
      'aethercli alias',
      'projects:add',
      'projects:hide',
      'projects:unhide',
      'projects:delete',
      'sessions:create',
      'sessions:rename',
      'sessions:delete',
      'sessions:resume',
      'aether:projects compatibility',
    ],
    projectId: primary.id,
    sessionId: session.id,
  }, null, 2))
  process.stdout.write('\n')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertSkillTeachesAgents() {
  const body = readFileSync(resolve(repoRoot, '.agents/skills/aether-control/SKILL.md'), 'utf8')
  const required = [
    'pnpm aether models list --json',
    'pnpm aethercli',
    'pnpm aether:ctl models list --json',
    'pnpm aether:ctl projects add',
    'pnpm aether:ctl sessions create',
    'pnpm aether:ctl sessions rename',
    'pnpm aether:ctl sessions delete',
    'pnpm aether:ctl sessions resume',
  ]
  for (const phrase of required) {
    if (body.search(escapedPhrasePattern(phrase)) === -1) {
      throw new Error(`Aether control skill is missing agent instruction: ${phrase}`)
    }
  }
}

function escapedPhrasePattern(phrase: string) {
  return new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

function runCtl(args: string[]) {
  return runJson(['aether:ctl', ...args])
}

function runAether(args: string[]) {
  return runJson(['aether', ...args])
}

function runAetherCli(args: string[]) {
  return runJson(['aethercli', ...args])
}

function runProjectsCompat(args: string[]) {
  return runJson(['aether:projects', ...args])
}

function runJson(args: string[]) {
  const output = execFileSync('pnpm', ['--silent', ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  })
  return JSON.parse(output) as unknown
}
