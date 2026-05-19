import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import packageJson from '../../package.json'
import { describe, expect, it } from 'vitest'

type AsarHeaderNode = {
  readonly files?: Record<string, AsarHeaderNode>
}

describe('desktop package contract', () => {
  it('ships runtime app assets without build-only packaging scripts', () => {
    expect(packageJson.build.files).toEqual(expect.arrayContaining([
      'dist/client/**',
      'dist/server/**',
      'dist/cli/**',
      'src/desktop/**',
      'scripts/kiri-desktop-backend.mjs',
      'settings.json',
      'package.json',
    ]))
    expect(packageJson.build.files.filter((entry) =>
      entry.startsWith('scripts/') && entry !== 'scripts/kiri-desktop-backend.mjs'
    )).toEqual([])
    expect(packageJson.build.files).not.toContain('scripts/create-desktop-dmg.mjs')
    expect(packageJson.build.files).not.toContain('scripts/normalize-desktop-app.mjs')
  })

  it('ships native helpers as extra resources next to the packaged app', () => {
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'resources/bin/kiri-mcp',
      to: 'bin/kiri-mcp',
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'dist/bin/kiri-git-diff-collector',
      to: 'bin/kiri-git-diff-collector',
    })
    expect(isExecutable(join(process.cwd(), 'resources/bin/kiri-mcp'))).toBe(true)
  })

  it('keeps built packaged app contents runnable when a desktop package assertion is requested', () => {
    if (process.env.KIRI_ASSERT_PACKAGED_APP !== '1') return

    const appRoots = [
      join(process.cwd(), 'dist/mac/kiri.app'),
      join(process.cwd(), 'dist/mac-arm64/kiri.app'),
      join(process.cwd(), 'dist/mac-universal/kiri.app'),
    ].filter((appRoot) => existsSync(appRoot))
    expect(appRoots.length, 'fresh packaged app output exists').toBeGreaterThan(0)

    for (const appRoot of appRoots) {
      const resourcesRoot = join(appRoot, 'Contents/Resources')
      const appAsar = join(resourcesRoot, 'app.asar')
      expect(existsSync(appAsar), `${appRoot} has app.asar`).toBe(true)
      expect(isExecutable(join(resourcesRoot, 'bin/kiri-mcp')), `${appRoot} has executable kiri-mcp`)
        .toBe(true)
      expect(
        isExecutable(join(resourcesRoot, 'bin/kiri-git-diff-collector')),
        `${appRoot} has executable kiri-git-diff-collector`,
      ).toBe(true)
      const header = readAsarHeader(appAsar)
      expect(hasAsarPath(header, ['scripts', 'kiri-desktop-backend.mjs'])).toBe(true)
      expect(hasAsarPath(header, ['dist', 'client'])).toBe(true)
      expect(hasAsarPath(header, ['dist', 'server'])).toBe(true)
      expect(hasAsarPath(header, ['dist', 'cli', 'kirictl.mjs'])).toBe(true)
      expect(hasAsarPath(header, ['src', 'desktop', 'main.mjs'])).toBe(true)
      expect(hasAsarPath(header, ['settings.json'])).toBe(true)
      expect(hasAsarPath(header, ['package.json'])).toBe(true)
      expect(hasAsarPath(header, ['scripts', 'create-desktop-dmg.mjs'])).toBe(false)
      expect(hasAsarPath(header, ['scripts', 'normalize-desktop-app.mjs'])).toBe(false)
    }
  })
})

function isExecutable(path: string) {
  return existsSync(path) && (statSync(path).mode & 0o111) !== 0
}

function readAsarHeader(path: string): AsarHeaderNode {
  const archive = readFileSync(path)
  expect(archive.byteLength, `${path} has enough bytes for ASAR header`).toBeGreaterThanOrEqual(16)
  const headerJsonLength = archive.readUInt32LE(12)
  const headerEnd = 16 + headerJsonLength
  expect(headerJsonLength, `${path} ASAR header length`).toBeGreaterThan(0)
  expect(headerEnd, `${path} ASAR header bounds`).toBeLessThanOrEqual(archive.byteLength)
  const header: unknown = JSON.parse(archive.subarray(16, headerEnd).toString())
  if (!isAsarHeaderNode(header)) {
    throw new Error(`${path} ASAR header is missing files`)
  }
  return header
}

function hasAsarPath(header: AsarHeaderNode, pathParts: readonly string[]) {
  let node: AsarHeaderNode | undefined = header
  for (const part of pathParts) {
    node = node.files?.[part]
    if (!node) return false
  }
  return true
}

function isAsarHeaderNode(value: unknown): value is AsarHeaderNode {
  return typeof value === 'object' && value !== null && 'files' in value
}
