import { describe, expect, it } from 'vitest'
import {
  terminalShouldCustomScrollWheel,
  terminalTypographyOptions,
  terminalWheelScrollLines,
} from '~/components/kiri-board/terminal-panel'

describe('terminal typography', () => {
  it('maps chat typography settings to xterm font options', () => {
    expect(terminalTypographyOptions({ fontSize: 'xlarge', monoFont: 'berkeley' })).toEqual({
      fontSize: 18,
      fontFamily: '"BerkeleyMono Nerd Font", ui-monospace, SFMono-Regular, Menlo, monospace',
    })
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
