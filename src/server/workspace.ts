import { queryOptions } from '@tanstack/react-query'
import { createServerFn } from '@tanstack/react-start'
import { getWorkspaceSnapshot } from './db'

export const fetchWorkspaceSnapshot = createServerFn({ method: 'GET' }).handler(
  async () => getWorkspaceSnapshot(),
)

export const workspaceQueryOptions = () =>
  queryOptions({
    queryKey: ['workspace-snapshot'],
    queryFn: () => fetchWorkspaceSnapshot(),
  })
