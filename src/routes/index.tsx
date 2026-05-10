import { createFileRoute } from '@tanstack/react-router'
import { PicanBoard } from '~/components/PicanBoard'
import { workspaceQueryOptions } from '~/server/workspace'

export const Route = createFileRoute('/')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(workspaceQueryOptions()),
  component: Home,
})

function Home() {
  const snapshot = Route.useLoaderData()
  return <PicanBoard snapshot={snapshot} />
}
