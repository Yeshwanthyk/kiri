import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

const projectRoot = process.cwd()
const tempRoots: string[] = []
const modelRowsSchema = z.array(z.object({
  runtime: z.string(),
  model: z.string(),
  isDefault: z.boolean(),
  contextWindow: z.number().nullable(),
}))
const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  hidden: z.boolean(),
  sessionCount: z.number(),
})
const sessionSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  runtime: z.string(),
  model: z.string(),
  status: z.string(),
  preview: z.string(),
  messageCount: z.number(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
})

describe('kirictl', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('manages models, projects, and sessions through JSON commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'kirictl-'))
    tempRoots.push(root)
    const env = {
      ...process.env,
      KIRI_ROOT_DIR: root,
      KIRI_DB_PATH: join(root, 'kiri.sqlite'),
      KIRI_STATE_DIR: join(root, 'state'),
      KIRI_SETTINGS_PATH: resolve(projectRoot, 'settings.json'),
    }

    const models = modelRowsSchema.parse(runJson(env, ['models', 'list', '--runtime', 'pi', '--json']))
    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runtime: 'pi',
        model: 'openai-codex/gpt-5.5',
        isDefault: true,
      }),
    ]))

    const project = projectSummarySchema.parse(runJson(env, [
      'projects',
      'add',
      '--name',
      'CLI Project',
      '--cwd',
      projectRoot,
      '--id',
      'cli-project',
      '--json',
    ]))
    expect(project).toMatchObject({
      id: 'cli-project',
      name: 'CLI Project',
      hidden: false,
      sessionCount: 0,
    })

    const session = sessionSummarySchema.parse(runJson(env, [
      'sessions',
      'create',
      '--project',
      'cli-project',
      '--runtime',
      'pi',
      '--model',
      'openai-codex/gpt-5.5',
      '--title',
      'CLI Session',
      '--json',
    ]))
    expect(session).toMatchObject({
      projectId: 'cli-project',
      title: 'CLI Session',
      runtime: 'pi',
      model: 'openai-codex/gpt-5.5',
      archivedAt: null,
    })

    const renamed = sessionSummarySchema.parse(runJson(env, [
      'sessions',
      'rename',
      '--agent',
      session.id,
      '--title',
      'Renamed Session',
      '--json',
    ]))
    expect(renamed.title).toBe('Renamed Session')

    const archived = sessionSummarySchema.parse(runJson(env, [
      'sessions',
      'delete',
      '--agent',
      session.id,
      '--yes',
      '--json',
    ]))
    expect(archived.archivedAt).toEqual(expect.any(String))

    const restored = sessionSummarySchema.parse(runJson(env, [
      'sessions',
      'resume',
      '--agent',
      session.id,
      '--json',
    ]))
    expect(restored.archivedAt).toBeNull()
  }, 20_000)

  it('transfers legacy Aether state into an empty kiri database', () => {
    const root = mkdtempSync(join(tmpdir(), 'kirictl-legacy-'))
    tempRoots.push(root)
    const legacyStateDir = join(root, '.aether')
    const kiriStateDir = join(root, '.kiri', 'userdata')
    const legacyEnv = {
      ...process.env,
      KIRI_ROOT_DIR: root,
      KIRI_DB_PATH: join(legacyStateDir, 'aether.sqlite'),
      KIRI_STATE_DIR: legacyStateDir,
      KIRI_SETTINGS_PATH: resolve(projectRoot, 'settings.json'),
    }
    const kiriEnv = {
      ...process.env,
      KIRI_ROOT_DIR: root,
      KIRI_DB_PATH: join(kiriStateDir, 'kiri.sqlite'),
      KIRI_STATE_DIR: kiriStateDir,
      KIRI_SETTINGS_PATH: resolve(projectRoot, 'settings.json'),
    }

    runJson(legacyEnv, [
      'projects',
      'add',
      '--name',
      'Legacy Aether Project',
      '--cwd',
      projectRoot,
      '--id',
      'legacy-aether-project',
      '--json',
    ])
    const session = sessionSummarySchema.parse(runJson(legacyEnv, [
      'sessions',
      'create',
      '--project',
      'legacy-aether-project',
      '--runtime',
      'pi',
      '--model',
      'openai-codex/gpt-5.5',
      '--title',
      'Legacy Aether Session',
      '--json',
    ]))
    const legacySessionFile = attachLegacySessionFile(legacyEnv.KIRI_DB_PATH, session.id)

    const projects = z.array(projectSummarySchema).parse(runJson(kiriEnv, [
      'projects',
      'list',
      '--all',
      '--json',
    ]))
    expect(projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'legacy-aether-project',
        name: 'Legacy Aether Project',
      }),
    ]))
    expect(existsSync(join(kiriStateDir, 'kiri.sqlite'))).toBe(true)

    const migratedSession = readSessionPaths(kiriEnv.KIRI_DB_PATH, session.id)
    expect(migratedSession.sessionDir.startsWith(kiriStateDir)).toBe(true)
    expect(migratedSession.sessionFile).toBe(join(
      kiriStateDir,
      relativeLegacyPath(legacyStateDir, legacySessionFile),
    ))
    expect(existsSync(migratedSession.sessionFile)).toBe(true)
  }, 20_000)

  it('backs up a malformed kiri database before recovering from legacy Aether state', () => {
    const root = mkdtempSync(join(tmpdir(), 'kirictl-malformed-'))
    tempRoots.push(root)
    const legacyStateDir = join(root, '.aether')
    const kiriStateDir = join(root, '.kiri', 'userdata')
    const legacyEnv = {
      ...process.env,
      KIRI_ROOT_DIR: root,
      KIRI_DB_PATH: join(legacyStateDir, 'aether.sqlite'),
      KIRI_STATE_DIR: legacyStateDir,
      KIRI_SETTINGS_PATH: resolve(projectRoot, 'settings.json'),
    }
    const kiriEnv = {
      ...process.env,
      KIRI_ROOT_DIR: root,
      KIRI_DB_PATH: join(kiriStateDir, 'kiri.sqlite'),
      KIRI_STATE_DIR: kiriStateDir,
      KIRI_SETTINGS_PATH: resolve(projectRoot, 'settings.json'),
    }

    runJson(legacyEnv, [
      'projects',
      'add',
      '--name',
      'Recovered Legacy Project',
      '--cwd',
      projectRoot,
      '--id',
      'recovered-legacy-project',
      '--json',
    ])
    mkdirSync(kiriStateDir, { recursive: true })
    writeFileSync(kiriEnv.KIRI_DB_PATH, 'not a sqlite database')
    writeFileSync(`${kiriEnv.KIRI_DB_PATH}-wal`, 'stale wal')

    const projects = z.array(projectSummarySchema).parse(runJson(kiriEnv, [
      'projects',
      'list',
      '--all',
      '--json',
    ]))
    expect(projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'recovered-legacy-project',
      }),
    ]))

    const stateFiles = new Set(readdirStateFiles(kiriStateDir))
    expect([...stateFiles].some((name) => name.startsWith('kiri.sqlite.malformed-'))).toBe(true)
    expect([...stateFiles].some((name) => name.startsWith('kiri.sqlite-wal.malformed-'))).toBe(true)
  }, 20_000)
})

function runJson(env: NodeJS.ProcessEnv, args: string[]) {
  const output = execFileSync(
    'pnpm',
    ['exec', 'tsx', 'src/cli/kirictl.ts', ...args],
    {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
    },
  )
  return JSON.parse(output) as unknown
}

function attachLegacySessionFile(dbPath: string, agentId: string) {
  const database = new DatabaseSync(dbPath)
  try {
    const row = database
      .prepare('SELECT session_dir AS sessionDir FROM agent_slots WHERE id = ?')
      .get(agentId) as { sessionDir: string }
    const sessionFile = join(row.sessionDir, 'legacy-session.jsonl')
    mkdirSync(dirname(sessionFile), { recursive: true })
    writeFileSync(sessionFile, '{"type":"message"}\n')
    database
      .prepare('UPDATE agent_slots SET session_file = ? WHERE id = ?')
      .run(sessionFile, agentId)
    return sessionFile
  } finally {
    database.close()
  }
}

function readSessionPaths(dbPath: string, agentId: string) {
  const database = new DatabaseSync(dbPath)
  try {
    return database
      .prepare('SELECT session_dir AS sessionDir, session_file AS sessionFile FROM agent_slots WHERE id = ?')
      .get(agentId) as { sessionDir: string, sessionFile: string }
  } finally {
    database.close()
  }
}

function relativeLegacyPath(legacyStateDir: string, filePath: string) {
  return filePath.slice(resolve(legacyStateDir).length + 1)
}

function readdirStateFiles(stateDir: string) {
  const paths = execFileSync('find', [stateDir, '-maxdepth', '1', '-type', 'f', '-print'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
  const files: string[] = []
  for (const path of paths) {
    if (path) files.push(basename(path))
  }
  return files
}
