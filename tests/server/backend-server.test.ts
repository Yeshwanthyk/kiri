import { describe, expect, it } from 'vitest'
import {
  kiriEnvironmentPath,
  createKiriFetchHandler,
  environmentInfo,
  startKiriBackend,
} from '~/server/backend-server'
import { resolveKiriConfig } from '~/server/kiri-config'

const config = resolveKiriConfig({
  cwd: '/repo/kiri',
  env: {
    KIRI_HOST_MODE: 'desktop',
    KIRI_STATE_DIR: '/Users/yesh/Library/Application Support/Kiri',
  },
})

describe('backend server wrapper', () => {
  it('exposes deterministic environment metadata for desktop readiness', async () => {
    const fetch = createKiriFetchHandler(
      () => new Response('app'),
      { config, readiness: () => undefined },
    )

    const response = await fetch(new Request(`http://127.0.0.1:0${kiriEnvironmentPath}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual(environmentInfo(config))
  })

  it('delegates non-readiness requests to the app fetch handler', async () => {
    const fetch = createKiriFetchHandler(
      (request) => new Response(`app:${new URL(request.url).pathname}`),
      { config, readiness: () => undefined },
    )

    const response = await fetch(new Request('http://127.0.0.1:0/projects'))

    expect(await response.text()).toBe('app:/projects')
  })

  it('reports unavailable when readiness fails', async () => {
    const fetch = createKiriFetchHandler(
      () => new Response('app'),
      {
        config,
        readiness: () => {
          throw new Error('settings missing')
        },
      },
    )

    const response = await fetch(new Request(`http://127.0.0.1:0${kiriEnvironmentPath}`))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      name: 'kiri',
      ready: false,
      error: 'settings missing',
    })
  })

  it('starts an srvx backend and closes it cleanly', async () => {
    const server = await startKiriBackend({
      config,
      readiness: () => undefined,
      fetch: (request) =>
        new Response(request.runtime?.name ? `runtime:${request.runtime.name}` : 'runtime:missing'),
    })
    try {
      expect(server.url).toBeTruthy()

      const environment = await fetch(new URL(kiriEnvironmentPath, server.url))
      expect(environment.status).toBe(200)
      await expect(environment.json()).resolves.toEqual(environmentInfo(config))

      const app = await fetch(new URL('/app', server.url))
      expect(await app.text()).toBe('runtime:node')
    } finally {
      await server.close(true)
    }
  })
})
