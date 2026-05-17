#!/usr/bin/env node

import { readFileSync } from 'node:fs'

const inputTag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? ''
const tagVersion = inputTag.trim().replace(/^v/, '')
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const packageVersion = String(packageJson.version)

if (!tagVersion) {
  console.error('Missing release tag. Expected v<package.json version>.')
  process.exit(1)
}

if (tagVersion !== packageVersion) {
  console.error(`Release tag ${inputTag} does not match package.json version ${packageVersion}.`)
  process.exit(1)
}
