import { describe, expect, it } from 'vitest'
import { runTerminalAgentHarness } from '../harness/terminal-agent-harness'

describe('terminal agent harness', () => {
  it('pastes repeatedly into the same fake Claude terminal thread', async () => {
    const result = await runTerminalAgentHarness('claude')

    expect(result.repeatedPasteSameThread).toBe(true)
    expect(result.firstPaste.sequence).toBe(1)
    expect(result.secondPaste.sequence).toBe(2)
    expect(result.tabPastes.map((paste) => paste.text).sort()).toEqual([
      'tab-a command',
      'tab-b command',
    ])
    expect(new Set(result.tabPastes.map((paste) => paste.pid)).size).toBe(2)
  }, 20_000)

  it('pastes repeatedly into the same fake OpenCode terminal thread', async () => {
    const result = await runTerminalAgentHarness('opencode')

    expect(result.repeatedPasteSameThread).toBe(true)
    expect(result.firstPaste.sequence).toBe(1)
    expect(result.secondPaste.sequence).toBe(2)
  }, 20_000)

  it('pastes repeatedly into the same fake Codex terminal thread', async () => {
    const result = await runTerminalAgentHarness('codex')

    expect(result.repeatedPasteSameThread).toBe(true)
    expect(result.firstPaste.sequence).toBe(1)
    expect(result.secondPaste.sequence).toBe(2)
  }, 20_000)
})
