import { describe, expect, it } from 'vitest'
import { resolveDaemonLaunch } from '../../src/server/kiriterm-daemon-client'

describe('kiriterm daemon selector', () => {
  it('keeps the node daemon path by default', () => {
    const previous = process.env.KIRI_TERM_CORE
    delete process.env.KIRI_TERM_CORE
    try {
      const launch = resolveDaemonLaunch()
      expect(launch.command).not.toContain('kiri-termd')
      expect(launch.args.join(' ')).toContain('term daemon')
    } finally {
      if (previous === undefined) delete process.env.KIRI_TERM_CORE
      else process.env.KIRI_TERM_CORE = previous
    }
  })

  it('uses the rust sidecar when requested', () => {
    const previous = process.env.KIRI_TERM_CORE
    process.env.KIRI_TERM_CORE = 'rust'
    try {
      const launch = resolveDaemonLaunch()
      expect(launch.args).toEqual([])
      expect(launch.command).toContain('kiri-termd')
    } finally {
      if (previous === undefined) delete process.env.KIRI_TERM_CORE
      else process.env.KIRI_TERM_CORE = previous
    }
  })
})
