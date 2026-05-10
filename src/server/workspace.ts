import { queryOptions } from '@tanstack/react-query'
import { createServerFn } from '@tanstack/react-start'
import {
  addProjectInputSchema,
  deleteProjectInputSchema,
  setAgentConfigInputSchema,
  sendMessageInputSchema,
} from '~/lib/contracts'
import {
  addProject,
  deleteProject,
  getWorkspaceSnapshot,
  setAgentConfig,
} from './db'
import { promptPiAgent } from './pi-runtime'

export const fetchWorkspaceSnapshot = createServerFn({ method: 'GET' }).handler(
  async () => getWorkspaceSnapshot(),
)

export const addProjectMutation = createServerFn({ method: 'POST' })
  .inputValidator(addProjectInputSchema)
  .handler(async ({ data }) => addProject(data))

export const deleteProjectMutation = createServerFn({ method: 'POST' })
  .inputValidator(deleteProjectInputSchema)
  .handler(async ({ data }) => deleteProject(data.id))

export const sendMessageMutation = createServerFn({ method: 'POST' })
  .inputValidator(sendMessageInputSchema)
  .handler(async ({ data }) => {
    await promptPiAgent(data)
    return getWorkspaceSnapshot()
  })

export const setAgentConfigMutation = createServerFn({ method: 'POST' })
  .inputValidator(setAgentConfigInputSchema)
  .handler(async ({ data }) => setAgentConfig(data))

export const workspaceQueryOptions = () =>
  queryOptions({
    queryKey: ['workspace-snapshot'],
    queryFn: () => fetchWorkspaceSnapshot(),
  })
