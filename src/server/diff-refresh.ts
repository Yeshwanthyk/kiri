import { collectGitDiffArtifacts } from './git-diff'
import {
  getAgentDetail,
  getAgentLaunchConfig,
  getWorkspaceSnapshot,
  replaceAgentDiffArtifacts,
} from './db'

export function refreshTerminalSessionDiffs(agentId: string) {
  const agent = getAgentDetail({ agentId, limit: 1 })
  if (agent.interfaceMode !== 'terminal') {
    throw new Error(`Diff refresh is only available for terminal sessions: ${agentId}`)
  }

  const config = getAgentLaunchConfig(agentId)
  replaceAgentDiffArtifacts({
    agentId,
    diffs: collectGitDiffArtifacts(config.cwd),
  })
  return getWorkspaceSnapshot()
}
