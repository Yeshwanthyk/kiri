import { describe, expect, it } from 'vitest'
import {
  compareKiriTerminalBytesToXterm,
  compareKiriTerminalToXterm,
} from '../harness/terminal-xterm-compare'

describe('kiri terminal xterm contract', () => {
  it('matches xterm cell state for captured Claude Code redraw output', async () => {
    const diffs = await compareKiriTerminalToXterm({
      fixturePath: 'tests/fixtures/terminal/ansi/claude-code-redraw.ansi',
      cols: 80,
      rows: 30,
    })

    expect(diffs).toEqual([])
  }, 30_000)

  it.each([
    ['repeat previous printable', 'abc\x1b[3b'],
    ['horizontal position absolute', 'x\x1b[10`Y'],
    ['horizontal position relative', 'x\x1b[10aY'],
    ['vertical position relative', 'x\x1b[3eY'],
    ['cursor horizontal tab', 'x\x1b[2IY'],
  ])('matches xterm for %s', async (_name, raw) => {
    const diffs = await compareKiriTerminalBytesToXterm({
      raw: Buffer.from(raw, 'utf8'),
      cols: 24,
      rows: 6,
    })

    expect(diffs).toEqual([])
  }, 30_000)
})
