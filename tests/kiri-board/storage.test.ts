import { describe, expect, it, vi } from 'vitest'
import {
  defaultChatTypography,
  normalizeChatTypography,
  readStoredChatDraft,
  readStoredChatDrafts,
  readStoredChatTypography,
  readStoredAgentByProject,
  readStoredResourceLayout,
  readStoredThemeSelection,
  readStoredKeymap,
  saveChatTypography,
  saveKeymap,
  saveStoredResourceLayout,
  updateChatDraft,
  type StorageLike,
} from '~/components/kiri-board/storage'
import { defaultKeymap } from '~/components/kiri-board/navigation'
import { defaultThemeSelection } from '~/theme/kiri-themes'

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

describe('keymap storage', () => {
  it('falls back when window storage is unavailable', () => {
    expect(readStoredKeymap()).toEqual(defaultKeymap)
  })

  it('reads and saves valid keymaps', () => {
    const storage = memoryStorage()
    const keymap = { ...defaultKeymap, focusChat: 'arrowup' }

    saveKeymap(keymap, storage)

    expect(readStoredKeymap(storage)).toEqual(keymap)
  })

  it('migrates the legacy default keymap', () => {
    const storage = memoryStorage({
      'kiri:keymap:v1': JSON.stringify({
        ...defaultKeymap,
        projectPrev: 'k',
        projectNext: 'j',
        agentPrev: 'h',
        agentNext: 'l',
      }),
    })

    expect(readStoredKeymap(storage)).toEqual(defaultKeymap)
  })

  it('falls back to defaults for duplicate or unsupported bindings', () => {
    const duplicate = memoryStorage({
      'kiri:keymap:v1': JSON.stringify({ ...defaultKeymap, projectPrev: 'l' }),
    })
    const unsupported = memoryStorage({
      'kiri:keymap:v1': JSON.stringify({ ...defaultKeymap, projectPrev: '?' }),
    })

    expect(readStoredKeymap(duplicate)).toEqual(defaultKeymap)
    expect(readStoredKeymap(unsupported)).toEqual(defaultKeymap)
  })
})

describe('chat typography storage', () => {
  it('falls back when window storage is unavailable', () => {
    expect(readStoredThemeSelection()).toEqual(defaultThemeSelection)
    expect(readStoredChatTypography()).toEqual(defaultChatTypography)
  })

  it('normalizes partial and invalid settings', () => {
    expect(normalizeChatTypography({ fontSize: 'large', monoFont: 'operator' })).toEqual({
      fontSize: 'large',
      monoFont: 'operator',
    })
    expect(normalizeChatTypography({ fontSize: 'giant', monoFont: 12 })).toEqual(
      defaultChatTypography,
    )
  })

  it('reads and saves chat typography', () => {
    const storage = memoryStorage()
    const settings = { fontSize: 'xlarge' as const, monoFont: 'berkeley' as const }

    saveChatTypography(settings, storage)

    expect(readStoredChatTypography(storage)).toEqual(settings)
  })
})

describe('chat draft storage', () => {
  it('falls back when session storage is unavailable', () => {
    expect(readStoredChatDraft('agent-1')).toBe('')
    expect(readStoredChatDrafts()).toEqual({})
  })

  it('stores and clears drafts by agent id', () => {
    const storage = memoryStorage()
    const setDraft = vi.fn()

    updateChatDraft('agent-1', 'hello', setDraft, storage)

    expect(setDraft).toHaveBeenCalledWith('hello')
    expect(readStoredChatDraft('agent-1', storage)).toBe('hello')

    updateChatDraft('agent-1', '', setDraft, storage)

    expect(readStoredChatDraft('agent-1', storage)).toBe('')
    expect(readStoredChatDrafts(storage)).toEqual({})
  })

  it('ignores non-string draft entries', () => {
    const storage = memoryStorage({
      'kiri:chat-drafts:v1': JSON.stringify({ good: 'draft', bad: 7 }),
    })

    expect(readStoredChatDrafts(storage)).toEqual({ good: 'draft' })
  })
})

describe('resource layout storage', () => {
  it('falls back when window storage is unavailable', () => {
    expect(readStoredResourceLayout()).toEqual({
      activeProjectId: null,
      projects: {},
    })
  })

  it('reads and saves normalized resource layout', () => {
    const storage = memoryStorage()
    const layout = {
      activeProjectId: 'alpha',
      projects: {
        alpha: {
          activeResourceId: 'terminal:t1' as const,
          activeTerminalResourceId: 'terminal:t1' as const,
          order: ['agent:a1', 'terminal:t1'] as const,
          terminals: [{
            id: 'terminal:t1' as const,
            kind: 'terminal' as const,
            terminalId: 't1',
            title: 'server',
            purpose: { kind: 'manual' as const },
          }],
        },
      },
    }

    saveStoredResourceLayout(layout, storage)

    expect(readStoredResourceLayout(storage)).toEqual(layout)
  })

  it('drops malformed resource layout fields', () => {
    const storage = memoryStorage({
      'kiri:resource-layout:v1': JSON.stringify({
        activeProjectId: 12,
        projects: {
          alpha: {
            activeResourceId: 'agent:a1',
            order: ['agent:a1', 'bad', 'scratchpad'],
            terminals: [
              {
                id: 'terminal:t1',
                kind: 'terminal',
                terminalId: 't1',
                title: '',
                purpose: { kind: 'unknown' },
              },
              { id: 'agent:nope', terminalId: 'bad' },
            ],
          },
          beta: 'bad',
        },
      }),
    })

    expect(readStoredResourceLayout(storage)).toEqual({
      activeProjectId: null,
      projects: {
        alpha: {
          activeResourceId: 'agent:a1',
          order: ['agent:a1'],
          terminals: [{
            id: 'terminal:t1',
            kind: 'terminal',
            terminalId: 't1',
            title: 'terminal',
            purpose: { kind: 'manual' },
          }],
        },
      },
    })
  })
})

describe('selected agent storage migration', () => {
  it('keeps only remembered agents that still exist in the workspace', () => {
    const storage = memoryStorage({
      'kiri:agent-by-project:v1': JSON.stringify({
        alpha: 'agent-alpha',
        beta: 'missing-agent',
      }),
    })
    const snapshot = {
      projects: [
        { id: 'alpha', agents: [{ id: 'agent-alpha' }] },
        { id: 'beta', agents: [{ id: 'agent-beta' }] },
      ],
      selected: { projectId: 'beta', agentId: 'agent-beta' },
    }

    expect(readStoredAgentByProject(snapshot as Parameters<typeof readStoredAgentByProject>[0], storage))
      .toEqual({
        alpha: 'agent-alpha',
        beta: 'agent-beta',
      })
  })

  it('seeds the selected agent when remembered agent storage is malformed', () => {
    const storage = memoryStorage({
      'kiri:agent-by-project:v1': '{',
    })
    const snapshot = {
      projects: [
        { id: 'alpha', agents: [{ id: 'agent-alpha' }] },
      ],
      selected: { projectId: 'alpha', agentId: 'agent-alpha' },
    }

    expect(readStoredAgentByProject(snapshot as Parameters<typeof readStoredAgentByProject>[0], storage))
      .toEqual({ alpha: 'agent-alpha' })
  })
})
