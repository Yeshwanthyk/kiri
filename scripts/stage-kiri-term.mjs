#!/usr/bin/env node

import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const source = resolve('target/release/kiri-term')
const target = resolve('resources/bin/kiri-term')

mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
chmodSync(target, 0o755)
