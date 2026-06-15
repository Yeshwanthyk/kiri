import type { ProjectRow } from '~/lib/contracts'
export {
  defaultKeymap,
  keyOptions,
  type KeymapAction,
  type KeymapSettings,
} from '~/lib/ui-preferences'
import {
  defaultKeymap,
  keyOptions,
  type KeymapAction,
  type KeymapSettings,
} from '~/lib/ui-preferences'

export type Selection = {
  projectId: string
  agentId: string
}

export const keymapGroups: {
  id: string
  label: string
  rows: { action: KeymapAction; label: string; hint: string }[]
}[] = [
  {
    id: 'board',
    label: 'Board navigation',
    rows: [
      { action: 'projectPrev', label: 'Project up', hint: 'Previous project row' },
      { action: 'projectNext', label: 'Project down', hint: 'Next project row' },
      { action: 'agentPrev', label: 'Resource left', hint: 'Previous resource tab' },
      { action: 'agentNext', label: 'Resource right', hint: 'Next resource tab' },
    ],
  },
  {
    id: 'session',
    label: 'Session',
    rows: [
      { action: 'startSession', label: 'Start session', hint: 'Open new-session dialog' },
      { action: 'deleteSession', label: 'Remove session', hint: 'Delete the selected session' },
    ],
  },
  {
    id: 'focus',
    label: 'Focus',
    rows: [
      { action: 'focusChat', label: 'Focus chat', hint: 'Jump cursor to composer' },
      { action: 'openTerminal', label: 'Open terminal', hint: 'Open terminal resource' },
      { action: 'openBrowser', label: 'Open browser', hint: 'Open browser resource' },
      { action: 'openScratchpad', label: 'Toggle scratchpad', hint: 'Open or close scratchpad' },
      { action: 'toggleTerminalFocus', label: 'Toggle terminal focus', hint: 'Jump into or out of the visible terminal' },
    ],
  },
]

export function moveProject(
  projects: ProjectRow[],
  currentProjectId: string,
  delta: 1 | -1,
): string {
  if (projects.length === 0) return currentProjectId
  const index = projects.findIndex((project) => project.id === currentProjectId)
  const nextIndex = clamp((index < 0 ? 0 : index) + delta, 0, projects.length - 1)
  return projects[nextIndex]?.id ?? currentProjectId
}

export function moveAgent(
  project: ProjectRow,
  currentAgentId: string,
  delta: 1 | -1,
): string | null {
  if (project.agents.length === 0) return null
  const index = project.agents.findIndex((agent) => agent.id === currentAgentId)
  const nextIndex = clamp((index < 0 ? 0 : index) + delta, 0, project.agents.length - 1)
  return project.agents[nextIndex]?.id ?? null
}

export function actionForKey(keymap: KeymapSettings, key: string): KeymapAction | undefined {
  return (Object.entries(keymap) as Array<[KeymapAction, string]>).find(
    ([, binding]) => binding === key,
  )?.[0]
}

export function updateKeymap(
  current: KeymapSettings,
  action: KeymapAction,
  value: string,
): KeymapSettings {
  const keymap = { ...current }
  const displacedAction = (
    Object.entries(keymap) as Array<[KeymapAction, string]>
  ).find(
    ([otherAction, binding]) => otherAction !== action && binding === value,
  )?.[0]

  if (displacedAction) {
    keymap[displacedAction] = current[action]
  }
  keymap[action] = value
  return keymap
}

export function formatKey(key: string) {
  if (key === 'tab') return 'Tab'
  if (key.startsWith('arrow')) return key.replace('arrow', 'Arrow ')
  return key.toUpperCase()
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
