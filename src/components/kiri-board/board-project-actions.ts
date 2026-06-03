'use client'

import * as React from 'react'
import type {
  AddProjectInput,
  ProjectRow,
  ReorderProjectsInput,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import { pickProjectDirectory } from '~/lib/host-capabilities'
import type { BoardWorkspaceState } from './board-workspace'

type Mutation<Input, Output> = (input: { data: Input }) => Promise<Output>

type BoardProjectMutations = {
  readonly addProject: Mutation<AddProjectInput, WorkspaceSnapshot>
  readonly chooseProjectDirectory: () => Promise<string>
  readonly deleteProject: Mutation<{ id: string }, WorkspaceSnapshot>
  readonly hideProject: Mutation<{ id: string }, WorkspaceSnapshot>
  readonly reorderProjects: Mutation<ReorderProjectsInput, WorkspaceSnapshot>
  readonly unhideProject: Mutation<{ id: string }, WorkspaceSnapshot>
}

type UseBoardProjectActionsInput = Pick<
  BoardWorkspaceState,
  'applyWorkspace' | 'runWorkspaceMutation'
> & {
  readonly selectedProjectId: string
  readonly mutations: BoardProjectMutations
  readonly selectProject: (projectId: string) => void
  readonly forgetProject: (projectId: string) => void
  readonly activateProject: (projectId: string) => void
  readonly activateProjectIfCurrent: (projectId: string, nextProjectId: string) => void
}

export function useBoardProjectActions({
  selectedProjectId,
  mutations,
  applyWorkspace,
  runWorkspaceMutation,
  selectProject,
  forgetProject,
  activateProject,
  activateProjectIfCurrent,
}: UseBoardProjectActionsInput) {
  const [pendingProjectDelete, setPendingProjectDelete] = React.useState<ProjectRow | null>(null)
  const [projectDeleteInFlight, setProjectDeleteInFlight] = React.useState(false)
  const [projectVisibilityPendingId, setProjectVisibilityPendingId] = React.useState<string | null>(null)

  const handleAddProject = React.useCallback(async (input: AddProjectInput) => {
    const next = await runWorkspaceMutation(() => mutations.addProject({ data: input }), applyWorkspace)
    const project = next.projects.find((item) => item.cwd === input.cwd) ?? next.projects.at(-1)
    if (project) selectProject(project.id)
  }, [applyWorkspace, mutations, runWorkspaceMutation, selectProject])

  const handleDeleteProject = React.useCallback(async (projectId: string) => {
    const next = await runWorkspaceMutation(
      () => mutations.deleteProject({ data: { id: projectId } }),
      applyWorkspace,
    )
    forgetProject(projectId)
    if (selectedProjectId === projectId) activateProject(next.selected.projectId)
  }, [activateProject, applyWorkspace, forgetProject, mutations, runWorkspaceMutation, selectedProjectId])

  const confirmDeleteProject = React.useCallback(async (projectId: string) => {
    setProjectDeleteInFlight(true)
    try {
      await handleDeleteProject(projectId)
      setPendingProjectDelete(null)
    } finally {
      setProjectDeleteInFlight(false)
    }
  }, [handleDeleteProject])

  const cancelDeleteProject = React.useCallback(() => {
    setPendingProjectDelete(null)
  }, [])

  const handleHideProject = React.useCallback(async (projectId: string) => {
    setProjectVisibilityPendingId(projectId)
    try {
      const next = await runWorkspaceMutation(
        () => mutations.hideProject({ data: { id: projectId } }),
        applyWorkspace,
      )
      forgetProject(projectId)
      activateProjectIfCurrent(projectId, next.selected.projectId)
    } finally {
      setProjectVisibilityPendingId((current) => current === projectId ? null : current)
    }
  }, [activateProjectIfCurrent, applyWorkspace, forgetProject, mutations, runWorkspaceMutation])

  const handleUnhideProject = React.useCallback(async (projectId: string) => {
    setProjectVisibilityPendingId(projectId)
    try {
      const next = await runWorkspaceMutation(
        () => mutations.unhideProject({ data: { id: projectId } }),
        applyWorkspace,
      )
      const project = next.projects.find((item) => item.id === projectId)
      if (project) selectProject(project.id)
    } finally {
      setProjectVisibilityPendingId((current) => current === projectId ? null : current)
    }
  }, [applyWorkspace, mutations, runWorkspaceMutation, selectProject])

  const handleReorderProjects = React.useCallback(async (projectIds: string[]) => {
    await runWorkspaceMutation(
      () => mutations.reorderProjects({ data: { ids: projectIds } }),
      applyWorkspace,
    )
  }, [applyWorkspace, mutations, runWorkspaceMutation])

  const handleChooseProjectDirectory = React.useCallback(() => {
    return pickProjectDirectory(() => mutations.chooseProjectDirectory())
  }, [mutations])

  return {
    pendingProjectDelete,
    projectDeleteInFlight,
    projectVisibilityPendingId,
    requestDeleteProject: setPendingProjectDelete,
    cancelDeleteProject,
    confirmDeleteProject,
    handleAddProject,
    handleDeleteProject,
    handleHideProject,
    handleUnhideProject,
    handleReorderProjects,
    handleChooseProjectDirectory,
  }
}
