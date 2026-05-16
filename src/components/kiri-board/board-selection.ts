import type { AgentCell, ProjectRow, WorkspaceSnapshot } from '~/lib/contracts'
import type { Selection } from './navigation'

export type ResolvedBoardSelection = {
  selectedProject: ProjectRow | undefined
  selectedAgent: AgentCell | undefined
  selection: Selection
}

export function resolveBoardSelection(
  workspace: WorkspaceSnapshot,
  activeProjectId: string,
  agentByProject: Record<string, string>,
): ResolvedBoardSelection {
  const selectedProject =
    workspace.projects.find((project) => project.id === activeProjectId) ??
    workspace.projects[0]
  const rememberedAgentId = selectedProject ? agentByProject[selectedProject.id] : undefined
  const selectedAgent =
    (rememberedAgentId
      ? selectedProject?.agents.find((agent) => agent.id === rememberedAgentId)
      : undefined) ?? selectedProject?.agents[0]

  return {
    selectedProject,
    selectedAgent,
    selection: {
      projectId: selectedProject?.id ?? '',
      agentId: selectedAgent?.id ?? '',
    },
  }
}
