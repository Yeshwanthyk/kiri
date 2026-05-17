#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = resolve(rootDir, 'build', 'icon.svg')
const pngPath = resolve(rootDir, 'build', 'icon.png')
const iconsetPath = resolve(rootDir, 'build', 'icon.iconset')
const icnsPath = resolve(rootDir, 'build', 'icon.icns')
const publicDir = resolve(rootDir, 'public')

mkdirSync(resolve(rootDir, 'build'), { recursive: true })
mkdirSync(publicDir, { recursive: true })

const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 1024 },
    deviceScaleFactor: 1,
  })
  await page.goto(pathToFileURL(svgPath).href)
  await page.screenshot({ path: pngPath, omitBackground: true })
} finally {
  await browser.close()
}

rmSync(iconsetPath, { recursive: true, force: true })
mkdirSync(iconsetPath, { recursive: true })

for (const [name, size] of [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]) {
  resizePng(pngPath, resolve(iconsetPath, name), size)
}

execFileSync('iconutil', ['-c', 'icns', iconsetPath, '-o', icnsPath], { stdio: 'inherit' })

resizePng(pngPath, resolve(publicDir, 'favicon-16x16.png'), 16)
resizePng(pngPath, resolve(publicDir, 'favicon-32x32.png'), 32)
resizePng(pngPath, resolve(publicDir, 'favicon.png'), 32)
resizePng(pngPath, resolve(publicDir, 'apple-touch-icon.png'), 180)
resizePng(pngPath, resolve(publicDir, 'android-chrome-192x192.png'), 192)
resizePng(pngPath, resolve(publicDir, 'android-chrome-512x512.png'), 512)

const favicon48 = resolve(rootDir, 'build', 'favicon-48x48.png')
resizePng(pngPath, favicon48, 48)
execFileSync('magick', [
  resolve(publicDir, 'favicon-16x16.png'),
  resolve(publicDir, 'favicon-32x32.png'),
  favicon48,
  resolve(publicDir, 'favicon.ico'),
], { stdio: 'inherit' })

function resizePng(input, output, size) {
  execFileSync('sips', ['-z', String(size), String(size), input, '--out', output], {
    stdio: 'ignore',
  })
}
