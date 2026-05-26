import { describe, expect, it, vi } from 'vitest'
import {
  applyTerminalFramesForTests,
  applyTerminalFrameForTests,
  parseTerminalFramesForTests,
  sendResizeForTests,
  terminalCanMeasureHostSizeForTests,
  terminalColorValueForTests,
  terminalCursorRowPartsForTests,
  terminalCursorShouldRenderForTests,
  terminalHostIsNearBottomForTests,
  terminalRenderedRowsForTests,
  terminalRowUnderlineBlankRunCountForTests,
  terminalRowUnderlineRunCountForTests,
  terminalRunHasVisibleUnderlineForTests,
  terminalRunIsBlankUnderlineForTests,
  terminalRunCellsForTests,
  terminalRunStyleForTests,
  terminalScreenStyleForTests,
  terminalSizeFromMeasurements,
  terminalTypographyOptions,
  terminalWheelActionForTests,
  terminalWheelMouseInputForTests,
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

  it('coalesces multiple terminal frames into one snapshot transition', () => {
    const initial = {
      cols: 4,
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

    const patched = applyTerminalFramesForTests(initial, [{
      type: 'patch',
      terminalId: 'term-1',
      patch: {
        cols: 4,
        rows: 1,
        screenSeq: 1,
        historySeq: 0,
        historyDelta: null,
        ops: [{
          op: 'replaceRow',
          row: { row: 0, fingerprint: 1, runs: [{ text: 'abcd', width: 4, style: {} }] },
        }],
      },
    }, {
      type: 'patch',
      terminalId: 'term-1',
      patch: {
        cols: 4,
        rows: 1,
        screenSeq: 2,
        historySeq: 0,
        historyDelta: null,
        ops: [{ op: 'setCursor', cursor: { row: 0, col: 4, visible: false } }],
      },
    }])

    expect(patched.rowsData[0]?.runs[0]?.text).toBe('abcd')
    expect(patched.cursor).toEqual({ row: 0, col: 4, visible: false })
  })

  it('can force a focused cursor marker when a TUI hides the terminal cursor', () => {
    expect(terminalCursorShouldRenderForTests({ row: 0, col: 1, visible: false }, false)).toBe(false)
    expect(terminalCursorShouldRenderForTests({ row: 0, col: 1, visible: false }, true)).toBe(true)
    expect(terminalCursorShouldRenderForTests({ row: 0, col: 1, visible: true }, false)).toBe(true)
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

  it('reserves measured terminal cell width so styled runs cannot drift from PTY geometry', () => {
    const renderMetrics = { cellWidth: 9.5, lineHeight: 18 }
    expect(terminalScreenStyleForTests(80, renderMetrics)).toMatchObject({
      width: '760px',
      minWidth: '760px',
      lineHeight: '18px',
    })
    expect(terminalRunStyleForTests({
      text: 'long output',
      width: 80,
      style: {},
    }, renderMetrics)).toMatchObject({
      width: '760px',
      minWidth: '760px',
    })
    expect(terminalRunCellsForTests({
      text: 'abc',
      width: 5,
      style: {},
    })).toEqual(['a', 'b', 'c', ' ', ' '])
    expect(terminalCursorRowPartsForTests([{
      text: 'looks pretty good',
      width: 17,
      style: {},
    }], 5)).toEqual([
      { kind: 'run', run: { text: 'looks', width: 5, style: {} } },
      { kind: 'cursor' },
      { kind: 'run', run: { text: ' pretty good', width: 12, style: {} } },
    ])
  })

  it('renders underline as terminal decoration metadata instead of CSS text decoration', () => {
    const visibleRun = {
      text: 'link',
      width: 4,
      style: { underline: true },
    }
    const blankRun = {
      text: '    ',
      width: 4,
      style: { underline: true },
    }
    expect(terminalRunStyleForTests(visibleRun)).not.toHaveProperty('textDecoration')
    expect(terminalRunHasVisibleUnderlineForTests(visibleRun)).toBe(true)
    expect(terminalRunHasVisibleUnderlineForTests(blankRun)).toBe(false)
    expect(terminalRunIsBlankUnderlineForTests(blankRun)).toBe(true)
  })

  it('exposes per-row underline diagnostics for live terminal capture', () => {
    const row = {
      row: 0,
      fingerprint: 0,
      runs: [
        { text: 'link', width: 4, style: { underline: true } },
        { text: '  ', width: 2, style: { underline: true } },
        { text: 'plain', width: 5, style: {} },
      ],
    }

    expect(terminalRowUnderlineRunCountForTests(row)).toBe(2)
    expect(terminalRowUnderlineBlankRunCountForTests(row)).toBe(1)
  })
})

describe('terminal sizing', () => {
  it('computes pty size from measured cells and excludes host padding', () => {
    expect(terminalSizeFromMeasurements({
      width: 1020,
      height: 548,
      paddingLeft: 10,
      paddingRight: 10,
      paddingTop: 8,
      paddingBottom: 8,
      charWidth: 10,
      lineHeight: 19,
    })).toEqual({ cols: 100, rows: 28 })
  })

  it('does not treat hidden zero-sized panes as measurable resize sources', () => {
    expect(terminalCanMeasureHostSizeForTests({
      clientWidth: 0,
      clientHeight: 480,
    })).toBe(false)
    expect(terminalCanMeasureHostSizeForTests({
      clientWidth: 960,
      clientHeight: 0,
    })).toBe(false)
    expect(terminalCanMeasureHostSizeForTests({
      clientWidth: 960,
      clientHeight: 480,
    })).toBe(true)
  })

  it('only records resize delivery after the websocket is open', () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    try {
      const connectingSend = vi.fn()
      expect(sendResizeForTests({
        readyState: 0,
        send: connectingSend,
      } as unknown as WebSocket, { cols: 120, rows: 40 })).toBe(false)
      expect(connectingSend).not.toHaveBeenCalled()

      const openSend = vi.fn()
      expect(sendResizeForTests({
        readyState: 1,
        send: openSend,
      } as unknown as WebSocket, { cols: 120, rows: 40 })).toBe(true)
      expect(openSend).toHaveBeenCalledWith(JSON.stringify({
        type: 'resize',
        cols: 120,
        rows: 40,
      }))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('terminal scroll follow', () => {
  it('keeps tail-follow active only near the bottom of scrollback', () => {
    expect(terminalHostIsNearBottomForTests({
      clientHeight: 300,
      scrollHeight: 900,
      scrollTop: 596,
    })).toBe(true)

    expect(terminalHostIsNearBottomForTests({
      clientHeight: 300,
      scrollHeight: 900,
      scrollTop: 500,
    })).toBe(false)
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

  it('routes wheel events to PTY input before host scrollback', () => {
    expect(terminalWheelActionForTests({
      deltaMode: 0,
      deltaY: 80,
      mouseInput: '\x1b[<65;3;5M',
    })).toEqual({ type: 'input', data: '\x1b[<65;3;5M' })
    expect(terminalWheelActionForTests({
      deltaMode: 0,
      deltaY: 80,
      mouseInput: null,
    })).toEqual({ type: 'scroll', lines: 2 })
    expect(terminalWheelActionForTests({
      deltaMode: 0,
      deltaY: 0,
      mouseInput: null,
    })).toEqual({ type: 'none' })
  })

  it('encodes wheel events for mouse-tracking terminal apps', () => {
    expect(terminalWheelMouseInputForTests({
      deltaY: -100,
      clientX: 25,
      clientY: 41,
      hostRect: { left: 10, top: 20 },
      paddingLeft: 5,
      paddingTop: 2,
      scrollTop: 0,
      cellWidth: 10,
      cols: 80,
      rows: 24,
      renderedHistoryRows: 0,
      lineHeight: 19,
      mouseBasic: true,
      mouseSgr: true,
    })).toBe('\x1b[<64;2;2M')
  })

  it('accounts for rendered scrollback rows when encoding wheel coordinates', () => {
    expect(terminalWheelMouseInputForTests({
      deltaY: 100,
      clientX: 35,
      clientY: 80,
      hostRect: { left: 10, top: 20 },
      paddingLeft: 5,
      paddingTop: 2,
      scrollTop: 95,
      cellWidth: 10,
      cols: 80,
      rows: 24,
      renderedHistoryRows: 4,
      lineHeight: 19,
      mouseBasic: true,
      mouseSgr: true,
    })).toBe('\x1b[<65;3;5M')
  })

  it('does not encode wheel input unless mouse tracking is active', () => {
    expect(terminalWheelMouseInputForTests({
      deltaY: 100,
      clientX: 35,
      clientY: 80,
      hostRect: { left: 10, top: 20 },
      paddingLeft: 5,
      paddingTop: 2,
      scrollTop: 0,
      cellWidth: 10,
      cols: 80,
      rows: 24,
      renderedHistoryRows: 0,
      lineHeight: 19,
      mouseBasic: false,
      mouseSgr: true,
    })).toBeNull()
  })
})
