import type { ProjectRow } from '~/lib/contracts'

export type KeymapAction =
  | 'projectPrev'
  | 'projectNext'
  | 'agentPrev'
  | 'agentNext'
  | 'startSession'
  | 'deleteSession'
  | 'focusChat'
  | 'openDiffs'
  | 'openTerminal'

export type KeymapSettings = Record<KeymapAction, string>

export type Selection = {
  projectId: string
  agentId: string
}

export const defaultKeymap: KeymapSettings = {
  projectPrev: 'k',
  projectNext: 'j',
  agentPrev: 'h',
  agentNext: 'l',
  startSession: 'n',
  deleteSession: 'x',
  focusChat: 'c',
  openDiffs: 'd',
  openTerminal: 't',
}

export const keyOptions: readonly string[] = [
  'h',
  'j',
  'k',
  'l',
  'n',
  'x',
  'c',
  'd',
  't',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
] as const

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
      { action: 'agentPrev', label: 'Agent left', hint: 'Previous session in row' },
      { action: 'agentNext', label: 'Agent right', hint: 'Next session in row' },
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
      { action: 'openDiffs', label: 'Open diffs', hint: 'Switch sidebar to diffs' },
      { action: 'openTerminal', label: 'Open terminal', hint: 'Switch sidebar to terminal' },
    ],
  },
]

export function moveProject(
  projects: ProjectRow[],
  current: Selection,
  delta: 1 | -1,
): Selection {
  const index = projects.findIndex((project) => project.id === current.projectId)
  const nextIndex = clamp(index + delta, 0, projects.length - 1)
  const project = projects[nextIndex]
  const currentProject = projects[index]
  if (!project) return current
  const agent =
    project.agents.find((item) => item.id === current.agentId) ??
    project.agents[
      clamp(
        currentProject?.agents.findIndex((item) => item.id === current.agentId) ??
          0,
        0,
        project.agents.length - 1,
      )
    ]
  return {
    projectId: project.id,
    agentId: agent?.id ?? current.agentId,
  }
}

export function moveAgent(project: ProjectRow, current: Selection, delta: 1 | -1): Selection {
  const index = project.agents.findIndex((agent) => agent.id === current.agentId)
  const nextIndex = clamp(index + delta, 0, project.agents.length - 1)
  return {
    projectId: project.id,
    agentId: project.agents[nextIndex]?.id ?? current.agentId,
  }
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
  if (key.startsWith('arrow')) return key.replace('arrow', 'Arrow ')
  return key.toUpperCase()
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
