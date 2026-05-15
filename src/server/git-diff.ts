import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { Context, Data, Effect, Layer } from 'effect'

const GIT_COMMAND_TIMEOUT_MS = 3000
const UNTRACKED_DIFF_BUDGET_MS = 3000
const UNTRACKED_DIFF_COMMAND_TIMEOUT_MS = 500

export type RuntimeDiffArtifact = {
  title: string
  path: string
  patch: string
}

export class GitDiffError extends Data.TaggedError('GitDiffError')<{
  readonly message: string
  readonly cwd: string
  readonly cause?: unknown
}> {}

export type GitCommandRunner = (
  cwd: string,
  args: ReadonlyArray<string>,
  timeout: number,
) => string

export type GitDiffServiceApi = {
  readonly collectArtifacts: (cwd: string) => Effect.Effect<RuntimeDiffArtifact[], GitDiffError>
  readonly artifactsFromPatch: (patch: string) => Effect.Effect<RuntimeDiffArtifact[]>
}

export class GitDiffService extends Context.Tag('@kiri/GitDiff')<
  GitDiffService,
  GitDiffServiceApi
>() {
  static readonly layer = Layer.succeed(
    GitDiffService,
    GitDiffService.of(makeGitDiffService()),
  )
}

export function makeGitDiffService(input: {
  readonly runGit?: GitCommandRunner
  readonly now?: () => number
} = {}): GitDiffServiceApi {
  const runGitCommand = input.runGit ?? runGit
  const now = input.now ?? Date.now
  return {
    collectArtifacts: (cwd) => Effect.try({
      try: () => collectGitDiffArtifactsWith({ cwd, runGit: runGitCommand, now }),
      catch: (error) => new GitDiffError({
        message: error instanceof Error ? error.message : 'Failed to collect git diffs',
        cwd,
        cause: error,
      }),
    }),
    artifactsFromPatch: (patch) => Effect.sync(() => diffArtifactsFromPatch(patch)),
  }
}

export function collectGitDiffArtifacts(cwd: string): RuntimeDiffArtifact[] {
  return collectGitDiffArtifactsWith({ cwd, runGit, now: Date.now })
}

function collectGitDiffArtifactsWith(input: {
  readonly cwd: string
  readonly runGit: GitCommandRunner
  readonly now: () => number
}): RuntimeDiffArtifact[] {
  const { cwd, runGit: runGitCommand, now } = input
  if (!isGitWorkTree(cwd, runGitCommand)) return []
  const untrackedPatches: string[] = []
  const untrackedDeadline = now() + UNTRACKED_DIFF_BUDGET_MS
  for (const path of untrackedFiles(cwd, runGitCommand)) {
    const remainingMs = untrackedDeadline - now()
    if (remainingMs <= 0) break
    untrackedPatches.push(
      ...splitGitPatch(runGitAllowExit(runGitCommand, cwd, [
        'diff',
        '--no-ext-diff',
        '--no-index',
        '--binary',
        '--',
        '/dev/null',
        path,
      ], Math.min(UNTRACKED_DIFF_COMMAND_TIMEOUT_MS, remainingMs))),
    )
  }
  const patches = [
    ...splitGitPatch(runGitAllowExit(runGitCommand, cwd, [
      'diff',
      '--no-ext-diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--binary',
      'HEAD',
      '--',
    ])),
    ...untrackedPatches,
  ]
  return patches.flatMap((patch) => {
    const path = diffPath(patch)
    if (!path || shouldSkipDiffPath(path)) return []
    return [{
      title: basename(path),
      path,
      patch,
    }]
  })
}

export function diffArtifactsFromPatch(patch: string): RuntimeDiffArtifact[] {
  return splitGitPatch(patch).flatMap((section) => {
    const path = diffPath(section)
    if (!path || shouldSkipDiffPath(path)) return []
    return [{
      title: basename(path),
      path,
      patch: section,
    }]
  })
}

function isGitWorkTree(cwd: string, runGitCommand: GitCommandRunner) {
  try {
    return runGitCommand(cwd, ['rev-parse', '--is-inside-work-tree'], GIT_COMMAND_TIMEOUT_MS)
      .trim() === 'true'
  } catch {
    return false
  }
}

function untrackedFiles(cwd: string, runGitCommand: GitCommandRunner) {
  const records = runGitCommand(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ], GIT_COMMAND_TIMEOUT_MS).split('\0')
  const paths: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    const status = record.slice(0, 2)
    const path = record.slice(3)
    if (status === '??' && path && !shouldSkipDiffPath(path)) {
      paths.push(path)
    }
    if (/[RC]/.test(status)) {
      index += 1
    }
  }
  return paths
}

function shouldSkipDiffPath(path: string) {
  for (const prefix of SKIPPED_DIFF_PREFIXES) {
    if (path.startsWith(prefix)) return true
  }
  return false
}

const SKIPPED_DIFF_PREFIXES = new Set(['.pi/', '.kiri/', 'node_modules/', 'dist/'])

function splitGitPatch(patch: string) {
  const trimmed = patch.trim()
  if (!trimmed) return []
  return trimmed.split(/\n(?=diff --git )/).flatMap((section) => {
    const next = section.trim()
    return next.startsWith('diff --git ') ? [next] : []
  })
}

function diffPath(patch: string) {
  const match = /^diff --git (?:a\/)?(.+?) (?:b\/)?(.+)$/m.exec(patch)
  if (!match) return null
  return cleanDiffPath(match[2] ?? match[1] ?? '')
}

function cleanDiffPath(path: string) {
  return path
    .replace(/^"|"$/g, '')
    .replace(/^b\//, '')
    .trim()
}

function runGit(cwd: string, args: ReadonlyArray<string>, timeout = GIT_COMMAND_TIMEOUT_MS) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout,
  })
}

function runGitAllowExit(
  runGitCommand: GitCommandRunner,
  cwd: string,
  args: ReadonlyArray<string>,
  timeout?: number,
) {
  try {
    return runGitCommand(cwd, args, timeout ?? GIT_COMMAND_TIMEOUT_MS)
  } catch (error) {
    const output = (error as { stdout?: Buffer | string }).stdout
    if (Buffer.isBuffer(output)) return output.toString('utf8')
    if (typeof output === 'string') return output
    return ''
  }
}
