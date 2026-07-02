import type { DeleteSessionInput, RuntimeKind } from '~/lib/contracts'
import {
  deleteProject,
  deleteProjectSummary,
  deleteSession,
  deleteSessionSummary,
  listSessionSummaries,
} from './db'
import { forgetProviderRuntimeAgent } from './provider-runtime'
import { closeAgentRuntimeTerminal, closeProjectShellTerminals } from './terminal-server'

type RuntimeCleanupSession = {
  readonly id: string
  readonly runtime: RuntimeKind
}

type RuntimeCleanupDependencies = {
  readonly forgetRuntime: (runtime: RuntimeKind, agentId: string) => void
  readonly closeTerminal: (agentId: string) => void
}

type ProjectRuntimeCleanupDependencies<Result> = RuntimeCleanupDependencies & {
  readonly listSessions: (projectId: string) => readonly RuntimeCleanupSession[]
  readonly deleteProject: (id: string) => Result
  readonly closeProjectTerminals?: (projectId: string) => void
}

type SessionRuntimeCleanupDependencies<Result> = RuntimeCleanupDependencies & {
  readonly findSession: (agentId: string) => RuntimeCleanupSession | undefined
  readonly deleteSession: (input: DeleteSessionInput) => Result
}

const liveCleanupDependencies: RuntimeCleanupDependencies = {
  forgetRuntime: forgetProviderRuntimeAgent,
  closeTerminal: closeAgentRuntimeTerminal,
}

function cleanupRuntimeSessions(
  sessions: readonly RuntimeCleanupSession[],
  dependencies: RuntimeCleanupDependencies = liveCleanupDependencies,
) {
  const errors: unknown[] = []
  for (const session of sessions) {
    try {
      dependencies.forgetRuntime(session.runtime, session.id)
    } catch (error) {
      errors.push(error)
    }
    try {
      dependencies.closeTerminal(session.id)
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

export function deleteProjectWithRuntimeCleanup(
  id: string,
  dependencies: ProjectRuntimeCleanupDependencies<ReturnType<typeof deleteProject>> = {
    ...liveCleanupDependencies,
    closeProjectTerminals: closeProjectShellTerminals,
    listSessions: (projectId) => listSessionSummaries({ projectId, includeArchived: true }),
    deleteProject,
  },
) {
  return deleteProjectAndCleanupRuntimes(id, dependencies)
}

export function deleteProjectSummaryWithRuntimeCleanup(
  id: string,
  dependencies: ProjectRuntimeCleanupDependencies<ReturnType<typeof deleteProjectSummary>> = {
    ...liveCleanupDependencies,
    closeProjectTerminals: closeProjectShellTerminals,
    listSessions: (projectId) => listSessionSummaries({ projectId, includeArchived: true }),
    deleteProject: deleteProjectSummary,
  },
) {
  return deleteProjectAndCleanupRuntimes(id, dependencies)
}

export function deleteSessionWithRuntimeCleanup(
  input: DeleteSessionInput,
  dependencies: SessionRuntimeCleanupDependencies<ReturnType<typeof deleteSession>> = {
    ...liveCleanupDependencies,
    findSession: findActiveSessionForRuntimeCleanup,
    deleteSession,
  },
) {
  return deleteSessionAndCleanupRuntime(input, dependencies)
}

export function deleteSessionSummaryWithRuntimeCleanup(
  input: DeleteSessionInput,
  dependencies: SessionRuntimeCleanupDependencies<ReturnType<typeof deleteSessionSummary>> = {
    ...liveCleanupDependencies,
    findSession: findAnySessionForRuntimeCleanup,
    deleteSession: deleteSessionSummary,
  },
) {
  return deleteSessionAndCleanupRuntime(input, dependencies)
}

function deleteProjectAndCleanupRuntimes<Result>(
  id: string,
  dependencies: ProjectRuntimeCleanupDependencies<Result>,
) {
  const sessions = dependencies.listSessions(id)
  const errors = cleanupRuntimeSessions(sessions, dependencies)
  try {
    dependencies.closeProjectTerminals?.(id)
  } catch (error) {
    errors.push(error)
  }
  reportCleanupErrors(errors)
  return dependencies.deleteProject(id)
}

function deleteSessionAndCleanupRuntime<Result>(
  input: DeleteSessionInput,
  dependencies: SessionRuntimeCleanupDependencies<Result>,
) {
  const session = dependencies.findSession(input.agentId)
  if (!session) throw new Error(`Session not found: ${input.agentId}`)

  throwCleanupErrors(cleanupRuntimeSessions([session], dependencies))
  return dependencies.deleteSession(input)
}

function findActiveSessionForRuntimeCleanup(agentId: string) {
  return listSessionSummaries()
    .find((session) => session.id === agentId)
}

function findAnySessionForRuntimeCleanup(agentId: string) {
  return listSessionSummaries({ includeArchived: true })
    .find((session) => session.id === agentId)
}

function reportCleanupErrors(errors: readonly unknown[]) {
  if (errors.length === 0) return
  console.error(`Runtime cleanup failed with ${errors.length} error(s)`, errors)
}

function throwCleanupErrors(errors: readonly unknown[]) {
  if (errors.length === 0) return
  if (errors.length === 1) throw errors[0]
  throw new AggregateError(errors, 'Runtime cleanup failed')
}
