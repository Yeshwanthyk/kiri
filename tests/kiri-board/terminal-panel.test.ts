import { describe, expect, it } from 'vitest'
import {
  applyTerminalFrameForTests,
  parseTerminalFramesForTests,
  terminalColorValueForTests,
  terminalRenderedRowsForTests,
  terminalShouldCustomScrollWheel,
  terminalTypographyOptions,
  terminalWheelScrollLines,
} from '~/components/kiri-board/terminal-panel'

describe('terminal typography', () => {
  it('maps chat typography settings to terminal renderer font options', () => {
    expect(terminalTypographyOptions({ fontSize: 'xlarge', monoFont: 'berkeley' })).toEqual({
      fontSize: 18,
      fontFamily: '"BerkeleyMono Nerd Font", ui-monospace, SFMono-Regular, Menlo, monospace',
    })
  })
})

describe('terminal frame renderer contract', () => {
  it('parses newline-delimited sidecar frames across websocket chunks', () => {
    const first = '{"type":"status","terminalId":"term-1","status":"running"}\n{"type":"snap'
    const parsed = parseTerminalFramesForTests(first)
    expect(parsed.frames).toHaveLength(1)
    expect(parsed.buffer).toBe('{"type":"snap')

    const second = parseTerminalFramesForTests('shot","terminalId":"term-1","snapshot":{"cols":2,"rows":1,"screenSeq":0,"historySeq":0,"bufferKind":"main","cursor":{"row":0,"col":0,"visible":true},"modes":{"bracketedPaste":false,"cursorVisible":true},"viewport":{"historyOffset":0,"visibleRows":1},"historyRows":[],"rowsData":[]}}\n', parsed.buffer)
    expect(second.frames.map((frame) => frame.type)).toEqual(['snapshot'])
    expect(second.buffer).toBe('')
  })

  it('applies snapshots and patches without rendering raw JSON as terminal text', () => {
    const initial = {
      cols: 2,
      rows: 1,
      screenSeq: 0,
      historySeq: 0,
      bufferKind: 'main' as const,
      cursor: { row: 0, col: 0, visible: true },
      modes: { bracketedPaste: false, cursorVisible: true },
      viewport: { historyOffset: 0, visibleRows: 1 },
      historyRows: [],
      rowsData: [],
    }
    const snapshot = applyTerminalFrameForTests(initial, {
      type: 'snapshot',
      terminalId: 'term-1',
      snapshot: initial,
    })
    const patched = applyTerminalFrameForTests(snapshot, {
      type: 'patch',
      terminalId: 'term-1',
      patch: {
        cols: 2,
        rows: 1,
        screenSeq: 1,
        historySeq: 0,
        historyDelta: null,
        ops: [{
          op: 'replaceRow',
          row: {
            row: 0,
            fingerprint: 1,
            runs: [{
              text: 'ok',
              width: 2,
              style: {},
            }],
          },
        }],
      },
    })

    expect(patched.rowsData[0]?.runs[0]?.text).toBe('ok')
  })

  it('renders scrollback rows before the live screen rows', () => {
    const rows = terminalRenderedRowsForTests({
      cols: 2,
      rows: 1,
      screenSeq: 1,
      historySeq: 1,
      bufferKind: 'main',
      cursor: { row: 0, col: 1, visible: true },
      modes: { bracketedPaste: false, cursorVisible: true },
      viewport: { historyOffset: 0, visibleRows: 1 },
      historyRows: [{
        id: 7,
        row: {
          row: 0,
          fingerprint: 11,
          runs: [{ text: 'hi', width: 2, style: {} }],
        },
      }],
      rowsData: [{
        row: 0,
        fingerprint: 12,
        runs: [{ text: 'ok', width: 2, style: {} }],
      }],
    })

    expect(rows.map((row) => row.key)).toEqual(['history-7', 'screen-0'])
    expect(rows.map((row) => row.row.runs[0]?.text)).toEqual(['hi', 'ok'])
  })

  it('applies partial cell replacements without dropping prefix or suffix cells', () => {
    const initial = {
      cols: 5,
      rows: 1,
      screenSeq: 0,
      historySeq: 0,
      bufferKind: 'main' as const,
      cursor: { row: 0, col: 1, visible: true },
      modes: { bracketedPaste: false, cursorVisible: true },
      viewport: { historyOffset: 0, visibleRows: 1 },
      historyRows: [],
      rowsData: [{
        row: 0,
        fingerprint: 1,
        runs: [{ text: 'abcde', width: 5, style: {} }],
      }],
    }

    const patched = applyTerminalFrameForTests(initial, {
      type: 'patch',
      terminalId: 'term-1',
      patch: {
        cols: 5,
        rows: 1,
        screenSeq: 1,
        historySeq: 0,
        historyDelta: null,
        ops: [{
          op: 'replaceCells',
          row: 0,
          col: 2,
          runs: [{ text: 'XY', width: 2, style: { bold: true } }],
        }],
      },
    })

    expect(patched.rowsData[0]?.runs.map((run) => run.text)).toEqual(['ab', 'XY', 'e'])
  })

  it('maps 256-color palette indices for sidecar-rendered ANSI styles', () => {
    expect(terminalColorValueForTests({ kind: 'palette', index: 196 })).toBe('rgb(255 0 0)')
    expect(terminalColorValueForTests({ kind: 'palette', index: 232 })).toBe('rgb(8 8 8)')
  })
})

describe('terminal wheel scrolling', () => {
  it('maps wheel deltas to scrollback lines', () => {
    expect(terminalWheelScrollLines({ deltaMode: 0, deltaY: -120 }))
      .toBe(-3)
    expect(terminalWheelScrollLines({ deltaMode: 1, deltaY: 2 }))
      .toBe(2)
    expect(terminalWheelScrollLines({ deltaMode: 2, deltaY: 1 }))
      .toBe(10)
    expect(terminalWheelScrollLines({ deltaMode: 0, deltaY: 0 }))
      .toBe(0)
  })

  it('only overrides wheel handling when normal scrollback exists', () => {
    expect(terminalShouldCustomScrollWheel({ type: 'normal', baseY: 12 }))
      .toBe(true)
    expect(terminalShouldCustomScrollWheel({ type: 'normal', baseY: 0 }))
      .toBe(false)
    expect(terminalShouldCustomScrollWheel({ type: 'alternate', baseY: 12 }))
      .toBe(false)
    expect(terminalShouldCustomScrollWheel(undefined))
      .toBe(false)
  })
})
