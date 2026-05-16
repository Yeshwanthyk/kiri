import type { AgentStatus } from '~/lib/contracts'

export function activeCodexTurnId(thread: {
  readonly turns?: ReadonlyArray<{ readonly id?: string; readonly status?: string }>
}) {
  const activeTurn = [...(thread.turns ?? [])].reverse().find((turn) => turn.status === 'inProgress')
  return activeTurn?.id
}

export function codexThreadAgentStatus(thread: {
  readonly status?: { readonly type?: string }
}): AgentStatus | null {
  if (thread.status?.type === 'active') return 'running'
  if (thread.status?.type === 'systemError') return 'failed'
  if (thread.status?.type === 'idle' || thread.status?.type === 'notLoaded') return 'idle'
  return null
}
