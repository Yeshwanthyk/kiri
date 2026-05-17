#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }

const arch = process.env.npm_config_arch ?? process.arch
const appOutDir = resolve(process.argv[2] ?? `dist/mac-${arch}`)
const appPath = resolve(appOutDir, 'kiri.app')
const dmgPath = resolve(process.argv[3] ?? `dist/kiri-${packageJson.version}-${arch}.dmg`)
const tmpDmgPath = dmgPath.endsWith('.dmg')
  ? `${dmgPath.slice(0, -'.dmg'.length)}.tmp.dmg`
  : `${dmgPath}.tmp.dmg`

if (!existsSync(appPath)) {
  throw new Error(`Packaged app not found: ${appPath}`)
}

for (let attempt = 1; attempt <= 3; attempt += 1) {
  rmSync(dmgPath, { force: true })
  rmSync(tmpDmgPath, { force: true })

  try {
    execFileSync(
      'hdiutil',
      [
        'create',
        '-srcfolder',
        appPath,
        '-volname',
        'kiri',
        '-format',
        'UDZO',
        '-imagekey',
        'zlib-level=9',
        '-ov',
        tmpDmgPath,
      ],
      { stdio: 'inherit' },
    )
    renameSync(tmpDmgPath, dmgPath)
    break
  } catch (error) {
    if (attempt === 3) {
      throw error
    }
    console.warn(`hdiutil create failed; retrying (${attempt}/3)`)
    sleep(2_000)
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}
