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
    timelinePage: detail.timelinePage,
    diffs: detail.diffs,
    tasks: detail.tasks,
    contextUsage: detail.contextUsage,
    pendingQuestion: detail.pendingQuestion,
  }
}

export function prependAgentDetailPages(
  detail: AgentCell | undefined,
  olderPages: readonly AgentCell[],
) {
  if (!detail || olderPages.length === 0) return detail
  const pages = [...olderPages]
    .filter((page) => page.id === detail.id)
    .sort((left, right) =>
      (right.timelinePage?.offset ?? 0) - (left.timelinePage?.offset ?? 0),
    )
  if (pages.length === 0) return detail
  const loaded = pages.reduce((count, page) => count + page.timeline.length, detail.timeline.length)
  const total = detail.timelinePage?.total ?? loaded
  return {
    ...detail,
    messages: [
      ...pages.flatMap((page) => page.messages),
      ...detail.messages,
    ],
    timelineEvents: [
      ...pages.flatMap((page) => page.timelineEvents),
      ...detail.timelineEvents,
    ],
    timeline: [
      ...pages.flatMap((page) => page.timeline),
      ...detail.timeline,
    ],
    timelinePage: detail.timelinePage
      ? {
          ...detail.timelinePage,
          returned: loaded,
          hasMore: loaded < total,
        }
      : undefined,
  }
}
