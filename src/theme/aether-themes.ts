export const aetherThemeNames = [
  'aether',
  'vesper',
  'github',
  'tokyonight',
  'catppuccin',
  'gruvbox',
  'rosepine',
] as const

export type AetherThemeName = (typeof aetherThemeNames)[number]
export type ThemeMode = 'dark' | 'light'

export type ThemeSelection = {
  name: AetherThemeName
  mode: ThemeMode
}

type ThemeTokens = {
  paper: string
  panel: string
  panel2: string
  ink: string
  muted: string
  line: string
  lineSubtle: string
  accent: string
  accent2: string
  warn: string
  danger: string
  success: string
}

type AetherTheme = Record<ThemeMode, ThemeTokens>

export const defaultThemeSelection: ThemeSelection = { name: 'aether', mode: 'light' }

function isAetherThemeName(value: string): value is AetherThemeName {
  return (aetherThemeNames as readonly string[]).includes(value)
}

export function normalizeThemeSelection(value: unknown): ThemeSelection {
  if (!value || typeof value !== 'object') return defaultThemeSelection
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' && isAetherThemeName(record.name)
    ? record.name
    : defaultThemeSelection.name
  const mode = record.mode === 'dark' || record.mode === 'light'
    ? record.mode
    : defaultThemeSelection.mode
  return { name, mode }
}

function resolveAetherTheme(selection: ThemeSelection): Record<`--${string}`, string> {
  const theme = aetherThemes[selection.name][selection.mode]
  const vars: Record<`--${string}`, string> = {
    '--paper': theme.paper,
    '--panel': theme.panel,
    '--panel-2': theme.panel2,
    '--ink': theme.ink,
    '--muted': theme.muted,
    '--line': theme.line,
    '--line-subtle': theme.lineSubtle,
    '--accent': theme.accent,
    '--accent-2': theme.accent2,
    '--warn': theme.warn,
    '--danger': theme.danger,
    '--success': theme.success,
    '--selection': mix(theme.accent, 16, theme.panel),
    '--selection-ink': theme.ink,
    '--overlay': selection.mode === 'dark'
      ? 'oklch(0 0 0 / 0.44)'
      : 'oklch(0.25 0.018 255 / 0.18)',
    '--panel-translucent': mix(theme.panel, 94, 'transparent'),
    '--accent-soft': mix(theme.accent, selection.mode === 'dark' ? 16 : 13, theme.panel),
    '--accent-muted': mix(theme.accent, 36, theme.muted),
    '--danger-soft': mix(theme.danger, selection.mode === 'dark' ? 16 : 12, theme.panel),
    '--warn-soft': mix(theme.warn, selection.mode === 'dark' ? 17 : 13, theme.panel),
    '--code-bg': mix(theme.panel2, selection.mode === 'dark' ? 76 : 70, theme.paper),
    '--context-fill': mix(theme.accent2, 58, theme.accent),
    '--context-track': mix(theme.line, selection.mode === 'dark' ? 70 : 58, theme.panel),
    '--context-core': mix(theme.panel, selection.mode === 'dark' ? 82 : 88, theme.paper),
    '--context-ink': theme.ink,
    '--shadow': selection.mode === 'dark'
      ? `0 22px 60px ${mix(theme.paper, 45, 'black')}`
      : `0 22px 60px ${mix(theme.ink, 18, 'transparent')}`,
  }
  return vars
}

export type AetherThemeTokens = ThemeTokens

export function getAetherThemeTokens(selection: ThemeSelection): AetherThemeTokens {
  return aetherThemes[selection.name][selection.mode]
}

export function applyAetherTheme(element: HTMLElement, selection: ThemeSelection): void {
  const vars = resolveAetherTheme(selection)
  element.dataset.theme = selection.name
  element.dataset.themeMode = selection.mode
  element.style.colorScheme = selection.mode
  for (const [name, value] of Object.entries(vars)) {
    element.style.setProperty(name, value)
  }
}

function mix(color: string, percent: number, target: string): string {
  return `color-mix(in oklab, ${color} ${percent}%, ${target})`
}

const aetherThemes: Record<AetherThemeName, AetherTheme> = {
  aether: {
    light: {
      paper: 'oklch(0.965 0.008 84)',
      panel: 'oklch(0.988 0.006 84)',
      panel2: 'oklch(0.935 0.011 92)',
      ink: 'oklch(0.205 0.018 255)',
      muted: 'oklch(0.49 0.021 248)',
      line: 'oklch(0.855 0.012 88)',
      lineSubtle: 'oklch(0.9 0.009 88)',
      accent: 'oklch(0.53 0.13 166)',
      accent2: 'oklch(0.52 0.12 27)',
      warn: 'oklch(0.66 0.14 72)',
      danger: 'oklch(0.58 0.16 25)',
      success: 'oklch(0.53 0.13 166)',
    },
    dark: {
      paper: 'oklch(0.145 0.012 255)',
      panel: 'oklch(0.18 0.014 255)',
      panel2: 'oklch(0.235 0.016 255)',
      ink: 'oklch(0.91 0.01 84)',
      muted: 'oklch(0.64 0.016 248)',
      line: 'oklch(0.31 0.018 255)',
      lineSubtle: 'oklch(0.25 0.016 255)',
      accent: 'oklch(0.74 0.105 166)',
      accent2: 'oklch(0.72 0.13 55)',
      warn: 'oklch(0.78 0.13 72)',
      danger: 'oklch(0.68 0.17 25)',
      success: 'oklch(0.74 0.105 166)',
    },
  },
  vesper: {
    light: {
      paper: '#fbfaf7',
      panel: '#ffffff',
      panel2: '#efede8',
      ink: '#141414',
      muted: '#68635b',
      line: '#d9d4ca',
      lineSubtle: '#e9e5dc',
      accent: '#b8662f',
      accent2: '#137d6d',
      warn: '#9a651f',
      danger: '#b94b4b',
      success: '#137d6d',
    },
    dark: {
      paper: '#101010',
      panel: '#171717',
      panel2: '#24211e',
      ink: '#fff8ef',
      muted: '#a7a09a',
      line: '#34302b',
      lineSubtle: '#26231f',
      accent: '#ffc799',
      accent2: '#99ffe4',
      warn: '#ffc799',
      danger: '#ff8080',
      success: '#99ffe4',
    },
  },
  github: {
    light: {
      paper: '#ffffff',
      panel: '#f6f8fa',
      panel2: '#eaeef2',
      ink: '#24292f',
      muted: '#57606a',
      line: '#d0d7de',
      lineSubtle: '#e6e9ef',
      accent: '#0969da',
      accent2: '#8250df',
      warn: '#9a6700',
      danger: '#cf222e',
      success: '#1a7f37',
    },
    dark: {
      paper: '#0d1117',
      panel: '#161b22',
      panel2: '#21262d',
      ink: '#c9d1d9',
      muted: '#8b949e',
      line: '#30363d',
      lineSubtle: '#21262d',
      accent: '#58a6ff',
      accent2: '#bc8cff',
      warn: '#d29922',
      danger: '#f85149',
      success: '#3fb950',
    },
  },
  tokyonight: {
    light: {
      paper: '#e1e2e7',
      panel: '#f2f3f7',
      panel2: '#d5d6db',
      ink: '#2f385c',
      muted: '#5a607d',
      line: '#b9bac1',
      lineSubtle: '#c8c9ce',
      accent: '#2e7de9',
      accent2: '#9854f1',
      warn: '#b15c00',
      danger: '#f52a65',
      success: '#587539',
    },
    dark: {
      paper: '#1a1b26',
      panel: '#1e2030',
      panel2: '#292e42',
      ink: '#c8d3f5',
      muted: '#828bb8',
      line: '#3b4261',
      lineSubtle: '#2f344d',
      accent: '#82aaff',
      accent2: '#c099ff',
      warn: '#ffc777',
      danger: '#ff757f',
      success: '#c3e88d',
    },
  },
  catppuccin: {
    light: {
      paper: '#eff1f5',
      panel: '#f7f8fb',
      panel2: '#e6e9ef',
      ink: '#4c4f69',
      muted: '#6c6f85',
      line: '#ccd0da',
      lineSubtle: '#dce0e8',
      accent: '#1e66f5',
      accent2: '#8839ef',
      warn: '#df8e1d',
      danger: '#d20f39',
      success: '#40a02b',
    },
    dark: {
      paper: '#1e1e2e',
      panel: '#252538',
      panel2: '#313244',
      ink: '#cdd6f4',
      muted: '#a6adc8',
      line: '#45475a',
      lineSubtle: '#383a4d',
      accent: '#89b4fa',
      accent2: '#cba6f7',
      warn: '#f9e2af',
      danger: '#f38ba8',
      success: '#a6e3a1',
    },
  },
  gruvbox: {
    light: {
      paper: '#fbf1c7',
      panel: '#f9f5d7',
      panel2: '#ebdbb2',
      ink: '#3c3836',
      muted: '#7c6f64',
      line: '#d5c4a1',
      lineSubtle: '#e6d9b8',
      accent: '#458588',
      accent2: '#b57614',
      warn: '#d79921',
      danger: '#cc241d',
      success: '#98971a',
    },
    dark: {
      paper: '#282828',
      panel: '#32302f',
      panel2: '#3c3836',
      ink: '#ebdbb2',
      muted: '#a89984',
      line: '#504945',
      lineSubtle: '#3c3836',
      accent: '#83a598',
      accent2: '#fabd2f',
      warn: '#fabd2f',
      danger: '#fb4934',
      success: '#b8bb26',
    },
  },
  rosepine: {
    light: {
      paper: '#faf4ed',
      panel: '#fffaf3',
      panel2: '#f2e9e1',
      ink: '#575279',
      muted: '#797593',
      line: '#dfdad9',
      lineSubtle: '#e8e3e1',
      accent: '#56949f',
      accent2: '#907aa9',
      warn: '#ea9d34',
      danger: '#b4637a',
      success: '#56949f',
    },
    dark: {
      paper: '#191724',
      panel: '#1f1d2e',
      panel2: '#26233a',
      ink: '#e0def4',
      muted: '#908caa',
      line: '#403d52',
      lineSubtle: '#312f44',
      accent: '#9ccfd8',
      accent2: '#c4a7e7',
      warn: '#f6c177',
      danger: '#eb6f92',
      success: '#9ccfd8',
    },
  },
}
