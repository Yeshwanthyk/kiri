import { expect, test } from '@playwright/test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startFakeCodexAppServer } from '../harness/fake-codex-app-server.mjs'

test.describe.configure({ mode: 'serial' })

const testDbPath = resolve(process.env.KIRI_DB_PATH ?? '.kiri/kiri.e2e.sqlite')
const projectRoot = process.cwd()
const fileOperationFixturePath = resolve(projectRoot, 'src/kiri-file-operation-e2e.tmp')
const detailFixturePath = resolve(projectRoot, 'src/detail.ts')
let fakeCodexServer: Awaited<ReturnType<typeof startFakeCodexAppServer>>

test.beforeAll(async () => {
  fakeCodexServer = await startFakeCodexAppServer({ port: 39111 })
})

test.afterAll(async () => {
  await fakeCodexServer?.close()
})

test.beforeEach(async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('kiri:terminal-transcript', '1')
  })
  if (fakeCodexServer) fakeCodexServer.requests.length = 0
  rmSync(fileOperationFixturePath, { force: true })
  rmSync(detailFixturePath, { force: true })
  mkdirSync(dirname(testDbPath), { recursive: true })
  rmSync(resolve(projectRoot, '.kiri', 'pi-sessions', 'e2e-kiri'), {
    force: true,
    recursive: true,
  })
  rmSync(resolve(projectRoot, '.kiri', 'codex-home'), {
    force: true,
    recursive: true,
  })
  const database = new DatabaseSync(testDbPath)
  resetE2eDatabase(database)
  if (testInfo.title !== 'empty workspace starts with an add-project path') {
    database.exec(`
    INSERT INTO projects (id, name, cwd, position)
    VALUES ('e2e-kiri', 'kiri Orchestrator', '${projectRoot.replaceAll("'", "''")}', 0);
    INSERT INTO projects (id, name, cwd, position)
    VALUES ('test-reference', 'Test Reference', '/Users/yesh/Documents/personal/reference/test', 1);
  `)
  }
  database.close()

  await page.goto('/')
  if (testInfo.title === 'empty workspace starts with an add-project path') {
    await expect(page.getByTestId('empty-project-state')).toHaveAttribute('data-hydrated', 'true')
  } else {
    await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  }
})

function resetE2eDatabase(database: DatabaseSync) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      position INTEGER NOT NULL,
      hidden_at TEXT
    );
  `)

  const tables = [
    'agent_context_usage',
    'diff_artifacts',
    'timeline_events',
    'messages',
    'threads',
    'deleted_sessions',
    'agent_slots',
    'projects',
  ]
  for (const table of tables) {
    if (tableExists(database, table)) {
      database.exec(`DELETE FROM ${table}`)
    }
  }
}

function tableExists(database: DatabaseSync, table: string) {
  return Boolean(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  )
}

test.afterEach(() => {
  rmSync(fileOperationFixturePath, { force: true })
  rmSync(detailFixturePath, { force: true })
})

test('empty workspace starts with an add-project path', async ({ page }) => {
  await expect(page.getByTestId('empty-project-state')).toHaveAttribute('data-hydrated', 'true')
  await page.getByTestId('empty-add-project').click()
  await page.getByTestId('project-name-input').fill('Current Repo')
  await page.getByTestId('project-cwd-input').fill(projectRoot)
  await page.getByTestId('project-id-input').fill('current-repo')
  await page.getByLabel('Project manager').getByRole('button', { name: 'Add project' }).click()

  await expect(page.getByTestId('selected-project').first()).toHaveText('Current Repo')
  await expect(page.getByTestId('selected-agent').first()).toHaveText('No session')
})

test('keyboard navigation moves projects without default sessions', async ({ page, isMobile }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  const firstProject = await page.getByTestId('selected-project').textContent()
  await expect(page.getByTestId('selected-project')).toContainText(/kiri/i)
  await expect(page.getByTestId('selected-agent')).toHaveText('No session')
  if (!isMobile) {
    await expect(page.getByTestId('empty-project-sessions').first()).toBeVisible()
  }

  await pressShiftKey(page, 'KeyJ')
  await expect(page.getByTestId('selected-project')).not.toHaveText(firstProject ?? '')
  await expect(page.getByTestId('selected-agent')).toHaveText('No session')

  await pressShiftKey(page, 'KeyK')
  await expect(page.getByTestId('selected-project')).toContainText(/kiri/i)
})

test('keymap settings remap navigation', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  const firstProject = await page.getByTestId('selected-project').textContent()

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByTestId('keymap-focusChat')).toBeVisible()
  await expect(page.getByTestId('keymap-openDiffs')).toBeVisible()
  await page.getByTestId('keymap-projectNext').selectOption('arrowdown')
  await page.getByRole('button', { name: 'Back to board' }).click()

  await pressShiftKey(page, 'KeyJ')
  await expect(page.getByTestId('selected-project')).toContainText(/kiri/i)

  await pressShiftKey(page, 'ArrowDown')
  await expect(page.getByTestId('selected-project')).not.toHaveText(firstProject ?? '')
})

test('start and remove session with keymaps', async ({ page }, testInfo) => {
  const title = `E2E Session ${testInfo.project.name}`

  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  await pressShiftKey(page, 'KeyN')
  await expect(page.getByTestId('session-launcher')).toBeVisible()

  const sessionModel = page.getByTestId('session-model')
  await expectRuntimeSelected(page, 'codex')
  await expect(sessionModel).toContainText('gpt-5.5')

  await clickRuntime(page, 'claude')
  await expectRuntimeSelected(page, 'claude')
  await expect(sessionModel).toContainText('claude-opus-4-7')
  await page.getByTestId('session-title').fill(title)
  await page
    .getByTestId('session-launcher')
    .getByRole('button', { name: /^Start .* session$/ })
    .click()

  await expect(page.getByTestId('selected-agent')).toHaveText(title)

  await pressShiftKey(page, 'KeyX')
  await expect(page.getByTestId('confirm-dialog')).toContainText(title)
  await page.getByTestId('confirm-dialog-confirm').click()

  await expect(page.getByTestId('selected-agent')).toHaveText('No session')
  await expect(page.getByTestId('board-pane')).not.toContainText(title)
})

test('session launcher resumes an existing local session', async ({ page }, testInfo) => {
  const firstTitle = `Resume First ${testInfo.project.name}`
  const secondTitle = `Resume Second ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, firstTitle)
  await createSession(page, secondTitle)
  await expect(page.getByTestId('selected-agent')).toHaveText(secondTitle)

  await pressShiftKey(page, 'KeyN')
  await page.getByTestId('session-launcher').getByRole('tab', { name: 'Resume' }).click()
  await page.getByTestId('session-launcher').getByRole('button', { name: new RegExp(firstTitle) }).click()

  await expect(page.getByTestId('selected-agent')).toHaveText(firstTitle)
  await expect(page.getByTestId('session-launcher')).toBeHidden()
})

test('removed sessions are archived and can be restored from resume', async ({ page }, testInfo) => {
  const title = `Archived Session ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  await pressShiftKey(page, 'KeyX')
  await expect(page.getByTestId('confirm-dialog')).toContainText(title)
  await page.getByTestId('confirm-dialog-confirm').click()
  await expect(page.getByTestId('selected-agent')).toHaveText('No session')
  await expect(page.getByTestId('board-pane')).not.toContainText(title)

  await pressShiftKey(page, 'KeyN')
  await page.getByTestId('session-launcher').getByRole('tab', { name: 'Resume' }).click()
  await expect(page.getByTestId('session-launcher')).toContainText('archived')
  await page.getByTestId('session-launcher').getByRole('button', { name: new RegExp(title) }).click()

  await expect(page.getByTestId('selected-agent')).toHaveText(title)
  await expect(page.getByTestId('board-pane')).toContainText(title)
})

test('shift delete removes the selected session, not the first session', async ({ page }, testInfo) => {
  const firstTitle = `Delete First ${testInfo.project.name}`
  const secondTitle = `Delete Second ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, firstTitle)
  await createSession(page, secondTitle)

  await page.getByTestId('agent-cell').filter({ hasText: firstTitle }).dispatchEvent('click')
  await expect(page.getByTestId('selected-agent')).toHaveText(firstTitle)
  await page.getByTestId('agent-cell').filter({ hasText: secondTitle }).dispatchEvent('click')
  await expect(page.getByTestId('selected-agent')).toHaveText(secondTitle)

  await pressShiftKey(page, 'KeyX')
  await expect(page.getByTestId('confirm-dialog')).toContainText(secondTitle)
  await page.getByTestId('confirm-dialog-confirm').click()

  await expect(page.getByTestId('board-pane')).toContainText(firstTitle)
  await expect(page.getByTestId('board-pane')).not.toContainText(secondTitle)
})

test('session launcher keeps runtime presets isolated from normal starts', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  await page.keyboard.press('Control+K')
  await page.getByTestId('command-search').fill('Start Claude in kiri')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('session-launcher')).toBeVisible()
  await expectRuntimeSelected(page, 'claude')
  await expect(page.getByTestId('session-model')).toContainText('claude-opus-4-7')
  await expect(page.getByTestId('session-interface-mode').getByRole('button')).toHaveCount(1)
  await expect(page.getByTestId('session-interface-mode').getByRole('button', { name: 'Terminal' })).toBeVisible()

  await page.keyboard.press('Escape')
  await pressShiftKey(page, 'KeyN')
  await expect(page.getByTestId('session-launcher')).toBeVisible()
  await expectRuntimeSelected(page, 'codex')
})

test('command menu starts, switches, and ends sessions', async ({ page }, testInfo) => {
  const firstTitle = `Command First ${testInfo.project.name}`
  const secondTitle = `Command Second ${testInfo.project.name}`

  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  await page.keyboard.press('Control+K')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('settings-page')).toBeVisible()
  await page.getByRole('button', { name: 'Back to board' }).click()

  await page.keyboard.press('Control+K')
  await page.getByTestId('command-search').fill('start')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('session-launcher')).toBeVisible()
  await page.getByTestId('session-title').fill(firstTitle)
  await page
    .getByTestId('session-launcher')
    .getByRole('button', { name: /^Start .* session$/ })
    .click()

  await expect(page.getByTestId('selected-agent')).toHaveText(firstTitle)
  await createSession(page, secondTitle)

  await page.keyboard.press('Control+K')
  await page.getByTestId('command-search').fill(firstTitle)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('selected-agent')).toHaveText(firstTitle)

  await page.keyboard.press('Control+K')
  await page.getByTestId('command-search').fill('end selected')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('confirm-dialog')).toContainText(firstTitle)
  await page.getByTestId('confirm-dialog-confirm').click()

  await expect(page.getByTestId('board-pane')).not.toContainText(firstTitle)
  await expect(page.getByTestId('selected-agent')).toHaveText(secondTitle)
})

test('projects panel adds, hides, and unhides projects', async ({ page, isMobile }, testInfo) => {
  const id = `e2e-${testInfo.project.name}`
  const name = `E2E ${testInfo.project.name}`

  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  await page.getByRole('button', { name: 'Projects' }).click()
  await page.getByTestId('project-name-input').fill(name)
  await page
    .getByTestId('project-cwd-input')
    .fill(projectRoot)
  await page.getByTestId('project-id-input').fill(id)
  await page.getByRole('button', { name: 'Add' }).click()

  await expect(page.getByTestId('project-settings-list')).toContainText(name)
  await page.getByRole('button', { name: `Move ${name} up` }).click()
  await page.getByRole('button', { name: `Move ${name} up` }).click()
  await expect(page.locator('[data-testid="project-settings-list"] .project-settings-row').first()).toContainText(name)
  await page.getByRole('button', { name: 'Close projects' }).click()
  await expect(page.getByTestId('board-pane')).toContainText(name)
  await page.reload()
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  await page.getByRole('button', { name: 'Projects' }).click()
  await expect(page.locator('[data-testid="project-settings-list"] .project-settings-row').first()).toContainText(name)

  await page.getByTestId('project-settings-list').getByRole('button', { name: `Hide ${name}` }).click()
  await expect(page.getByTestId('project-settings-list')).not.toContainText(name)
  await expect(page.getByTestId('hidden-project-list')).toContainText(name)
  await page.getByRole('button', { name: 'Close projects' }).click()
  await expect(page.getByTestId('board-grid')).not.toContainText(name)

  if (isMobile) {
    await page.keyboard.press('Control+K')
    await page.getByTestId('command-search').fill(`unhide ${name}`)
    await page.keyboard.press('Enter')
  } else {
    await expect(page.getByTestId('hidden-project-shelf')).toContainText(name)
    await page.getByRole('button', { name: `Restore ${name}` }).click()
    await expect(page.getByTestId('board-grid')).toContainText(name)

    await page.getByTestId('board-pane').getByRole('button', { name: `Hide ${name}` }).click()
    await expect(page.getByTestId('hidden-project-shelf')).toContainText(name)
    await page.getByRole('button', { name: `Restore ${name}` }).click()
  }
  await expect(page.getByTestId('board-grid')).toContainText(name)

  await page.keyboard.press('Control+K')
  await page.getByTestId('command-search').fill(`remove ${name}`)
  const removeCommand = page.getByRole('button', { name: `Remove ${name}` })
  await expect(removeCommand).toBeVisible()
  await removeCommand.click()
  await expect(page.getByTestId('confirm-dialog')).toContainText('project directory and files stay on disk')
  await page.getByTestId('confirm-dialog-cancel').click()
  await expect(page.getByTestId('board-pane')).toContainText(name)

  await page.getByRole('button', { name: 'Projects' }).click()
  await page.getByRole('button', { name: `Remove ${name}` }).click()
  await expect(page.getByTestId('confirm-dialog')).toContainText('project directory and files stay on disk')
  await page.getByTestId('confirm-dialog-confirm').click()
  await expect(page.getByTestId('project-settings-list')).not.toContainText(name)
  await page.getByRole('button', { name: 'Close projects' }).click()
  await expect(page.getByTestId('board-pane')).not.toContainText(name)
})

test('chat composer accepts and records input', async ({ page }, testInfo) => {
  const title = `Chat Session ${testInfo.project.name}`
  const text = `hello from ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  await page.getByTestId('chat-input').fill(text)
  await page.getByRole('button', { name: 'Send prompt' }).click()

  await expect(page.getByTestId('chat-panel')).toContainText(text, {
    timeout: 30_000,
  })
  await expect(page.getByTestId('chat-input')).toHaveValue('')
})

test('codex runtime runs through app-server harness', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const title = `Codex Session ${testInfo.project.name}`
  const text = `hello codex ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title, 'codex', 'low')

  await page.getByTestId('chat-input').fill(text)
  await page.getByRole('button', { name: 'Send prompt' }).click()

  await expect(page.getByTestId('chat-panel')).toContainText(text, {
    timeout: 30_000,
  })
  await expect(page.getByTestId('chat-panel')).toContainText(`fake codex received: ${text}`, {
    timeout: 30_000,
  })
  await expect(page.locator('.context-chip')).toHaveAttribute(
    'title',
    /45 \/ 258,000 tokens used/,
  )

  const fileOperationText = `please perform file operation ${testInfo.project.name}`
  await page.getByTestId('chat-input').fill(fileOperationText)
  await page.getByRole('button', { name: 'Send prompt' }).click()
  await expect(page.getByLabel('Runtime activity').last()).toBeVisible({
    timeout: 30_000,
  })
  await expect.poll(() => diffPathsForSessionTitle(title), {
    timeout: 30_000,
  }).toContain('src/kiri-file-operation-e2e.tmp')
  await showLatestActivity(page)
  await expect(page.getByTestId('chat-panel')).toContainText('Edited')

  const requests = fakeCodexServer.requests as CodexHarnessRequest[]
  expect(requests.some((request) => request.method === 'initialize')).toBe(true)
  expect(requests.some((request) => request.method === 'thread/start')).toBe(true)
  expect(requests.some((request) => request.method === 'turn/start')).toBe(true)
  const firstReadWithTurnsIndex = requests.findIndex((request) => (
    request.method === 'thread/read' && request.params?.includeTurns !== false
  ))
  const fallbackReadWithoutTurnsIndex = requests.findIndex((request) => (
    request.method === 'thread/read' && request.params?.includeTurns === false
  ))
  const firstTurnStartIndex = requests.findIndex((request) => request.method === 'turn/start')
  expect(firstReadWithTurnsIndex).toBeGreaterThanOrEqual(0)
  expect(fallbackReadWithoutTurnsIndex).toBeGreaterThan(firstReadWithTurnsIndex)
  expect(firstTurnStartIndex).toBeGreaterThan(fallbackReadWithoutTurnsIndex)
  expect(requests.find((request) => request.method === 'thread/start')?.params?.sandbox)
    .toBe('danger-full-access')
  expect(turnStartRequests(requests).at(-1)?.params.sandboxPolicy)
    .toEqual({ type: 'dangerFullAccess' })
  expect(turnStartRequests(requests).at(-1)?.params.effort).toBe('low')

  const compactWithoutUsageText = `compact without usage ${testInfo.project.name}`
  await page.getByTestId('chat-input').fill(compactWithoutUsageText)
  await page.getByRole('button', { name: 'Send prompt' }).click()
  await expect(page.getByTestId('chat-panel')).toContainText(
    `fake codex received: ${compactWithoutUsageText}`,
    { timeout: 30_000 },
  )
  await showLatestActivity(page)
  await expect(page.getByTestId('chat-panel')).toContainText('Context compacted')
  await expect(page.locator('.context-chip')).toHaveCount(0)

  await page.getByTestId('chat-input').fill('/thinking high')
  await page.getByRole('button', { name: 'Send prompt' }).click()
  await expect(page.getByTestId('thinking-level')).toContainText('Thinking high')

  const secondText = `hello codex high ${testInfo.project.name}`
  await page.getByTestId('chat-input').fill(secondText)
  await page.getByRole('button', { name: 'Send prompt' }).click()
  await expect(page.getByTestId('chat-panel')).toContainText(`fake codex received: ${secondText}`, {
    timeout: 30_000,
  })
  expect(turnStartRequests(requests).at(-1)?.params.effort).toBe('high')

  const compactText = `please compact context ${testInfo.project.name}`
  await page.getByTestId('chat-input').fill(compactText)
  await page.getByRole('button', { name: 'Send prompt' }).click()
  await expect(page.getByTestId('chat-panel')).toContainText(`fake codex received: ${compactText}`, {
    timeout: 30_000,
  })
  await showLatestActivity(page)
  await expect(page.getByTestId('chat-panel')).toContainText('Context compacted')
  await expect(page.locator('.context-chip')).toHaveAttribute(
    'title',
    /18 \/ 258,000 tokens used/,
  )

  await page.getByTestId('chat-input').fill('/review')
  await page.getByRole('button', { name: 'Send prompt' }).click()
  await expect(page.getByTestId('chat-panel')).toContainText(
    'fake codex reviewed: uncommitted changes',
    { timeout: 30_000 },
  )

  await page.getByTestId('chat-input').fill('/review base main')
  await page.getByRole('button', { name: 'Send prompt' }).click()
  await expect(page.getByTestId('chat-panel')).toContainText('fake codex reviewed: base main', {
    timeout: 30_000,
  })

  const reviewRequests = requests.filter((request) => request.method === 'review/start')
  expect(reviewRequests.at(-2)?.params?.target).toEqual({ type: 'uncommittedChanges' })
  expect(reviewRequests.at(-1)?.params?.target).toEqual({ type: 'baseBranch', branch: 'main' })
})

test('codex runtime replaces a missing rollout thread on first prompt', async ({ page }, testInfo) => {
  const title = `Missing Rollout ${testInfo.project.name}`
  const text = `first prompt after missing rollout ${testInfo.project.name}`
  const missingThreadId = `missing-rollout-${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title, 'codex', 'low')

  const database = new DatabaseSync(testDbPath)
  database
    .prepare('UPDATE agent_slots SET runtime_state_json = ? WHERE title = ?')
    .run(JSON.stringify({
      threadId: missingThreadId,
      websocketUrl: 'ws://127.0.0.1:39111',
    }), title)
  database.close()

  await page.getByTestId('chat-input').fill(text)
  await page.getByRole('button', { name: 'Send prompt' }).click()

  await expect(page.getByTestId('chat-panel')).toContainText(`fake codex received: ${text}`, {
    timeout: 30_000,
  })

  const requests = fakeCodexServer.requests as CodexHarnessRequest[]
  const missingReadIndex = requests.findIndex((request) => (
    request.method === 'thread/read' && request.params?.threadId === missingThreadId
  ))
  const newThreadStartIndex = requests.findIndex((request) => request.method === 'thread/start')
  const turnStartIndex = requests.findIndex((request) => request.method === 'turn/start')
  expect(missingReadIndex).toBeGreaterThanOrEqual(0)
  expect(newThreadStartIndex).toBeGreaterThan(missingReadIndex)
  expect(turnStartIndex).toBeGreaterThan(newThreadStartIndex)
})

test('sidebar switches between chat, diffs, and terminal', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop sidebar tabs only')
  const title = `Sidebar Session ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  await page.getByRole('button', { name: 'Diffs' }).click()
  await expect(page.getByTestId('diff-panel')).toContainText('No diffs')

  await page.getByTestId('tab-terminal').click()
  await expect(page.getByTestId('terminal-panel')).toContainText('Connected', { timeout: 10_000 })
  await page
    .getByTestId('terminal-panel')
    .getByRole('textbox', { name: 'Terminal input' })
    .first()
    .click()
  const terminalInput = page
    .getByTestId('terminal-panel')
    .getByRole('textbox', { name: 'Terminal input' })
    .first()
  await page.keyboard.type('pwd')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('terminal-transcript')).toContainText(projectRoot)

  await expect(terminalInput).toBeFocused()
  await page.keyboard.down('Shift')
  await page.keyboard.press('Tab')
  await page.keyboard.up('Shift')
  await expect(terminalInput).not.toBeFocused()
  await page.keyboard.down('Shift')
  await page.keyboard.press('Tab')
  await page.keyboard.up('Shift')
  await expect(terminalInput).toBeFocused()
  await page.keyboard.down('Shift')
  await page.keyboard.press('Tab')
  await page.keyboard.up('Shift')
  await expect(terminalInput).not.toBeFocused()
  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyC')
  await page.keyboard.up('Shift')
  await expect(page.getByTestId('chat-panel')).toBeVisible()
  await expect(page.getByTestId('chat-input')).toBeFocused()
})

test('terminal preserves running shell across sidebar tab switches', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop sidebar tabs only')
  const title = `Terminal Persistence ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  await page.getByTestId('tab-terminal').click()
  await expect(page.getByTestId('terminal-panel')).toContainText('Connected', { timeout: 10_000 })
  const terminalInput = page
    .getByTestId('terminal-panel')
    .getByRole('textbox', { name: 'Terminal input' })
    .first()
  await terminalInput.click()
  await page.keyboard.type(
    'export KIRI_E2E_MARKER=tab-preserved; cd src; sleep 30 & export KIRI_E2E_PID=$!; echo ready:$KIRI_E2E_MARKER:$PWD:$KIRI_E2E_PID',
  )
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('terminal-transcript')).toContainText(
    `ready:tab-preserved:${projectRoot}/src`,
  )

  await page.getByTestId('tab-chat').click()
  await expect(page.getByTestId('chat-panel')).toBeVisible()
  await page.getByTestId('tab-terminal').click()
  await expect(page.getByTestId('terminal-panel')).toBeVisible()
  await terminalInput.click()
  await page.keyboard.type(
    'kill -0 "$KIRI_E2E_PID" && echo preserved:$KIRI_E2E_MARKER:$PWD; kill "$KIRI_E2E_PID"',
  )
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('terminal-transcript')).toContainText(
    `preserved:tab-preserved:${projectRoot}/src`,
  )
})

test('terminal interface sessions render the agent runtime in chat and shell in terminal tab', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop sidebar tabs only')
  const title = `Terminal Interface ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title, 'claude', 'medium')

  await expect(page.getByTestId('terminal-panel')).toContainText('Connected', { timeout: 10_000 })
  await expect(page.getByTestId('terminal-panel')).toContainText('Agent terminal')
  await expect(page.getByTestId('terminal-transcript')).toContainText('kiri agent terminal')

  await page.getByTestId('tab-terminal').click()
  await expect(page.getByTestId('terminal-panel')).toContainText('Shell terminal')
  await page
    .getByTestId('terminal-panel')
    .getByRole('textbox', { name: 'Terminal input' })
    .first()
    .click()
  await page.keyboard.type('pwd')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('terminal-transcript')).toContainText(projectRoot)
})

test('codex terminal interface resumes after the PTY exits and keeps diffs available', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop terminal interface flow')
  const title = `Codex Terminal Resume ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title, 'codex', 'low', 'terminal')

  await expect(page.getByTestId('terminal-panel')).toContainText('Connected', { timeout: 10_000 })
  await expect(page.getByTestId('terminal-panel')).toContainText('Agent terminal')
  await expect(page.getByTestId('terminal-transcript')).toContainText('mode:fresh')
  const freshTranscript = await page.getByTestId('terminal-transcript').textContent()
  const sessionId = freshTranscript?.match(/session:(fake-session-[^\s]+)/)?.[1]
  if (!sessionId) throw new Error('Fake Codex terminal session id was not rendered')

  let terminalInput = page
    .getByTestId('terminal-panel')
    .getByRole('textbox', { name: 'Terminal input' })
    .first()
  await terminalInput.click()
  await page.keyboard.type('remember alpha')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('terminal-transcript')).toContainText(`remembered:alpha:session:${sessionId}`)
  await expect
    .poll(async () => readAgentRuntimeState(title)?.codexSessionId)
    .toBe(sessionId)

  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('terminal-transcript')).toContainText('bye session:')

  await page.getByTestId('tab-terminal').click()
  await expect(page.getByTestId('terminal-panel')).toContainText('Shell terminal')
  await page.getByTestId('tab-chat').click()
  await expect(page.getByTestId('terminal-transcript')).toContainText('mode:resume')
  await expect(page.getByTestId('terminal-transcript')).toContainText(`session:${sessionId}`)

  terminalInput = page
    .getByTestId('terminal-panel')
    .getByRole('textbox', { name: 'Terminal input' })
    .first()
  await terminalInput.click()
  await page.keyboard.type('state')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('terminal-transcript')).toContainText(`state:alpha:session:${sessionId}:mode:resume`)

  writeFileSync(fileOperationFixturePath, 'codex terminal diff\n')
  await page.getByTestId('tab-diffs').click()
  await expect
    .poll(async () => diffPathsForSessionTitle(title).includes('src/kiri-file-operation-e2e.tmp'))
    .toBe(true)
  await expect(page.getByTestId('diff-panel')).toContainText('Changed files')
})

test('selected agent detail loads chat, diffs, and local drafts', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop selected-agent detail flow')
  const detailAgentId = 'agent-detail-e2e'
  const otherAgentId = 'agent-detail-other'

  seedSessionWithDetail({
    agentId: detailAgentId,
    slot: 'session-detail',
    title: 'Detail Session',
    messageText: 'seeded detail assistant tail',
  })
  seedSessionWithDetail({
    agentId: otherAgentId,
    slot: 'session-other',
    title: 'Other Session',
    messageText: 'other session body',
    position: 1,
  })

  await page.goto('/')
  await expect(page.getByTestId('selected-agent')).toHaveText('Detail Session')
  await expect(page.getByTestId('chat-panel')).toContainText('seeded detail assistant tail')

  await page.getByRole('button', { name: 'Diffs' }).click()
  await expect(page.getByTestId('diff-panel')).toContainText('1 file')
  await expect(page.getByTestId('diff-panel')).toContainText('src/detail.ts')

  await page.getByRole('button', { name: 'Chat' }).click()
  await page.getByTestId('chat-input').fill('local unsent draft')
  await page.getByRole('button', { name: 'Other Session' }).click()
  await expect(page.getByTestId('chat-input')).toHaveValue('')
  await page.getByRole('button', { name: 'Detail Session' }).click()
  await expect(page.getByTestId('chat-input')).toHaveValue('local unsent draft')
  await expect(page.evaluate(() => sessionStorage.getItem('kiri:chat-drafts:v1')))
    .resolves.toContain(detailAgentId)
})

test('escape leaves chat composer so board keymaps work', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop board keymaps only')
  const title = `Escape Session ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  const firstProject = await page.getByTestId('selected-project').textContent()
  await page.getByTestId('chat-input').focus()
  await expect(page.getByTestId('chat-input')).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('chat-input')).not.toBeFocused()

  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyJ')
  await page.keyboard.up('Shift')
  await expect(page.getByTestId('selected-project')).not.toHaveText(firstProject ?? '')
})

test('escape leaves scratchpad input so sidebar keymaps work', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop sidebar keymaps only')
  const title = `Scratchpad Escape Session ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  await page.getByTestId('tab-scratchpad').click()
  await page.getByTestId('scratchpad-input').focus()
  await expect(page.getByTestId('scratchpad-input')).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('scratchpad-input')).not.toBeFocused()
  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyD')
  await page.keyboard.up('Shift')
  await expect(page.getByTestId('diff-panel')).toContainText('No diffs')
})

test('agent switching does not refocus chat after explicit chat focus', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop agent switching only')
  const firstTitle = `First Session ${testInfo.project.name}`
  const secondTitle = `Second Session ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, firstTitle)
  await createSession(page, secondTitle)

  await pressShiftKey(page, 'KeyC')
  await expect(page.getByTestId('chat-input')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('chat-input')).not.toBeFocused()

  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyH')
  await page.keyboard.up('Shift')

  await expect(page.getByTestId('selected-agent')).toHaveText(firstTitle)
  await expect(page.getByTestId('chat-input')).not.toBeFocused()
})

test('mobile layout keeps navigation and sidebar usable', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile project only')

  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  await expect(page.getByTestId('board-pane')).not.toBeVisible()
  await expect(page.getByTestId('sidebar-pane')).toBeVisible()
  await expect(page.getByLabel('Mobile navigation')).toBeVisible()
  await expect(page.getByTestId('selected-agent')).toHaveText('No session')
})

async function createSession(
  page: import('@playwright/test').Page,
  title: string,
  runtime: 'pi' | 'codex' | 'claude' = 'pi',
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
  interfaceMode: 'gui' | 'terminal' = 'gui',
) {
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  await pressShiftKey(page, 'KeyN')
  await clickRuntime(page, runtime)
  await clickInterfaceMode(page, runtime === 'claude' ? 'terminal' : interfaceMode)
  if (thinkingLevel) {
    await clickThinkingLevel(page, thinkingLevel)
  }
  await page.getByTestId('session-title').fill(title)
  await page
    .getByTestId('session-launcher')
    .getByRole('button', { name: /^Start .* session$/ })
    .click()
  await expect(page.getByTestId('selected-agent')).toHaveText(title)
}

async function clickInterfaceMode(
  page: import('@playwright/test').Page,
  interfaceMode: 'gui' | 'terminal',
) {
  await page
    .getByTestId('session-interface-mode')
    .getByRole('button', { name: interfaceMode === 'gui' ? 'GUI' : 'Terminal' })
    .click()
}

const runtimeLabels = {
  codex: 'Codex',
  pi: 'Pi',
  claude: 'Claude',
} as const

async function clickRuntime(
  page: import('@playwright/test').Page,
  runtime: 'pi' | 'codex' | 'claude',
) {
  await page
    .getByTestId('session-runtime')
    .getByRole('button', { name: new RegExp(`^${runtimeLabels[runtime]}\\b`) })
    .click()
}

async function expectRuntimeSelected(
  page: import('@playwright/test').Page,
  runtime: 'pi' | 'codex' | 'claude',
) {
  await expect(
    page
      .getByTestId('session-runtime')
      .getByRole('button', { name: new RegExp(`^${runtimeLabels[runtime]}\\b`) }),
  ).toHaveAttribute('aria-pressed', 'true')
}

async function clickThinkingLevel(
  page: import('@playwright/test').Page,
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
) {
  await page
    .getByTestId('session-thinking-level')
    .getByRole('button', { name: thinkingLevel })
    .click()
}

function seedSessionWithDetail(input: {
  agentId: string
  slot: string
  title: string
  messageText: string
  position?: number
}) {
  const escapedTitle = input.title.replaceAll("'", "''")
  const escapedMessage = input.messageText.replaceAll("'", "''")
  const timestamp = new Date().toISOString()
  const threadId = `${input.agentId}-thread`
  writeFileSync(detailFixturePath, 'export const detail = true\n')
  const patch = [
    'diff --git a/src/detail.ts b/src/detail.ts',
    'index 0000000..1111111 100644',
    '--- a/src/detail.ts',
    '+++ b/src/detail.ts',
    '@@ -1 +1 @@',
    '-export const detail = false',
    '+export const detail = true',
    '',
  ].join('\n').replaceAll("'", "''")
  const database = new DatabaseSync(testDbPath)
  database.exec(`
    PRAGMA foreign_keys = ON;
    INSERT INTO agent_slots (
      id, project_id, slot, title, runtime, model, status,
      session_dir, session_file, position
    )
    VALUES (
      '${input.agentId}', 'e2e-kiri', '${input.slot}', '${escapedTitle}',
      'pi', 'openai-codex/gpt-5.5', 'idle',
      '${projectRoot.replaceAll("'", "''")}', NULL, ${input.position ?? 0}
    );
    INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
    VALUES ('${threadId}', '${input.agentId}', 1, '${escapedMessage}', 1, '${timestamp}');
    INSERT INTO messages (id, thread_id, role, text, timestamp)
    VALUES ('${input.agentId}-message', '${threadId}', 'assistant', '${escapedMessage}', '${timestamp}');
    INSERT INTO timeline_events (
      id, thread_id, kind, tone, label, detail, timestamp, payload_json
    )
    VALUES (
      '${input.agentId}-event', '${threadId}', 'tool_use', 'tool',
      'Read', 'src/detail.ts', '${timestamp}', '{}'
    );
    INSERT INTO diff_artifacts (id, agent_id, title, path, patch, updated_at)
    VALUES (
      '${input.agentId}-diff', '${input.agentId}', 'src/detail.ts',
      'src/detail.ts', '${patch}', '${timestamp}'
    );
  `)
  database.close()
}

function diffPathsForSessionTitle(title: string) {
  const database = new DatabaseSync(testDbPath)
  try {
    return database
      .prepare(`
        SELECT d.path
        FROM diff_artifacts d
        JOIN agent_slots a ON a.id = d.agent_id
        WHERE a.title = ?
        ORDER BY d.path ASC
      `)
      .all(title)
      .map((row) => (row as { path: string }).path)
  } finally {
    database.close()
  }
}

function readAgentRuntimeState(title: string) {
  const database = new DatabaseSync(testDbPath)
  try {
    const row = database
      .prepare('SELECT runtime_state_json AS runtimeStateJson FROM agent_slots WHERE title = ?')
      .get(title) as { runtimeStateJson: string | null } | undefined
    if (!row?.runtimeStateJson) return null
    return JSON.parse(row.runtimeStateJson) as Record<string, unknown>
  } finally {
    database.close()
  }
}

type CodexHarnessRequest = {
  method: string
  params?: {
    effort?: string
    includeTurns?: boolean
    sandbox?: string
    sandboxPolicy?: { type: string }
    target?: unknown
    threadId?: string
  }
}

function turnStartRequests(requests: CodexHarnessRequest[]) {
  return requests.filter((request): request is CodexHarnessRequest & {
    params: NonNullable<CodexHarnessRequest['params']>
  } => (
    request.method === 'turn/start' && 'params' in request
  ))
}

async function pressShiftKey(page: import('@playwright/test').Page, key: string) {
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.down('Shift')
  await page.keyboard.press(key)
  await page.keyboard.up('Shift')
}

async function showLatestActivity(page: import('@playwright/test').Page) {
  const collapsedActivityRows = page.getByRole('button', { name: 'Show' })
  if (await collapsedActivityRows.count()) {
    await collapsedActivityRows.last().click()
  }
}
