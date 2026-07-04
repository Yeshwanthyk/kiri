import { serve } from 'srvx/node'
import type { ServerRequest } from 'srvx'
import { controlProtocolVersion } from '@kiri/control/control-protocol'
import type { KiriConfig } from './kiri-config'
import { getKiriConfig } from './kiri-config'
import { checkBackendReadiness } from './backend-readiness'

export const kiriEnvironmentPath = '/.well-known/kiri/environment'

export type KiriBackendInfo = {
  readonly name: 'kiri'
  readonly mode: KiriConfig['hostMode']
  readonly rootDir: string
  readonly stateDir: string
  readonly dbPath: string
  readonly controlProtocolVersion: number
}

export type FetchHandler = (request: ServerRequest) => Response | Promise<Response>
export type ReadinessCheck = () => void | Promise<void>

export type StartKiriBackendInput = {
  readonly fetch: FetchHandler
  readonly host?: string
  readonly port?: number
  readonly config?: KiriConfig
  readonly readiness?: ReadinessCheck
}

export type KiriBackendServer = ReturnType<typeof serve>

export async function startKiriBackend(input: StartKiriBackendInput): Promise<KiriBackendServer> {
  const config = input.config ?? getKiriConfig()
  const server = serve({
    fetch: createKiriFetchHandler(input.fetch, {
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

export function createKiriFetchHandler(
  appFetch: FetchHandler,
  options: {
    readonly config?: KiriConfig
    readonly readiness?: ReadinessCheck
  } = {},
): FetchHandler {
  const config = options.config ?? getKiriConfig()
  const readiness: ReadinessCheck = options.readiness ?? checkBackendReadiness
  return async (request) => {
    const url = new URL(request.url)
    if (url.pathname === kiriEnvironmentPath) {
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
            name: 'kiri',
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

export function environmentInfo(config: KiriConfig): KiriBackendInfo {
  return {
    name: 'kiri',
    mode: config.hostMode,
    rootDir: config.rootDir,
    stateDir: config.stateDir,
    dbPath: config.dbPath,
    controlProtocolVersion,
  }
}
