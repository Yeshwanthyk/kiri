#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const projectRoot = resolve(process.cwd())
const packageRoots = ['dist/client', 'dist/server', 'dist/cli']
const textExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.txt',
])
const forbiddenPatterns = [
  { pattern: /\/Users\/yesh/g, label: '/Users/yesh' },
  { pattern: /Users\/yesh/g, label: 'Users/yesh' },
  { pattern: /\.kiri\/userdata/g, label: '.kiri/userdata' },
]
const forbiddenArtifactNames = new Set([
  'attachments',
  'kiri.sqlite',
  'preferences.json',
])

for (const file of collectFiles(packageRoots)) {
  if (file.endsWith('.map')) {
    rmSync(file, { force: true })
    continue
  }
  if (!isTextFile(file)) continue
  const before = readFileSync(file, 'utf8')
  const after = before
    .replaceAll(projectRoot, '')
    .replaceAll(projectRoot.split(sep).join('/'), '')
    .replace(/^\/\/# sourceMappingURL=.*$/gm, '')
  if (after !== before) writeFileSync(file, after)
}

const failures = []
for (const file of collectFiles(packageRoots)) {
  const name = file.split(sep).at(-1)
  if (name && forbiddenArtifactNames.has(name)) {
    failures.push(`${relative(projectRoot, file)} contains packaged user-data artifact name`)
    continue
  }
  if (!isTextFile(file)) continue
  const contents = readFileSync(file, 'utf8')
  for (const { pattern, label } of forbiddenPatterns) {
    pattern.lastIndex = 0
    if (pattern.test(contents)) failures.push(`${relative(projectRoot, file)} contains ${label}`)
  }
}

if (failures.length > 0) {
  console.error('Desktop package inputs contain non-release-safe local data:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

function collectFiles(roots) {
  const files = []
  for (const root of roots) walk(resolve(root), files)
  return files
}

function walk(path, files) {
  if (!existsSync(path)) return
  const stat = statSync(path)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry), files)
    return
  }
  if (stat.isFile()) files.push(path)
}

function isTextFile(path) {
  return textExtensions.has(path.slice(path.lastIndexOf('.')))
}
