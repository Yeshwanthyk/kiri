import { describe, expect, it } from 'vitest'
import type { AgentCell, ProjectRow } from '~/lib/contracts'
import {
  collectBrowserResources,
  ensureBrowserResource,
  ensureTerminalResource,
  insertAgentResource,
  moveProjectResource,
  reconcileProjectResources,
  selectAdjacentResource,
  type ProjectResourceLayout,
} from '~/components/kiri-board/resource-tabs'

describe('resource tabs', () => {
  it('derives agent resources when layout is missing', () => {
    const result = reconcileProjectResources({
      project: project('alpha', ['a1', 'a2']),
      layout: undefined,
    })

    expect(result.resources.map((resource) => resource.id)).toEqual([
      'agent:a1',
      'agent:a2',
    ])
    expect(result.activeResourceId).toBe('agent:a1')
  })

  it('drops the old scratchpad tab sentinel after reconciliation', () => {
    const result = reconcileProjectResources({
      project: project('alpha', ['a1', 'a2']),
      layout: {
        activeResourceId: 'scratchpad',
        order: ['scratchpad', 'agent:a2', 'agent:a1'],
        terminals: [],
        browsers: [],
      },
    })

    expect(result.layout.order).toEqual(['agent:a2', 'agent:a1'])
    expect(result.activeResourceId).toBe('agent:a2')
  })

  it('inserts a new agent before terminal resources by default', () => {
    const layout: ProjectResourceLayout = {
      activeResourceId: 'agent:a1',
      order: ['agent:a1', 'terminal:t1'],
      terminals: [{
        id: 'terminal:t1',
        kind: 'terminal',
        terminalId: 't1',
        title: 'server',
        purpose: { kind: 'manual' },
      }],
      browsers: [],
    }

    expect(insertAgentResource({ layout, agentId: 'a2' })).toMatchObject({
      activeResourceId: 'agent:a2',
      order: ['agent:a1', 'agent:a2', 'terminal:t1'],
    })
  })

  it('prunes stale agents without losing terminal resources', () => {
    const result = reconcileProjectResources({
      project: project('alpha', ['a2']),
      layout: {
        activeResourceId: 'agent:missing',
        order: ['agent:missing', 'terminal:t1', 'agent:a2', 'scratchpad'],
        terminals: [{
          id: 'terminal:t1',
          kind: 'terminal',
          terminalId: 't1',
          title: 'server',
          purpose: { kind: 'manual' },
        }],
        browsers: [],
      },
    })

    expect(result.layout.order).toEqual(['terminal:t1', 'agent:a2'])
    expect(result.activeResourceId).toBe('terminal:t1')
  })

  it('moves resources and selects adjacent resources deterministically', () => {
    const layout: ProjectResourceLayout = {
      activeResourceId: 'agent:a1',
      order: ['agent:a1', 'terminal:t1', 'agent:a2'],
      terminals: [{
        id: 'terminal:t1',
        kind: 'terminal',
        terminalId: 't1',
        title: 'server',
        purpose: { kind: 'manual' },
      }],
      browsers: [],
    }
    const moved = moveProjectResource({ layout, resourceId: 'terminal:t1', toIndex: 2 })
    const reconciled = reconcileProjectResources({
      project: project('alpha', ['a1', 'a2']),
      layout: moved,
    })

    expect(moved.order).toEqual(['agent:a1', 'agent:a2', 'terminal:t1'])
    expect(selectAdjacentResource({
      resources: reconciled.resources,
      activeResourceId: 'agent:a2',
      delta: 1,
    })).toBe('terminal:t1')
  })

  it('creates and reuses manual terminal resources', () => {
    const layout: ProjectResourceLayout = {
      activeResourceId: 'agent:a1',
      order: ['agent:a1'],
      terminals: [],
      browsers: [],
    }

    const first = ensureTerminalResource({ layout, terminalId: 'term-1', title: 'server' })
    const second = ensureTerminalResource({ layout: first.layout })

    expect(first.resourceId).toBe('terminal:term-1')
    expect(first.layout.order).toEqual(['agent:a1', 'terminal:term-1'])
    expect(first.layout.terminals).toEqual([{
      id: 'terminal:term-1',
      kind: 'terminal',
      terminalId: 'term-1',
      title: 'server',
      purpose: { kind: 'manual' },
    }])
    expect(second.resourceId).toBe(first.resourceId)
  })

  it('creates and reuses browser resources', () => {
    const layout: ProjectResourceLayout = {
      activeResourceId: 'agent:a1',
      order: ['agent:a1'],
      terminals: [],
      browsers: [],
    }

    const first = ensureBrowserResource({
      layout,
      browserId: 'browser-1',
      title: 'docs',
      url: 'https://example.com',
    })
    const second = ensureBrowserResource({ layout: first.layout })

    expect(first.resourceId).toBe('browser:browser-1')
    expect(first.layout.order).toEqual(['agent:a1', 'browser:browser-1'])
    expect(first.layout.browsers).toEqual([{
      id: 'browser:browser-1',
      kind: 'browser',
      browserId: 'browser-1',
      title: 'docs',
      url: 'https://example.com',
    }])
    expect(second.resourceId).toBe(first.resourceId)
  })

  it('collects browser resources across projects without duplicates', () => {
    const browserA = {
      id: 'browser:b1',
      kind: 'browser',
      browserId: 'b1',
      title: 'docs',
      url: 'https://example.com',
    } as const
    const browserB = {
      id: 'browser:b2',
      kind: 'browser',
      browserId: 'b2',
      title: 'status',
      url: 'https://status.example.com',
    } as const

    expect(collectBrowserResources({
      alpha: {
        resources: [
          { id: 'agent:a1', kind: 'agent', agentId: 'a1' },
          browserA,
        ],
      },
      beta: { resources: [browserB, browserA] },
    })).toEqual([browserA, browserB])
  })

  it('keeps empty projects empty instead of falling back to scratchpad', () => {
    const result = reconcileProjectResources({
      project: project('alpha', []),
      layout: undefined,
    })

    expect(result.resources).toEqual([])
    expect(result.activeResourceId).toBeNull()
    expect(result.layout.order).toEqual([])
  })
})

function project(id: string, agentIds: string[]): ProjectRow {
  return {
    id,
    name: id,
    cwd: `/repo/${id}`,
    position: 0,
    hiddenAt: null,
    agents: agentIds.map((agentId) => agent(agentId, id)),
  }
}

function agent(id: string, projectId: string): AgentCell {
  return {
    id,
    projectId,
    slot: `session-${id}`,
    title: id,
    runtime: 'codex',
    interfaceMode: 'gui',
    model: 'gpt-5.5',
    status: 'idle',
    sessionDir: `/tmp/${id}`,
    sessionFile: null,
    preview: '',
    messageCount: 0,
    contextUsage: null,
    pendingQuestion: null,
    updatedAt: '2026-05-11T12:00:00.000Z',
    isSession: true,
    messages: [],
    timelineEvents: [],
    timeline: [],
    tasks: [],
  }
}
