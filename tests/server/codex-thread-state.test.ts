import { describe, expect, it } from 'vitest'
import { activeCodexTurnId, codexThreadAgentStatus } from '~/server/codex-thread-state'

describe('Codex thread state helpers', () => {
  it('returns the most recent in-progress turn id', () => {
    expect(activeCodexTurnId({
      turns: [
        { id: 'turn-1', status: 'inProgress' },
        { id: 'turn-2', status: 'completed' },
        { id: 'turn-3', status: 'inProgress' },
      ],
    })).toBe('turn-3')
  })

  it('returns undefined when no turn is active', () => {
    expect(activeCodexTurnId({ turns: [{ id: 'turn-1', status: 'completed' }] })).toBeUndefined()
    expect(activeCodexTurnId({})).toBeUndefined()
  })

  it('maps Codex thread status into agent status', () => {
    expect(codexThreadAgentStatus({ status: { type: 'active' } })).toBe('running')
    expect(codexThreadAgentStatus({ status: { type: 'systemError' } })).toBe('failed')
    expect(codexThreadAgentStatus({ status: { type: 'idle' } })).toBe('idle')
    expect(codexThreadAgentStatus({ status: { type: 'notLoaded' } })).toBe('idle')
    expect(codexThreadAgentStatus({ status: { type: 'other' } })).toBeNull()
    expect(codexThreadAgentStatus({})).toBeNull()
  })
})
