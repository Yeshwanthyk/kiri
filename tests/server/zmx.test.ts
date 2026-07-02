import { describe, expect, it } from 'vitest'
import {
  isKiriZmxSession,
  parseZmxListOutput,
  resolveZmxBinary,
  zmxAttachArgv,
  type ZmxExecFile,
  zmxKillSession,
  zmxListSessions,
  zmxSend,
  zmxSessionName,
} from '~/server/zmx'

describe('zmx wrapper', () => {
  it('derives short deterministic Kiri session names', () => {
    const runtime = zmxSessionName('agent-1:runtime')
    const shell = zmxSessionName('agent-1:shell')
    const long = zmxSessionName('project with weird/chars and a very very long terminal id:shell:abc')

    expect(runtime).toMatch(/^kiri-agent-1-runt-[0-9a-f]{24}$/)
    expect(shell).not.toBe(runtime)
    expect(long.length).toBeLessThanOrEqual(42)
    expect(isKiriZmxSession(runtime)).toBe(true)
    expect(isKiriZmxSession('other')).toBe(false)
  })

  it('builds attach argv using zmx real command shape', () => {
    expect(zmxAttachArgv('kiri-agent', '/bin/sh', ['-lc', 'echo hi']))
      .toEqual(['attach', 'kiri-agent', '/bin/sh', '-lc', 'echo hi'])
  })

  it('resolves only when opt-in is enabled and a binary exists', () => {
    const exists = (path: string) => path === '/opt/bin/zmx' || path === '/bin/zmx'

    expect(resolveZmxBinary({
      env: { KIRI_ZMX: '0', KIRI_ZMX_BIN: '/opt/bin/zmx' },
      exists,
    })).toBeNull()
    expect(resolveZmxBinary({
      env: { KIRI_ZMX: '1', KIRI_ZMX_BIN: '/opt/bin/zmx' },
      exists,
    })).toBe('/opt/bin/zmx')
    expect(resolveZmxBinary({
      env: { KIRI_ZMX: '1', PATH: '/usr/bin:/bin' },
      exists,
    })).toBe('/bin/zmx')
  })

  it('parses short and detailed list output defensively', () => {
    expect(parseZmxListOutput([
      'kiri-one',
      '→ name=kiri-two\tpid=123\tclients=2\tcreated=42\tstart_dir=/repo',
      'name=other\terr=Timeout\tstatus=unreachable',
      '',
    ].join('\n'))).toEqual([
      { name: 'kiri-one', raw: 'kiri-one' },
      { name: 'kiri-two', pid: 123, clients: 2, created: 42, raw: '→ name=kiri-two\tpid=123\tclients=2\tcreated=42\tstart_dir=/repo' },
      { name: 'other', raw: 'name=other\terr=Timeout\tstatus=unreachable' },
    ])
  })

  it('runs lifecycle commands without a shell', async () => {
    const calls: Array<{ file: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = []
    const execFile: ZmxExecFile = (file, args, options) => {
      calls.push({ file, args, env: options.env })
      return Promise.resolve({
        stdout: args[0] === 'list' ? 'kiri-a\nkiri-b\n' : '',
        stderr: '',
      })
    }
    const env = { ZMX_DIR: '/tmp/zmx-test' }

    await expect(zmxListSessions({ binary: '/bin/zmx', env, execFile }))
      .resolves.toEqual(['kiri-a', 'kiri-b'])
    await zmxSend({ binary: '/bin/zmx', name: 'kiri-a', data: 'echo hi\r', env, execFile })
    await zmxKillSession({ binary: '/bin/zmx', name: 'kiri-a', force: true, env, execFile })

    expect(calls).toEqual([
      { file: '/bin/zmx', args: ['list', '--short'], env },
      { file: '/bin/zmx', args: ['send', 'kiri-a', 'echo hi\r'], env },
      { file: '/bin/zmx', args: ['kill', 'kiri-a', '--force'], env },
    ])
  })
})
