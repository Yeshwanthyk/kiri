'use client'

import * as React from 'react'
import type {
  KnowledgeAddInput,
  KnowledgeEntry,
  KnowledgeUpdateInput,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import type { BoardWorkspaceState } from './board-workspace'

type Mutation<Input, Output> = (input: { data: Input }) => Promise<Output>

type BoardKnowledgeMutations = {
  readonly addKnowledgeEntry: Mutation<KnowledgeAddInput, KnowledgeEntry>
  readonly deleteKnowledgeEntry: Mutation<{ id: string }, KnowledgeEntry>
  readonly listKnowledgeEntries: Mutation<{ projectId?: string }, readonly KnowledgeEntry[]>
  readonly updateKnowledgeEntry: Mutation<KnowledgeUpdateInput, KnowledgeEntry>
}

type UseBoardKnowledgeActionsInput = Pick<
  BoardWorkspaceState,
  'applyWorkspace'
> & {
  readonly mutations: BoardKnowledgeMutations
  readonly refreshWorkspace: () => Promise<WorkspaceSnapshot>
}

export function useBoardKnowledgeActions({
  mutations,
  applyWorkspace,
  refreshWorkspace,
}: UseBoardKnowledgeActionsInput) {
  const refreshAfterKnowledgeChange = React.useCallback(async () => {
    applyWorkspace(await refreshWorkspace())
  }, [applyWorkspace, refreshWorkspace])

  const handleListKnowledge = React.useCallback(async (projectId?: string) =>
    mutations.listKnowledgeEntries({ data: projectId ? { projectId } : {} }),
  [mutations])

  const handleCaptureKnowledge = React.useCallback(async (input: KnowledgeAddInput) => {
    const entry = await mutations.addKnowledgeEntry({ data: input })
    await refreshAfterKnowledgeChange()
    return entry
  }, [mutations, refreshAfterKnowledgeChange])

  const handleUpdateKnowledge = React.useCallback(async (input: KnowledgeUpdateInput) => {
    const entry = await mutations.updateKnowledgeEntry({ data: input })
    await refreshAfterKnowledgeChange()
    return entry
  }, [mutations, refreshAfterKnowledgeChange])

  const handleDeleteKnowledge = React.useCallback(async (id: string) => {
    await mutations.deleteKnowledgeEntry({ data: { id } })
    await refreshAfterKnowledgeChange()
  }, [mutations, refreshAfterKnowledgeChange])

  return {
    handleCaptureKnowledge,
    handleDeleteKnowledge,
    handleListKnowledge,
    handleUpdateKnowledge,
  }
}
