import type { RuntimeKind } from '~/lib/contracts'
import {
  deleteProject,
  deleteProjectSummary,
  listSessionSummaries,
} from './db'
import { forgetProviderRuntimeAgent } from './provider-runtime'
import { closeAgentRuntimeTerminal } from './terminal-server'

export type RuntimeCleanupSession = {
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

const liveCleanupDependencies: RuntimeCleanupDependencies = {
  forgetRuntime: forgetProviderRuntimeAgent,
  closeTerminal: closeAgentRuntimeTerminal,
}

export function cleanupRuntimeSessions(
  sessions: readonly RuntimeCleanupSession[],
  dependencies: RuntimeCleanupDependencies = liveCleanupDependencies,
) {
  for (const session of sessions) {
    dependencies.forgetRuntime(session.runtime, session.id)
    dependencies.closeTerminal(session.id)
  }
}

export function cleanupProjectRuntimeSessions(projectId: string) {
  const sessions = listSessionSummaries({ projectId, includeArchived: true })
  cleanupRuntimeSessions(sessions)
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

function deleteProjectAndCleanupRuntimes<Result>(
  id: string,
  dependencies: ProjectRuntimeCleanupDependencies<Result>,
) {
  const sessions = dependencies.listSessions(id)
  const result = dependencies.deleteProject(id)
  cleanupRuntimeSessions(sessions, dependencies)
  return result
}
