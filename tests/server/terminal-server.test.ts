import { createServer, type Server } from 'node:http'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeTerminalServerForTests,
  ensureTerminalServer,
  makeTerminalServerService,
  TerminalServerService,
} from '~/server/terminal-server'

describe('terminal server', () => {
  afterEach(async () => {
    await closeTerminalServerForTests()
    vi.unstubAllEnvs()
  })

  it('clears failed startup state so listen failures can be retried', async () => {
    const blocker = createServer()
    const port = await listen(blocker)
    vi.stubEnv('KIRI_TERMINAL_HOST', '127.0.0.1')
    vi.stubEnv('KIRI_TERMINAL_PORT', String(port))

    try {
      await expect(ensureTerminalServer()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    } finally {
      await close(blocker)
    }

    await expect(ensureTerminalServer()).resolves.toMatchObject({
      host: '127.0.0.1',
      port,
      path: '/terminal',
    })
  })

  it('keeps independent server service instances scoped to their own state', async () => {
    const first = makeTerminalServerService()
    const second = makeTerminalServerService()

    try {
      const [firstInfo, secondInfo] = await Promise.all([
        first.ensure(),
        second.ensure(),
      ])

      expect(firstInfo).toMatchObject({ host: '127.0.0.1', path: '/terminal' })
      expect(secondInfo).toMatchObject({ host: '127.0.0.1', path: '/terminal' })
      expect(firstInfo.token).not.toBe(secondInfo.token)
      expect(firstInfo.port).not.toBe(secondInfo.port)
    } finally {
      await first.close()
      await second.close()
    }
  })

  it('provides a scoped Effect service layer and closes resources after scope exit', async () => {
    const info = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const service = yield* TerminalServerService
        return yield* Effect.promise(() => service.ensure())
      }).pipe(Effect.provide(TerminalServerService.layer)),
    ))

    expect(info).toMatchObject({
      host: '127.0.0.1',
      path: '/terminal',
    })

    const probe = createServer()
    try {
      await listen(probe, info.port)
    } finally {
      await close(probe)
    }
  })
})

function listen(server: Server, port = 0) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP address'))
        return
      }
      resolve(address.port)
    })
  })
}

function close(server: Server) {
  if (!server.listening) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
