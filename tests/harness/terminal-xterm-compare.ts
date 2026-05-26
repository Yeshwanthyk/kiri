import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import xtermHeadless from '@xterm/headless'

type XtermCell = {
  readonly text: string
  readonly width: number
  readonly bold: boolean
  readonly dim: boolean
  readonly italic: boolean
  readonly underline: boolean
  readonly inverse: boolean
}

type XtermLine = {
  readonly getCell: (index: number) => {
    readonly getChars: () => string
    readonly getWidth: () => number
    readonly isBold: () => boolean
    readonly isDim: () => boolean
    readonly isItalic: () => boolean
    readonly isUnderline: () => boolean | number
    readonly isInverse: () => boolean
  }
}

type XtermTerminal = {
  readonly buffer: {
    readonly active: {
      readonly baseY: number
      readonly cursorX: number
      readonly cursorY: number
      readonly length: number
      readonly getLine: (index: number) => XtermLine
    }
  }
  readonly write: (data: string, callback: () => void) => void
}

type XtermModule = {
  readonly Terminal: new(options: {
    readonly cols: number
    readonly rows: number
    readonly scrollback: number
    readonly allowProposedApi: boolean
  }) => XtermTerminal
}

type KiriSnapshot = {
  readonly cols: number
  readonly rows: number
  readonly cursor: { readonly row: number; readonly col: number }
  readonly rowsData: readonly {
    readonly runs: readonly {
      readonly text: string
      readonly width: number
      readonly style: {
        readonly bold?: boolean
        readonly dim?: boolean
        readonly italic?: boolean
        readonly underline?: boolean
        readonly inverse?: boolean
      }
    }[]
  }[]
}

type XtermSnapshot = {
  readonly cursor: { readonly row: number; readonly col: number }
  readonly rows: readonly (readonly XtermCell[])[]
}

export type TerminalXtermDiff = {
  readonly row: number
  readonly col?: number
  readonly field: string
  readonly kiri: unknown
  readonly xterm: unknown
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { Terminal } = xtermHeadless as unknown as XtermModule

export async function compareKiriTerminalToXterm(input: {
  readonly fixturePath: string
  readonly cols: number
  readonly rows: number
}): Promise<readonly TerminalXtermDiff[]> {
  const fixturePath = resolve(repoRoot, input.fixturePath)
  const raw = readFileSync(fixturePath)
  const kiri = runKiriDump(fixturePath, input.cols, input.rows)
  const xterm = await runXterm(raw, input.cols, input.rows)
  return diffSnapshots(kiri, xterm)
}

export async function compareKiriTerminalBytesToXterm(input: {
  readonly raw: Buffer
  readonly cols: number
  readonly rows: number
}): Promise<readonly TerminalXtermDiff[]> {
  const root = mkdtempSync(join(tmpdir(), 'kiri-term-xterm-fixture-'))
  try {
    const fixturePath = join(root, 'input.ansi')
    writeFileSync(fixturePath, input.raw)
    const kiri = runKiriDump(fixturePath, input.cols, input.rows)
    const xterm = await runXterm(input.raw, input.cols, input.rows)
    return diffSnapshots(kiri, xterm)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function runKiriDump(fixturePath: string, cols: number, rows: number): KiriSnapshot {
  const root = mkdtempSync(join(tmpdir(), 'kiri-term-xterm-'))
  try {
    writeFileSync(join(root, 'Cargo.toml'), `[package]
name = "kiri-term-xterm-dump"
version = "0.1.0"
edition = "2021"

[dependencies]
kiri-term = { path = ${JSON.stringify(join(repoRoot, 'crates/kiri-term'))} }
serde_json = "1"
`)
    const src = join(root, 'src')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'main.rs'), `use std::{env, fs};
use kiri_term::TerminalDocument;

fn main() {
    let args: Vec<String> = env::args().collect();
    let bytes = fs::read(&args[1]).unwrap();
    let cols: usize = args[2].parse().unwrap();
    let rows: usize = args[3].parse().unwrap();
    let mut document = TerminalDocument::new(cols, rows);
    document.apply_bytes(&bytes);
    println!("{}", serde_json::to_string(&document.snapshot()).unwrap());
}
`)
    const output = execFileSync('cargo', ['run', '--quiet', '--', fixturePath, String(cols), String(rows)], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    })
    return JSON.parse(output.toString()) as KiriSnapshot
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function runXterm(raw: Buffer, cols: number, rows: number) {
  const term = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true })
  const text = new TextDecoder('utf-8').decode(raw)
  await new Promise<void>((resolvePromise) => term.write(text, resolvePromise))
  const start = Math.max(0, term.buffer.active.length - rows)
  return {
    cursor: { row: term.buffer.active.cursorY, col: term.buffer.active.cursorX },
    rows: Array.from({ length: rows }, (_, row) => {
      const line = term.buffer.active.getLine(start + row)
      return Array.from({ length: cols }, (_, col): XtermCell => {
        const cell = line.getCell(col)
        return {
          text: cell.getChars() || ' ',
          width: cell.getWidth(),
          bold: Boolean(cell.isBold()),
          dim: Boolean(cell.isDim()),
          italic: Boolean(cell.isItalic()),
          underline: Boolean(cell.isUnderline()),
          inverse: Boolean(cell.isInverse()),
        }
      })
    }),
  }
}

function diffSnapshots(
  kiri: KiriSnapshot,
  xterm: XtermSnapshot,
): readonly TerminalXtermDiff[] {
  const diffs: TerminalXtermDiff[] = []
  if (kiri.cursor.row !== xterm.cursor.row) {
    diffs.push({ row: -1, field: 'cursor.row', kiri: kiri.cursor.row, xterm: xterm.cursor.row })
  }
  if (kiri.cursor.col !== xterm.cursor.col) {
    diffs.push({ row: -1, field: 'cursor.col', kiri: kiri.cursor.col, xterm: xterm.cursor.col })
  }
  for (let row = 0; row < kiri.rows; row += 1) {
    const kiriCells = expandKiriRow(kiri.rowsData[row]?.runs ?? [], kiri.cols)
    const xtermCells = xterm.rows[row] ?? []
    for (let col = 0; col < kiri.cols; col += 1) {
      const left = kiriCells[col]
      const right = xtermCells[col]
      if (!left || !right) continue
      for (const field of ['text', 'width', 'bold', 'dim', 'italic', 'underline', 'inverse'] as const) {
        if (left[field] !== right[field]) {
          diffs.push({ row, col, field, kiri: left[field], xterm: right[field] })
        }
      }
    }
  }
  return diffs
}

function expandKiriRow(runs: KiriSnapshot['rowsData'][number]['runs'], cols: number): readonly XtermCell[] {
  const cells: XtermCell[] = []
  for (const run of runs) {
    const chars = Array.from(run.text)
    const width = Math.max(run.width, chars.length)
    for (let index = 0; index < width; index += 1) {
      cells.push({
        text: chars[index] ?? ' ',
        width: 1,
        bold: Boolean(run.style.bold),
        dim: Boolean(run.style.dim),
        italic: Boolean(run.style.italic),
        underline: Boolean(run.style.underline),
        inverse: Boolean(run.style.inverse),
      })
    }
  }
  while (cells.length < cols) {
    cells.push({
      text: ' ',
      width: 1,
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      inverse: false,
    })
  }
  return cells.slice(0, cols)
}
