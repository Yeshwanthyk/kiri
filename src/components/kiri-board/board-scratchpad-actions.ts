'use client'

import * as React from 'react'
import type {
  AddScratchpadBlockInput,
  RuntimeKind,
  ScratchpadBlock,
  SessionInterfaceMode,
  ThinkingLevel,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import type { SidebarTab } from './board-types'
import type { BoardWorkspaceState } from './board-workspace'

type Mutation<Input, Output> = (input: { data: Input }) => Promise<Output>

type ScratchpadTriggerOverrides = {
  readonly projectId?: string
  readonly runtime?: RuntimeKind
  readonly interfaceMode?: SessionInterfaceMode
  readonly model?: string
  readonly thinkingLevel?: ThinkingLevel
  readonly title?: string
}

type BoardScratchpadMutations = {
  readonly addScratchpadBlock: Mutation<AddScratchpadBlockInput, WorkspaceSnapshot>
  readonly deleteScratchpadBlock: Mutation<{ id: string }, WorkspaceSnapshot>
  readonly triggerScratchpadBlock: Mutation<
    {
      id: string
      projectId: string
      runtime?: RuntimeKind
      interfaceMode?: SessionInterfaceMode
      model?: string
      thinkingLevel?: ThinkingLevel
      title?: string
    },
    { snapshot: WorkspaceSnapshot; agentId: string }
  >
}

type UseBoardScratchpadActionsInput = Pick<
  BoardWorkspaceState,
  'applyWorkspace' | 'runWorkspaceMutation'
> & {
  readonly selectedProjectId: string | undefined
  readonly mutations: BoardScratchpadMutations
  readonly selectAgent: (projectId: string, agentId: string) => void
  readonly setTab: (tab: SidebarTab) => void
}

export function useBoardScratchpadActions({
  selectedProjectId,
  mutations,
  applyWorkspace,
  runWorkspaceMutation,
  selectAgent,
  setTab,
}: UseBoardScratchpadActionsInput) {
  const handleCaptureBlock = React.useCallback(async (body: string, projectId: string | null) => {
    await runWorkspaceMutation(
      () => mutations.addScratchpadBlock({ data: { body, projectId } }),
      applyWorkspace,
    )
  }, [applyWorkspace, mutations, runWorkspaceMutation])

  const handleDeleteBlock = React.useCallback(async (id: string) => {
    await runWorkspaceMutation(
      () => mutations.deleteScratchpadBlock({ data: { id } }),
      applyWorkspace,
    )
  }, [applyWorkspace, mutations, runWorkspaceMutation])

  const handleTriggerBlock = React.useCallback(async (
    block: ScratchpadBlock,
    overrides?: ScratchpadTriggerOverrides,
  ) => {
    const projectId = overrides?.projectId ?? block.projectId ?? selectedProjectId
    if (!projectId) throw new Error('Pick a project before triggering a block')
    const result = await runWorkspaceMutation(
      () => mutations.triggerScratchpadBlock({
        data: {
          id: block.id,
          projectId,
          runtime: overrides?.runtime,
          interfaceMode: overrides?.interfaceMode,
          model: overrides?.model,
          title: overrides?.title,
          thinkingLevel: overrides?.thinkingLevel,
        },
      }),
      (next) => applyWorkspace(next.snapshot),
    )
    selectAgent(projectId, result.agentId)
    setTab('chat')
  }, [applyWorkspace, mutations, runWorkspaceMutation, selectAgent, selectedProjectId, setTab])

  return {
    handleCaptureBlock,
    handleDeleteBlock,
    handleTriggerBlock,
  }
}
