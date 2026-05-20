import { describe, expect, it } from 'vitest'
import { compareKiriTerminalToXterm } from '../harness/terminal-xterm-compare'

describe('kiri terminal xterm contract', () => {
  it('matches xterm cell state for captured Claude Code redraw output', async () => {
    const diffs = await compareKiriTerminalToXterm({
      fixturePath: 'tests/fixtures/terminal/ansi/claude-code-redraw.ansi',
      cols: 80,
      rows: 30,
    })

    expect(diffs).toEqual([])
  }, 30_000)
})
