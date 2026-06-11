import { afterEach, describe, expect, it } from 'vitest'
import { encodeTerminalKey, encodeTerminalKeys } from '../../src/lib/terminal-keys'
import { startTerminalHarness, type TerminalHarness } from '../harness/terminal-harness'

// Agent-parity contract: everything a human can do in a terminal (type, press
// keys, read the screen, interrupt, resume) must be scriptable through the
// registry surface that the MCP control plane exposes. These tests run a real
// /bin/bash in a real pty.

const harnesses: TerminalHarness[] = []

function start(...args: Parameters<typeof startTerminalHarness>) {
  const harness = startTerminalHarness(...args)
  harnesses.push(harness)
  return harness
}

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.dispose()
  }
})

describe('terminal keys', () => {
  it('encodes named keys, chords, and rejects unknown names', () => {
    expect(encodeTerminalKey('Enter')).toBe('\r')
    expect(encodeTerminalKey('up')).toBe('\x1b[A')
    expect(encodeTerminalKey('c-c')).toBe('\x03')
    expect(encodeTerminalKey('ctrl-z')).toBe('\x1a')
    expect(encodeTerminalKey('c-[')).toBe('\x1b')
    expect(encodeTerminalKey('f5')).toBe('\x1b[15~')
    expect(encodeTerminalKey('nope')).toBeNull()
    expect(encodeTerminalKeys(['up', 'up', 'enter'])).toBe('\x1b[A\x1b[A\r')
    expect(() => encodeTerminalKeys(['enter', 'warp-drive'])).toThrow('Unknown terminal key')
  })
})

describe('terminal harness (real pty)', () => {
  it('runs a command and observes its output on screen', async () => {
    const harness = start()
    await harness.waitFor(/KIRI\$/)

    harness.input("printf 'harness-%s\\n' ok")
    harness.keys('enter')

    await harness.waitFor(/harness-ok/)
    const text = await harness.text()
    expect(text).toContain('harness-ok')
  }, 15_000)

  it('answers an interactive prompt like a human would', async () => {
    const harness = start()
    await harness.waitFor(/KIRI\$/)

    harness.input('read -p "Continue? " answer && printf "got-%s\\n" "$answer"')
    harness.keys('enter')
    await harness.waitFor(/Continue\?/)

    harness.input('yes')
    harness.keys('enter')

    await harness.waitFor(/got-yes/)
  }, 15_000)

  it('interrupts a running command with ctrl-c and stays usable', async () => {
    const harness = start()
    await harness.waitFor(/KIRI\$/)

    harness.input('sleep 30')
    harness.keys('enter')
    await harness.waitFor(/sleep 30/)
    // Give bash time to actually fork sleep so SIGINT hits a running command.
    await new Promise((resolve) => setTimeout(resolve, 200))

    harness.keys('c-c')
    await harness.waitFor(/\^C/, { timeoutMs: 10_000, scope: 'output' })
    harness.input("printf 'after-%s\\n' interrupt")
    harness.keys('enter')

    await harness.waitFor(/after-interrupt/, { timeoutMs: 10_000 })
  }, 20_000)

  it('recalls history with the up arrow', async () => {
    const harness = start()
    await harness.waitFor(/KIRI\$/)

    harness.input("printf 'first-%s\\n' run")
    harness.keys('enter')
    await harness.waitFor(/first-run/)

    harness.keys('up', 'enter')
    await harness.waitFor(/first-run[\s\S]*first-run/)
  }, 15_000)

  it('reattach snapshot reproduces the screen exactly', async () => {
    const harness = start()
    await harness.waitFor(/KIRI\$/)
    harness.input("printf 'snapshot-%s\\n' me")
    harness.keys('enter')
    await harness.waitFor(/snapshot-me/)

    const original = await harness.screen()
    const snapshot = harness.snapshot()

    const restoredHarness = start({ command: '/bin/cat', args: [] })
    const { registry, session } = restoredHarness
    registry.append(session, snapshot)
    const restored = await restoredHarness.screen()

    expect(restored.lines).toEqual(original.lines)
    expect(restored.cursorX).toBe(original.cursorX)
    expect(restored.cursorY).toBe(original.cursorY)
  }, 15_000)

  it('reflects resizes in the parsed screen dimensions', async () => {
    const harness = start()
    await harness.waitFor(/KIRI\$/)

    harness.resize(60, 20)
    const screen = await harness.screen()
    expect(screen.cols).toBe(60)
    expect(screen.rows).toBe(20)
    expect(screen.lines).toHaveLength(20)
  }, 15_000)
})
