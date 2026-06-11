// Pure split-tree layout model for the kiriterm shell workspace. Layout is a
// client concern: every leaf maps to a daemon session via its termId, so a
// reload reattaches each visible pane with full scrollback.

export type PaneLeaf = {
  readonly kind: 'leaf'
  readonly id: string
  readonly termId: string
}

export type PaneSplit = {
  readonly kind: 'split'
  readonly id: string
  readonly direction: 'row' | 'column'
  readonly ratio: number
  readonly a: PaneNode
  readonly b: PaneNode
}

export type PaneNode = PaneLeaf | PaneSplit

export type TerminalTab = {
  readonly id: string
  readonly root: PaneNode
}

export type TerminalLayout = {
  readonly tabs: readonly TerminalTab[]
  readonly activeTabId: string
  readonly activePaneId: string
}

export type IdGenerator = () => string

const minRatio = 0.1
const maxRatio = 0.9

export function createTerminalLayout(nextId: IdGenerator): TerminalLayout {
  const leaf = makeLeaf(nextId, 'main')
  const tab: TerminalTab = { id: nextId(), root: leaf }
  return { tabs: [tab], activeTabId: tab.id, activePaneId: leaf.id }
}

export function layoutLeaves(node: PaneNode): PaneLeaf[] {
  return node.kind === 'leaf' ? [node] : [...layoutLeaves(node.a), ...layoutLeaves(node.b)]
}

export function activeTab(layout: TerminalLayout): TerminalTab {
  const tab = layout.tabs.find((candidate) => candidate.id === layout.activeTabId)
  if (!tab) throw new Error('Terminal layout has no active tab')
  return tab
}

export function splitPane(
  layout: TerminalLayout,
  paneId: string,
  direction: 'row' | 'column',
  nextId: IdGenerator,
): TerminalLayout {
  const tab = tabContaining(layout, paneId)
  if (!tab) return layout
  const fresh = makeLeaf(nextId)
  const root = mapNode(tab.root, paneId, (leaf) => ({
    kind: 'split',
    id: nextId(),
    direction,
    ratio: 0.5,
    a: leaf,
    b: fresh,
  }))
  return {
    ...layout,
    tabs: layout.tabs.map((candidate) => candidate === tab ? { ...tab, root } : candidate),
    activeTabId: tab.id,
    activePaneId: fresh.id,
  }
}

export function closePane(
  layout: TerminalLayout,
  paneId: string,
  nextId: IdGenerator,
): TerminalLayout {
  const tab = tabContaining(layout, paneId)
  if (!tab) return layout

  const remaining = removeLeaf(tab.root, paneId)
  if (remaining) {
    const tabs = layout.tabs.map((candidate) =>
      candidate === tab ? { ...tab, root: remaining } : candidate)
    return focusPane(
      { ...layout, tabs },
      layout.activePaneId === paneId
        ? (layoutLeaves(remaining)[0]?.id ?? layout.activePaneId)
        : layout.activePaneId,
    )
  }

  // Closing the last pane closes the tab; closing the last tab resets to a
  // fresh single-pane layout so the workspace is never empty.
  if (layout.tabs.length === 1) return createTerminalLayout(nextId)
  const tabs = layout.tabs.filter((candidate) => candidate !== tab)
  const index = layout.tabs.indexOf(tab)
  const fallback = tabs[Math.min(index, tabs.length - 1)] ?? tabs[0]
  if (!fallback) return createTerminalLayout(nextId)
  const nextActivePane = layoutLeaves(fallback.root)[0]
  return {
    tabs,
    activeTabId: layout.activeTabId === tab.id ? fallback.id : layout.activeTabId,
    activePaneId: layout.activePaneId === paneId
      ? (nextActivePane?.id ?? layout.activePaneId)
      : layout.activePaneId,
  }
}

export function focusPane(layout: TerminalLayout, paneId: string): TerminalLayout {
  const tab = tabContaining(layout, paneId)
  if (!tab) return layout
  if (layout.activePaneId === paneId && layout.activeTabId === tab.id) return layout
  return { ...layout, activeTabId: tab.id, activePaneId: paneId }
}

export function focusAdjacentPane(layout: TerminalLayout, offset: 1 | -1): TerminalLayout {
  const tab = tabContaining(layout, layout.activePaneId) ?? activeTab(layout)
  const leaves = layoutLeaves(tab.root)
  if (leaves.length < 2) return layout
  const index = leaves.findIndex((leaf) => leaf.id === layout.activePaneId)
  const next = leaves[(index + offset + leaves.length) % leaves.length]
  return next ? focusPane(layout, next.id) : layout
}

export function selectTab(layout: TerminalLayout, tabId: string): TerminalLayout {
  const tab = layout.tabs.find((candidate) => candidate.id === tabId)
  if (!tab || layout.activeTabId === tabId) return layout
  const firstLeaf = layoutLeaves(tab.root)[0]
  return {
    ...layout,
    activeTabId: tabId,
    activePaneId: tabContaining(layout, layout.activePaneId) === tab
      ? layout.activePaneId
      : (firstLeaf?.id ?? layout.activePaneId),
  }
}

export function selectTabAt(layout: TerminalLayout, index: number): TerminalLayout {
  const tab = layout.tabs[index]
  return tab ? selectTab(layout, tab.id) : layout
}

export function newTab(layout: TerminalLayout, nextId: IdGenerator): TerminalLayout {
  const leaf = makeLeaf(nextId)
  const tab: TerminalTab = { id: nextId(), root: leaf }
  return {
    tabs: [...layout.tabs, tab],
    activeTabId: tab.id,
    activePaneId: leaf.id,
  }
}

export function setSplitRatio(layout: TerminalLayout, splitId: string, ratio: number): TerminalLayout {
  const clamped = Math.min(maxRatio, Math.max(minRatio, ratio))
  const tabs = layout.tabs.map((tab) => {
    const root = mapSplit(tab.root, splitId, (split) => ({ ...split, ratio: clamped }))
    return root === tab.root ? tab : { ...tab, root }
  })
  return { ...layout, tabs }
}

// Serialized layouts come from localStorage; anything malformed falls back to
// a fresh layout rather than crashing the workspace.
export function parseTerminalLayout(raw: string | null, nextId: IdGenerator): TerminalLayout {
  if (!raw) return createTerminalLayout(nextId)
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isLayout(parsed)) return createTerminalLayout(nextId)
    const leafIds = new Set(parsed.tabs.flatMap((tab) => layoutLeaves(tab.root).map((leaf) => leaf.id)))
    if (parsed.tabs.length === 0 || !leafIds.has(parsed.activePaneId)) {
      return createTerminalLayout(nextId)
    }
    if (!parsed.tabs.some((tab) => tab.id === parsed.activeTabId)) {
      return createTerminalLayout(nextId)
    }
    return parsed
  } catch {
    return createTerminalLayout(nextId)
  }
}

export function makeTerminalLayoutIdGenerator(): IdGenerator {
  return () => `t${Math.random().toString(36).slice(2, 8)}`
}

function makeLeaf(nextId: IdGenerator, termId?: string): PaneLeaf {
  return { kind: 'leaf', id: nextId(), termId: termId ?? nextId() }
}

function tabContaining(layout: TerminalLayout, paneId: string): TerminalTab | null {
  return layout.tabs.find((tab) =>
    layoutLeaves(tab.root).some((leaf) => leaf.id === paneId)) ?? null
}

function mapNode(node: PaneNode, leafId: string, replace: (leaf: PaneLeaf) => PaneNode): PaneNode {
  if (node.kind === 'leaf') return node.id === leafId ? replace(node) : node
  const a = mapNode(node.a, leafId, replace)
  const b = mapNode(node.b, leafId, replace)
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

function mapSplit(node: PaneNode, splitId: string, replace: (split: PaneSplit) => PaneNode): PaneNode {
  if (node.kind === 'leaf') return node
  if (node.id === splitId) return replace(node)
  const a = mapSplit(node.a, splitId, replace)
  const b = mapSplit(node.b, splitId, replace)
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

function removeLeaf(node: PaneNode, leafId: string): PaneNode | null {
  if (node.kind === 'leaf') return node.id === leafId ? null : node
  const a = removeLeaf(node.a, leafId)
  const b = removeLeaf(node.b, leafId)
  if (a === node.a && b === node.b) return node
  if (a && b) return { ...node, a, b }
  return a ?? b
}

function isLayout(value: unknown): value is TerminalLayout {
  if (typeof value !== 'object' || value === null) return false
  if (!('tabs' in value) || !Array.isArray(value.tabs)) return false
  if (!('activeTabId' in value) || typeof value.activeTabId !== 'string') return false
  if (!('activePaneId' in value) || typeof value.activePaneId !== 'string') return false
  return value.tabs.every(isTab)
}

function isTab(value: unknown): value is TerminalTab {
  if (typeof value !== 'object' || value === null) return false
  if (!('id' in value) || typeof value.id !== 'string') return false
  return 'root' in value && isNode(value.root)
}

function isNode(value: unknown): value is PaneNode {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false
  if (value.kind === 'leaf') {
    return 'id' in value && typeof value.id === 'string' &&
      'termId' in value && typeof value.termId === 'string' &&
      /^[a-z0-9-]{1,32}$/i.test(value.termId)
  }
  if (value.kind !== 'split') return false
  return 'id' in value && typeof value.id === 'string' &&
    'direction' in value && (value.direction === 'row' || value.direction === 'column') &&
    'ratio' in value && typeof value.ratio === 'number' &&
    value.ratio >= minRatio && value.ratio <= maxRatio &&
    'a' in value && isNode(value.a) &&
    'b' in value && isNode(value.b)
}
