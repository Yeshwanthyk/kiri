import { describe, expect, it } from 'vitest'
import { runTerminalAgentHarness, runTerminalShellHarness } from '../harness/terminal-agent-harness'

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

  it('drives project shell tabs and split panes for editor/script workflows', async () => {
    const result = await runTerminalShellHarness()

    expect(result.editedFile).toBe('edited:editor.txt\n')
    expect(result.tabPastes.map((paste) => paste.text).sort()).toEqual([
      'edited:editor.txt',
      'running:long-script',
    ])
    expect(result.splitPastes.map((paste) => paste.text).sort()).toEqual([
      'left-pane',
      'right-pane',
    ])
    expect(result.reconnectPaste.pid).toBe(result.tabPastes[0]?.pid)
    expect(result.reconnectPaste.text).toBe('after reconnect')
    expect(new Set([...result.tabPastes, ...result.splitPastes].map((paste) => paste.pid)).size)
      .toBe(4)
  }, 20_000)
})
