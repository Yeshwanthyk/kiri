#!/usr/bin/env node

import { mkdirSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { build } from 'esbuild'

const targets = [
  {
    entryPoint: 'src/cli/kirictl.ts',
    outfile: resolve('dist/cli/kirictl.mjs'),
  },
  {
    entryPoint: 'src/cli/kiri-hook.ts',
    outfile: resolve('dist/cli/kiri-hook.mjs'),
  },
]

for (const target of targets) {
  mkdirSync(dirname(target.outfile), { recursive: true })

  await build({
    entryPoints: [target.entryPoint],
    outfile: target.outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: {
      js: 'import { createRequire as __kiriCreateRequire } from "node:module"; const require = __kiriCreateRequire(import.meta.url);',
    },
    sourcemap: false,
    external: [
      'node-pty',
    ],
    plugins: [
      {
        name: 'kiri-tsconfig-paths',
        setup(build) {
          build.onResolve({ filter: /^~\// }, (args) => {
            const base = resolve('src', args.path.slice(2))
            const path = resolveImportPath(base)
            return { path }
          })
          build.onResolve({ filter: /^@kiri\/control\// }, (args) => {
            const base = resolve('packages/kiri-control/src', args.path.slice('@kiri/control/'.length))
            const path = resolveImportPath(base)
            return { path }
          })
        },
      },
    ],
  })
}

function resolveImportPath(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`]) {
    if (existsSync(candidate)) return candidate
  }
  return base
}
