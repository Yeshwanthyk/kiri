import type { ProjectRow } from '~/lib/contracts'

export type ResourceId =
  | `agent:${string}`
  | `terminal:${string}`
  | 'scratchpad'

export type ResourceKind = 'agent' | 'terminal'

export type AgentResource = {
  readonly id: `agent:${string}`
  readonly kind: 'agent'
  readonly agentId: string
}

export type TerminalResourcePurpose =
  | { readonly kind: 'manual' }
  | {
    readonly kind: 'project-action'
    readonly actionId: string
    readonly label: string
    readonly command: string
  }

export type TerminalResource = {
  readonly id: `terminal:${string}`
  readonly kind: 'terminal'
  readonly terminalId: string
  readonly title: string
  readonly purpose: TerminalResourcePurpose
}

export type ProjectResource =
  | AgentResource
  | TerminalResource

export type ProjectResourceLayout = {
  readonly activeResourceId: ResourceId | null
  readonly order: readonly ResourceId[]
  readonly terminals: readonly TerminalResource[]
  readonly activeTerminalResourceId?: `terminal:${string}`
}

export type ResourceShellLayout = {
  readonly activeProjectId: string | null
  readonly projects: Record<string, ProjectResourceLayout>
}

export const emptyResourceShellLayout: ResourceShellLayout = {
  activeProjectId: null,
  projects: {},
}

export function agentResourceId(agentId: string): `agent:${string}` {
  return `agent:${agentId}`
}

export function terminalResourceId(terminalId: string): `terminal:${string}` {
  return `terminal:${terminalId}`
}

export function reconcileProjectResources(input: {
  readonly project: ProjectRow
  readonly layout: ProjectResourceLayout | undefined
}): {
  readonly resources: readonly ProjectResource[]
  readonly activeResourceId: ResourceId | null
  readonly layout: ProjectResourceLayout
} {
  const agentResources = input.project.agents.map((agent): AgentResource => ({
    id: agentResourceId(agent.id),
    kind: 'agent',
    agentId: agent.id,
  }))
  const agentIds = new Set<ResourceId>(agentResources.map((resource) => resource.id))
  const terminals = dedupeTerminals(input.layout?.terminals ?? [])
  const terminalIds = new Set<ResourceId>(terminals.map((resource) => resource.id))
  const resourcesById = new Map<ResourceId, ProjectResource>([
    ...agentResources.map((resource) => [resource.id, resource] as const),
    ...terminals.map((resource) => [resource.id, resource] as const),
  ])

  const order: ResourceId[] = []
  for (const resourceId of input.layout?.order ?? []) {
    if (!isResourceId(resourceId)) continue
    if (order.includes(resourceId)) continue
    if (agentIds.has(resourceId) || terminalIds.has(resourceId)) {
      order.push(resourceId)
    }
  }

  for (const resource of agentResources) {
    if (order.includes(resource.id)) continue
    const terminalIndex = order.findIndex((resourceId) => resourceId.startsWith('terminal:'))
    order.splice(terminalIndex >= 0 ? terminalIndex : order.length, 0, resource.id)
  }
  for (const resource of terminals) {
    if (!order.includes(resource.id)) order.push(resource.id)
  }

  const resources = order
    .map((resourceId) => resourcesById.get(resourceId))
    .filter((resource): resource is ProjectResource => Boolean(resource))
  const activeResourceId = resolveActiveResourceId(resources, input.layout?.activeResourceId)
  const activeTerminalResourceId = resolveActiveTerminalResourceId(
    terminals,
    input.layout?.activeTerminalResourceId,
    activeResourceId,
  )

  return {
    resources,
    activeResourceId,
    layout: {
      activeResourceId,
      order: resources.map((resource) => resource.id),
      terminals,
      ...(activeTerminalResourceId ? { activeTerminalResourceId } : {}),
    },
  }
}

export function moveProjectResource(input: {
  readonly layout: ProjectResourceLayout
  readonly resourceId: ResourceId
  readonly toIndex: number
}): ProjectResourceLayout {
  if (!input.layout.order.includes(input.resourceId)) return input.layout
  const order = input.layout.order.filter((resourceId) => resourceId !== input.resourceId)
  const nextIndex = clamp(input.toIndex, 0, order.length)
  order.splice(nextIndex, 0, input.resourceId)
  return {
    ...input.layout,
    order,
  }
}

export function selectAdjacentResource(input: {
  readonly resources: readonly ProjectResource[]
  readonly activeResourceId: ResourceId | null
  readonly delta: 1 | -1
}): ResourceId | null {
  if (input.resources.length === 0) return null
  const index = input.resources.findIndex((resource) => resource.id === input.activeResourceId)
  const nextIndex = clamp((index < 0 ? 0 : index) + input.delta, 0, input.resources.length - 1)
  return input.resources[nextIndex]?.id ?? null
}

export function insertAgentResource(input: {
  readonly layout: ProjectResourceLayout
  readonly agentId: string
}): ProjectResourceLayout {
  const resourceId = agentResourceId(input.agentId)
  if (input.layout.order.includes(resourceId)) {
    return { ...input.layout, activeResourceId: resourceId }
  }
  const order = [...input.layout.order]
  const terminalIndex = order.findIndex((item) => item.startsWith('terminal:'))
  const insertIndex = terminalIndex >= 0 ? terminalIndex : order.length
  order.splice(insertIndex, 0, resourceId)
  return {
    ...input.layout,
    activeResourceId: resourceId,
    order,
  }
}

export function ensureTerminalResource(input: {
  readonly layout: ProjectResourceLayout
  readonly terminalId?: string
  readonly title?: string
}): {
  readonly layout: ProjectResourceLayout
  readonly resourceId: `terminal:${string}`
} {
  const existing = input.layout.activeTerminalResourceId
    ? input.layout.terminals.find((resource) => resource.id === input.layout.activeTerminalResourceId)
    : input.layout.terminals[0]
  if (existing) {
    return {
      resourceId: existing.id,
      layout: {
        ...input.layout,
        activeResourceId: existing.id,
        activeTerminalResourceId: existing.id,
      },
    }
  }

  const terminalId = input.terminalId ?? createTerminalId()
  const resourceId = terminalResourceId(terminalId)
  const terminal: TerminalResource = {
    id: resourceId,
    kind: 'terminal',
    terminalId,
    title: input.title?.trim() || 'terminal',
    purpose: { kind: 'manual' },
  }
  return {
    resourceId,
    layout: {
      ...input.layout,
      activeResourceId: resourceId,
      activeTerminalResourceId: resourceId,
      order: input.layout.order.includes(resourceId)
        ? input.layout.order
        : [...input.layout.order, resourceId],
      terminals: [...input.layout.terminals, terminal],
    },
  }
}

export function isResourceId(value: unknown): value is ResourceId {
  return value === 'scratchpad' ||
    (typeof value === 'string' && (
      value.startsWith('agent:') ||
      value.startsWith('terminal:')
    ))
}

export function normalizeProjectResourceLayout(value: unknown): ProjectResourceLayout | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const order = Array.isArray(record.order)
    ? record.order.filter(isResourceId)
    : []
  const terminals = Array.isArray(record.terminals)
    ? record.terminals.map(normalizeTerminalResource).filter((item): item is TerminalResource => Boolean(item))
    : []
  const activeResourceId = isResourceId(record.activeResourceId) ? record.activeResourceId : null
  const activeTerminalResourceId = (
    typeof record.activeTerminalResourceId === 'string' &&
    record.activeTerminalResourceId.startsWith('terminal:')
  )
    ? record.activeTerminalResourceId as `terminal:${string}`
    : undefined
  return {
    activeResourceId,
    order: order.filter((resourceId) => resourceId !== 'scratchpad'),
    terminals,
    ...(activeTerminalResourceId ? { activeTerminalResourceId } : {}),
  }
}

export function normalizeResourceShellLayout(value: unknown): ResourceShellLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyResourceShellLayout
  const record = value as Record<string, unknown>
  const projects: Record<string, ProjectResourceLayout> = {}
  if (record.projects && typeof record.projects === 'object' && !Array.isArray(record.projects)) {
    for (const [projectId, projectLayout] of Object.entries(record.projects)) {
      const normalized = normalizeProjectResourceLayout(projectLayout)
      if (normalized) projects[projectId] = normalized
    }
  }
  return {
    activeProjectId: typeof record.activeProjectId === 'string' ? record.activeProjectId : null,
    projects,
  }
}

function normalizeTerminalResource(value: unknown): TerminalResource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !record.id.startsWith('terminal:')) return undefined
  if (typeof record.terminalId !== 'string' || !record.terminalId.trim()) return undefined
  return {
    id: record.id as `terminal:${string}`,
    kind: 'terminal',
    terminalId: record.terminalId,
    title: typeof record.title === 'string' && record.title.trim() ? record.title : 'terminal',
    purpose: normalizeTerminalPurpose(record.purpose),
  }
}

function normalizeTerminalPurpose(value: unknown): TerminalResourcePurpose {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'manual' }
  const record = value as Record<string, unknown>
  if (
    record.kind === 'project-action' &&
    typeof record.actionId === 'string' &&
    typeof record.label === 'string' &&
    typeof record.command === 'string'
  ) {
    return {
      kind: 'project-action',
      actionId: record.actionId,
      label: record.label,
      command: record.command,
    }
  }
  return { kind: 'manual' }
}

function dedupeTerminals(terminals: readonly TerminalResource[]) {
  const seen = new Set<ResourceId>()
  const next: TerminalResource[] = []
  for (const terminal of terminals) {
    if (seen.has(terminal.id)) continue
    seen.add(terminal.id)
    next.push(terminal)
  }
  return next
}

function resolveActiveResourceId(
  resources: readonly ProjectResource[],
  stored: ResourceId | null | undefined,
) {
  if (stored && resources.some((resource) => resource.id === stored)) return stored
  return resources[0]?.id ?? null
}

function resolveActiveTerminalResourceId(
  terminals: readonly TerminalResource[],
  stored: `terminal:${string}` | undefined,
  activeResourceId: ResourceId | null,
) {
  if (stored && terminals.some((terminal) => terminal.id === stored)) return stored
  const activeTerminalId = activeResourceId ? asTerminalResourceId(activeResourceId) : undefined
  if (activeTerminalId) return activeTerminalId
  return terminals[0]?.id
}

function asTerminalResourceId(value: ResourceId): `terminal:${string}` | undefined {
  return value.startsWith('terminal:') ? value as `terminal:${string}` : undefined
}

function createTerminalId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `terminal-${Date.now().toString(36)}`
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
