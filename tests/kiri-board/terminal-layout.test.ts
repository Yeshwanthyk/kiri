import { describe, expect, it } from 'vitest'
import {
  activeTab,
  closePane,
  createTerminalLayout,
  focusAdjacentPane,
  focusPane,
  layoutLeaves,
  newTab,
  parseTerminalLayout,
  selectTab,
  selectTabAt,
  setSplitRatio,
  splitPane,
  type TerminalLayout,
} from '~/components/kiri-board/terminal-layout'

function counterIds() {
  let counter = 0
  return () => `id-${(counter += 1)}`
}

function fresh(): { layout: TerminalLayout; nextId: () => string } {
  const nextId = counterIds()
  return { layout: createTerminalLayout(nextId), nextId }
}

describe('terminal layout', () => {
  it('creates a single tab with a main shell pane', () => {
    const { layout } = fresh()
    expect(layout.tabs).toHaveLength(1)
    const leaves = layoutLeaves(activeTab(layout).root)
    expect(leaves).toHaveLength(1)
    expect(leaves[0]?.termId).toBe('main')
    expect(layout.activePaneId).toBe(leaves[0]?.id)
  })

  it('splits the active pane and focuses the new one', () => {
    const { layout, nextId } = fresh()
    const split = splitPane(layout, layout.activePaneId, 'row', nextId)
    const leaves = layoutLeaves(activeTab(split).root)
    expect(leaves).toHaveLength(2)
    expect(split.activePaneId).toBe(leaves[1]?.id)
    expect(leaves[1]?.termId).not.toBe('main')

    const root = activeTab(split).root
    expect(root.kind).toBe('split')
    if (root.kind === 'split') {
      expect(root.direction).toBe('row')
      expect(root.ratio).toBe(0.5)
    }
  })

  it('closing a pane collapses its parent split', () => {
    const { layout, nextId } = fresh()
    const split = splitPane(layout, layout.activePaneId, 'column', nextId)
    const closed = closePane(split, split.activePaneId, nextId)
    const leaves = layoutLeaves(activeTab(closed).root)
    expect(leaves).toHaveLength(1)
    expect(leaves[0]?.termId).toBe('main')
    expect(closed.activePaneId).toBe(leaves[0]?.id)
  })

  it('closing the last pane of the last tab resets to a fresh layout', () => {
    const { layout, nextId } = fresh()
    const closed = closePane(layout, layout.activePaneId, nextId)
    expect(closed.tabs).toHaveLength(1)
    expect(layoutLeaves(activeTab(closed).root)).toHaveLength(1)
    expect(closed.activePaneId).not.toBe(layout.activePaneId)
  })

  it('closing the last pane of a tab closes the tab and moves focus', () => {
    const { layout, nextId } = fresh()
    const withTab = newTab(layout, nextId)
    expect(withTab.tabs).toHaveLength(2)
    const closed = closePane(withTab, withTab.activePaneId, nextId)
    expect(closed.tabs).toHaveLength(1)
    expect(closed.activeTabId).toBe(layout.activeTabId)
    expect(closed.activePaneId).toBe(layout.activePaneId)
  })

  it('focus moves across panes in order and wraps', () => {
    const { layout, nextId } = fresh()
    let current = splitPane(layout, layout.activePaneId, 'row', nextId)
    current = splitPane(current, current.activePaneId, 'column', nextId)
    const leaves = layoutLeaves(activeTab(current).root)
    expect(leaves).toHaveLength(3)

    current = focusPane(current, leaves[0]?.id ?? '')
    current = focusAdjacentPane(current, 1)
    expect(current.activePaneId).toBe(leaves[1]?.id)
    current = focusAdjacentPane(current, -1)
    current = focusAdjacentPane(current, -1)
    expect(current.activePaneId).toBe(leaves[2]?.id)
  })

  it('selecting tabs by id or index focuses a pane inside that tab', () => {
    const { layout, nextId } = fresh()
    const withTab = newTab(layout, nextId)
    const back = selectTab(withTab, layout.activeTabId)
    expect(back.activeTabId).toBe(layout.activeTabId)
    expect(layoutLeaves(activeTab(back).root).some((leaf) => leaf.id === back.activePaneId))
      .toBe(true)

    const second = selectTabAt(back, 1)
    expect(second.activeTabId).toBe(withTab.activeTabId)
    expect(selectTabAt(second, 9)).toBe(second)
  })

  it('clamps split ratios', () => {
    const { layout, nextId } = fresh()
    const split = splitPane(layout, layout.activePaneId, 'row', nextId)
    const root = activeTab(split).root
    if (root.kind !== 'split') throw new Error('expected split root')

    const wide = setSplitRatio(split, root.id, 0.99)
    const wideRoot = activeTab(wide).root
    if (wideRoot.kind !== 'split') throw new Error('expected split root')
    expect(wideRoot.ratio).toBe(0.9)

    const narrow = setSplitRatio(split, root.id, -1)
    const narrowRoot = activeTab(narrow).root
    if (narrowRoot.kind !== 'split') throw new Error('expected split root')
    expect(narrowRoot.ratio).toBe(0.1)
  })

  it('round-trips through JSON and rejects malformed payloads', () => {
    const { layout, nextId } = fresh()
    const split = splitPane(layout, layout.activePaneId, 'row', nextId)
    const restored = parseTerminalLayout(JSON.stringify(split), counterIds())
    expect(restored).toEqual(split)

    const freshIds = counterIds()
    expect(parseTerminalLayout(null, freshIds).tabs).toHaveLength(1)
    expect(parseTerminalLayout('not json', counterIds()).tabs).toHaveLength(1)
    expect(parseTerminalLayout('{"tabs":[]}', counterIds()).tabs).toHaveLength(1)
    // Stale active ids fall back to a fresh layout instead of crashing.
    const stale = JSON.stringify({ ...split, activePaneId: 'gone' })
    const fallback = parseTerminalLayout(stale, counterIds())
    expect(layoutLeaves(activeTab(fallback).root)[0]?.termId).toBe('main')
    // termIds are constrained to safe characters for session keys.
    const evil = JSON.stringify({
      tabs: [{ id: 't', root: { kind: 'leaf', id: 'p', termId: 'bad/../id' } }],
      activeTabId: 't',
      activePaneId: 'p',
    })
    expect(layoutLeaves(activeTab(parseTerminalLayout(evil, counterIds())).root)[0]?.termId)
      .toBe('main')
  })
})
