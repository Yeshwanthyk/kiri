import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  BackendReadinessError,
  checkBackendReadiness,
  makeBackendReadinessService,
} from '~/server/backend-readiness'

describe('BackendReadinessService', () => {
  it('checks settings before opening the database through injected dependencies', async () => {
    const calls: string[] = []
    const service = makeBackendReadinessService({
      loadSettings: () => calls.push('settings'),
      openDb: () => calls.push('db'),
    })

    await Effect.runPromise(service.check())

    expect(calls).toEqual(['settings', 'db'])
  })

  it('wraps failed readiness probes in the service error type', async () => {
    const cause = new Error('settings missing')
    const service = makeBackendReadinessService({
      loadSettings: () => {
        throw cause
      },
      openDb: () => undefined,
    })

    const result = await Effect.runPromise(Effect.either(service.check()))

    expect(result).toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'BackendReadinessError',
        cause,
        message: 'settings missing',
      } satisfies Partial<BackendReadinessError>,
    })
  })

  it('reports async probe rejections as readiness failures', async () => {
    const service = makeBackendReadinessService({
      loadSettings: () => Promise.resolve(),
      openDb: () => Promise.reject(new Error('db rejected')),
    })

    const result = await Effect.runPromise(Effect.either(service.check()))

    expect(result).toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'BackendReadinessError',
        message: 'db rejected',
      } satisfies Partial<BackendReadinessError>,
    })
  })

  it('wraps openDb failures after settings pass', async () => {
    const cause = new Error('db unavailable')
    const service = makeBackendReadinessService({
      loadSettings: () => undefined,
      openDb: () => {
        throw cause
      },
    })

    const result = await Effect.runPromise(Effect.either(service.check()))

    expect(result).toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'BackendReadinessError',
        cause,
        message: 'db unavailable',
      } satisfies Partial<BackendReadinessError>,
    })
  })

  it('preserves normal Error shape through the compatibility export', async () => {
    await expect(
      checkBackendReadiness({
        loadSettings: () => {
          throw new Error('db unavailable')
        },
        openDb: () => undefined,
      }),
    ).rejects.toThrow('db unavailable')
  })
})
