import type { DatabaseSync } from 'node:sqlite'
import type {
  KiriSettings,
  ScratchpadBlock,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import {
  pendingQuestionSchema,
  workspaceSnapshotSchema,
} from '~/lib/contracts'
import type { UiPreferences } from '~/lib/ui-preferences'
import {
  agentDetailDbRowSchema,
  archivedSessionDbRowSchema,
  contextUsageDbRowSchema,
  projectDbRowSchema,
} from './schema'
import {
  parseAgentRuntimeStateJson,
  readContextUsage,
} from './runtime-state'

type ReadWorkspaceSnapshotInput = {
  readonly settings: KiriSettings
  readonly preferences: UiPreferences
  readonly scratchpadBlocks: ScratchpadBlock[]
}

export function readWorkspaceSnapshot(
  database: DatabaseSync,
  input: ReadWorkspaceSnapshotInput,
): WorkspaceSnapshot {
  const projects = database
    .prepare(
      `
        SELECT id, name, cwd, position, hidden_at AS hiddenAt
        FROM projects
        ORDER BY position ASC
      `,
    )
    .all()
    .map((row) => projectDbRowSchema.parse(row))

  const agents = database
    .prepare(
      `
        SELECT
          a.id,
          a.project_id AS projectId,
          p.cwd,
          a.slot,
          a.title,
          a.runtime,
          a.interface_mode AS interfaceMode,
          a.model,
          a.status,
          a.session_dir AS sessionDir,
          a.session_file AS sessionFile,
          a.runtime_state_json AS runtimeStateJson,
          a.position,
          a.archived_at AS archivedAt,
          t.id AS threadId,
          t.preview,
          t.message_count AS messageCount,
          t.updated_at AS updatedAt,
          (
            SELECT COUNT(*)
            FROM diff_artifacts d
            WHERE d.agent_id = a.id
          ) AS diffCount
        FROM agent_slots a
        INNER JOIN projects p ON p.id = a.project_id
        LEFT JOIN threads t ON t.agent_id = a.id AND t.active = 1
        ORDER BY a.position ASC
      `,
    )
    .all()
    .map((row) => agentDetailDbRowSchema.parse(row))

  const contextUsages = database
    .prepare(
      `
        SELECT
          agent_id AS agentId,
          used_tokens AS usedTokens,
          window_tokens AS windowTokens,
          updated_at AS updatedAt,
          session_file AS sessionFile
        FROM agent_context_usage
      `,
    )
    .all()
    .map((row) => contextUsageDbRowSchema.parse(row))

  const contextUsageByAgent = new Map(
    contextUsages.map((usage) => [usage.agentId, usage]),
  )
  const activeAgentsByProject = groupBy(
    agents.filter((agent) => !agent.archivedAt),
    (agent) => agent.projectId,
  )

  const snapshotProjectRows = projects.map((project) => ({
    ...project,
    agents: (activeAgentsByProject.get(project.id) ?? []).map((agent) => {
      return {
        id: agent.id,
        projectId: agent.projectId,
        slot: agent.slot,
        title: agent.title,
        runtime: agent.runtime,
        interfaceMode: agent.interfaceMode,
        model: agent.model,
        status: agent.status,
        sessionDir: agent.sessionDir,
        sessionFile: agent.sessionFile,
        preview: agent.preview ?? 'No messages yet',
        messageCount: agent.messageCount ?? 0,
        diffCount: agent.diffCount,
        contextUsage: readContextUsage(
          agent,
          input.settings,
          contextUsageByAgent.get(agent.id),
        ),
        pendingQuestion: pendingQuestionSchema.safeParse(
          parseAgentRuntimeStateJson(agent.runtimeStateJson, agent.id).pendingQuestion,
        ).data ?? null,
        updatedAt: agent.updatedAt ?? new Date(0).toISOString(),
        isSession: agent.slot.startsWith('session-'),
        messages: [],
        timelineEvents: [],
        timeline: [],
        diffs: [],
        tasks: [],
      }
    }),
  }))
  const projectNameById = new Map(projects.map((project) => [project.id, project.name]))
  const visibleProjectIds = new Set(
    projects.flatMap((project) => project.hiddenAt ? [] : [project.id]),
  )
  const archivedSessions = agents
    .flatMap((agent) => {
      if (!agent.archivedAt || !visibleProjectIds.has(agent.projectId)) return []
      return [archivedSessionDbRowSchema.parse({
        ...agent,
        projectName: projectNameById.get(agent.projectId) ?? agent.projectId,
        archivedAt: agent.archivedAt,
      })]
    })
    .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))
    .map((agent) => ({
      id: agent.id,
      projectId: agent.projectId,
      projectName: agent.projectName,
      title: agent.title,
      runtime: agent.runtime,
      interfaceMode: agent.interfaceMode,
      model: agent.model,
      status: agent.status,
      preview: agent.preview ?? 'No messages yet',
      messageCount: agent.messageCount ?? 0,
      updatedAt: agent.updatedAt ?? new Date(0).toISOString(),
      archivedAt: agent.archivedAt,
    }))
  const snapshotProjects = snapshotProjectRows.filter((project) => !project.hiddenAt)
  const hiddenProjects = snapshotProjectRows.filter((project) => project.hiddenAt)
  const selectedProject = snapshotProjects[0]
  const selectedAgent = selectedProject?.agents[0]

  return workspaceSnapshotSchema.parse({
    settings: input.settings,
    preferences: input.preferences,
    projects: snapshotProjects,
    hiddenProjects,
    archivedSessions,
    scratchpadBlocks: input.scratchpadBlocks,
    selected: {
      projectId: selectedProject?.id ?? '',
      agentId: selectedAgent?.id ?? '',
    },
  })
}

function groupBy<T, K extends string>(
  items: readonly T[],
  getKey: (item: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const key = getKey(item)
    const group = groups.get(key)
    if (group) {
      group.push(item)
    } else {
      groups.set(key, [item])
    }
  }
  return groups
}
