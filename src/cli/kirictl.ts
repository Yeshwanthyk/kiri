#!/usr/bin/env tsx

import { Args, Command, Options } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Console, Effect, Layer, Option } from 'effect'
import {
  runtimeKinds,
  thinkingLevels,
  type RuntimeKind,
  type ThinkingLevel,
} from '~/lib/contracts'
import { KiriControl } from '~/server/kiri-control'
import { runKiriMcpServer } from '~/server/kiri-mcp'

const version = '0.1.0'

const json = Options.boolean('json').pipe(
  Options.withDescription('Emit machine-readable JSON'),
)
const all = Options.boolean('all').pipe(
  Options.withDescription('Include hidden projects or archived sessions'),
)
const projectIdOption = Options.text('project').pipe(
  Options.withDescription('Project id'),
  Options.optional,
)
const requiredProjectIdOption = Options.text('project').pipe(
  Options.withDescription('Project id'),
)
const runtimeOption = Options.choice('runtime', runtimeKinds).pipe(
  Options.withDescription('Runtime/provider'),
  Options.optional,
)
const modelOption = Options.text('model').pipe(
  Options.withDescription('Model id from settings.json'),
  Options.optional,
)
const titleOption = Options.text('title').pipe(
  Options.withDescription('Session title'),
  Options.optional,
)
const bodyOption = Options.text('body').pipe(
  Options.withDescription('Scratchpad block body'),
)
const thinkingOption = Options.choice('thinking', thinkingLevels).pipe(
  Options.withDescription('Thinking level'),
  Options.optional,
)
const idOption = Options.text('id').pipe(Options.withDescription('Stable id'))
const optionalIdOption = Options.text('id').pipe(
  Options.withDescription('Stable id'),
  Options.optional,
)
const nameOption = Options.text('name').pipe(Options.withDescription('Project name'))
const cwdOption = Options.text('cwd').pipe(Options.withDescription('Project cwd'))
const agentOption = Options.text('agent').pipe(Options.withDescription('Agent/session id'))
const yesOption = Options.boolean('yes').pipe(
  Options.withAlias('y'),
  Options.withDescription('Confirm destructive operation'),
)

const modelsListCommand = Command.make(
  'list',
  { runtime: runtimeOption, json },
  ({ runtime, json }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const rows = yield* control.listModels(optionValue(runtime))
      yield* print(rows, json, formatModels)
    }),
).pipe(Command.withDescription('List configured models'))

const modelsCommand = Command.make('models', {}).pipe(
  Command.withDescription('Inspect configured runtimes and models'),
  Command.withSubcommands([modelsListCommand]),
)

const projectsListCommand = Command.make(
  'list',
  { all, json },
  ({ all, json }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const rows = yield* control.listProjects(all)
      yield* print(rows, json, formatProjects)
    }),
).pipe(Command.withDescription('List projects'))

const projectsAddCommand = Command.make(
  'add',
  { name: nameOption, cwd: cwdOption, id: optionalIdOption, json },
  ({ name, cwd, id, json }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const project = yield* control.addProject({
        name,
        cwd,
        id: optionValue(id),
      })
      yield* print(project, json, (value) => `Added project ${value.id}: ${value.name}`)
    }),
).pipe(Command.withDescription('Add a project row'))

const projectsHideCommand = Command.make(
  'hide',
  { id: idOption, json },
  ({ id, json }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const project = yield* control.hideProject(id)
      yield* print(project, json, (value) => `Hidden project ${value.id}: ${value.name}`)
    }),
).pipe(Command.withDescription('Hide a project from the board'))

const projectsUnhideCommand = Command.make(
  'unhide',
  { id: idOption, json },
  ({ id, json }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const project = yield* control.unhideProject(id)
      yield* print(project, json, (value) => `Unhid project ${value.id}: ${value.name}`)
    }),
).pipe(Command.withDescription('Unhide a project'))

const projectsDeleteCommand = Command.make(
  'delete',
  { id: idOption, yes: yesOption, json },
  ({ id, yes, json }) =>
    Effect.gen(function* () {
      if (!yes) throw new Error(`Refusing to delete ${id} without --yes`)
      const control = yield* KiriControl
      const project = yield* control.deleteProject(id)
      yield* print(project, json, (value) => `Deleted project ${value.id}: ${value.name}`)
    }),
).pipe(Command.withDescription('Delete project metadata'))

const projectsCommand = Command.make('projects', {}).pipe(
  Command.withDescription('Manage project registry rows'),
  Command.withSubcommands([
    projectsListCommand,
    projectsAddCommand,
    projectsHideCommand,
    projectsUnhideCommand,
    projectsDeleteCommand,
  ]),
)

const sessionsListCommand = Command.make(
  'list',
  { project: projectIdOption, all, json },
  ({ project, all, json }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const rows = yield* control.listSessions({
        projectId: optionValue(project),
        includeArchived: all,
      })
      yield* print(rows, json, formatSessions)
    }),
).pipe(Command.withDescription('List sessions'))

const sessionsCreateCommand = Command.make(
  'create',
  {
    project: requiredProjectIdOption,
    runtime: runtimeOption,
    model: modelOption,
    title: titleOption,
    thinking: thinkingOption,
    json,
  },
  ({ project, runtime, model, title, thinking, json }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const session = yield* control.startSession({
        projectId: project,
        runtime: optionValue(runtime),
        model: optionValue(model),
        title: optionValue(title),
        thinkingLevel: optionValue(thinking) ?? 'medium',
      })
      yield* print(session, json, (value) => `Created session ${value.id}: ${value.title}`)
    }),
).pipe(Command.withDescription('Create an idle agent session'))

const sessionsRenameCommand = Command.make(
  'rename',
  { agent: agentOption, title: titleOption, json },
  ({ agent, title, json }) =>
    Effect.gen(function* () {
      const nextTitle = optionValue(title)
      if (!nextTitle) throw new Error('Missing required --title')
      const control = yield* KiriControl
      const session = yield* control.renameSession({ agentId: agent, title: nextTitle })
      yield* print(session, json, (value) => `Renamed session ${value.id}: ${value.title}`)
    }),
).pipe(Command.withDescription('Rename a session'))

const sessionsDeleteCommand = Command.make(
  'delete',
  { agent: agentOption, yes: yesOption, json },
  ({ agent, yes, json }) =>
    Effect.gen(function* () {
      if (!yes) throw new Error(`Refusing to delete ${agent} without --yes`)
      const control = yield* KiriControl
      const session = yield* control.deleteSession(agent)
      yield* print(session, json, (value) => `Archived session ${value.id}: ${value.title}`)
    }),
).pipe(Command.withDescription('Archive a session'))

const sessionsRestoreCommand = Command.make(
  'restore',
  { agent: agentOption, json },
  ({ agent, json }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const session = yield* control.restoreSession({ agentId: agent })
      yield* print(session, json, (value) => `Restored session ${value.id}: ${value.title}`)
    }),
).pipe(Command.withDescription('Restore an archived session'))

const sessionsResumeCommand = Command.make(
  'resume',
  { agent: agentOption, json },
  ({ agent, json }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const session = yield* control.restoreSession({ agentId: agent })
      yield* print(session, json, (value) => `Resumed session ${value.id}: ${value.title}`)
    }),
).pipe(Command.withDescription('Resume an archived session'))

const sessionsCommand = Command.make('sessions', {}).pipe(
  Command.withDescription('Manage agent sessions'),
  Command.withSubcommands([
    sessionsListCommand,
    sessionsCreateCommand,
    sessionsRenameCommand,
    sessionsDeleteCommand,
    sessionsRestoreCommand,
    sessionsResumeCommand,
  ]),
)

const scratchpadListCommand = Command.make(
  'list',
  { project: projectIdOption, json },
  ({ project, json }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const rows = yield* control.listScratchpad({ projectId: optionValue(project) })
      yield* print(rows, json, formatScratchpad)
    }),
).pipe(Command.withDescription('List scratchpad blocks'))

const scratchpadAddCommand = Command.make(
  'add',
  { project: projectIdOption, body: bodyOption, json },
  ({ project, body, json }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const block = yield* control.addScratchpad({
        projectId: optionValue(project) ?? null,
        body,
      })
      yield* print(block, json, (value) => `Added scratchpad block ${value.id}`)
    }),
).pipe(Command.withDescription('Add a scratchpad block'))

const scratchpadDeleteCommand = Command.make(
  'delete',
  { id: idOption, json },
  ({ id, json }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const block = yield* control.deleteScratchpad(id)
      yield* print(block, json, (value) => `Deleted scratchpad block ${value.id}`)
    }),
).pipe(Command.withDescription('Delete a scratchpad block'))

const scratchpadTriggerCommand = Command.make(
  'trigger',
  {
    id: idOption,
    project: requiredProjectIdOption,
    runtime: runtimeOption,
    model: modelOption,
    title: titleOption,
    thinking: thinkingOption,
    json,
  },
  ({ id, project, runtime, model, title, thinking, json }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const result = yield* control.triggerScratchpad({
        id,
        projectId: project,
        runtime: optionValue(runtime),
        model: optionValue(model),
        title: optionValue(title),
        thinkingLevel: optionValue(thinking) ?? 'medium',
      })
      yield* print(result, json, (value) =>
        `Triggered scratchpad block ${value.block.id} in session ${value.session.id}: ${value.session.title}`)
    }),
).pipe(Command.withDescription('Trigger a scratchpad block as a new session'))

const scratchpadCommand = Command.make('scratchpad', {}).pipe(
  Command.withDescription('Manage scratchpad blocks'),
  Command.withSubcommands([
    scratchpadListCommand,
    scratchpadAddCommand,
    scratchpadDeleteCommand,
    scratchpadTriggerCommand,
  ]),
)

const mcpCommand = Command.make('mcp', {}, () =>
  Effect.gen(function* () {
    const control = yield* KiriControl
    yield* Effect.promise(() => runKiriMcpServer(control))
  }),
).pipe(Command.withDescription('Run the Kiri MCP server over stdio'))

export const kirictlCommand = Command.make('kirictl', {}).pipe(
  Command.withDescription('Control Kiri from scripts and AI agents'),
  Command.withSubcommands([
    modelsCommand,
    projectsCommand,
    sessionsCommand,
    scratchpadCommand,
    mcpCommand,
  ]),
)

const cli = Command.run(kirictlCommand, {
  name: 'kirictl',
  version,
})

const MainLayer = Layer.merge(KiriControl.layer, NodeContext.layer)

cli(process.argv).pipe(
  Effect.provide(MainLayer),
  NodeRuntime.runMain,
)

function optionValue<A>(value: Option.Option<A>): A | undefined {
  return Option.getOrUndefined(value)
}

function print<A>(
  value: A,
  asJson: boolean,
  format: (value: A) => string,
) {
  return Console.log(asJson ? `${JSON.stringify(value, null, 2)}\n` : format(value))
}

function formatModels(rows: readonly {
  runtime: RuntimeKind
  model: string
  isDefault: boolean
  contextWindow: number | null
}[]) {
  if (rows.length === 0) return 'No models configured.'
  return rows
    .map((row) => {
      const marker = row.isDefault ? 'default' : 'available'
      const context = row.contextWindow === null ? 'unknown' : `${row.contextWindow} tokens`
      return `${row.runtime}\t${row.model}\t${marker}\t${context}`
    })
    .join('\n')
}

function formatProjects(rows: readonly {
  id: string
  name: string
  cwd: string
  hidden: boolean
  sessionCount: number
}[]) {
  if (rows.length === 0) return 'No projects configured.'
  return rows
    .map((row) => {
      const state = row.hidden ? 'hidden' : 'visible'
      return `${row.id}\t${row.name}\t${state}\t${row.sessionCount} sessions\t${row.cwd}`
    })
    .join('\n')
}

function formatSessions(rows: readonly {
  id: string
  projectId: string
  title: string
  runtime: RuntimeKind
  model: string
  status: string
  archivedAt: string | null
}[]) {
  if (rows.length === 0) return 'No sessions configured.'
  return rows
    .map((row) => {
      const state = row.archivedAt ? 'archived' : row.status
      return `${row.id}\t${row.projectId}\t${row.title}\t${row.runtime}\t${row.model}\t${state}`
    })
    .join('\n')
}

function formatScratchpad(rows: readonly {
  id: string
  projectId: string | null
  projectName: string | null
  body: string
  createdAt: string
  triggeredAt: string | null
  triggeredAgentId: string | null
}[]) {
  if (rows.length === 0) return 'No scratchpad blocks.'
  return rows
    .map((row) => {
      const project = row.projectId ?? 'global'
      const state = row.triggeredAt ? `triggered:${row.triggeredAgentId ?? 'unknown'}` : 'pending'
      return `${row.id}\t${project}\t${state}\t${row.body}`
    })
    .join('\n')
}
