import type { AgentCell } from '~/lib/contracts'

export function mergeAgentDetail(
  summary: AgentCell | undefined,
  detail: AgentCell | undefined,
) {
  if (!summary) return undefined
  if (!detail || detail.id !== summary.id) return summary
  return {
    ...summary,
    messages: detail.messages,
    timelineEvents: detail.timelineEvents,
    timeline: detail.timeline,
    diffs: detail.diffs,
    tasks: detail.tasks,
    contextUsage: detail.contextUsage,
    pendingQuestion: detail.pendingQuestion,
  }
}
