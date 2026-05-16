import { describe, expect, it, vi } from 'vitest'
import {
  defaultChatTypography,
  normalizeChatTypography,
  readStoredChatDraft,
  readStoredChatDrafts,
  readStoredChatTypography,
  readStoredAgentByProject,
  readStoredThemeSelection,
  readStoredKeymap,
  saveChatTypography,
  saveKeymap,
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

  it('falls back to defaults for duplicate or unsupported bindings', () => {
    const duplicate = memoryStorage({
      'kiri:keymap:v1': JSON.stringify({ ...defaultKeymap, projectPrev: 'j' }),
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
