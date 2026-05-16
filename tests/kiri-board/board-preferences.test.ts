import { describe, expect, it } from 'vitest'
import {
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

  it('uses stored selected sessions only when the server has no selection', () => {
    expect(shouldUseStoredAgentByProject({}, { project: 'agent' })).toBe(true)
    expect(shouldUseStoredAgentByProject({ project: 'agent' }, { project: 'other' })).toBe(false)
    expect(shouldUseStoredAgentByProject({}, {})).toBe(false)
  })
})
