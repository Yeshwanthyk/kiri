#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }

const arch = process.env.npm_config_arch ?? process.arch
const appOutDir = resolve(process.argv[2] ?? `dist/mac-${arch}`)
const appPath = resolve(appOutDir, 'kiri.app')
const dmgPath = resolve(process.argv[3] ?? `dist/kiri-${packageJson.version}-${arch}.dmg`)

if (!existsSync(appPath)) {
  throw new Error(`Packaged app not found: ${appPath}`)
}

rmSync(dmgPath, { force: true })

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
    dmgPath,
  ],
  { stdio: 'inherit' },
)
