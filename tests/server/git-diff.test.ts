import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  GitDiffError,
  GitDiffService,
  collectGitDiffArtifacts,
  collectRustGitDiffArtifacts,
  diffArtifactsFromPatch,
  makeGitDiffService,
} from '../../src/server/git-diff'

describe('git diff capture', () => {
  it('only captures dirty files from the requested worktree', () => {
    const cleanRepo = initRepo()
    const dirtyRepo = initRepo()

    writeFileSync(join(dirtyRepo, 'other.ts'), 'export const other = 2\n')

    expect(collectGitDiffArtifacts(cleanRepo)).toEqual([])
  })

  it('captures uncommitted files from the requested worktree', () => {
    const repo = initRepo()

    writeFileSync(join(repo, 'tracked.ts'), 'export const value = 2\n')
    writeFileSync(join(repo, 'new.ts'), 'export const created = true\n')

    const paths = collectGitDiffArtifacts(repo).map((diff) => diff.path)

    expect(paths).toContain('tracked.ts')
    expect(paths).toContain('new.ts')
  })

  it.effect('captures diffs through the Effect service layer', () =>
    Effect.gen(function* () {
      const service = yield* GitDiffService
      const repo = initRepo()

      writeFileSync(join(repo, 'tracked.ts'), 'export const value = 3\n')

      const paths = (yield* service.collectArtifacts(repo)).map((diff) => diff.path)

      expect(paths).toContain('tracked.ts')
    }).pipe(Effect.provide(GitDiffService.layer)),
  )

  it.effect('bounds untracked diff collection by remaining budget', () =>
    Effect.gen(function* () {
      const times = [1000, 2600, 3800, 4200]
      const calls: Array<{ args: ReadonlyArray<string>; timeout: number }> = []
      const service = makeGitDiffService({
        now: () => times.shift() ?? 4200,
        runGit: (_cwd, args, timeout) => {
          calls.push({ args, timeout })
          if (args[0] === 'rev-parse') return 'true\n'
          if (args[0] === 'status') return '?? one.ts\0?? two.ts\0?? three.ts\0'
          if (args.includes('one.ts')) {
            return 'diff --git a/one.ts b/one.ts\nnew file mode 100644\n'
          }
          if (args.includes('two.ts')) {
            return 'diff --git a/two.ts b/two.ts\nnew file mode 100644\n'
          }
          return ''
        },
      })

      const artifacts = yield* service.collectArtifacts('/repo')

      expect(artifacts.map((artifact) => artifact.path)).toEqual(['one.ts', 'two.ts'])
      expect(calls.filter((call) => call.args[0] === 'diff' && call.args.includes('/dev/null')))
        .toEqual([
          expect.objectContaining({ timeout: 500 }),
          expect.objectContaining({ timeout: 200 }),
        ])
    }),
  )

  it.effect('skips ignored diff paths from injected git output', () =>
    Effect.gen(function* () {
      const service = makeGitDiffService({
        runGit: (_cwd, args) => {
          if (args[0] === 'rev-parse') return 'true\n'
          if (args[0] === 'status') return ''
          return [
            'diff --git a/dist/app.js b/dist/app.js\n--- a/dist/app.js\n+++ b/dist/app.js',
            'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts',
          ].join('\n')
        },
      })

      const artifacts = yield* service.collectArtifacts('/repo')

      expect(artifacts.map((artifact) => artifact.path)).toEqual(['src/app.ts'])
    }),
  )

  it.effect('matches the pure patch parser through the Effect service', () =>
    Effect.gen(function* () {
      const service = makeGitDiffService()
      const patch = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts'

      const artifacts = yield* service.artifactsFromPatch(patch)

      expect(artifacts).toEqual(diffArtifactsFromPatch(patch))
    }),
  )

  it.effect('wraps injected git runner failures in typed errors', () =>
    Effect.gen(function* () {
      const service = makeGitDiffService({
        runGit: (_cwd, args) => {
          if (args[0] === 'rev-parse') return 'true\n'
          throw new Error('git status exploded')
        },
      })

      const error = yield* service.collectArtifacts('/repo').pipe(Effect.flip)

      expect(error).toBeInstanceOf(GitDiffError)
      expect(error.cwd).toBe('/repo')
      expect(error.message).toBe('git status exploded')
    }),
  )

  it.effect('falls back to the TypeScript collector when Rust mode fails', () =>
    Effect.gen(function* () {
      let rustCalls = 0
      const service = makeGitDiffService({
        env: { KIRI_GIT_DIFF_COLLECTOR: 'rust' },
        runRustCollector: () => {
          rustCalls += 1
          throw new Error('rust collector unavailable')
        },
        runGit: (_cwd, args) => {
          if (args[0] === 'rev-parse') return 'true\n'
          if (args[0] === 'status') return ''
          return 'diff --git a/src/fallback.ts b/src/fallback.ts\n--- a/src/fallback.ts\n+++ b/src/fallback.ts'
        },
      })

      const artifacts = yield* service.collectArtifacts('/repo')

      expect(rustCalls).toBe(1)
      expect(artifacts.map((artifact) => artifact.path)).toEqual(['src/fallback.ts'])
    }),
  )

  it.effect('uses an available Rust collector by default', () =>
    Effect.gen(function* () {
      let rustCalls = 0
      const service = makeGitDiffService({
        env: {},
        runRustCollector: () => {
          rustCalls += 1
          return [{ title: 'fast.ts', path: 'src/fast.ts', patch: 'diff --git a/src/fast.ts b/src/fast.ts' }]
        },
        runGit: () => {
          throw new Error('TypeScript collector should not run')
        },
      })

      const artifacts = yield* service.collectArtifacts('/repo')

      expect(rustCalls).toBe(1)
      expect(artifacts.map((artifact) => artifact.path)).toEqual(['src/fast.ts'])
    }),
  )

  it.effect('can force the TypeScript collector for compatibility', () =>
    Effect.gen(function* () {
      let rustCalls = 0
      const service = makeGitDiffService({
        env: { KIRI_GIT_DIFF_COLLECTOR: 'typescript' },
        runRustCollector: () => {
          rustCalls += 1
          return []
        },
        runGit: (_cwd, args) => {
          if (args[0] === 'rev-parse') return 'true\n'
          if (args[0] === 'status') return ''
          return 'diff --git a/src/compat.ts b/src/compat.ts\n--- a/src/compat.ts\n+++ b/src/compat.ts'
        },
      })

      const artifacts = yield* service.collectArtifacts('/repo')

      expect(rustCalls).toBe(0)
      expect(artifacts.map((artifact) => artifact.path)).toEqual(['src/compat.ts'])
    }),
  )

  it.effect('passes injected env through to the default Rust collector', () =>
    Effect.gen(function* () {
      const bin = join(mkdtempSync(join(tmpdir(), 'kiri-git-diff-bin-')), 'collector')
      writeFileSync(bin, '#!/bin/sh\nprintf "[]"\n')
      chmodSync(bin, 0o755)
      const service = makeGitDiffService({
        env: {
          KIRI_GIT_DIFF_COLLECTOR: 'rust',
          KIRI_GIT_DIFF_COLLECTOR_BIN: bin,
        },
        runGit: () => {
          throw new Error('TypeScript collector should not run')
        },
      })

      const artifacts = yield* service.collectArtifacts('/repo')

      expect(artifacts).toEqual([])
    }),
  )

  it('resolves the Rust collector from packaged resources', () => {
    const resourcesRoot = mkdtempSync(join(tmpdir(), 'kiri-git-diff-resources-'))
    const binDir = join(resourcesRoot, 'bin')
    mkdirSync(binDir)
    writeFileSync(join(binDir, 'kiri-git-diff-collector'), '#!/bin/sh\nprintf "[]"\n')
    chmodSync(join(binDir, 'kiri-git-diff-collector'), 0o755)

    const descriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: resourcesRoot,
    })
    try {
      expect(collectRustGitDiffArtifacts('/repo', {})).toEqual([])
    } finally {
      if (descriptor) {
        Object.defineProperty(process, 'resourcesPath', descriptor)
      } else {
        Reflect.deleteProperty(process, 'resourcesPath')
      }
    }
  })

  it.effect('matches TypeScript output with the Rust collector on a real worktree', () =>
    Effect.gen(function* () {
      buildRustCollector()
      const repo = initRepo()

      writeFileSync(join(repo, 'tracked.ts'), 'export const value = 4\n')
      writeFileSync(join(repo, 'new.ts'), 'export const created = true\n')
      mkdirSync(join(repo, 'dist'))
      writeFileSync(join(repo, 'dist', 'skip.js'), 'compiled\n')

      const service = makeGitDiffService({ env: { KIRI_GIT_DIFF_COLLECTOR: 'typescript' } })
      const tsArtifacts = yield* service.collectArtifacts(repo)
      const rustArtifacts = collectRustGitDiffArtifacts(repo)

      expect(normalizeArtifacts(rustArtifacts)).toEqual(normalizeArtifacts(tsArtifacts))
    }), 15_000,
  )
})

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kiri-git-diff-'))
  runGit(dir, ['init'])
  runGit(dir, ['config', 'user.email', 'test@example.com'])
  runGit(dir, ['config', 'user.name', 'Kiri Test'])
  writeFileSync(join(dir, 'tracked.ts'), 'export const value = 1\n')
  runGit(dir, ['add', 'tracked.ts'])
  runGit(dir, ['commit', '-m', 'initial'])
  return dir
}

function buildRustCollector() {
  execFileSync('cargo', ['build', '-p', 'kiri-git-diff-collector'], { stdio: 'inherit' })
}

function normalizeArtifacts(artifacts: ReturnType<typeof collectGitDiffArtifacts>) {
  return artifacts
    .map((artifact) => ({
      title: artifact.title,
      path: artifact.path,
      patch: artifact.patch.replaceAll('\r\n', '\n'),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function runGit(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}
