#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

const appOutDir = resolve(process.argv[2] ?? findMacAppOutDir())
const electronApp = join(appOutDir, 'Electron.app')
const kiriApp = join(appOutDir, 'kiri.app')
const appPath = existsSync(kiriApp) ? kiriApp : electronApp

if (!existsSync(appPath)) {
  throw new Error(`Packaged app not found in ${appOutDir}`)
}

const plistPath = join(appPath, 'Contents', 'Info.plist')
setPlistValue(plistPath, 'CFBundleName', 'kiri')
setPlistValue(plistPath, 'CFBundleDisplayName', 'kiri')
setPlistValue(plistPath, 'CFBundleExecutable', 'kiri')

if (appPath === electronApp) {
  const oldExecutable = join(electronApp, 'Contents', 'MacOS', 'Electron')
  const newExecutable = join(electronApp, 'Contents', 'MacOS', 'kiri')
  if (existsSync(oldExecutable) && !existsSync(newExecutable)) {
    renameSync(oldExecutable, newExecutable)
  }
  renameSync(electronApp, kiriApp)
}

function setPlistValue(plistPath, key, value) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath])
}

function findMacAppOutDir() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch
  return `dist/mac-${arch}`
}
