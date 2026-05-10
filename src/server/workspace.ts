import { queryOptions } from '@tanstack/react-query'
import { createServerFn } from '@tanstack/react-start'
import {
  addProjectInputSchema,
  deleteSessionInputSchema,
  deleteProjectInputSchema,
  interruptMessageInputSchema,
  sendMessageInputSchema,
  startSessionInputSchema,
  steerMessageInputSchema,
} from '~/lib/contracts'
import {
  addProject,
  deleteSession,
  deleteProject,
  getWorkspaceSnapshot,
  startSession,
} from './db'
import { interruptPiAgent, promptPiAgent, steerPiAgent } from './pi-runtime'

export const fetchWorkspaceSnapshot = createServerFn({ method: 'GET' }).handler(
  async () => getWorkspaceSnapshot(),
)

export const addProjectMutation = createServerFn({ method: 'POST' })
  .inputValidator(addProjectInputSchema)
  .handler(async ({ data }) => addProject(data))

export const deleteProjectMutation = createServerFn({ method: 'POST' })
  .inputValidator(deleteProjectInputSchema)
  .handler(async ({ data }) => deleteProject(data.id))

export const deleteSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(deleteSessionInputSchema)
  .handler(async ({ data }) => deleteSession(data))

export const sendMessageMutation = createServerFn({ method: 'POST' })
  .inputValidator(sendMessageInputSchema)
  .handler(async ({ data }) => {
    await promptPiAgent(data)
    return getWorkspaceSnapshot()
  })

export const steerMessageMutation = createServerFn({ method: 'POST' })
  .inputValidator(steerMessageInputSchema)
  .handler(async ({ data }) => {
    await steerPiAgent(data)
    return getWorkspaceSnapshot()
  })

export const interruptMessageMutation = createServerFn({ method: 'POST' })
  .inputValidator(interruptMessageInputSchema)
  .handler(async ({ data }) => {
    await interruptPiAgent(data)
    return getWorkspaceSnapshot()
  })

export const startSessionMutation = createServerFn({ method: 'POST' })
  .inputValidator(startSessionInputSchema)
  .handler(async ({ data }) => startSession(data))

export const workspaceQueryOptions = () =>
  queryOptions({
    queryKey: ['workspace-snapshot'],
    queryFn: () => fetchWorkspaceSnapshot(),
  })
