import type { AgentTask } from '~/lib/contracts'

export function compactSessionTitle(preview: string | undefined, fallback: string) {
  const title = preview?.replace(/\s+/g, ' ').trim()
  if (!title) return fallback
  return title.length > 44 ? `${title.slice(0, 41)}...` : title
}

export function deriveSessionTitleFrom(
  preview: string | undefined,
  tasks: readonly AgentTask[],
  fallback: string,
) {
  return compactSessionTitle(
    tasks.find((task) => task.status === 'inProgress')?.title ?? preview,
    fallback,
  )
}

export function forkSessionTitle(title: string) {
  const trimmed = title.replace(/\s+/g, ' ').trim()
  const base = trimmed.replace(/\s+fork(?:\s+\(\d+\))?$/i, '').trim() || trimmed
  return `${base} fork`
}
