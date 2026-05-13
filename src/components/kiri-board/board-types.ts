import type { LucideIcon } from 'lucide-react'
import type { RuntimeKind, ThinkingLevel, WorkspaceSnapshot } from '~/lib/contracts'

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
export const sessionRuntimeOrder = ['codex', 'pi', 'claude'] as const satisfies readonly RuntimeKind[]

export const runtimeCopy = {
  codex: {
    label: 'Codex',
    meta: 'local app',
    detail: 'Attach or start a Codex session against this repo.',
  },
  pi: {
    label: 'Pi',
    meta: 'provider hub',
    detail: 'Use Pi provider routing and runtime-aware commands.',
  },
  claude: {
    label: 'Claude',
    meta: 'code',
    detail: 'Run a Claude Code session with the same project target.',
  },
} as const satisfies Record<RuntimeKind, { label: string; meta: string; detail: string }>

export function settingsRuntimeDetail(settings: WorkspaceSnapshot['settings'], runtime: RuntimeKind) {
  return settings.runtimes[runtime].defaultModel
}

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || target.isContentEditable
}
