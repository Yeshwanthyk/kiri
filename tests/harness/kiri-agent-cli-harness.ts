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
const spawnResultSchema = z.object({
  session: sessionSchema,
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
const scratchpadSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  triggeredAt: z.string().nullable(),
  triggeredAgentId: z.string().nullable(),
})
const scratchpadRowsSchema = z.array(scratchpadSchema)
const workflowItemSchema = z.object({
  id: z.string(),
  action: z.string(),
  activeAgentId: z.string().nullable(),
  status: z.string(),
  tracked: z.boolean(),
  terminalPaste: z.object({ submit: z.boolean() }).nullable(),
})
const workflowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  itemCount: z.number(),
  launchedCount: z.number(),
  archivedAt: z.string().nullable(),
  items: z.array(workflowItemSchema),
})
const workflowRowsSchema = z.array(workflowSchema.omit({ items: true }))

try {
  assertSkillTeachesAgents()

  const models = modelRowsSchema.parse(runCall('kiri:ctl', {
    operation: 'model.list',
    params: { runtime: 'pi' },
  }))
  const kiriModels = modelRowsSchema.parse(runCall('kiri', {
    operation: 'model.list',
    params: { runtime: 'pi' },
  }))
  const kiriCliModels = modelRowsSchema.parse(runCall('kiricli', {
    operation: 'model.list',
    params: { runtime: 'pi' },
  }))
  if (models.length !== kiriModels.length || models.length !== kiriCliModels.length) {
    throw new Error('Kiri CLI aliases do not return the same model set')
  }
  const defaultPiModel = models.find((model) => model.runtime === 'pi' && model.isDefault)
  if (!defaultPiModel) throw new Error('No default pi model found')

  const primary = projectSchema.parse(runCall('kiri:ctl', {
    operation: 'project.add',
    params: {
      name: 'Agent Harness Primary',
      cwd: repoRoot,
      id: 'agent-harness-primary',
    },
  }))
  if (primary.id !== 'agent-harness-primary' || primary.hidden) {
    throw new Error('Primary project was not added as visible')
  }

  const secondary = projectSchema.parse(runCall('kiri:ctl', {
    operation: 'project.add',
    params: {
      name: 'Agent Harness Secondary',
      cwd: repoRoot,
      id: 'agent-harness-secondary',
    },
  }))
  if (secondary.id !== 'agent-harness-secondary') {
    throw new Error('Secondary project was not added')
  }

  const hidden = projectSchema.parse(runCall('kiri:ctl', {
    operation: 'project.hide',
    params: { id: secondary.id },
  }))
  if (!hidden.hidden) throw new Error('Secondary project was not hidden')

  const unhidden = projectSchema.parse(runCall('kiri:ctl', {
    operation: 'project.unhide',
    params: { id: secondary.id },
  }))
  if (unhidden.hidden) throw new Error('Secondary project was not unhidden')

  const projects = projectRowsSchema.parse(runCall('kiri:ctl', {
    operation: 'project.list',
    params: { includeHidden: true },
  }))
  if (!projects.some((project) => project.id === primary.id)) {
    throw new Error('project.list did not see CLI-created project')
  }

  const session = sessionSchema.parse(runCall('kiri:ctl', {
    operation: 'session.create',
    params: {
      projectId: primary.id,
      runtime: defaultPiModel.runtime,
      model: defaultPiModel.model,
      title: 'Agent Harness Session',
    },
  }))
  if (session.projectId !== primary.id || session.archivedAt !== null) {
    throw new Error('Session was not created as an active primary-project session')
  }

  const spawned = spawnResultSchema.parse(runCall('kiri:ctl', {
    operation: 'session.spawn',
    params: {
      projectId: primary.id,
      runtime: defaultPiModel.runtime,
      model: defaultPiModel.model,
      title: 'Agent Harness Spawn',
      text: 'Spawn from harness',
      terminalSpawn: false,
    },
  }))
  if (
    spawned.session.projectId !== primary.id ||
    spawned.delivery.kind !== 'terminal' ||
    spawned.delivery.spawned !== false
  ) {
    throw new Error('Session spawn did not create and queue a terminal session')
  }

  const renamed = sessionSchema.parse(runCall('kiri:ctl', {
    operation: 'session.rename',
    params: {
      agentId: session.id,
      title: 'Agent Harness Session Renamed',
    },
  }))
  if (renamed.title !== 'Agent Harness Session Renamed') {
    throw new Error('Session rename did not persist')
  }

  const activeSessions = sessionRowsSchema.parse(runCall('kiri:ctl', {
    operation: 'session.list',
    params: { projectId: primary.id },
  }))
  if (!activeSessions.some((candidate) => candidate.id === session.id)) {
    throw new Error('Session list did not include active session')
  }

  const archived = sessionSchema.parse(runCall('kiri:ctl', {
    operation: 'session.archive',
    params: { agentId: session.id },
  }))
  if (archived.archivedAt === null) throw new Error('Session archive did not archive')

  const restored = sessionSchema.parse(runCall('kiri:ctl', {
    operation: 'session.restore',
    params: { agentId: session.id },
  }))
  if (restored.archivedAt !== null) throw new Error('Session restore did not restore')

  const block = scratchpadSchema.parse(runCall('kiri:ctl', {
    operation: 'scratchpad.add',
    params: {
      projectId: primary.id,
      body: 'Agent harness scratchpad block',
    },
  }))
  if (block.projectId !== primary.id || block.body !== 'Agent harness scratchpad block') {
    throw new Error('Scratchpad add did not persist the expected block')
  }

  const blocks = scratchpadRowsSchema.parse(runCall('kiri:ctl', {
    operation: 'scratchpad.list',
    params: { projectId: primary.id },
  }))
  if (!blocks.some((candidate) => candidate.id === block.id)) {
    throw new Error('Scratchpad list did not include created block')
  }

  const workflow = workflowSchema.parse(runCall('kiri:ctl', {
    operation: 'workflow.create',
    params: {
      projectId: primary.id,
      title: 'Agent Harness Workflow',
      defaults: {
        runtime: defaultPiModel.runtime,
        model: defaultPiModel.model,
        attachScratchpad: true,
      },
      items: [{
        id: 'impl',
        action: 'launch',
        title: 'Harness Implement',
        body: 'Implement from harness',
      }, {
        id: 'note',
        action: 'scratchpad',
        title: 'Harness Note',
        body: 'Remember from harness',
      }],
    },
  }))
  if (workflow.projectId !== primary.id || workflow.itemCount !== 2) {
    throw new Error('Workflow create did not persist expected run')
  }

  const dispatch = z.object({
    id: z.string(),
    status: z.string(),
    launched: z.number(),
    scratchpadOnly: z.number(),
    failed: z.number(),
  }).parse(runCall('kiri:ctl', {
    operation: 'workflow.dispatch',
    params: { id: workflow.id },
  }))
  if (dispatch.launched !== 1 || dispatch.scratchpadOnly !== 1 || dispatch.failed !== 0) {
    throw new Error('Workflow dispatch did not launch and complete expected items')
  }

  const shownWorkflow = workflowSchema.parse(runCall('kiri:ctl', {
    operation: 'workflow.show',
    params: { id: workflow.id },
  }))
  if (shownWorkflow.launchedCount !== 1) {
    throw new Error('workflow.show did not include launched item count')
  }
  const workflowRows = workflowRowsSchema.parse(runCall('kiri:ctl', {
    operation: 'workflow.list',
    params: { projectId: primary.id },
  }))
  if (!workflowRows.some((candidate) => candidate.id === workflow.id)) {
    throw new Error('workflow.list did not include created workflow')
  }

  const terminalWorkflow = workflowSchema.parse(runCall('kiri:ctl', {
    operation: 'workflow.create',
    params: {
      projectId: primary.id,
      title: 'Agent Harness Terminal Workflow',
      defaults: {
        runtime: defaultPiModel.runtime,
        interfaceMode: 'terminal',
        model: defaultPiModel.model,
        attachScratchpad: false,
        terminalPaste: { submit: false },
      },
      items: [{
        id: 'terminal',
        action: 'launch',
        title: 'Harness Terminal',
        body: 'terminal body from harness',
      }],
    },
  }))
  const terminalDispatch = z.object({
    launched: z.number(),
    results: z.array(z.object({
      terminalPaste: z.object({
        queued: z.boolean(),
        submitted: z.boolean(),
        bytes: z.number(),
      }).nullable(),
    }).passthrough()),
  }).parse(runCall('kiri:ctl', {
    operation: 'workflow.dispatch',
    params: { id: terminalWorkflow.id },
  }))
  if (
    terminalDispatch.launched !== 1 ||
    terminalDispatch.results[0]?.terminalPaste?.queued !== true ||
    terminalDispatch.results[0]?.terminalPaste?.submitted !== false
  ) {
    throw new Error('Terminal workflow dispatch did not queue terminal input')
  }

  const archivedWorkflow = workflowSchema.parse(runCall('kiri:ctl', {
    operation: 'workflow.archive',
    params: { id: workflow.id },
  }))
  if (archivedWorkflow.archivedAt === null) throw new Error('Workflow archive did not archive')
  const restoredWorkflow = workflowSchema.parse(runCall('kiri:ctl', {
    operation: 'workflow.restore',
    params: { id: workflow.id },
  }))
  if (restoredWorkflow.archivedAt !== null) throw new Error('Workflow restore did not restore')

  const deletedBlock = scratchpadSchema.parse(runCall('kiri:ctl', {
    operation: 'scratchpad.delete',
    params: { id: block.id },
  }))
  if (deletedBlock.id !== block.id) throw new Error('Scratchpad delete returned the wrong block')

  const deleted = projectSchema.parse(runCall('kiri:ctl', {
    operation: 'project.delete',
    params: { id: secondary.id },
  }))
  if (deleted.id !== secondary.id) throw new Error('Project delete returned the wrong project')

  process.stdout.write(JSON.stringify({
    ok: true,
    checked: [
      'skill',
      'model.list',
      'kiri alias',
      'kiricli alias',
      'project.add',
      'project.hide',
      'project.unhide',
      'project.delete',
      'session.create',
      'session.spawn',
      'session.rename',
      'session.archive',
      'session.restore',
      'scratchpad.add',
      'scratchpad.list',
      'scratchpad.delete',
      'workflow.create',
      'workflow.dispatch',
      'workflow.show',
      'workflow.list',
      'workflow.archive',
      'workflow.restore',
      'terminal paste queue',
    ],
    projectId: primary.id,
    sessionId: session.id,
    spawnedSessionId: spawned.session.id,
  }, null, 2))
  process.stdout.write('\n')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertSkillTeachesAgents() {
  const body = readFileSync(resolve(repoRoot, '.agents/skills/kiri-control/SKILL.md'), 'utf8')
  const required = [
    'kiri_get',
    'kiri_do',
    'pnpm kiri:ctl call',
    'operations.list',
    'Deterministic Flow',
    'Choose the first matching row',
    'model.list',
    'project.add',
    'session.create',
    'session.spawn',
    'agent.prompt',
    'terminal.input',
    'session.rename',
    'session.archive',
    'session.restore',
    'scratchpad.add',
    'scratchpad.list',
    'scratchpad.delete',
    'workflow.create',
    'workflow.dispatch',
    'workflow.show',
    'workflow.list',
    'workflow.archive',
    'workflow.restore',
    'Do not use workflows for a single new worker',
    'Do not use `session.create` + `agent.prompt` for new prompted work',
    'terminalSpawn:false',
    'pnpm kiricli mcp',
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

function runCall(script: string, request: unknown) {
  const response = responseSchema.parse(runJson([
    script,
    'call',
    JSON.stringify(request),
  ]))
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}

function runJson(args: string[]) {
  const output = execFileSync('pnpm', ['--silent', ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  })
  return JSON.parse(output) as unknown
}
