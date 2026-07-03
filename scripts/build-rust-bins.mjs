#!/usr/bin/env node

import { copyFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const projectRoot = resolve(process.cwd())
const destinationDir = join(projectRoot, 'dist', 'bin')
const binaries = ['kiri-read-model-indexer', 'kiri-termd']
const macTargets = ['aarch64-apple-darwin', 'x86_64-apple-darwin']
const macCargoPath = process.platform === 'darwin'
  ? execFileSync('rustup', ['which', 'cargo'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim()
  : null
const macRustcPath = process.platform === 'darwin'
  ? execFileSync('rustup', ['which', 'rustc'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim()
  : null
const cargoCommand = macCargoPath ?? 'cargo'
const installedRustTargets = process.platform === 'darwin'
  ? new Set(execFileSync('rustup', ['target', 'list', '--installed'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean))
  : new Set()

mkdirSync(destinationDir, { recursive: true })

for (const packageName of binaries) {
  const binaryName = process.platform === 'win32'
    ? `${packageName}.exe`
    : packageName
  const destination = join(destinationDir, binaryName)
  if (process.platform === 'darwin') {
    buildMacUniversalBinary(packageName, binaryName, destination)
    continue
  }

  execCargo(['build', '--release', '-p', packageName])
  const source = join(projectRoot, 'target', 'release', binaryName)
  copyFileSync(source, destination)
  chmodSync(destination, 0o755)
}

function execCargo(args) {
  execFileSync(cargoCommand, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...(macRustcPath === null ? {} : { RUSTC: macRustcPath }),
    },
    stdio: 'inherit',
  })
}

function buildMacUniversalBinary(packageName, binaryName, destination) {
  for (const target of macTargets) {
    assertRustTargetInstalled(target)
    execCargo(['build', '--release', '--target', target, '-p', packageName])
  }
  const slices = macTargets.map((target) =>
    join(projectRoot, 'target', target, 'release', binaryName),
  )
  rmSync(destination, { force: true })
  execFileSync('lipo', ['-create', '-output', destination, ...slices], {
    cwd: projectRoot,
    stdio: 'inherit',
  })
  chmodSync(destination, 0o755)
}

function assertRustTargetInstalled(target) {
  if (installedRustTargets.has(target)) return
  throw new Error(`Missing Rust target ${target}. Run: rustup target add ${macTargets.join(' ')}`)
}
