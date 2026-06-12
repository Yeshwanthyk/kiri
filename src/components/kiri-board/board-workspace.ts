'use client'

import * as React from 'react'
import type { WorkspaceRevision, WorkspaceSnapshot } from '~/lib/contracts'
import type { RefreshAgentDetail } from './board-types'
import { createWorkspaceDedupe, createWorkspaceRevisionGate } from './workspace-fingerprint'
import { pollWorkspaceDuringAction, pollWorkspaceInBackground } from './workspace-polling'

type UseBoardWorkspaceInput = {
  readonly snapshot: WorkspaceSnapshot
  readonly refreshWorkspace: () => Promise<WorkspaceSnapshot>
  readonly refreshWorkspaceRevision: () => Promise<WorkspaceRevision>
}

export type BoardWorkspaceState = {
  readonly workspace: WorkspaceSnapshot
  readonly applyWorkspace: (next: WorkspaceSnapshot) => void
  readonly runWorkspaceMutation: <T>(
    action: () => Promise<T>,
    onResult: (result: T) => void,
  ) => Promise<T>
  readonly withWorkspacePolling: (
    action: () => Promise<WorkspaceSnapshot>,
    onResult: (result: WorkspaceSnapshot) => void,
    onPoll?: RefreshAgentDetail,
  ) => Promise<void>
}

export function useBoardWorkspace({
  snapshot,
  refreshWorkspace,
  refreshWorkspaceRevision,
}: UseBoardWorkspaceInput): BoardWorkspaceState {
  const [workspace, setWorkspace] = React.useState(snapshot)
  const refreshWorkspaceRef = React.useRef(refreshWorkspace)
  const refreshWorkspaceRevisionRef = React.useRef(refreshWorkspaceRevision)
  const activeWorkspaceMutationsRef = React.useRef(0)
  const workspaceActivityEpochRef = React.useRef(0)
  const workspaceDedupeRef = React.useRef(createWorkspaceDedupe(snapshot))
  const workspaceRevisionGateRef = React.useRef(createWorkspaceRevisionGate())

  const applyWorkspace = React.useCallback((next: WorkspaceSnapshot) => {
    workspaceDedupeRef.current.apply(next, setWorkspace)
  }, [])

  const beginWorkspaceMutation = React.useCallback(() => {
    activeWorkspaceMutationsRef.current += 1
    workspaceActivityEpochRef.current += 1
    let ended = false
    return () => {
      if (ended) return
      ended = true
      activeWorkspaceMutationsRef.current -= 1
      workspaceActivityEpochRef.current += 1
    }
  }, [])

  const runWorkspaceMutation = React.useCallback(async <T,>(
    action: () => Promise<T>,
    onResult: (result: T) => void,
  ) => {
    const endWorkspaceMutation = beginWorkspaceMutation()
    try {
      const result = await action()
      onResult(result)
      return result
    } finally {
      endWorkspaceMutation()
    }
  }, [beginWorkspaceMutation])

  const withWorkspacePolling = React.useCallback(async (
    action: () => Promise<WorkspaceSnapshot>,
    onResult: (result: WorkspaceSnapshot) => void,
    onPoll?: RefreshAgentDetail,
  ) => {
    const endWorkspaceMutation = beginWorkspaceMutation()
    let tickChanged = false
    const gatedOnPoll = onPoll
      ? async () => {
          if (tickChanged) await onPoll()
        }
      : undefined
    try {
      await pollWorkspaceDuringAction<WorkspaceSnapshot, WorkspaceSnapshot | null>({
        action,
        refreshWorkspace: () =>
          workspaceRevisionGateRef.current.refreshIfChanged({
            refreshRevision: () => refreshWorkspaceRevisionRef.current(),
            refreshWorkspace: () => refreshWorkspaceRef.current(),
          }),
        onResult,
        onWorkspace: (next) => {
          tickChanged = next !== null && workspaceDedupeRef.current.apply(next, setWorkspace)
        },
        onPoll: gatedOnPoll,
      })
    } finally {
      endWorkspaceMutation()
    }
  }, [beginWorkspaceMutation])

  React.useEffect(() => {
    applyWorkspace(snapshot)
  }, [applyWorkspace, snapshot])

  React.useEffect(() => {
    refreshWorkspaceRef.current = refreshWorkspace
  }, [refreshWorkspace])

  React.useEffect(() => {
    refreshWorkspaceRevisionRef.current = refreshWorkspaceRevision
  }, [refreshWorkspaceRevision])

  React.useEffect(() =>
    pollWorkspaceInBackground({
      refreshWorkspace: () =>
        workspaceRevisionGateRef.current.refreshIfChanged({
          refreshRevision: () => refreshWorkspaceRevisionRef.current(),
          refreshWorkspace: () => refreshWorkspaceRef.current(),
        }),
      onWorkspace: (next) => {
        if (next) applyWorkspace(next)
      },
      isIdle: () => activeWorkspaceMutationsRef.current === 0,
      idleToken: () => workspaceActivityEpochRef.current,
    }),
  [applyWorkspace])

  return React.useMemo(() => ({
    workspace,
    applyWorkspace,
    runWorkspaceMutation,
    withWorkspacePolling,
  }), [applyWorkspace, runWorkspaceMutation, withWorkspacePolling, workspace])
}
