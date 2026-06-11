// Named key → byte-sequence encoding shared by the terminal control plane
// (MCP terminal.keys, kirictl) and the test harness. Names are matched
// case-insensitively. Ctrl chords use the form "c-x" (or "ctrl-x").

const namedKeys: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  escape: '\x1b',
  esc: '\x1b',
  backspace: '\x7f',
  space: ' ',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  insert: '\x1b[2~',
  delete: '\x1b[3~',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
}

export function encodeTerminalKey(name: string): string | null {
  const normalized = name.trim().toLowerCase()
  if (!normalized) return null
  const named = namedKeys[normalized]
  if (named !== undefined) return named
  const chord = /^(?:c|ctrl)-([a-z[\\\]^_])$/.exec(normalized)
  if (chord) {
    const char = chord[1]
    if (char === undefined) return null
    // Ctrl maps to the character's code point with the high bits stripped:
    // c-a → 0x01 ... c-z → 0x1a, c-[ → ESC, c-\ → FS, c-] → GS, c-^ → RS, c-_ → US.
    return String.fromCharCode(char.charCodeAt(0) % 32)
  }
  return null
}

export function encodeTerminalKeys(names: readonly string[]): string {
  return names.map((name) => {
    const encoded = encodeTerminalKey(name)
    if (encoded === null) {
      throw new Error(`Unknown terminal key: ${JSON.stringify(name)}`)
    }
    return encoded
  }).join('')
}

export function knownTerminalKeys(): string[] {
  return [...Object.keys(namedKeys), 'c-a..c-z', 'c-[', 'c-\\', 'c-]', 'c-^', 'c-_']
}
