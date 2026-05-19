#!/usr/bin/env node

import { copyFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const projectRoot = resolve(process.cwd())
const destinationDir = join(projectRoot, 'dist', 'bin')
const binaries = ['kiri-git-diff-collector']

mkdirSync(destinationDir, { recursive: true })

for (const packageName of binaries) {
  const binaryName = process.platform === 'win32'
    ? `${packageName}.exe`
    : packageName
  execFileSync('cargo', ['build', '--release', '-p', packageName], {
    cwd: projectRoot,
    stdio: 'inherit',
  })
  const source = join(projectRoot, 'target', 'release', binaryName)
  const destination = join(destinationDir, binaryName)
  copyFileSync(source, destination)
  chmodSync(destination, 0o755)
}
