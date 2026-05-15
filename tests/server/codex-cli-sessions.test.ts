import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findLatestCodexSessionForCwd,
  waitForLatestCodexSessionForCwd,
} from '~/server/codex-cli-sessions'

describe('Codex CLI session discovery', () => {
  it('finds the newest Codex session for the project cwd', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = resolve('/tmp/project')
    writeCodexSession(codexHome, '2026/05/14/rollout-old.jsonl', 'old-session', cwd, 1)
    writeCodexSession(codexHome, '2026/05/15/rollout-other.jsonl', 'other-session', '/tmp/other', 3)
    writeCodexSession(codexHome, '2026/05/15/rollout-new.jsonl', 'new-session', cwd, 5)

    expect(findLatestCodexSessionForCwd({ codexHome, cwd })).toBe('new-session')
  })

  it('ignores malformed session files and non-matching cwd values', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const sessionPath = join(codexHome, 'sessions/2026/05/15/rollout-malformed.jsonl')
    mkdirSync(dirname(sessionPath), { recursive: true })
    writeFileSync(sessionPath, 'not json\n')
    writeCodexSession(codexHome, '2026/05/15/rollout-other.jsonl', 'other-session', '/tmp/other', 5)

    expect(findLatestCodexSessionForCwd({ codexHome, cwd: '/tmp/project' })).toBeNull()
  })

  it('ignores stale sessions from earlier launches in the same cwd', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = '/tmp/project'
    writeCodexSession(codexHome, '2026/05/15/rollout-stale.jsonl', 'stale-session', cwd, 1)
    writeCodexSession(codexHome, '2026/05/15/rollout-current.jsonl', 'current-session', cwd, 10)

    expect(findLatestCodexSessionForCwd({
      codexHome,
      cwd,
      newerThanMs: 5_000,
    })).toBe('current-session')
  })

  it('returns null when only stale same-cwd sessions exist', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = '/tmp/project'
    writeCodexSession(codexHome, '2026/05/15/rollout-stale.jsonl', 'stale-session', cwd, 1)

    expect(findLatestCodexSessionForCwd({
      codexHome,
      cwd,
      newerThanMs: 5_000,
    })).toBeNull()
  })

  it('does not choose a Codex session when new same-cwd discovery is ambiguous', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = '/tmp/project'
    writeCodexSession(codexHome, '2026/05/15/rollout-first.jsonl', 'first-session', cwd, 10)
    writeCodexSession(codexHome, '2026/05/15/rollout-second.jsonl', 'second-session', cwd, 11)

    expect(findLatestCodexSessionForCwd({
      codexHome,
      cwd,
      newerThanMs: 5_000,
      requireUnique: true,
    })).toBeNull()
  })

  it('waits briefly for Codex to write session metadata after terminal launch', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'kiri-codex-home-'))
    const cwd = '/tmp/project'
    const pending = waitForLatestCodexSessionForCwd({
      codexHome,
      cwd,
      attempts: 10,
      intervalMs: 5,
    })
    setTimeout(() => writeCodexSession(codexHome, '2026/05/15/rollout-later.jsonl', 'later-session', cwd, 1), 10)

    await expect(pending).resolves.toBe('later-session')
  })
})

function writeCodexSession(
  codexHome: string,
  relativePath: string,
  id: string,
  cwd: string,
  mtimeSeconds: number,
) {
  const path = join(codexHome, 'sessions', relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({
    type: 'session_meta',
    payload: { id, cwd },
  })}\n`)
  const date = new Date(mtimeSeconds * 1000)
  utimesSync(path, date, date)
}
