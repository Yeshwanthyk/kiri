import type { ProjectRow } from '~/lib/contracts'

export type ResourceId =
  | `agent:${string}`
  | `terminal:${string}`
  | `browser:${string}`
  | 'scratchpad'

export type ResourceKind = 'agent' | 'terminal' | 'browser'

export const DEFAULT_BROWSER_URL = 'https://www.google.com'

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

export type BrowserResource = {
  readonly id: `browser:${string}`
  readonly kind: 'browser'
  readonly browserId: string
  readonly title: string
  readonly url: string
}

export type ProjectResource =
  | AgentResource
  | TerminalResource
  | BrowserResource

export type ProjectResourceLayout = {
  readonly activeResourceId: ResourceId | null
  readonly order: readonly ResourceId[]
  readonly terminals: readonly TerminalResource[]
  readonly browsers: readonly BrowserResource[]
  readonly activeTerminalResourceId?: `terminal:${string}`
  readonly activeBrowserResourceId?: `browser:${string}`
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

export function browserResourceId(browserId: string): `browser:${string}` {
  return `browser:${browserId}`
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
  const browsers = dedupeBrowsers(input.layout?.browsers ?? [])
  const browserIds = new Set<ResourceId>(browsers.map((resource) => resource.id))
  const resourcesById = new Map<ResourceId, ProjectResource>([
    ...agentResources.map((resource) => [resource.id, resource] as const),
    ...terminals.map((resource) => [resource.id, resource] as const),
    ...browsers.map((resource) => [resource.id, resource] as const),
  ])

  const order: ResourceId[] = []
  for (const resourceId of input.layout?.order ?? []) {
    if (!isResourceId(resourceId)) continue
    if (order.includes(resourceId)) continue
    if (agentIds.has(resourceId) || terminalIds.has(resourceId) || browserIds.has(resourceId)) {
      order.push(resourceId)
    }
  }

  for (const resource of agentResources) {
    if (order.includes(resource.id)) continue
    const nonAgentIndex = order.findIndex(
      (resourceId) => resourceId.startsWith('terminal:') || resourceId.startsWith('browser:'),
    )
    order.splice(nonAgentIndex >= 0 ? nonAgentIndex : order.length, 0, resource.id)
  }
  for (const resource of terminals) {
    if (!order.includes(resource.id)) order.push(resource.id)
  }
  for (const resource of browsers) {
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
  const activeBrowserResourceId = resolveActiveBrowserResourceId(
    browsers,
    input.layout?.activeBrowserResourceId,
    activeResourceId,
  )

  return {
    resources,
    activeResourceId,
    layout: {
      activeResourceId,
      order: resources.map((resource) => resource.id),
      terminals,
      browsers,
      ...(activeTerminalResourceId ? { activeTerminalResourceId } : {}),
      ...(activeBrowserResourceId ? { activeBrowserResourceId } : {}),
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
  const nonAgentIndex = order.findIndex(
    (item) => item.startsWith('terminal:') || item.startsWith('browser:'),
  )
  const insertIndex = nonAgentIndex >= 0 ? nonAgentIndex : order.length
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

export function ensureBrowserResource(input: {
  readonly layout: ProjectResourceLayout
  readonly browserId?: string
  readonly title?: string
  readonly url?: string
}): {
  readonly layout: ProjectResourceLayout
  readonly resourceId: `browser:${string}`
} {
  const existing = input.layout.activeBrowserResourceId
    ? input.layout.browsers.find((resource) => resource.id === input.layout.activeBrowserResourceId)
    : input.layout.browsers[0]
  if (existing) {
    return {
      resourceId: existing.id,
      layout: {
        ...input.layout,
        activeResourceId: existing.id,
        activeBrowserResourceId: existing.id,
      },
    }
  }

  const browserId = input.browserId ?? createBrowserId()
  const resourceId = browserResourceId(browserId)
  const browser: BrowserResource = {
    id: resourceId,
    kind: 'browser',
    browserId,
    title: input.title?.trim() || 'browser',
    url: input.url?.trim() || DEFAULT_BROWSER_URL,
  }
  return {
    resourceId,
    layout: {
      ...input.layout,
      activeResourceId: resourceId,
      activeBrowserResourceId: resourceId,
      order: input.layout.order.includes(resourceId)
        ? input.layout.order
        : [...input.layout.order, resourceId],
      browsers: [...input.layout.browsers, browser],
    },
  }
}

export function isResourceId(value: unknown): value is ResourceId {
  return value === 'scratchpad' ||
    (typeof value === 'string' && (
      value.startsWith('agent:') ||
      value.startsWith('terminal:') ||
      value.startsWith('browser:')
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
  const browsers = Array.isArray(record.browsers)
    ? record.browsers.map(normalizeBrowserResource).filter((item): item is BrowserResource => Boolean(item))
    : []
  const activeResourceId = isResourceId(record.activeResourceId) ? record.activeResourceId : null
  const activeTerminalResourceId = (
    typeof record.activeTerminalResourceId === 'string' &&
    record.activeTerminalResourceId.startsWith('terminal:')
  )
    ? record.activeTerminalResourceId as `terminal:${string}`
    : undefined
  const activeBrowserResourceId = (
    typeof record.activeBrowserResourceId === 'string' &&
    record.activeBrowserResourceId.startsWith('browser:')
  )
    ? record.activeBrowserResourceId as `browser:${string}`
    : undefined
  return {
    activeResourceId,
    order: order.filter((resourceId) => resourceId !== 'scratchpad'),
    terminals,
    browsers,
    ...(activeTerminalResourceId ? { activeTerminalResourceId } : {}),
    ...(activeBrowserResourceId ? { activeBrowserResourceId } : {}),
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

function normalizeBrowserResource(value: unknown): BrowserResource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !record.id.startsWith('browser:')) return undefined
  if (typeof record.browserId !== 'string' || !record.browserId.trim()) return undefined
  return {
    id: record.id as `browser:${string}`,
    kind: 'browser',
    browserId: record.browserId,
    title: typeof record.title === 'string' && record.title.trim() ? record.title : 'browser',
    url: typeof record.url === 'string' && record.url.trim() ? record.url : DEFAULT_BROWSER_URL,
  }
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

function dedupeBrowsers(browsers: readonly BrowserResource[]) {
  const seen = new Set<ResourceId>()
  const next: BrowserResource[] = []
  for (const browser of browsers) {
    if (seen.has(browser.id)) continue
    seen.add(browser.id)
    next.push(browser)
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

function resolveActiveBrowserResourceId(
  browsers: readonly BrowserResource[],
  stored: `browser:${string}` | undefined,
  activeResourceId: ResourceId | null,
) {
  if (stored && browsers.some((browser) => browser.id === stored)) return stored
  const activeBrowserId = activeResourceId ? asBrowserResourceId(activeResourceId) : undefined
  if (activeBrowserId) return activeBrowserId
  return browsers[0]?.id
}

function asBrowserResourceId(value: ResourceId): `browser:${string}` | undefined {
  return value.startsWith('browser:') ? value as `browser:${string}` : undefined
}

function createTerminalId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `terminal-${Date.now().toString(36)}`
}

function createBrowserId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `browser-${Date.now().toString(36)}`
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
