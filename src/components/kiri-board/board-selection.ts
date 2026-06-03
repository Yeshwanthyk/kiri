'use client'

import * as React from 'react'
import type { AgentCell, ProjectRow, WorkspaceSnapshot } from '~/lib/contracts'
import type { Selection } from './navigation'

export type ResolvedBoardSelection = {
  selectedProject: ProjectRow | undefined
  selectedAgent: AgentCell | undefined
  selection: Selection
}

type PersistAgentByProject = (input: { data: Record<string, string> }) => Promise<unknown>

type BoardSelectionInput = {
  readonly snapshot: WorkspaceSnapshot
  readonly workspace: WorkspaceSnapshot
  readonly persistAgentByProject: PersistAgentByProject
}

type BoardSelectionState = ResolvedBoardSelection & {
  readonly setAgentByProject: (selection: Record<string, string>) => void
  readonly selectProject: (projectId: string) => void
  readonly selectAgent: (projectId: string, agentId: string) => void
  readonly forgetProject: (projectId: string) => void
  readonly activateProject: (projectId: string) => void
  readonly activateProjectIfCurrent: (projectId: string, nextProjectId: string) => void
}

export function useBoardSelection({
  snapshot,
  workspace,
  persistAgentByProject,
}: BoardSelectionInput): BoardSelectionState {
  const [activeProjectId, setActiveProjectId] = React.useState<string>(snapshot.selected.projectId)
  const [agentByProject, setAgentByProjectState] = React.useState<Record<string, string>>(() =>
    snapshot.preferences.agentByProject,
  )
  const agentByProjectRef = React.useRef(agentByProject)

  const setAgentByProject = React.useCallback((next: Record<string, string>) => {
    agentByProjectRef.current = next
    setAgentByProjectState(next)
  }, [])

  const saveAgentByProject = React.useCallback((
    next: Record<string, string>,
    previous: Record<string, string>,
  ) => {
    setAgentByProject(next)
    void persistAgentByProject({ data: next }).catch((error) => {
      console.error('Failed to save selected session preference', error)
      setAgentByProject(previous)
    })
  }, [persistAgentByProject, setAgentByProject])

  const selectAgent = React.useCallback((projectId: string, agentId: string) => {
    setActiveProjectId(projectId)
    const previous = agentByProjectRef.current
    if (previous[projectId] === agentId) return
    saveAgentByProject({ ...previous, [projectId]: agentId }, previous)
  }, [saveAgentByProject])

  const selectProject = React.useCallback((projectId: string) => {
    setActiveProjectId(projectId)
  }, [])

  const forgetProject = React.useCallback((projectId: string) => {
    const previous = agentByProjectRef.current
    if (!(projectId in previous)) return
    const next = { ...previous }
    delete next[projectId]
    saveAgentByProject(next, previous)
  }, [saveAgentByProject])

  const activateProject = React.useCallback((projectId: string) => {
    setActiveProjectId(projectId)
  }, [])

  const activateProjectIfCurrent = React.useCallback((projectId: string, nextProjectId: string) => {
    setActiveProjectId((current) => current === projectId ? nextProjectId : current)
  }, [])

  const resolved = React.useMemo(
    () => resolveBoardSelection(workspace, activeProjectId, agentByProject),
    [activeProjectId, agentByProject, workspace],
  )

  return React.useMemo(() => ({
    ...resolved,
    setAgentByProject,
    selectProject,
    selectAgent,
    forgetProject,
    activateProject,
    activateProjectIfCurrent,
  }), [
    activateProject,
    activateProjectIfCurrent,
    forgetProject,
    resolved,
    selectAgent,
    selectProject,
    setAgentByProject,
  ])
}

export function useProjectSelectionScroll(
  selectedProjectId: string,
  boardScrollRef: React.RefObject<HTMLDivElement | null>,
) {
  const previousSelectedProjectIdRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    const previousProjectId = previousSelectedProjectIdRef.current
    previousSelectedProjectIdRef.current = selectedProjectId
    if (!previousProjectId || previousProjectId === selectedProjectId) return

    const pane = boardScrollRef.current
    if (!pane || !selectedProjectId) return
    const target = pane.querySelector<HTMLElement>('[data-project-selected="true"]')
    if (!target) return

    const paneRect = pane.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const edgePadding = 18
    const delta =
      targetRect.top < paneRect.top + edgePadding
        ? targetRect.top - paneRect.top - edgePadding
        : targetRect.bottom > paneRect.bottom - edgePadding
          ? targetRect.bottom - paneRect.bottom + edgePadding
          : 0
    if (Math.abs(delta) > 8) {
      pane.scrollBy({ top: delta, behavior: 'auto' })
    }
  }, [boardScrollRef, selectedProjectId])
}

export function resolveBoardSelection(
  workspace: WorkspaceSnapshot,
  activeProjectId: string,
  agentByProject: Record<string, string>,
): ResolvedBoardSelection {
  const selectedProject =
    workspace.projects.find((project) => project.id === activeProjectId) ??
    workspace.projects[0]
  const rememberedAgentId = selectedProject ? agentByProject[selectedProject.id] : undefined
  const selectedAgent =
    (rememberedAgentId
      ? selectedProject?.agents.find((agent) => agent.id === rememberedAgentId)
      : undefined) ?? selectedProject?.agents[0]

  return {
    selectedProject,
    selectedAgent,
    selection: {
      projectId: selectedProject?.id ?? '',
      agentId: selectedAgent?.id ?? '',
    },
  }
}
