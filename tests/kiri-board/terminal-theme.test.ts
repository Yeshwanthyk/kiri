import { describe, expect, it } from 'vitest'
import {
  buildTerminalTheme,
  makeCanvasColorResolver,
  type TerminalThemeContext,
} from '~/components/kiri-board/terminal-theme'

function context(overrides: Partial<TerminalThemeContext>): TerminalThemeContext {
  return {
    themeName: 'kiri',
    mode: 'dark',
    readVariable: () => '',
    resolveColor: () => null,
    ...overrides,
  }
}

describe('buildTerminalTheme', () => {
  it('falls back to the built-in surfaces when CSS variables are unavailable', () => {
    const theme = buildTerminalTheme(context({}))
    expect(theme.background).toBe('#101216')
    expect(theme.foreground).toBe('#e6e8ef')
    expect(theme.cursor).toBe('#f5c15c')
    expect(theme.cursorAccent).toBe('#101216')
    expect(theme.selectionBackground).toBe('#334155')
  })

  it('uses resolved CSS variable colors for surfaces', () => {
    const variables: Record<string, string> = {
      '--paper': 'oklch(0.145 0.012 255)',
      '--ink': 'oklch(0.91 0.01 84)',
      '--accent': 'oklch(0.74 0.105 166)',
      '--selection': 'color-mix(in oklab, red 16%, blue)',
    }
    const resolved: Record<string, string> = {
      'oklch(0.145 0.012 255)': '#15171c',
      'oklch(0.91 0.01 84)': '#e5e3da',
      'oklch(0.74 0.105 166)': '#4fbf9a',
      'color-mix(in oklab, red 16%, blue)': '#3c1ad1',
    }
    const theme = buildTerminalTheme(context({
      readVariable: (name) => variables[name] ?? '',
      resolveColor: (value) => resolved[value] ?? null,
    }))
    expect(theme.background).toBe('#15171c')
    expect(theme.foreground).toBe('#e5e3da')
    expect(theme.cursor).toBe('#4fbf9a')
    expect(theme.cursorAccent).toBe('#15171c')
    expect(theme.selectionBackground).toBe('#3c1ad1')
  })

  it('keeps the fallback surface when a variable resolves to an invalid color', () => {
    const theme = buildTerminalTheme(context({
      readVariable: () => 'not-a-color',
      resolveColor: () => null,
    }))
    expect(theme.background).toBe('#101216')
  })

  it('selects the ANSI palette by theme name and mode', () => {
    const githubDark = buildTerminalTheme(context({ themeName: 'github' }))
    expect(githubDark.red).toBe('#ff7b72')
    expect(githubDark.brightWhite).toBe('#ffffff')

    const githubLight = buildTerminalTheme(context({ themeName: 'github', mode: 'light' }))
    expect(githubLight.red).toBe('#cf222e')
    expect(githubLight.blue).toBe('#0969da')

    const gruvboxDark = buildTerminalTheme(context({ themeName: 'gruvbox' }))
    expect(gruvboxDark.yellow).toBe('#d79921')
  })

  it('falls back to the kiri palette for unknown theme names', () => {
    const theme = buildTerminalTheme(context({ themeName: 'mystery-theme' }))
    expect(theme.red).toBe('#ef4444')
    expect(theme.cyan).toBe('#2dd4bf')
  })

  it('uses light fallback surfaces in light mode', () => {
    const theme = buildTerminalTheme(context({ mode: 'light' }))
    expect(theme.background).toBe('#ffffff')
    expect(theme.foreground).toBe('#24292f')
  })
})

describe('makeCanvasColorResolver', () => {
  it('returns null when the 2d context is unavailable', () => {
    const resolver = makeCanvasColorResolver(() => ({
      width: 0,
      height: 0,
      getContext: () => null,
    }))
    expect(resolver('#ff0000')).toBeNull()
  })

  it('returns null for empty values without touching the canvas', () => {
    let created = 0
    const resolver = makeCanvasColorResolver(() => {
      created += 1
      return document.createElement('canvas')
    })
    expect(resolver('   ')).toBeNull()
    expect(created).toBe(0)
  })

  it('normalizes colors through a painted pixel', () => {
    const data = new Uint8ClampedArray([21, 23, 28, 255])
    let fillStyle = ''
    const fakeContext = {
      get fillStyle() {
        return fillStyle
      },
      set fillStyle(value: string) {
        // Mimic canvas behavior: invalid colors keep the previous value.
        if (value === 'not-a-color') return
        fillStyle = value
      },
      clearRect: () => undefined,
      fillRect: () => undefined,
      getImageData: () => ({ data }),
    }
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => fakeContext,
    }
    const resolver = makeCanvasColorResolver(() => canvas)
    expect(resolver('oklch(0.145 0.012 255)')).toBe('#15171c')
    expect(resolver('not-a-color')).toBeNull()
  })
})
