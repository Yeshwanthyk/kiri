import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
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

export type RustGitDiffCollector = (cwd: string) => RuntimeDiffArtifact[]

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
  readonly runRustCollector?: RustGitDiffCollector
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
} = {}): GitDiffServiceApi {
  const runGitCommand = input.runGit ?? runGit
  const runRustCollector = input.runRustCollector ?? collectRustGitDiffArtifacts
  const env = input.env ?? process.env
  const now = input.now ?? Date.now
  return {
    collectArtifacts: (cwd) => Effect.try({
      try: () => collectGitDiffArtifactsWith({
        cwd,
        env,
        runGit: runGitCommand,
        runRustCollector,
        now,
      }),
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
  return collectGitDiffArtifactsWith({
    cwd,
    env: process.env,
    runGit,
    runRustCollector: collectRustGitDiffArtifacts,
    now: Date.now,
  })
}

function collectGitDiffArtifactsWith(input: {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly runGit: GitCommandRunner
  readonly runRustCollector: RustGitDiffCollector
  readonly now: () => number
}): RuntimeDiffArtifact[] {
  const { cwd, env, runGit: runGitCommand, runRustCollector, now } = input
  const collectorMode = env.KIRI_GIT_DIFF_COLLECTOR?.trim().toLowerCase()
  if (collectorMode === 'rust') {
    try {
      return runRustCollector(cwd)
    } catch {
      // Keep the new collector as an opt-in acceleration path until parity is proven broadly.
    }
  }
  return collectGitDiffArtifactsWithTypeScript({ cwd, runGit: runGitCommand, now })
}

function collectGitDiffArtifactsWithTypeScript(input: {
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

export function collectRustGitDiffArtifacts(cwd: string): RuntimeDiffArtifact[] {
  const output = execFileSync(rustCollectorBinaryPath(), [cwd], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_COMMAND_TIMEOUT_MS + UNTRACKED_DIFF_BUDGET_MS + 1000,
  })
  return parseRustDiffCollectorOutput(output)
}

function rustCollectorBinaryPath() {
  const explicit = process.env.KIRI_GIT_DIFF_COLLECTOR_BIN?.trim()
  if (explicit) return explicit

  const binaryName = process.platform === 'win32'
    ? 'kiri-git-diff-collector.exe'
    : 'kiri-git-diff-collector'
  const candidates = [
    resolve(process.cwd(), 'target', 'debug', binaryName),
    resolve(process.cwd(), 'target', 'release', binaryName),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found
  return candidates[0]
}

function parseRustDiffCollectorOutput(output: string): RuntimeDiffArtifact[] {
  const parsed: unknown = JSON.parse(output)
  if (!Array.isArray(parsed)) {
    throw new Error('Rust git diff collector returned non-array JSON')
  }
  return parsed.map((item) => {
    if (!isRuntimeDiffArtifact(item)) {
      throw new Error('Rust git diff collector returned invalid artifact JSON')
    }
    return item
  })
}

function isRuntimeDiffArtifact(value: unknown): value is RuntimeDiffArtifact {
  if (!value || typeof value !== 'object') return false
  const artifact = value as Record<string, unknown>
  return typeof artifact.title === 'string'
    && typeof artifact.path === 'string'
    && typeof artifact.patch === 'string'
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
