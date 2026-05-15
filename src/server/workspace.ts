import { queryOptions } from '@tanstack/react-query'
import { createServerFn } from '@tanstack/react-start'
import {
  addProjectInputSchema,
  addScratchpadBlockInputSchema,
  agentDetailInputSchema,
  answerQuestionInputSchema,
  deleteScratchpadBlockInputSchema,
  deleteSessionInputSchema,
  deleteProjectInputSchema,
  renameSessionInputSchema,
  refreshTerminalDiffsInputSchema,
  forkSessionInputSchema,
  hideProjectInputSchema,
  interruptMessageInputSchema,
  resetSessionInputSchema,
  reorderProjectsInputSchema,
  reviewSessionInputSchema,
  restoreSessionInputSchema,
  sendMessageInputSchema,
  setAgentByProjectPreferenceInputSchema,
  setChatTypographyPreferenceInputSchema,
  setKeymapPreferenceInputSchema,
  setThemePreferenceInputSchema,
  setThinkingLevelInputSchema,
  startSessionInputSchema,
  steerMessageInputSchema,
  terminalConfigInputSchema,
  triggerScratchpadBlockInputSchema,
  unhideProjectInputSchema,
} from '~/lib/contracts'
import { runWorkspaceServiceMethod } from './workspace-service'

export const fetchWorkspaceSnapshot = createServerFn({ method: 'GET' }).handler(
  async () => runWorkspaceServiceMethod((workspace) => workspace.snapshot()),
)

export const fetchAgentDetail = createServerFn({ method: 'GET' })
  .inputValidator(agentDetailInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.agentDetail(data)))

export const addProjectMutation = createServerFn({ method: 'POST' })
  .inputValidator(addProjectInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.addProject(data)))

export const deleteProjectMutation = createServerFn({ method: 'POST' })
  .inputValidator(deleteProjectInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.deleteProject(data)))

export const hideProjectMutation = createServerFn({ method: 'POST' })
  .inputValidator(hideProjectInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.hideProject(data)))

export const reorderProjectsMutation = createServerFn({ method: 'POST' })
  .inputValidator(reorderProjectsInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.reorderProjects(data)))

export const unhideProjectMutation = createServerFn({ method: 'POST' })
  .inputValidator(unhideProjectInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.unhideProject(data)))

export const chooseProjectDirectoryMutation = createServerFn({ method: 'POST' })
  .handler(async () => runWorkspaceServiceMethod((workspace) => workspace.chooseProjectDirectory()))

export const deleteSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(deleteSessionInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.deleteSession(data)))

export const restoreSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(restoreSessionInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.restoreSession(data)))

export const renameSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(renameSessionInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.renameSession(data)))

export const sendMessageMutation = createServerFn({ method: 'POST' })
  .inputValidator(sendMessageInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.sendMessage(data)))

export const steerMessageMutation = createServerFn({ method: 'POST' })
  .inputValidator(steerMessageInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.steerMessage(data)))

export const interruptMessageMutation = createServerFn({ method: 'POST' })
  .inputValidator(interruptMessageInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.interruptMessage(data)))

export const setThinkingLevelMutation = createServerFn({ method: 'POST' })
  .inputValidator(setThinkingLevelInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.setThinkingLevel(data)))

export const setThemePreferenceMutation = createServerFn({ method: 'POST' })
  .inputValidator(setThemePreferenceInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.setThemePreference(data)))

export const setKeymapPreferenceMutation = createServerFn({ method: 'POST' })
  .inputValidator(setKeymapPreferenceInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.setKeymapPreference(data)))

export const setChatTypographyPreferenceMutation = createServerFn({ method: 'POST' })
  .inputValidator(setChatTypographyPreferenceInputSchema)
  .handler(async ({ data }) =>
    runWorkspaceServiceMethod((workspace) => workspace.setChatTypographyPreference(data)))

export const setAgentByProjectPreferenceMutation = createServerFn({ method: 'POST' })
  .inputValidator(setAgentByProjectPreferenceInputSchema)
  .handler(async ({ data }) =>
    runWorkspaceServiceMethod((workspace) => workspace.setAgentByProjectPreference(data)))

export const resetSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(resetSessionInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.resetSession(data)))

export const forkSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(forkSessionInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.forkSession(data)))

export const reviewSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(reviewSessionInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.reviewSession(data)))

export const answerQuestionMutation = createServerFn({ method: 'POST' })
  .inputValidator(answerQuestionInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.answerQuestion(data)))

export const terminalConfigQuery = createServerFn({ method: 'GET' })
  .inputValidator(terminalConfigInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.terminalConfig(data)))

export const refreshTerminalDiffsMutation = createServerFn({ method: 'POST' })
  .inputValidator(refreshTerminalDiffsInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.refreshTerminalDiffs(data)))

export const startSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(startSessionInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.startSession(data)))

export const addScratchpadBlockMutation = createServerFn({ method: 'POST' })
  .inputValidator(addScratchpadBlockInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.addScratchpadBlock(data)))

export const deleteScratchpadBlockMutation = createServerFn({ method: 'POST' })
  .inputValidator(deleteScratchpadBlockInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.deleteScratchpadBlock(data)))

export const triggerScratchpadBlockMutation = createServerFn({ method: 'POST' })
  .inputValidator(triggerScratchpadBlockInputSchema)
  .handler(async ({ data }) => runWorkspaceServiceMethod((workspace) => workspace.triggerScratchpadBlock(data)))

export const workspaceQueryOptions = () =>
  queryOptions({
    queryKey: ['workspace-snapshot'],
    queryFn: () => fetchWorkspaceSnapshot(),
  })

export const agentDetailQueryOptions = (agentId: string, limit = 500, revision = '', offset = 0) =>
  queryOptions({
    queryKey: ['agent-detail', agentId, limit, offset, revision],
    queryFn: () => fetchAgentDetail({ data: { agentId, limit, offset } }),
    enabled: agentId.length > 0,
  })
