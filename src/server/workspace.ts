import { queryOptions } from '@tanstack/react-query'
import { createServerFn } from '@tanstack/react-start'
import { execFileSync } from 'node:child_process'
import {
  addProjectInputSchema,
  agentDetailInputSchema,
  answerQuestionInputSchema,
  deleteSessionInputSchema,
  deleteProjectInputSchema,
  renameSessionInputSchema,
  forkSessionInputSchema,
  hideProjectInputSchema,
  interruptMessageInputSchema,
  resetSessionInputSchema,
  reviewSessionInputSchema,
  restoreSessionInputSchema,
  sendMessageInputSchema,
  setThinkingLevelInputSchema,
  startSessionInputSchema,
  steerMessageInputSchema,
  terminalConfigInputSchema,
  unhideProjectInputSchema,
} from '~/lib/contracts'
import {
  addProject,
  deleteSession,
  deleteProject,
  renameSession,
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
import { ensureTerminalServer } from './terminal-server'

export const fetchWorkspaceSnapshot = createServerFn({ method: 'GET' }).handler(
  async () => getWorkspaceSnapshot(),
)

export const fetchAgentDetail = createServerFn({ method: 'GET' })
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

export const unhideProjectMutation = createServerFn({ method: 'POST' })
  .inputValidator(unhideProjectInputSchema)
  .handler(async ({ data }) => unhideProject(data.id))

export const chooseProjectDirectoryMutation = createServerFn({ method: 'POST' })
  .handler(async () => {
    const output = execFileSync('osascript', [
      '-e',
      'POSIX path of (choose folder with prompt "Choose a project directory")',
    ], { encoding: 'utf8' })
    return output.trim()
  })

export const deleteSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(deleteSessionInputSchema)
  .handler(async ({ data }) => deleteSession(data))

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
    getAgentLaunchConfig(data.agentId)
    return ensureTerminalServer()
  })

export const startSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(startSessionInputSchema)
  .handler(async ({ data }) => startSession(data))

export const workspaceQueryOptions = () =>
  queryOptions({
    queryKey: ['workspace-snapshot'],
    queryFn: () => fetchWorkspaceSnapshot(),
  })

export const agentDetailQueryOptions = (agentId: string, limit = 100, revision = '') =>
  queryOptions({
    queryKey: ['agent-detail', agentId, limit, revision],
    queryFn: () => fetchAgentDetail({ data: { agentId, limit } }),
    enabled: agentId.length > 0,
  })
