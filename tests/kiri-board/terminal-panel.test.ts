import { describe, expect, it } from 'vitest'
import {
  terminalWebSocketUrl,
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

describe('terminal websocket url', () => {
  it('uses same-origin proxy path when the server provides one', () => {
    withLocation('https://pro.tail6bc56d.ts.net/session', () => {
      expect(terminalWebSocketUrl({
        host: '127.0.0.1',
        port: 49152,
        path: '/terminal',
        proxyPath: '/terminal',
        token: 'secret',
        mode: 'runtime',
        runtime: 'codex',
        model: 'gpt-5.5',
      }, 'agent-1', 80, 24, 'main')).toBe(
        'wss://pro.tail6bc56d.ts.net/terminal?kiri_terminal_port=49152&agentId=agent-1&mode=runtime&cols=80&rows=24&token=secret',
      )
    })
  })

  it('falls back to direct terminal port without a proxy path', () => {
    withLocation('https://pro.tail6bc56d.ts.net/session', () => {
      expect(terminalWebSocketUrl({
        host: '127.0.0.1',
        port: 49152,
        path: '/terminal',
        token: 'secret',
        mode: 'shell',
        runtime: 'codex',
        model: 'gpt-5.5',
      }, 'agent-1', 80, 24, 'main')).toBe(
        'wss://pro.tail6bc56d.ts.net:49152/terminal?agentId=agent-1&mode=shell&cols=80&rows=24&token=secret',
      )
    })
  })
})

function withLocation(url: string, run: () => void) {
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: new URL(url) },
  })
  try {
    run()
  } finally {
    if (previousWindow === undefined) {
      delete (globalThis as { window?: Window }).window
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
      })
    }
  }
}
