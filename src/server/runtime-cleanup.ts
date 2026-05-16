import type { DeleteSessionInput, RuntimeKind } from '~/lib/contracts'
import {
  deleteProject,
  deleteProjectSummary,
  deleteSession,
  deleteSessionSummary,
  listSessionSummaries,
} from './db'
import { forgetProviderRuntimeAgent } from './provider-runtime'
import { closeAgentRuntimeTerminal } from './terminal-server'

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
  for (const session of sessions) {
    dependencies.forgetRuntime(session.runtime, session.id)
    dependencies.closeTerminal(session.id)
  }
}

export function deleteProjectWithRuntimeCleanup(
  id: string,
  dependencies: ProjectRuntimeCleanupDependencies<ReturnType<typeof deleteProject>> = {
    ...liveCleanupDependencies,
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
  const result = dependencies.deleteProject(id)
  cleanupRuntimeSessions(sessions, dependencies)
  return result
}

function deleteSessionAndCleanupRuntime<Result>(
  input: DeleteSessionInput,
  dependencies: SessionRuntimeCleanupDependencies<Result>,
) {
  const session = dependencies.findSession(input.agentId)
  if (!session) throw new Error(`Session not found: ${input.agentId}`)

  const result = dependencies.deleteSession(input)
  cleanupRuntimeSessions([session], dependencies)
  return result
}

function findActiveSessionForRuntimeCleanup(agentId: string) {
  return listSessionSummaries()
    .find((session) => session.id === agentId)
}

function findAnySessionForRuntimeCleanup(agentId: string) {
  return listSessionSummaries({ includeArchived: true })
    .find((session) => session.id === agentId)
}
