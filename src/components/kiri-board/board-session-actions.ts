import type { AgentCell, ProjectRow } from '~/lib/contracts'

export function fallbackAgentAfterSessionDelete(
  project: ProjectRow,
  deletedAgentIndex: number,
): AgentCell | undefined {
  return project.agents[Math.max(0, Math.min(deletedAgentIndex - 1, project.agents.length - 1))]
}
