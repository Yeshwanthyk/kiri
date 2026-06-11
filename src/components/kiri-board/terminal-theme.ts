import type { ITheme } from '@xterm/xterm'
import type { KiriThemeName, ThemeMode } from '~/theme/kiri-themes'

export type TerminalColorResolver = (value: string) => string | null

export type TerminalThemeContext = {
  readonly themeName: string
  readonly mode: ThemeMode
  readonly readVariable: (name: string) => string
  readonly resolveColor: TerminalColorResolver
}

type AnsiPalette = {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

type SurfaceFallbacks = {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

const surfaceFallbacks: Record<ThemeMode, SurfaceFallbacks> = {
  dark: {
    background: '#101216',
    foreground: '#e6e8ef',
    cursor: '#f5c15c',
    selectionBackground: '#334155',
  },
  light: {
    background: '#ffffff',
    foreground: '#24292f',
    cursor: '#b8662f',
    selectionBackground: '#c2d5f0',
  },
}

// ANSI 16 palettes per kiri theme. Where an upstream theme publishes an official
// terminal palette (tokyonight moon/day, catppuccin mocha/latte, gruvbox, rose
// pine main/dawn, github primer, vesper) those values are used verbatim; kiri and
// vesper-light are curated to match their UI tokens.
const ansiPalettes: Record<KiriThemeName, Record<ThemeMode, AnsiPalette>> = {
  kiri: {
    dark: {
      black: '#101216',
      red: '#ef4444',
      green: '#22c55e',
      yellow: '#f5c15c',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#2dd4bf',
      white: '#e6e8ef',
      brightBlack: '#64748b',
      brightRed: '#f87171',
      brightGreen: '#4ade80',
      brightYellow: '#facc15',
      brightBlue: '#93c5fd',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#f8fafc',
    },
    light: {
      black: '#1e293b',
      red: '#dc2626',
      green: '#15803d',
      yellow: '#a16207',
      blue: '#2563eb',
      magenta: '#7c3aed',
      cyan: '#0f766e',
      white: '#cbd5e1',
      brightBlack: '#64748b',
      brightRed: '#ef4444',
      brightGreen: '#16a34a',
      brightYellow: '#ca8a04',
      brightBlue: '#3b82f6',
      brightMagenta: '#9333ea',
      brightCyan: '#0d9488',
      brightWhite: '#f1f5f9',
    },
  },
  vesper: {
    dark: {
      black: '#101010',
      red: '#f5a191',
      green: '#90b99f',
      yellow: '#e6b99d',
      blue: '#aca1cf',
      magenta: '#e29eca',
      cyan: '#ea83a5',
      white: '#a0a0a0',
      brightBlack: '#7e7e7e',
      brightRed: '#ff8080',
      brightGreen: '#99ffe4',
      brightYellow: '#ffc799',
      brightBlue: '#b9aeda',
      brightMagenta: '#ecaad6',
      brightCyan: '#f591b2',
      brightWhite: '#ffffff',
    },
    light: {
      black: '#141414',
      red: '#b94b4b',
      green: '#137d6d',
      yellow: '#9a651f',
      blue: '#6e5f96',
      magenta: '#a3568f',
      cyan: '#b04a6b',
      white: '#d9d4ca',
      brightBlack: '#68635b',
      brightRed: '#d05c5c',
      brightGreen: '#18937f',
      brightYellow: '#b8762a',
      brightBlue: '#837299',
      brightMagenta: '#b969a3',
      brightCyan: '#c25f7e',
      brightWhite: '#fbfaf7',
    },
  },
  github: {
    dark: {
      black: '#484f58',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightBlack: '#6e7681',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#ffffff',
    },
    light: {
      black: '#24292f',
      red: '#cf222e',
      green: '#116329',
      yellow: '#4d2d00',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#6e7781',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#1a7f37',
      brightYellow: '#633c01',
      brightBlue: '#218bff',
      brightMagenta: '#a475f9',
      brightCyan: '#3192aa',
      brightWhite: '#8c959f',
    },
  },
  tokyonight: {
    dark: {
      black: '#1b1d2b',
      red: '#ff757f',
      green: '#c3e88d',
      yellow: '#ffc777',
      blue: '#82aaff',
      magenta: '#c099ff',
      cyan: '#86e1fc',
      white: '#828bb8',
      brightBlack: '#444a73',
      brightRed: '#ff8d94',
      brightGreen: '#c7fb6d',
      brightYellow: '#ffd8ab',
      brightBlue: '#9ab8ff',
      brightMagenta: '#caabff',
      brightCyan: '#b2ebff',
      brightWhite: '#c8d3f5',
    },
    light: {
      black: '#e9e9ed',
      red: '#f52a65',
      green: '#587539',
      yellow: '#8c6c3e',
      blue: '#2e7de9',
      magenta: '#9854f1',
      cyan: '#007197',
      white: '#6172b0',
      brightBlack: '#a1a6c5',
      brightRed: '#ff4774',
      brightGreen: '#5c8524',
      brightYellow: '#a27629',
      brightBlue: '#358aff',
      brightMagenta: '#a463ff',
      brightCyan: '#007ea8',
      brightWhite: '#3760bf',
    },
  },
  catppuccin: {
    dark: {
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
    },
    light: {
      black: '#5c5f77',
      red: '#d20f39',
      green: '#40a02b',
      yellow: '#df8e1d',
      blue: '#1e66f5',
      magenta: '#ea76cb',
      cyan: '#179299',
      white: '#acb0be',
      brightBlack: '#6c6f85',
      brightRed: '#de293e',
      brightGreen: '#49af3d',
      brightYellow: '#eea02d',
      brightBlue: '#456eff',
      brightMagenta: '#fe85d8',
      brightCyan: '#2d9fa8',
      brightWhite: '#bcc0cc',
    },
  },
  gruvbox: {
    dark: {
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2',
    },
    light: {
      black: '#fbf1c7',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#7c6f64',
      brightBlack: '#928374',
      brightRed: '#9d0006',
      brightGreen: '#79740e',
      brightYellow: '#b57614',
      brightBlue: '#076678',
      brightMagenta: '#8f3f71',
      brightCyan: '#427b58',
      brightWhite: '#3c3836',
    },
  },
  rosepine: {
    dark: {
      black: '#26233a',
      red: '#eb6f92',
      green: '#31748f',
      yellow: '#f6c177',
      blue: '#9ccfd8',
      magenta: '#c4a7e7',
      cyan: '#ebbcba',
      white: '#e0def4',
      brightBlack: '#6e6a86',
      brightRed: '#eb6f92',
      brightGreen: '#31748f',
      brightYellow: '#f6c177',
      brightBlue: '#9ccfd8',
      brightMagenta: '#c4a7e7',
      brightCyan: '#ebbcba',
      brightWhite: '#e0def4',
    },
    light: {
      black: '#f2e9e1',
      red: '#b4637a',
      green: '#286983',
      yellow: '#ea9d34',
      blue: '#56949f',
      magenta: '#907aa9',
      cyan: '#d7827e',
      white: '#575279',
      brightBlack: '#9893a5',
      brightRed: '#b4637a',
      brightGreen: '#286983',
      brightYellow: '#ea9d34',
      brightBlue: '#56949f',
      brightMagenta: '#907aa9',
      brightCyan: '#d7827e',
      brightWhite: '#575279',
    },
  },
}

function isKiriThemeName(value: string): value is KiriThemeName {
  return Object.prototype.hasOwnProperty.call(ansiPalettes, value)
}

export function buildTerminalTheme(context: TerminalThemeContext): ITheme {
  const palette = isKiriThemeName(context.themeName)
    ? ansiPalettes[context.themeName][context.mode]
    : ansiPalettes.kiri[context.mode]
  const fallback = surfaceFallbacks[context.mode]
  const surface = (variable: string, fallbackColor: string) => {
    const raw = context.readVariable(variable).trim()
    if (!raw) return fallbackColor
    return context.resolveColor(raw) ?? fallbackColor
  }
  const background = surface('--paper', fallback.background)
  return {
    background,
    foreground: surface('--ink', fallback.foreground),
    cursor: surface('--accent', fallback.cursor),
    cursorAccent: background,
    selectionBackground: surface('--selection', fallback.selectionBackground),
    ...palette,
  }
}

type TerminalCanvasContext = {
  fillStyle: string | CanvasGradient | CanvasPattern
  clearRect: (x: number, y: number, width: number, height: number) => void
  fillRect: (x: number, y: number, width: number, height: number) => void
  getImageData: (x: number, y: number, width: number, height: number) => { data: ArrayLike<number> }
}

export type TerminalCanvas = {
  width: number
  height: number
  getContext: (
    contextId: '2d',
    options?: CanvasRenderingContext2DSettings,
  ) => TerminalCanvasContext | null
}

// Normalizes any CSS color (oklch, color-mix, ...) to a hex/rgba string xterm can
// parse, by painting one pixel and reading it back. Returns null when the canvas
// 2D context is unavailable (jsdom) or the value is not a valid color.
export function makeCanvasColorResolver(
  createCanvas: () => TerminalCanvas = () => document.createElement('canvas'),
): TerminalColorResolver {
  let context: TerminalCanvasContext | null | undefined
  return (value) => {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (context === undefined) {
      const canvas = createCanvas()
      canvas.width = 1
      canvas.height = 1
      context = canvas.getContext('2d', { willReadFrequently: true })
    }
    if (!context) return null
    context.fillStyle = '#000000'
    context.fillStyle = trimmed
    const parsedAgainstBlack = context.fillStyle
    context.fillStyle = '#ffffff'
    context.fillStyle = trimmed
    if (parsedAgainstBlack !== context.fillStyle) return null
    context.clearRect(0, 0, 1, 1)
    context.fillRect(0, 0, 1, 1)
    const data = context.getImageData(0, 0, 1, 1).data
    const red = data[0] ?? 0
    const green = data[1] ?? 0
    const blue = data[2] ?? 0
    const alpha = data[3] ?? 0
    if (alpha === 0) return null
    if (alpha >= 255) return hexColor(red, green, blue)
    return `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})`
  }
}

const sharedResolver = makeCanvasColorResolver()

export function terminalThemeForHost(host: HTMLElement, fallbackMode: ThemeMode): ITheme {
  const root = host.ownerDocument.documentElement
  const datasetMode = root.dataset.themeMode
  return buildTerminalTheme({
    themeName: root.dataset.theme ?? 'kiri',
    mode: datasetMode === 'dark' || datasetMode === 'light' ? datasetMode : fallbackMode,
    readVariable: (name) => getComputedStyle(host).getPropertyValue(name),
    resolveColor: sharedResolver,
  })
}

function hexColor(red: number, green: number, blue: number) {
  return `#${hexByte(red)}${hexByte(green)}${hexByte(blue)}`
}

function hexByte(value: number) {
  return value.toString(16).padStart(2, '0')
}
