'use client'

import * as React from 'react'
import { useServerFn } from '@tanstack/react-start'
import {
  addProjectMutation,
  addScratchpadBlockMutation,
  answerQuestionMutation,
  chooseProjectDirectoryMutation,
  deleteProjectMutation,
  deleteScratchpadBlockMutation,
  deleteSessionMutation,
  fetchWorkspaceSnapshot,
  fetchWorkspaceRevision,
  forkSessionMutation,
  hideProjectMutation,
  interruptMessageMutation,
  renameSessionMutation,
  reorderProjectsMutation,
  resetSessionMutation,
  restoreSessionMutation,
  reviewSessionMutation,
  sendMessageMutation,
  setAgentByProjectPreferenceMutation,
  setChatTypographyPreferenceMutation,
  setKeymapPreferenceMutation,
  setThemePreferenceMutation,
  setThinkingLevelMutation,
  startSessionMutation,
  steerMessageMutation,
  triggerScratchpadBlockMutation,
  unhideProjectMutation,
} from '~/server/workspace'

export function useBoardServerActions() {
  const addProject = useServerFn(addProjectMutation)
  const addScratchpadBlock = useServerFn(addScratchpadBlockMutation)
  const answerQuestion = useServerFn(answerQuestionMutation)
  const chooseProjectDirectory = useServerFn(chooseProjectDirectoryMutation)
  const deleteProject = useServerFn(deleteProjectMutation)
  const deleteScratchpadBlock = useServerFn(deleteScratchpadBlockMutation)
  const deleteSession = useServerFn(deleteSessionMutation)
  const forkSession = useServerFn(forkSessionMutation)
  const hideProject = useServerFn(hideProjectMutation)
  const refreshWorkspace = useServerFn(fetchWorkspaceSnapshot)
  const refreshWorkspaceRevision = useServerFn(fetchWorkspaceRevision)
  const resetSession = useServerFn(resetSessionMutation)
  const restoreSession = useServerFn(restoreSessionMutation)
  const reviewSession = useServerFn(reviewSessionMutation)
  const sendMessage = useServerFn(sendMessageMutation)
  const setAgentByProjectPreference = useServerFn(setAgentByProjectPreferenceMutation)
  const setChatTypographyPreference = useServerFn(setChatTypographyPreferenceMutation)
  const setKeymapPreference = useServerFn(setKeymapPreferenceMutation)
  const setThemePreference = useServerFn(setThemePreferenceMutation)
  const setThinkingLevel = useServerFn(setThinkingLevelMutation)
  const steerMessage = useServerFn(steerMessageMutation)
  const interruptMessage = useServerFn(interruptMessageMutation)
  const renameSession = useServerFn(renameSessionMutation)
  const reorderProjects = useServerFn(reorderProjectsMutation)
  const startSession = useServerFn(startSessionMutation)
  const triggerScratchpadBlock = useServerFn(triggerScratchpadBlockMutation)
  const unhideProject = useServerFn(unhideProjectMutation)

  const workspaceQueries = React.useMemo(() => ({
    refreshWorkspace,
    refreshWorkspaceRevision,
  }), [
    refreshWorkspace,
    refreshWorkspaceRevision,
  ])

  const preferenceMutations = React.useMemo(() => ({
    setAgentByProjectPreference,
    setChatTypographyPreference,
    setKeymapPreference,
    setThemePreference,
  }), [
    setAgentByProjectPreference,
    setChatTypographyPreference,
    setKeymapPreference,
    setThemePreference,
  ])

  const sessionMutations = React.useMemo(() => ({
    renameSession,
    deleteSession,
    sendMessage,
    steerMessage,
    interruptMessage,
    setThinkingLevel,
    resetSession,
    forkSession,
    reviewSession,
    answerQuestion,
    startSession,
    restoreSession,
  }), [
    answerQuestion,
    deleteSession,
    forkSession,
    interruptMessage,
    renameSession,
    resetSession,
    restoreSession,
    reviewSession,
    sendMessage,
    setThinkingLevel,
    startSession,
    steerMessage,
  ])

  const projectMutations = React.useMemo(() => ({
    addProject,
    chooseProjectDirectory,
    deleteProject,
    hideProject,
    reorderProjects,
    unhideProject,
  }), [
    addProject,
    chooseProjectDirectory,
    deleteProject,
    hideProject,
    reorderProjects,
    unhideProject,
  ])

  const scratchpadMutations = React.useMemo(() => ({
    addScratchpadBlock,
    deleteScratchpadBlock,
    triggerScratchpadBlock,
  }), [
    addScratchpadBlock,
    deleteScratchpadBlock,
    triggerScratchpadBlock,
  ])

  return {
    workspaceQueries,
    preferenceMutations,
    sessionMutations,
    projectMutations,
    scratchpadMutations,
  }
}
