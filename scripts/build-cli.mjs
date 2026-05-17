#!/usr/bin/env node

import { mkdirSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { build } from 'esbuild'

const outfile = resolve('dist/cli/kirictl.mjs')

mkdirSync(dirname(outfile), { recursive: true })

await build({
  entryPoints: ['src/cli/kirictl.ts'],
  outfile,
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
      },
    },
  ],
})

function resolveImportPath(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`]) {
    if (existsSync(candidate)) return candidate
  }
  return base
}
