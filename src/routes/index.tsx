import { createFileRoute } from '@tanstack/react-router'
import { AetherBoard } from '~/components/AetherBoard'
import { workspaceQueryOptions } from '~/server/workspace'

export const Route = createFileRoute('/')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(workspaceQueryOptions()),
  component: Home,
})

function Home() {
  const snapshot = Route.useLoaderData()
  return <AetherBoard snapshot={snapshot} />
}
