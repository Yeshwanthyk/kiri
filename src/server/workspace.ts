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
import {
  addProject,
  addScratchpadBlock,
  deleteScratchpadBlock,
  deleteSession,
  deleteProject,
  renameSession,
  reorderProjects,
  restoreSession,
  getAgentDetail,
  getAgentLaunchConfig,
  getWorkspaceSnapshot,
  hideProject,
  startSession,
  unhideProject,
} from './db'
import {
  forkAgentSession,
  answerAgentQuestion,
  interruptAgent,
  promptAgent,
  resetAgentSession,
  reviewAgentSession,
  setAgentThinkingLevel,
  steerAgent,
} from './runtime'
import { forgetProviderRuntimeAgent } from './provider-runtime'
import { triggerScratchpadSession } from './scratchpad-trigger'
import { closeAgentRuntimeTerminal, ensureTerminalServer } from './terminal-server'
import {
  setAgentByProjectPreference,
  setChatTypographyPreference,
  setKeymapPreference,
  setThemePreference,
} from './preferences'
import { refreshTerminalSessionDiffs } from './diff-refresh'
import { chooseProjectDirectory } from './directory-picker'

export const fetchWorkspaceSnapshot = createServerFn({ method: 'GET' }).handler(
  async () => getWorkspaceSnapshot(),
)

const fetchAgentDetail = createServerFn({ method: 'GET' })
  .inputValidator(agentDetailInputSchema)
  .handler(async ({ data }) => getAgentDetail(data))

export const addProjectMutation = createServerFn({ method: 'POST' })
  .inputValidator(addProjectInputSchema)
  .handler(async ({ data }) => addProject(data))

export const deleteProjectMutation = createServerFn({ method: 'POST' })
  .inputValidator(deleteProjectInputSchema)
  .handler(async ({ data }) => deleteProject(data.id))

export const hideProjectMutation = createServerFn({ method: 'POST' })
  .inputValidator(hideProjectInputSchema)
  .handler(async ({ data }) => hideProject(data.id))

export const reorderProjectsMutation = createServerFn({ method: 'POST' })
  .inputValidator(reorderProjectsInputSchema)
  .handler(async ({ data }) => reorderProjects(data))

export const unhideProjectMutation = createServerFn({ method: 'POST' })
  .inputValidator(unhideProjectInputSchema)
  .handler(async ({ data }) => unhideProject(data.id))

export const chooseProjectDirectoryMutation = createServerFn({ method: 'POST' })
  .handler(async () => chooseProjectDirectory())

export const deleteSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(deleteSessionInputSchema)
  .handler(async ({ data }) => {
    const config = getAgentLaunchConfig(data.agentId)
    const snapshot = deleteSession(data)
    forgetProviderRuntimeAgent(config.runtime, data.agentId)
    closeAgentRuntimeTerminal(data.agentId)
    return snapshot
  })

export const restoreSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(restoreSessionInputSchema)
  .handler(async ({ data }) => restoreSession(data))

export const renameSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(renameSessionInputSchema)
  .handler(async ({ data }) => renameSession(data))

export const sendMessageMutation = createServerFn({ method: 'POST' })
  .inputValidator(sendMessageInputSchema)
  .handler(async ({ data }) => {
    await promptAgent(data)
    return getWorkspaceSnapshot()
  })

export const steerMessageMutation = createServerFn({ method: 'POST' })
  .inputValidator(steerMessageInputSchema)
  .handler(async ({ data }) => {
    await steerAgent(data)
    return getWorkspaceSnapshot()
  })

export const interruptMessageMutation = createServerFn({ method: 'POST' })
  .inputValidator(interruptMessageInputSchema)
  .handler(async ({ data }) => {
    await interruptAgent(data)
    return getWorkspaceSnapshot()
  })

export const setThinkingLevelMutation = createServerFn({ method: 'POST' })
  .inputValidator(setThinkingLevelInputSchema)
  .handler(async ({ data }) => {
    await setAgentThinkingLevel(data)
    return getWorkspaceSnapshot()
  })

export const setThemePreferenceMutation = createServerFn({ method: 'POST' })
  .inputValidator(setThemePreferenceInputSchema)
  .handler(async ({ data }) => setThemePreference(data))

export const setKeymapPreferenceMutation = createServerFn({ method: 'POST' })
  .inputValidator(setKeymapPreferenceInputSchema)
  .handler(async ({ data }) => setKeymapPreference(data))

export const setChatTypographyPreferenceMutation = createServerFn({ method: 'POST' })
  .inputValidator(setChatTypographyPreferenceInputSchema)
  .handler(async ({ data }) => setChatTypographyPreference(data))

export const setAgentByProjectPreferenceMutation = createServerFn({ method: 'POST' })
  .inputValidator(setAgentByProjectPreferenceInputSchema)
  .handler(async ({ data }) => setAgentByProjectPreference(data))

export const resetSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(resetSessionInputSchema)
  .handler(async ({ data }) => {
    await resetAgentSession(data)
    return getWorkspaceSnapshot()
  })

export const forkSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(forkSessionInputSchema)
  .handler(async ({ data }) => {
    const agentId = await forkAgentSession(data)
    return { agentId, snapshot: getWorkspaceSnapshot() }
  })

export const reviewSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(reviewSessionInputSchema)
  .handler(async ({ data }) => {
    await reviewAgentSession(data)
    return getWorkspaceSnapshot()
  })

export const answerQuestionMutation = createServerFn({ method: 'POST' })
  .inputValidator(answerQuestionInputSchema)
  .handler(async ({ data }) => {
    await answerAgentQuestion(data)
    return getWorkspaceSnapshot()
  })

export const terminalConfigQuery = createServerFn({ method: 'GET' })
  .inputValidator(terminalConfigInputSchema)
  .handler(async ({ data }) => {
    const config = getAgentLaunchConfig(data.agentId)
    const server = await ensureTerminalServer()
    return {
      ...server,
      mode: data.mode,
      runtime: config.runtime,
      model: config.model,
    }
  })

export const refreshTerminalDiffsMutation = createServerFn({ method: 'POST' })
  .inputValidator(refreshTerminalDiffsInputSchema)
  .handler(async ({ data }) => refreshTerminalSessionDiffs(data.agentId))

export const startSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(startSessionInputSchema)
  .handler(async ({ data }) => startSession(data))

export const addScratchpadBlockMutation = createServerFn({ method: 'POST' })
  .inputValidator(addScratchpadBlockInputSchema)
  .handler(async ({ data }) => addScratchpadBlock(data))

export const deleteScratchpadBlockMutation = createServerFn({ method: 'POST' })
  .inputValidator(deleteScratchpadBlockInputSchema)
  .handler(async ({ data }) => deleteScratchpadBlock(data.id))

export const triggerScratchpadBlockMutation = createServerFn({ method: 'POST' })
  .inputValidator(triggerScratchpadBlockInputSchema)
  .handler(async ({ data }) => {
    const { agentId } = await triggerScratchpadSession(data)
    const snapshot = getWorkspaceSnapshot()
    return { agentId, snapshot }
  })

export const workspaceQueryOptions = () =>
  queryOptions({
    queryKey: ['workspace-snapshot'],
    queryFn: () => fetchWorkspaceSnapshot(),
  })

export const agentDetailQueryOptions = (agentId: string, limit = 500, revision = '') =>
  queryOptions({
    queryKey: ['agent-detail', agentId, limit, revision],
    queryFn: () => fetchAgentDetail({ data: { agentId, limit } }),
    enabled: agentId.length > 0,
  })
