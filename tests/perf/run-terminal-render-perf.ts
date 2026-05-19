import { performance } from 'node:perf_hooks'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import {
  applyTerminalFrameForTests,
  TerminalRowsForTests,
  terminalRenderedRowsForTests,
} from '../../src/components/kiri-board/terminal-panel'

const rows = 30
const cols = 120
const patches = 2_000
const budgets = {
  maxRenderMs: 1_000,
  maxFinalRows: rows,
  maxHeapUsedDeltaMb: 128,
}
let snapshot: Parameters<typeof applyTerminalFrameForTests>[0] = {
  cols,
  rows,
  screenSeq: 0,
  historySeq: 0,
  bufferKind: 'main' as const,
  cursor: { row: 0, col: 0, visible: true },
  modes: { bracketedPaste: false, cursorVisible: true },
  viewport: { historyOffset: 0, visibleRows: rows },
  historyRows: [],
  rowsData: Array.from({ length: rows }, (_, row) => ({
    row,
    fingerprint: 0,
    runs: [],
  })),
}

const beforeMemory = process.memoryUsage()
const startedAt = performance.now()
let renderedRows = 0
let renderedRunSpans = 0
let htmlBytes = 0

for (let seq = 1; seq <= patches; seq += 1) {
  const row = seq % rows
  snapshot = applyTerminalFrameForTests(snapshot, {
    type: 'patch',
    terminalId: 'perf',
    patch: {
      cols,
      rows,
      screenSeq: seq,
      historySeq: 0,
      historyDelta: null,
      ops: [{
        op: 'replaceRow',
        row: {
          row,
          fingerprint: seq,
          runs: [{
            text: `${seq.toString().padStart(4, '0')} ${'x'.repeat(cols - 5)}`,
            width: cols,
            style: seq % 2 === 0 ? { foreground: { kind: 'palette', index: 10 } } : {},
          }],
        },
      }],
    },
  })
  const html = renderToString(createElement(TerminalRowsForTests, { snapshot }))
  renderedRows += count(html, 'class="terminal-row"')
  renderedRunSpans += count(html, 'class="terminal-run"')
  htmlBytes += Buffer.byteLength(html)
}

const renderMs = performance.now() - startedAt
const afterMemory = process.memoryUsage()

const output = {
  ok: true,
  patches,
  renderMs: round(renderMs),
  avgRenderMsPerPatch: round(renderMs / patches),
  renderedRows,
  renderedRunSpans,
  htmlBytes,
  finalRows: terminalRenderedRowsForTests(snapshot).length,
  finalScreenSeq: snapshot.screenSeq,
  heapUsedDeltaMb: round((afterMemory.heapUsed - beforeMemory.heapUsed) / 1024 / 1024),
  rssDeltaMb: round((afterMemory.rss - beforeMemory.rss) / 1024 / 1024),
  budgets,
}

assertBudget(output.renderMs <= budgets.maxRenderMs, 'terminal React render', output)
assertBudget(output.finalRows <= budgets.maxFinalRows, 'terminal final rows', output)
assertBudget(output.heapUsedDeltaMb <= budgets.maxHeapUsedDeltaMb, 'terminal heap used delta', output)

console.log(JSON.stringify(output))

function count(value: string, needle: string) {
  return value.split(needle).length - 1
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function assertBudget(condition: boolean, label: string, output: unknown) {
  if (!condition) {
    throw new Error(`Perf budget exceeded: ${label}\n${JSON.stringify(output, null, 2)}`)
  }
}
