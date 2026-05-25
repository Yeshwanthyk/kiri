import type { LucideIcon } from 'lucide-react'
import type { ThinkingLevel } from '~/lib/contracts'

export type SidebarTab = 'chat' | 'diffs' | 'terminal' | 'scratchpad'

export type RefreshAgentDetail = () => Promise<void>

export type CommandPaletteAction = {
  id: string
  title: string
  detail: string
  icon: LucideIcon
  disabled: boolean
  run: () => void
}

export const sessionThinkingLevels = ['off', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly ThinkingLevel[]
export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || target.isContentEditable
}
