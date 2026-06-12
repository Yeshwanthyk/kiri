import { describe, expect, it } from 'vitest'
import {
  mergeMissingStoredAgentByProject,
  shouldUseStoredAgentByProject,
  shouldUseStoredPreference,
} from '~/components/kiri-board/board-preferences'

describe('board preference migration decisions', () => {
  it('uses stored preferences only when the server value is still the default', () => {
    const defaultValue = { mode: 'light', name: 'kiri' }
    const storedValue = { mode: 'dark', name: 'tokyonight' }
    const serverValue = { mode: 'light', name: 'rosepine' }

    expect(shouldUseStoredPreference(defaultValue, defaultValue, storedValue)).toBe(true)
    expect(shouldUseStoredPreference(serverValue, defaultValue, storedValue)).toBe(false)
    expect(shouldUseStoredPreference(defaultValue, defaultValue, defaultValue)).toBe(false)
  })

  it('merges stored selected sessions for projects missing on the server', () => {
    expect(shouldUseStoredAgentByProject({}, { project: 'agent' })).toBe(true)
    expect(shouldUseStoredAgentByProject({ project: 'agent' }, { project: 'other' })).toBe(false)
    expect(shouldUseStoredAgentByProject({ kiri: 'session-1' }, { merlin: 'session-2' })).toBe(true)
    expect(shouldUseStoredAgentByProject({}, {})).toBe(false)
    expect(mergeMissingStoredAgentByProject(
      { kiri: 'session-1' },
      { kiri: 'stale', merlin: 'session-2' },
    )).toEqual({ kiri: 'session-1', merlin: 'session-2' })
  })
})
