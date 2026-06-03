'use client'

import * as React from 'react'
import type {
  AgentCell,
  ProjectRow,
  ReviewTarget,
  SendMessageImage,
  StartSessionInput,
  ThinkingLevel,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import type { RefreshAgentDetail, SidebarTab } from './board-types'
import type { BoardWorkspaceState } from './board-workspace'

type Mutation<Input, Output> = (input: { data: Input }) => Promise<Output>

type BoardSessionMutations = {
  readonly renameSession: Mutation<{ agentId: string; title: string }, WorkspaceSnapshot>
  readonly deleteSession: Mutation<{ agentId: string }, WorkspaceSnapshot>
  readonly sendMessage: Mutation<{
    agentId: string
    text: string
    images: SendMessageImage[]
  }, WorkspaceSnapshot>
  readonly refreshTerminalDiffs: Mutation<{ agentId: string }, WorkspaceSnapshot>
  readonly steerMessage: Mutation<{
    agentId: string
    text: string
    images: SendMessageImage[]
  }, WorkspaceSnapshot>
  readonly interruptMessage: Mutation<{ agentId: string }, WorkspaceSnapshot>
  readonly setThinkingLevel: Mutation<{ agentId: string; level?: ThinkingLevel }, WorkspaceSnapshot>
  readonly resetSession: Mutation<{ agentId: string }, WorkspaceSnapshot>
  readonly forkSession: Mutation<{ agentId: string }, { snapshot: WorkspaceSnapshot; agentId: string }>
  readonly reviewSession: Mutation<{ agentId: string; target: ReviewTarget }, WorkspaceSnapshot>
  readonly answerQuestion: Mutation<{
    agentId: string
    requestId: string
    answers: Record<string, string | string[]>
  }, WorkspaceSnapshot>
  readonly startSession: Mutation<StartSessionInput, WorkspaceSnapshot>
  readonly restoreSession: Mutation<{ agentId: string }, WorkspaceSnapshot>
}

type UseBoardSessionActionsInput = Pick<
  BoardWorkspaceState,
  'applyWorkspace' | 'runWorkspaceMutation' | 'withWorkspacePolling'
> & {
  readonly selectedProject: ProjectRow | undefined
  readonly mutations: BoardSessionMutations
  readonly selectAgent: (projectId: string, agentId: string) => void
  readonly forgetProject: (projectId: string) => void
  readonly activateProject: (projectId: string) => void
  readonly resetChatFocus: () => void
  readonly setTab: (tab: SidebarTab) => void
  readonly closeSessionLauncher: () => void
}

export function useBoardSessionActions({
  selectedProject,
  mutations,
  applyWorkspace,
  runWorkspaceMutation,
  withWorkspacePolling,
  selectAgent,
  forgetProject,
  activateProject,
  resetChatFocus,
  setTab,
  closeSessionLauncher,
}: UseBoardSessionActionsInput) {
  const [pendingDelete, setPendingDelete] = React.useState<{ agentId: string; title: string } | null>(null)
  const [deleteInFlight, setDeleteInFlight] = React.useState(false)

  const handleRenameSession = React.useCallback(async (agentId: string, title: string) => {
    await runWorkspaceMutation(
      () => mutations.renameSession({ data: { agentId, title } }),
      applyWorkspace,
    )
  }, [applyWorkspace, mutations, runWorkspaceMutation])

  const handleDeleteSession = React.useCallback((agentId: string) => {
    const agent = selectedProject?.agents.find((item) => item.id === agentId)
    if (!agent || !selectedProject) return
    setPendingDelete({ agentId, title: agent.title })
  }, [selectedProject])

  const cancelDeleteSession = React.useCallback(() => {
    setPendingDelete(null)
  }, [])

  const confirmDeleteSession = React.useCallback(async () => {
    if (!pendingDelete || !selectedProject) return
    const { agentId } = pendingDelete
    const currentProjectId = selectedProject.id
    const currentIndex = selectedProject.agents.findIndex((agent) => agent.id === agentId)
    setDeleteInFlight(true)
    try {
      const next = await runWorkspaceMutation(
        () => mutations.deleteSession({ data: { agentId } }),
        applyWorkspace,
      )
      const project = next.projects.find((item) => item.id === currentProjectId) ?? next.projects[0]
      if (!project) return
      const fallbackAgent = fallbackAgentAfterSessionDelete(project, currentIndex)
      if (fallbackAgent) {
        selectAgent(project.id, fallbackAgent.id)
      } else {
        forgetProject(project.id)
        activateProject(project.id)
        resetChatFocus()
      }
    } finally {
      setDeleteInFlight(false)
      setPendingDelete(null)
    }
  }, [
    activateProject,
    applyWorkspace,
    forgetProject,
    mutations,
    pendingDelete,
    resetChatFocus,
    runWorkspaceMutation,
    selectAgent,
    selectedProject,
  ])

  const handleSendMessage = React.useCallback(async (
    agentId: string,
    text: string,
    images: SendMessageImage[] = [],
    onDetailRefresh?: RefreshAgentDetail,
  ) => {
    await withWorkspacePolling(
      () => mutations.sendMessage({ data: { agentId, text, images } }),
      applyWorkspace,
      onDetailRefresh,
    )
    await onDetailRefresh?.()
  }, [applyWorkspace, mutations, withWorkspacePolling])

  const handleRefreshTerminalDiffs = React.useCallback(async (
    agentId: string,
    onDetailRefresh?: RefreshAgentDetail,
  ) => {
    await runWorkspaceMutation(
      () => mutations.refreshTerminalDiffs({ data: { agentId } }),
      applyWorkspace,
    )
    await onDetailRefresh?.()
  }, [applyWorkspace, mutations, runWorkspaceMutation])

  const handleSteerMessage = React.useCallback(async (
    agentId: string,
    text: string,
    images: SendMessageImage[] = [],
  ) => {
    await runWorkspaceMutation(
      () => mutations.steerMessage({ data: { agentId, text, images } }),
      applyWorkspace,
    )
  }, [applyWorkspace, mutations, runWorkspaceMutation])

  const handleInterruptMessage = React.useCallback(async (agentId: string) => {
    await runWorkspaceMutation(
      () => mutations.interruptMessage({ data: { agentId } }),
      applyWorkspace,
    )
  }, [applyWorkspace, mutations, runWorkspaceMutation])

  const handleThinkingCommand = React.useCallback(async (agentId: string, level?: ThinkingLevel) => {
    await runWorkspaceMutation(
      () => mutations.setThinkingLevel({ data: { agentId, level } }),
      applyWorkspace,
    )
  }, [applyWorkspace, mutations, runWorkspaceMutation])

  const handleResetSession = React.useCallback(async (agentId: string) => {
    await runWorkspaceMutation(
      () => mutations.resetSession({ data: { agentId } }),
      applyWorkspace,
    )
  }, [applyWorkspace, mutations, runWorkspaceMutation])

  const handleForkSession = React.useCallback(async (agentId: string) => {
    const result = await runWorkspaceMutation(
      () => mutations.forkSession({ data: { agentId } }),
      (next) => applyWorkspace(next.snapshot),
    )
    const project = result.snapshot.projects.find((item) =>
      item.agents.some((agent) => agent.id === result.agentId),
    )
    if (project) selectAgent(project.id, result.agentId)
  }, [applyWorkspace, mutations, runWorkspaceMutation, selectAgent])

  const handleReviewSession = React.useCallback(async (agentId: string, target: ReviewTarget) => {
    await runWorkspaceMutation(
      () => mutations.reviewSession({ data: { agentId, target } }),
      applyWorkspace,
    )
  }, [applyWorkspace, mutations, runWorkspaceMutation])

  const handleAnswerQuestion = React.useCallback(async (
    agentId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
  ) => {
    await runWorkspaceMutation(
      () => mutations.answerQuestion({ data: { agentId, requestId, answers } }),
      applyWorkspace,
    )
  }, [applyWorkspace, mutations, runWorkspaceMutation])

  const handleStartSession = React.useCallback(async (input: StartSessionInput) => {
    const next = await runWorkspaceMutation(
      () => mutations.startSession({ data: input }),
      applyWorkspace,
    )
    const project = next.projects.find((item) => item.id === input.projectId)
    const agent =
      (input.title
        ? project?.agents.find((item) => item.title === input.title)
        : undefined) ?? project?.agents[project.agents.length - 1]
    if (project && agent) selectAgent(project.id, agent.id)
    setTab('chat')
    closeSessionLauncher()
  }, [applyWorkspace, closeSessionLauncher, mutations, runWorkspaceMutation, selectAgent, setTab])

  const handleResumeSession = React.useCallback(async (
    projectId: string,
    agentId: string,
    archived: boolean,
  ) => {
    if (archived) {
      await runWorkspaceMutation(
        () => mutations.restoreSession({ data: { agentId } }),
        applyWorkspace,
      )
    }
    selectAgent(projectId, agentId)
    setTab('chat')
    closeSessionLauncher()
  }, [applyWorkspace, closeSessionLauncher, mutations, runWorkspaceMutation, selectAgent, setTab])

  return {
    pendingDelete,
    deleteInFlight,
    cancelDeleteSession,
    confirmDeleteSession,
    handleRenameSession,
    handleDeleteSession,
    handleSendMessage,
    handleRefreshTerminalDiffs,
    handleSteerMessage,
    handleInterruptMessage,
    handleThinkingCommand,
    handleResetSession,
    handleForkSession,
    handleReviewSession,
    handleAnswerQuestion,
    handleStartSession,
    handleResumeSession,
  }
}

export function fallbackAgentAfterSessionDelete(
  project: ProjectRow,
  deletedAgentIndex: number,
): AgentCell | undefined {
  return project.agents[Math.max(0, Math.min(deletedAgentIndex - 1, project.agents.length - 1))]
}
