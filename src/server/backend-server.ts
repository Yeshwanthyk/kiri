import { serve } from 'srvx/node'
import type { ServerRequest } from 'srvx'
import type { AetherConfig } from './aether-config'
import { getAetherConfig } from './aether-config'
import { getDb } from './db'
import { getSettings } from './settings'

export const aetherEnvironmentPath = '/.well-known/aether/environment'

export type AetherBackendInfo = {
  readonly name: 'aether'
  readonly mode: AetherConfig['hostMode']
  readonly rootDir: string
  readonly stateDir: string
  readonly dbPath: string
}

export type FetchHandler = (request: ServerRequest) => Response | Promise<Response>
export type ReadinessCheck = () => void | Promise<void>

export type StartAetherBackendInput = {
  readonly fetch: FetchHandler
  readonly host?: string
  readonly port?: number
  readonly config?: AetherConfig
  readonly readiness?: ReadinessCheck
}

export type AetherBackendServer = ReturnType<typeof serve>

export async function startAetherBackend(input: StartAetherBackendInput): Promise<AetherBackendServer> {
  const config = input.config ?? getAetherConfig()
  const server = serve({
    fetch: createAetherFetchHandler(input.fetch, {
      config,
      readiness: input.readiness,
    }),
    hostname: input.host ?? '127.0.0.1',
    port: input.port ?? 0,
    silent: true,
  })
  await server.ready()
  return server
}

export function createAetherFetchHandler(
  appFetch: FetchHandler,
  options: {
    readonly config?: AetherConfig
    readonly readiness?: ReadinessCheck
  } = {},
): FetchHandler {
  const config = options.config ?? getAetherConfig()
  const readiness = options.readiness ?? checkBackendReadiness
  return async (request) => {
    const url = new URL(request.url)
    if (url.pathname === aetherEnvironmentPath) {
      try {
        await readiness()
        return Response.json(environmentInfo(config), {
          headers: {
            'cache-control': 'no-store',
          },
        })
      } catch (cause) {
        return Response.json(
          {
            name: 'aether',
            ready: false,
            error: cause instanceof Error ? cause.message : String(cause),
          },
          {
            status: 503,
            headers: {
              'cache-control': 'no-store',
            },
          },
        )
      }
    }
    return appFetch(request)
  }
}

function checkBackendReadiness() {
  getSettings()
  getDb()
}

export function environmentInfo(config: AetherConfig): AetherBackendInfo {
  return {
    name: 'aether',
    mode: config.hostMode,
    rootDir: config.rootDir,
    stateDir: config.stateDir,
    dbPath: config.dbPath,
  }
}
