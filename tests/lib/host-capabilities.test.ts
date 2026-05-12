import { describe, expect, it, vi } from 'vitest'
import { pickProjectDirectory } from '~/lib/host-capabilities'

describe('host capabilities', () => {
  it('uses the desktop bridge folder picker when present', async () => {
    const fallback = vi.fn(async () => '/fallback')
    const picked = await pickProjectDirectory(
      fallback,
      { pickFolder: async () => '/desktop/project' },
    )

    expect(picked).toBe('/desktop/project')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back to the web server capability when the bridge is absent', async () => {
    await expect(pickProjectDirectory(async () => '/fallback')).resolves.toBe('/fallback')
  })

  it('does not open the web fallback when desktop folder selection is cancelled', async () => {
    const fallback = vi.fn(async () => '/fallback')
    await expect(
      pickProjectDirectory(fallback, { pickFolder: async () => null }),
    ).rejects.toThrow('Project directory selection canceled')
    expect(fallback).not.toHaveBeenCalled()
  })
})
