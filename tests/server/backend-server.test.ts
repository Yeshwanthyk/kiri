import { describe, expect, it } from 'vitest'
import {
  aetherEnvironmentPath,
  createAetherFetchHandler,
  environmentInfo,
  startAetherBackend,
} from '~/server/backend-server'
import { resolveAetherConfig } from '~/server/aether-config'

const config = resolveAetherConfig({
  cwd: '/repo/aether',
  env: {
    AETHER_HOST_MODE: 'desktop',
    AETHER_STATE_DIR: '/Users/yesh/Library/Application Support/Aether',
  },
})

describe('backend server wrapper', () => {
  it('exposes deterministic environment metadata for desktop readiness', async () => {
    const fetch = createAetherFetchHandler(
      async () => new Response('app'),
      { config, readiness: () => undefined },
    )

    const response = await fetch(new Request(`http://127.0.0.1:0${aetherEnvironmentPath}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual(environmentInfo(config))
  })

  it('delegates non-readiness requests to the app fetch handler', async () => {
    const fetch = createAetherFetchHandler(
      async (request) => new Response(`app:${new URL(request.url).pathname}`),
      { config, readiness: () => undefined },
    )

    const response = await fetch(new Request('http://127.0.0.1:0/projects'))

    expect(await response.text()).toBe('app:/projects')
  })

  it('reports unavailable when readiness fails', async () => {
    const fetch = createAetherFetchHandler(
      async () => new Response('app'),
      {
        config,
        readiness: () => {
          throw new Error('settings missing')
        },
      },
    )

    const response = await fetch(new Request(`http://127.0.0.1:0${aetherEnvironmentPath}`))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      name: 'aether',
      ready: false,
      error: 'settings missing',
    })
  })

  it('starts an srvx backend and closes it cleanly', async () => {
    const server = await startAetherBackend({
      config,
      readiness: () => undefined,
      fetch: async (request) =>
        new Response(request.runtime?.name ? `runtime:${request.runtime.name}` : 'runtime:missing'),
    })
    try {
      expect(server.url).toBeTruthy()

      const environment = await fetch(new URL(aetherEnvironmentPath, server.url))
      expect(environment.status).toBe(200)
      await expect(environment.json()).resolves.toEqual(environmentInfo(config))

      const app = await fetch(new URL('/app', server.url))
      expect(await app.text()).toBe('runtime:node')
    } finally {
      await server.close(true)
    }
  })
})
