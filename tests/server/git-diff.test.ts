import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectGitDiffArtifacts } from '../../src/server/git-diff'

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

function runGit(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}
