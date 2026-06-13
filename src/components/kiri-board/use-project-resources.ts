'use client'

import * as React from 'react'
import type { ProjectRow, WorkspaceSnapshot } from '~/lib/contracts'
import {
  emptyResourceShellLayout,
  insertAgentResource,
  moveProjectResource,
  reconcileProjectResources,
  selectAdjacentResource,
  ensureTerminalResource,
  type ResourceId,
  type ResourceShellLayout,
} from './resource-tabs'
import {
  readStoredResourceLayout,
  saveStoredResourceLayout,
} from './storage'

type UseProjectResourcesInput = {
  readonly workspace: WorkspaceSnapshot
  readonly activeProjectId: string
}

export function useProjectResources({
  workspace,
  activeProjectId,
}: UseProjectResourcesInput) {
  const [storedLayout, setStoredLayout] = React.useState<ResourceShellLayout>(
    emptyResourceShellLayout,
  )
  const [hydrated, setHydrated] = React.useState(false)
  const initialActiveProjectIdRef = React.useRef(activeProjectId)

  React.useEffect(() => {
    setStoredLayout(readStoredResourceLayout())
    setHydrated(true)
  }, [])

  const reconciled = React.useMemo(() => {
    const projects: Record<string, ReturnType<typeof reconcileProjectResources>> = {}
    for (const project of workspace.projects) {
      projects[project.id] = reconcileProjectResources({
        project,
        layout: storedLayout.projects[project.id],
      })
    }
    return projects
  }, [storedLayout.projects, workspace.projects])

  const layout = React.useMemo<ResourceShellLayout>(() => {
    const storedActiveProjectVisible = Boolean(
      storedLayout.activeProjectId &&
      workspace.projects.some((project) => project.id === storedLayout.activeProjectId),
    )
    const shouldUseStoredActiveProject =
      hydrated &&
      storedActiveProjectVisible &&
      activeProjectId === initialActiveProjectIdRef.current
    return {
      activeProjectId: shouldUseStoredActiveProject
        ? storedLayout.activeProjectId
        : activeProjectId || storedLayout.activeProjectId,
      projects: Object.fromEntries(
        Object.entries(reconciled).map(([projectId, projectLayout]) => [
          projectId,
          projectLayout.layout,
        ]),
      ),
    }
  }, [
    activeProjectId,
    hydrated,
    reconciled,
    storedLayout.activeProjectId,
    workspace.projects,
  ])

  React.useEffect(() => {
    if (!hydrated) return
    saveStoredResourceLayout(layout)
  }, [hydrated, layout])

  const updateProjectLayout = React.useCallback((
    projectId: string,
    update: (current: ResourceShellLayout) => ResourceShellLayout,
  ) => {
    setStoredLayout((current) => {
      const base = ensureProjectLayout(current, workspace.projects, projectId)
      return update(base)
    })
  }, [workspace.projects])

  const selectResource = React.useCallback((projectId: string, resourceId: ResourceId) => {
    updateProjectLayout(projectId, (current) => {
      const project = workspace.projects.find((item) => item.id === projectId)
      if (!project) return current
      const reconciledProject = reconcileProjectResources({
        project,
        layout: current.projects[projectId],
      })
      if (!reconciledProject.resources.some((resource) => resource.id === resourceId)) return current
      const activeTerminalResourceId = resourceId.startsWith('terminal:')
        ? resourceId as `terminal:${string}`
        : undefined
      return {
        ...current,
        activeProjectId: projectId,
        projects: {
          ...current.projects,
          [projectId]: {
            ...reconciledProject.layout,
            activeResourceId: resourceId,
            ...(activeTerminalResourceId
              ? { activeTerminalResourceId }
              : {}),
          },
        },
      }
    })
  }, [updateProjectLayout, workspace.projects])

  const moveResource = React.useCallback((
    projectId: string,
    resourceId: ResourceId,
    toIndex: number,
  ) => {
    updateProjectLayout(projectId, (current) => {
      const project = workspace.projects.find((item) => item.id === projectId)
      if (!project) return current
      const reconciledProject = reconcileProjectResources({
        project,
        layout: current.projects[projectId],
      })
      return {
        ...current,
        activeProjectId: projectId,
        projects: {
          ...current.projects,
          [projectId]: moveProjectResource({
            layout: reconciledProject.layout,
            resourceId,
            toIndex,
          }),
        },
      }
    })
  }, [updateProjectLayout, workspace.projects])

  const selectAdjacent = React.useCallback((
    projectId: string,
    delta: 1 | -1,
  ) => {
    const projectResources = reconciled[projectId]
    if (!projectResources) return
    const resourceId = selectAdjacentResource({
      resources: projectResources.resources,
      activeResourceId: projectResources.activeResourceId,
      delta,
    })
    if (!resourceId) return
    selectResource(projectId, resourceId)
  }, [reconciled, selectResource])

  const insertAgent = React.useCallback((projectId: string, agentId: string) => {
    updateProjectLayout(projectId, (current) => {
      const project = workspace.projects.find((item) => item.id === projectId)
      if (!project) return current
      const reconciledProject = reconcileProjectResources({
        project,
        layout: current.projects[projectId],
      })
      return {
        ...current,
        activeProjectId: projectId,
        projects: {
          ...current.projects,
          [projectId]: insertAgentResource({
            layout: reconciledProject.layout,
            agentId,
          }),
        },
      }
    })
  }, [updateProjectLayout, workspace.projects])

  const ensureTerminal = React.useCallback((projectId: string) => {
    let nextResourceId: ResourceId | null = null
    updateProjectLayout(projectId, (current) => {
      const project = workspace.projects.find((item) => item.id === projectId)
      if (!project) return current
      const reconciledProject = reconcileProjectResources({
        project,
        layout: current.projects[projectId],
      })
      const next = ensureTerminalResource({
        layout: reconciledProject.layout,
        title: 'terminal',
      })
      nextResourceId = next.resourceId
      return {
        ...current,
        activeProjectId: projectId,
        projects: {
          ...current.projects,
          [projectId]: next.layout,
        },
      }
    })
    return nextResourceId
  }, [updateProjectLayout, workspace.projects])

  const activeProjectResources = reconciled[activeProjectId]

  return {
    hydrated,
    layout,
    activeProjectResources,
    resourcesByProject: reconciled,
    selectResource,
    moveResource,
    selectAdjacent,
    insertAgent,
    ensureTerminal,
  }
}

function ensureProjectLayout(
  layout: ResourceShellLayout,
  projects: readonly ProjectRow[],
  projectId: string,
): ResourceShellLayout {
  if (layout.projects[projectId]) return layout
  const project = projects.find((item) => item.id === projectId)
  if (!project) return layout
  return {
    ...layout,
    projects: {
      ...layout.projects,
      [projectId]: reconcileProjectResources({
        project,
        layout: undefined,
      }).layout,
    },
  }
}
