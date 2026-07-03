import { describe, expect, it } from 'vitest'
import { resolveDaemonLaunch } from '../../src/server/kiriterm-daemon-client'

describe('kiriterm daemon resolver', () => {
  it('uses the rust sidecar by default', () => {
    const launch = withEnv({}, () => resolveDaemonLaunch())

    expect(launch.args).toEqual([])
    expect(launch.env).toEqual({})
    expect(launch.command).toContain('kiri-termd')
  })

  it('lets an explicit daemon binary override the default sidecar', () => {
    const launch = withEnv({ KIRI_TERM_DAEMON_BIN: '/tmp/custom-kiriterm' }, () =>
      resolveDaemonLaunch(),
    )

    expect(launch).toEqual({
      command: '/tmp/custom-kiriterm',
      args: ['term', 'daemon'],
      env: {},
    })
  })
})

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>()
  for (const key of ['KIRI_TERM_DAEMON_BIN']) {
    previous.set(key, process.env[key])
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
