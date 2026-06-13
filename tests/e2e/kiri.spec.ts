import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { refreshReadModelEntriesIfChanged } from '../../src/server/read-model-indexer'
import { startFakeCodexAppServer } from '../harness/fake-codex-app-server.mjs'

test.describe.configure({ mode: 'serial', timeout: 60_000 })

const testDbPath = resolve(process.env.KIRI_DB_PATH ?? '.kiri/kiri.e2e.sqlite')
const appRoot = process.cwd()
const projectRoot = resolve(tmpdir(), 'kiri-pican-e2e-worktree')
const userSettingsPath = resolve(appRoot, '.kiri', 'settings.json')
const detailFixturePath = resolve(projectRoot, 'src/detail.ts')
let fakeCodexServer: Awaited<ReturnType<typeof startFakeCodexAppServer>>

test.beforeAll(async () => {
  fakeCodexServer = await startFakeCodexAppServer({ port: 39111 })
})

test.afterAll(async () => {
  await fakeCodexServer?.close()
  rmSync(projectRoot, { force: true, recursive: true })
})

test.afterEach(() => {
  rmSync(userSettingsPath, { force: true })
})

test.beforeEach(async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('kiri:terminal-transcript', '1')
    window.localStorage.setItem('kiri:terminal-debug', '1')
  })
  if (fakeCodexServer) fakeCodexServer.requests.length = 0
  resetE2eProjectWorktree()
  mkdirSync(dirname(testDbPath), { recursive: true })
  rmSync(resolve(appRoot, '.kiri', 'preferences.json'), { force: true })
  rmSync(userSettingsPath, { force: true })
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
    'timeline_events',
    'messages',
    'threads',
    'deleted_sessions',
    'scratchpad_blocks',
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

function resetE2eProjectWorktree() {
  rmSync(projectRoot, { force: true, recursive: true })
  mkdirSync(resolve(projectRoot, 'src'), { recursive: true })
  writeFileSync(resolve(projectRoot, 'src/.keep'), 'fixture source directory\n')
  runGit(projectRoot, ['init'])
  runGit(projectRoot, ['config', 'user.email', 'test@example.com'])
  runGit(projectRoot, ['config', 'user.name', 'Kiri E2E'])
  runGit(projectRoot, ['add', 'src/.keep'])
  runGit(projectRoot, ['commit', '-m', 'initial'])
}

function runGit(cwd: string, args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
}

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

test('user Pi settings can opt into GUI interface mode', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  mkdirSync(dirname(userSettingsPath), { recursive: true })
  writeFileSync(userSettingsPath, JSON.stringify({
    runtimes: {
      pi: {
        models: ['deepseek/deepseek-v4-flash'],
        contextWindows: { 'deepseek/deepseek-v4-flash': 1_000_000 },
        interfaceModes: ['gui', 'terminal'],
        defaultInterfaceMode: 'gui',
      },
    },
  }))

  await page.reload()
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  await pressShiftKey(page, 'KeyN')
  await expect(page.getByTestId('session-launcher')).toBeVisible()
  await clickRuntime(page, 'pi')
  await expectRuntimeSelected(page, 'pi')
  await expect(page.getByTestId('session-interface-mode').getByRole('button', { name: 'GUI' })).toBeVisible()
  await expect(page.getByTestId('session-interface-mode').getByRole('button', { name: 'Terminal' })).toBeVisible()
  expect(pageErrors.filter((message) => message.includes('interfaceModes'))).toEqual([])
})

test('keyboard navigation moves projects without default sessions', async ({ page, isMobile }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  const firstProject = await page.getByTestId('selected-project').textContent()
  await expect(page.getByTestId('selected-project')).toContainText(/kiri/i)
  await expect(page.getByTestId('selected-agent')).toHaveText('No session')
  if (!isMobile) {
    await expect(page.getByTestId('empty-session-panel')).toBeVisible()
  }

  await pressShiftKey(page, 'KeyL')
  await expect(page.getByTestId('selected-project')).not.toHaveText(firstProject ?? '')
  await expect(page.getByTestId('selected-agent')).toHaveText('No session')

  await pressShiftKey(page, 'KeyH')
  await expect(page.getByTestId('selected-project')).toContainText(/kiri/i)

  await pressMetaKey(page, 'ArrowDown')
  await expect(page.getByTestId('selected-project')).not.toHaveText(firstProject ?? '')

  await pressMetaKey(page, 'ArrowUp')
  await expect(page.getByTestId('selected-project')).toContainText(/kiri/i)
})

test('project arrows move through empty projects and focused scratchpad dialog', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop board keymaps only')
  const title = `Scratchpad Nav ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)
  await expect.poll(() => activeLayoutProjectId(page)).toBe('e2e-kiri')

  await pressMetaKeyFromFocus(page, 'ArrowDown')
  await expect.poll(() => activeLayoutProjectId(page)).toBe('test-reference')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-active-resource-kind', 'empty')
  await expect(page.getByTestId('empty-session-panel')).toBeVisible()
  await expect(page.getByTestId('scratchpad-float')).toBeHidden()

  await openScratchpadResource(page)
  await page.getByTestId('scratchpad-input').focus()
  await expect(page.getByTestId('scratchpad-input')).toBeFocused()
  await pressMetaKeyFromFocus(page, 'ArrowUp')
  await expect.poll(() => activeLayoutProjectId(page)).toBe('e2e-kiri')
})

test('scratchpad shortcut toggles floating panel', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop board keymaps only')

  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  await expect(page.getByTestId('scratchpad-float')).toBeHidden()

  await pressShiftKey(page, 'KeyS')
  await expect(page.getByTestId('scratchpad-float')).toBeVisible()

  await pressShiftKeyFromFocus(page, 'KeyS')
  await expect(page.getByTestId('scratchpad-float')).toBeHidden()

  await pressShiftKeyFromFocus(page, 'KeyS')
  await expect(page.getByTestId('scratchpad-float')).toBeVisible()
  await page.getByTestId('scratchpad-float-close').click()
  await expect(page.getByTestId('scratchpad-float')).toBeHidden()
})

test('keyboard navigation jumps directly to projects by command number', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  await expect(page.getByTestId('selected-project')).toContainText(/kiri/i)

  await pressMetaKey(page, 'Digit2')
  await expect(page.getByTestId('selected-project')).toContainText('Test Reference')

  await pressMetaKey(page, 'Digit1')
  await expect(page.getByTestId('selected-project')).toContainText(/kiri/i)

  await pressMetaKey(page, 'Digit9')
  await expect(page.getByTestId('selected-project')).toContainText(/kiri/i)
})

test('keymap settings remap navigation', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  const firstProject = await page.getByTestId('selected-project').textContent()

  await openSettingsPage(page)
  await expect(page.getByTestId('keymap-focusChat')).toBeVisible()
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

  await expectRuntimeSelected(page, 'codex')
  await expect(page.getByTestId('session-interface-mode').getByRole('button', { name: 'GUI' })).toBeVisible()
  await expect(page.getByTestId('session-interface-mode').getByRole('button', { name: 'Terminal' })).toBeVisible()

  await clickRuntime(page, 'claude')
  await expectRuntimeSelected(page, 'claude')
  await expect(page.getByTestId('session-interface-mode')).toBeHidden()
  const existingSessionIds = await startedSessionIds()
  await page
    .getByTestId('session-launcher')
    .getByRole('button', { name: 'Start session' })
    .click()

  await renameLatestSessionForTest(page, title, existingSessionIds)
  await expect(page.getByTestId('selected-agent')).toHaveText(title)

  await pressShiftKey(page, 'KeyX')
  await expect(page.getByTestId('confirm-dialog')).toContainText(title)
  await page.getByTestId('confirm-dialog-confirm').click()

  await expect(page.getByTestId('selected-agent')).toHaveText('No session')
  await expect(page.getByTestId('board-pane')).not.toContainText(title)
})

test('resource tabs reorder by keyboard and mouse drag', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop drag flow only')
  const title = `Movable Resource ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)
  await openTerminalResource(page)
  await expect.poll(() => resourceTabOrder(page)).toEqual([title, 'terminal'])

  await pressMetaShiftKey(page, 'ArrowLeft')
  await expect.poll(() => resourceTabOrder(page)).toEqual(['terminal', title])

  const terminalTab = page
    .locator('.resource-tab-shell')
    .filter({ has: page.getByRole('tab', { name: 'terminal' }) })
  const agentTab = page
    .locator('.resource-tab-shell')
    .filter({ has: page.getByRole('tab', { name: title }) })
  await terminalTab.dragTo(agentTab)
  await expect.poll(() => resourceTabOrder(page)).toEqual([title, 'terminal'])
})

test('agent resource tabs expose a close control', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop resource tabs only')
  const title = `Closable Resource ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  await page.getByRole('button', { name: `Close ${title}` }).click()
  await expect(page.getByTestId('confirm-dialog')).toContainText(title)
  await page.getByTestId('confirm-dialog-confirm').click()

  await expect(page.getByTestId('selected-agent')).toHaveText('No session')
  await expect(page.getByTestId('board-pane')).not.toContainText(title)
})

test('agent resource tabs rename inline', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop resource tabs only')
  const title = `Rename Resource ${testInfo.project.name}`
  const nextTitle = `Renamed Resource ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  await page.getByRole('tab', { name: title }).dblclick()
  const titleInput = page.getByLabel(`Rename ${title}`)
  await expect(titleInput).toBeFocused()
  await titleInput.fill(nextTitle)
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('selected-agent')).toHaveText(nextTitle)
  await expect(page.getByRole('tab', { name: nextTitle })).toBeVisible()
})

test('session launcher selects provider by number and enter starts it', async ({ page }, testInfo) => {
  const title = `Number Provider ${testInfo.project.name}`

  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  await pressShiftKey(page, 'KeyN')
  await expect(page.getByTestId('session-launcher')).toBeVisible()

  const claudeRuntime = page
    .getByTestId('session-runtime')
    .getByRole('button', { name: /^Claude\b/ })
  await expect(claudeRuntime).toHaveAttribute('aria-keyshortcuts', '3')

  await page.keyboard.press('3')
  await expectRuntimeSelected(page, 'claude')
  await expect(page.getByTestId('session-interface-mode')).toBeHidden()

  const existingSessionIds = await startedSessionIds()
  await page.keyboard.press('Enter')

  await renameLatestSessionForTest(page, title, existingSessionIds)
  await expect(page.getByTestId('selected-agent')).toHaveText(title)
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

  await openAgentResource(page, firstTitle)
  await expect(page.getByTestId('selected-agent')).toHaveText(firstTitle)
  await openAgentResource(page, secondTitle)
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
  await expect(page.getByTestId('session-interface-mode')).toBeHidden()

  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+K')
  await page.getByTestId('command-search').fill('Start OpenCode in kiri')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('session-launcher')).toBeVisible()
  await expectRuntimeSelected(page, 'opencode')
  await expect(page.getByTestId('session-interface-mode')).toBeHidden()

  await page.keyboard.press('Escape')
  await pressShiftKey(page, 'KeyN')
  await expect(page.getByTestId('session-launcher')).toBeVisible()
  await expectRuntimeSelected(page, 'codex')
})

test('command menu starts, switches, and ends sessions', async ({ page }) => {
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
  await page
    .getByTestId('session-launcher')
    .getByRole('button', { name: 'Start session' })
    .click()

  const firstTitle = await selectedSessionTitle(page)
  await startUntitledSession(page)
  const secondTitle = await selectedSessionTitle(page)
  expect(secondTitle).not.toBe(firstTitle)

  await page.keyboard.press('Control+K')
  await page.getByTestId('command-search').fill(firstTitle)
  await page
    .getByRole('option', { name: new RegExp(`Switch to ${escapeRegExp(firstTitle)}`) })
    .click()
  await expect(page.getByTestId('selected-agent')).toHaveText(firstTitle)

  await page.keyboard.press('Control+K')
  await page.getByTestId('command-search').fill('end selected')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('confirm-dialog')).toContainText(firstTitle)
  await page.getByTestId('confirm-dialog-confirm').click()

  await expect(page.getByTestId('board-pane')).not.toContainText(firstTitle)
  await expect(page.getByTestId('selected-agent')).toHaveText(secondTitle)
})

test('projects panel adds, hides, and unhides projects', async ({ page }, testInfo) => {
  const id = `e2e-${testInfo.project.name}`
  const name = `E2E ${testInfo.project.name}`

  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  await openProjectsPage(page)
  await page.getByTestId('project-name-input').fill(name)
  await page
    .getByTestId('project-cwd-input')
    .fill(projectRoot)
  await page.getByTestId('project-id-input').fill(id)
  await page.getByRole('button', { name: 'Add project' }).click()

  await expect(page.getByTestId('project-settings-list')).toContainText(name)
  await page.getByRole('button', { name: `Move ${name} up` }).click()
  await page.getByRole('button', { name: `Move ${name} up` }).click()
  await expect(page.locator('[data-testid="project-settings-list"] .project-settings-row').first()).toContainText(name)
  await page.getByRole('button', { name: 'Close projects' }).click()
  await expect(page.getByTestId('board-pane')).toContainText(name)
  await page.reload()
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  await openProjectsPage(page)
  await expect(page.locator('[data-testid="project-settings-list"] .project-settings-row').first()).toContainText(name)

  await page.getByTestId('project-settings-list').getByRole('button', { name: `Hide ${name}` }).click()
  await expect(page.getByTestId('project-settings-list')).not.toContainText(name)
  await expect(page.getByTestId('hidden-project-list')).toContainText(name)
  await page.getByRole('button', { name: 'Close projects' }).click()
  await expect(page.getByTestId('board-pane')).not.toContainText(name)

  await page.keyboard.press('Control+K')
  await page.getByTestId('command-search').fill(`unhide ${name}`)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('board-pane')).toContainText(name)

  await page.keyboard.press('Control+K')
  await page.getByTestId('command-search').fill(`remove ${name}`)
  const removeCommand = page
    .getByRole('listbox', { name: 'Commands' })
    .getByRole('option', { name: `Remove ${name}` })
  await expect(removeCommand).toBeVisible()
  await removeCommand.click()
  await expect(page.getByTestId('confirm-dialog')).toContainText('project directory and files stay on disk')
  await page.getByTestId('confirm-dialog-cancel').click()
  await expect(page.getByTestId('board-pane')).toContainText(name)

  await openProjectsPage(page)
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

test('chat timeline selection and new-content indicator stay stable', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop chat keyboard and scroll flow')
  const title = 'Timeline Keyboard Session'
  seedChatTimelineSession({
    agentId: 'agent-chat-timeline',
    slot: 'session-chat-timeline',
    title,
    messageCount: 120,
  })

  await page.goto('/')
  await expect(page.getByTestId('selected-agent')).toHaveText(title)
  await expect(page.getByTestId('chat-panel')).toContainText('timeline message 119')

  await page.getByTestId('chat-input').click()
  await page.keyboard.press('ArrowUp')
  await expect(page.locator('.timeline-row[aria-current="true"]')).toContainText('timeline message 119')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.timeline-row[aria-current="true"]')).toHaveCount(0)

  await page.locator('.message-list').evaluate((list) => {
    list.scrollTop = 0
    list.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await page.getByTestId('chat-input').fill('new content while reading older messages')
  await page.getByRole('button', { name: 'Send prompt' }).click()
  await expect(page.getByRole('button', { name: 'Jump to latest messages' })).toBeVisible()
  await page.getByRole('button', { name: 'Jump to latest messages' }).click({ force: true })
  await expect(page.getByRole('button', { name: 'Jump to latest messages' })).toBeHidden()
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
  await showLatestActivity(page)
  await expect(page.getByTestId('chat-panel')).toContainText('Changed file')
  await expect(page.getByTestId('chat-panel')).toContainText('src/kiri-file-operation-e2e.tmp')

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

test('resource tabs switch between agent and terminal', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop resource tabs only')
  const title = `Resource Session ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  await openTerminalResource(page)
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
  await page.getByRole('button', { name: /Toggle terminal focus/ }).click()
  await expect(terminalInput).not.toBeFocused()
  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyC')
  await page.keyboard.up('Shift')
  await expect(page.getByTestId('chat-panel')).toBeVisible()
  await expect(page.getByTestId('chat-input')).toBeFocused()
})

test('terminal preserves running shell across resource tab switches', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop resource tabs only')
  const title = `Terminal Persistence ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  await openTerminalResource(page)
  await expect(page.getByTestId('terminal-panel')).toContainText('Connected', { timeout: 10_000 })
  const terminalInput = page
    .getByTestId('terminal-panel')
    .getByRole('textbox', { name: 'Terminal input' })
    .first()
  await terminalInput.click()
  const terminalInputElement = await terminalInput.elementHandle()
  if (!terminalInputElement) throw new Error('Terminal input was not mounted')
  await page.keyboard.type(
    'export KIRI_E2E_MARKER=tab-preserved; cd src; sleep 30 & export KIRI_E2E_PID=$!; echo ready:$KIRI_E2E_MARKER:$PWD:$KIRI_E2E_PID',
  )
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('terminal-transcript')).toContainText(
    `ready:tab-preserved:${projectRoot}/src`,
  )
  await page.keyboard.type(
    "for i in $(seq 1 1200); do printf 'KIRI_SCROLL_%04d\\n' \"$i\"; done",
  )
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('terminal-transcript')).toContainText('KIRI_SCROLL_1200')
  const shellPane = page
    .getByTestId('terminal-panel')
    .locator('[data-terminal-mode="shell"]')
    .first()
  await expect.poll(async () =>
    Number(await shellPane.getAttribute('data-terminal-base-y') ?? 0),
  ).toBeGreaterThan(0)
  const baseYBeforeSwitch = Number(
    await shellPane.getAttribute('data-terminal-base-y') ?? 0,
  )

  await openAgentResource(page, title)
  await expect(page.getByTestId('chat-panel')).toBeVisible()
  await expect.poll(async () => terminalInputElement.evaluate((element) => element.isConnected))
    .toBe(true)
  await openTerminalResource(page)
  await expect(page.getByTestId('terminal-panel')).toBeVisible()
  await expect.poll(async () =>
    terminalInputElement.evaluate((element) =>
      element === document.querySelector('[data-testid="terminal-panel"] .xterm-helper-textarea'),
    ),
  ).toBe(true)
  await expect.poll(async () =>
    Number(await shellPane.getAttribute('data-terminal-base-y') ?? 0),
  ).toBeGreaterThanOrEqual(baseYBeforeSwitch)
  await terminalInput.click()
  await page.keyboard.type(
    'kill -0 "$KIRI_E2E_PID" && echo preserved:$KIRI_E2E_MARKER:$PWD; kill "$KIRI_E2E_PID"',
  )
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('terminal-transcript')).toContainText(
    `preserved:tab-preserved:${projectRoot}/src`,
  )
})

test('terminal focus controls still work after a theme change', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop terminal focus flow')
  const title = `Terminal Theme Focus ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  await openTerminalResource(page)
  await expect(page.getByTestId('terminal-panel')).toContainText('Connected', { timeout: 10_000 })
  let terminalInput = page
    .getByTestId('terminal-panel')
    .getByRole('textbox', { name: 'Terminal input' })
    .first()
  await terminalInput.click()
  await expect(terminalInput).toBeFocused()

  await openSettingsPage(page)
  await page.getByTestId('theme-mode-dark').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark')
  await page.getByRole('button', { name: 'Back to board' }).click()
  await openTerminalResource(page)
  await expect(page.getByTestId('terminal-panel')).toContainText('Connected', { timeout: 10_000 })

  terminalInput = page
    .getByTestId('terminal-panel')
    .getByRole('textbox', { name: 'Terminal input' })
    .first()
  await terminalInput.click()
  await page.keyboard.type('pwd')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('terminal-transcript')).toContainText(projectRoot)
  await expect(terminalInput).toBeFocused()

  await page.getByRole('button', { name: /Toggle terminal focus/ }).click()
  await expect(terminalInput).not.toBeFocused()
  await terminalInput.click()
  await expect(terminalInput).toBeFocused()
})

test('terminal interface sessions render the agent runtime in chat and shell in terminal resource', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop resource tabs only')
  const title = `Terminal Interface ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title, 'claude', 'medium')

  await expect(page.getByTestId('terminal-panel')).toHaveAttribute('data-terminal-status', 'Connected', {
    timeout: 10_000,
  })
  await expect(page.getByTestId('terminal-transcript')).toContainText('kiri agent terminal')

  await openTerminalResource(page)
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

test('terminal focus key toggles out and back into a terminal chat session', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop terminal focus flow')
  const title = `Terminal Chat Focus ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title, 'codex', 'low', 'terminal')

  await expect(page.getByTestId('terminal-panel')).toContainText('Connected', { timeout: 10_000 })
  const terminalInput = page
    .getByTestId('terminal-panel')
    .getByRole('textbox', { name: 'Terminal input' })
    .first()
  await terminalInput.click()
  await expect(terminalInput).toBeFocused()

  await page.keyboard.press('Shift+Tab')
  await expect(terminalInput).not.toBeFocused()

  await page.keyboard.press('Shift+Tab')
  await expect(terminalInput).toBeFocused()
})

test('codex terminal interface resumes after the PTY exits', async ({ page, isMobile }, testInfo) => {
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

  await openTerminalResource(page)
  await expect(page.getByTestId('terminal-panel')).toContainText('Shell terminal')
  await openAgentResource(page, title)
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
})

test('selected agent detail loads chat and local drafts', async ({ page, isMobile }) => {
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

  await page.getByTestId('chat-input').fill('local unsent draft')
  await page.getByRole('button', { name: 'Other Session' }).click()
  await expect(page.getByTestId('chat-input')).toHaveValue('')
  await page.getByRole('button', { name: 'Detail Session' }).click()
  await expect(page.getByTestId('chat-input')).toHaveValue('local unsent draft')
  await expect(page.evaluate(() => sessionStorage.getItem('kiri:chat-drafts:v1')))
    .resolves.toContain(detailAgentId)
})

test('large chat renders within browser budget', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop render budget only')
  test.setTimeout(60_000)
  const title = `Perf Session ${testInfo.project.name}`
  seedLargeSessionWithDetail({
    agentId: 'agent-browser-perf',
    slot: 'session-browser-perf',
    title,
    messageCount: 1_200,
  })

  const chatStart = Date.now()
  await page.goto('/')
  await expect(page.getByTestId('selected-agent')).toHaveText(title)
  await expect(page.getByTestId('chat-panel')).toContainText('browser perf message 1199')
  const chatMs = Date.now() - chatStart
  expect(chatMs).toBeLessThan(8_000)
  await expect(page.getByTestId('chat-panel').locator('.timeline-row')).toHaveCount(500)
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

test('escape leaves scratchpad input so resource keymaps work', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop resource keymaps only')
  const title = `Scratchpad Escape Session ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  await openScratchpadResource(page)
  await page.getByTestId('scratchpad-input').focus()
  await expect(page.getByTestId('scratchpad-input')).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('scratchpad-float')).toBeHidden()
  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyT')
  await page.keyboard.up('Shift')
  await expect(page.getByTestId('terminal-panel')).toBeVisible()
})

test('scratchpad trigger can start codex in terminal mode', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop terminal trigger flow')
  const title = `Scratchpad Trigger Seed ${testInfo.project.name}`
  const body = `scratchpad codex terminal ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  await openScratchpadResource(page)
  await expect(page.getByText(/trigger as/i)).toBeVisible()
  await expect(page.getByTestId('scratchpad-panel').getByRole('radiogroup', { name: 'Trigger model' })).toHaveCount(0)
  await expect(page.getByTestId('scratchpad-panel').getByRole('radiogroup', { name: 'Trigger thinking level' })).toHaveCount(0)
  await page.getByRole('radio', { name: 'terminal' }).click()
  await expect(page.getByText(/Codex · terminal/)).toBeVisible()

  await page.getByTestId('scratchpad-input').fill(body)
  await page.getByTestId('scratchpad-panel').getByRole('button', { name: 'Capture' }).click()
  await expect(page.getByTestId('scratchpad-block')).toContainText(body)

  await page.getByTestId('scratchpad-block').getByRole('button', { name: 'Trigger' }).click()

  await expect(page.getByTestId('terminal-panel')).toHaveAttribute('data-terminal-status', 'Connected', {
    timeout: 10_000,
  })
  await expect(page.getByTestId('terminal-transcript')).toContainText('fake-codex-terminal mode:fresh')
  await expect(page.getByTestId('terminal-transcript')).toContainText(body)
  await expect
    .poll(() => readLatestCodexSessionInterfaceMode())
    .toBe('terminal')
  expect(fakeCodexServer.requests.map((request: CodexHarnessRequest) => request.method)).not.toContain('thread/start')
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
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.up('Shift')

  await expect(page.getByTestId('selected-agent')).toHaveText(firstTitle)
  await expect(page.getByTestId('chat-input')).not.toBeFocused()
})

test('mobile layout keeps navigation and resources usable', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile project only')

  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  await expect(page.getByTestId('board-pane')).toBeVisible()
  await expect(page.getByTestId('resource-stage')).toBeVisible()
  await expect(page.getByLabel('Mobile navigation')).toBeVisible()
  await expect(page.getByTestId('selected-agent')).toHaveText('No session')
})

test('mobile shell visual snapshot', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile visual snapshot only')

  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  await expect(page.getByLabel('Mobile navigation')).toBeVisible()
  await expect(page.locator('.kiri-shell')).toHaveScreenshot('mobile-shell.png', {
    animations: 'disabled',
  })
})

test('settings theme visual snapshot', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop settings snapshot only')

  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  await openSettingsPage(page)
  await page.getByTestId('theme-mode-dark').click()
  await page.getByTestId('theme-card-tokyonight').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'tokyonight')
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark')
  await expect(page.getByTestId('settings-page')).toHaveScreenshot('settings-theme-tokyonight-dark.png', {
    animations: 'disabled',
  })
})

test('core controls expose accessible dialog, tab, and option semantics', async ({ page }, testInfo) => {
  const title = `A11y Session ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  const viewTabs = page.getByRole('tablist', { name: 'Selected agent view' })
  await expect(viewTabs.getByRole('tab', { name: /Chat/ })).toHaveAttribute('aria-selected', 'true')
  await viewTabs.getByRole('tab', { name: /Diffs/ }).click()
  await expect(viewTabs.getByRole('tab', { name: /Diffs/ })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Open scratchpad' }).click()
  await expect(page.getByTestId('scratchpad-float')).toBeVisible()
  await page.getByRole('button', { name: 'Close scratchpad' }).last().click()
  await expect(page.getByTestId('scratchpad-float')).toBeHidden()
  await openAgentResource(page, title)

  await page.keyboard.press('Control+K')
  const commandMenu = page.getByRole('dialog', { name: 'Command menu' })
  await expect(commandMenu).toBeVisible()
  await expect(page.getByTestId('command-search')).toBeFocused()
  await page.getByTestId('command-search').fill('settings')
  await expect(
    commandMenu.getByRole('listbox', { name: 'Commands' }).getByRole('option', { name: /Open settings/ }),
  ).toHaveAttribute('aria-selected', 'true')
  await focusLastElementInside(page, '[aria-label="Command menu"]')
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('command-search')).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expectActiveElementInside(page, '[aria-label="Command menu"]')
  await expect(page.getByTestId('command-search')).not.toBeFocused()
  await page.keyboard.press('Escape')
  await expect(commandMenu).toBeHidden()

  await page.getByTestId('corner-peek-anchor').click()
  const projectsButton = page.getByTestId('corner-peek-projects-action')
  await projectsButton.click()
  await expect(page.getByRole('dialog', { name: 'Project manager' })).toBeVisible()
  const addProjectButton = page.getByLabel('Project manager').getByRole('button', { name: 'Add project' })
  await expect(addProjectButton).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close projects' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expectActiveElementInside(page, '[aria-label="Project manager"]')
  await expect(page.getByRole('button', { name: 'Close projects' })).not.toBeFocused()
  await focusLastElementInside(page, '[aria-label="Project manager"]')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Close projects' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Project manager' })).toBeHidden()
  await expect(page.getByTestId('corner-peek-anchor')).toBeFocused()
})

test('launcher, confirm, and settings controls expose accessible states', async ({ page, isMobile }, testInfo) => {
  const title = `A11y Dialog ${testInfo.project.name}`

  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  const startSessionButton = page.getByRole('button', { name: 'Start session' })
  await startSessionButton.focus()
  await expect(startSessionButton).toBeFocused()
  await startSessionButton.click()
  const launcher = page.getByTestId('session-launcher')
  await expect(launcher).toHaveAttribute('role', 'dialog')
  await expect(launcher.getByRole('tab', { name: 'New' })).toHaveAttribute('aria-selected', 'true')
  await focusLastElementInside(page, '[data-testid="session-launcher"]')
  await page.keyboard.press('Tab')
  await expect(launcher.getByRole('button', { name: 'Close session launcher' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expectActiveElementInside(page, '[data-testid="session-launcher"]')
  await expect(launcher.getByRole('button', { name: 'Close session launcher' })).not.toBeFocused()
  await launcher.getByRole('tab', { name: 'Resume' }).click()
  await expect(launcher.getByRole('tab', { name: 'Resume' })).toHaveAttribute('aria-selected', 'true')
  await expect(launcher.getByRole('tabpanel')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(launcher).toBeHidden()
  await expect(startSessionButton).toBeFocused()

  await createSession(page, title)
  const removeSessionButton = page.getByTestId('remove-session')
  if (isMobile) {
    await pressShiftKey(page, 'KeyX')
  } else {
    await removeSessionButton.focus()
    await expect(removeSessionButton).toBeFocused()
    await removeSessionButton.click()
  }
  const confirm = page.getByTestId('confirm-dialog')
  await expect(confirm).toHaveAttribute('role', 'alertdialog')
  await expect(confirm).toContainText(title)
  await expect(page.getByTestId('confirm-dialog-confirm')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('confirm-dialog-cancel')).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByTestId('confirm-dialog-confirm')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  if (!isMobile) {
    await expect(removeSessionButton).toBeFocused()
  }

  await openSettingsPage(page)
  const themeModeTabs = page.getByRole('tablist', { name: 'Theme mode' })
  await themeModeTabs.getByRole('tab', { name: 'light' }).click()
  await expect(themeModeTabs.getByRole('tab', { name: 'light' })).toHaveAttribute('aria-selected', 'true')
  await themeModeTabs.getByRole('tab', { name: 'dark' }).click()
  await expect(themeModeTabs.getByRole('tab', { name: 'dark' })).toHaveAttribute('aria-selected', 'true')
  const themeRadios = page.getByRole('radiogroup', { name: 'Theme name' })
  await themeRadios.getByRole('radio', { name: 'kiri' }).click()
  await expect(themeRadios.getByRole('radio', { name: 'kiri' })).toHaveAttribute('aria-checked', 'true')
  await themeRadios.getByRole('radio', { name: 'tokyonight' }).click()
  await expect(themeRadios.getByRole('radio', { name: 'tokyonight' })).toHaveAttribute('aria-checked', 'true')
})

async function createSession(
  page: import('@playwright/test').Page,
  title: string,
  runtime: 'pi' | 'codex' | 'claude' | 'opencode' = 'codex',
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
  interfaceMode: 'gui' | 'terminal' = 'gui',
) {
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  await pressShiftKey(page, 'KeyN')
  await clickRuntime(page, runtime)
  if (await sessionInterfaceModePickerVisible(page)) {
    await clickInterfaceMode(page, interfaceMode)
  }
  const existingSessionIds = await startedSessionIds()
  await page
    .getByTestId('session-launcher')
    .getByRole('button', { name: 'Start session' })
    .click()
  await renameLatestSessionForTest(page, title, existingSessionIds)
  if (thinkingLevel && runtime === 'codex' && interfaceMode === 'gui') {
    await setThinkingLevel(page, thinkingLevel)
  }
  await expect(page.getByTestId('selected-agent')).toHaveText(title)
}

async function openTerminalResource(page: import('@playwright/test').Page) {
  const existingTerminal = page.getByTestId('resource-tab-terminal').first()
  if (await existingTerminal.isVisible().catch(() => false)) {
    await existingTerminal.click()
  } else {
    await page.getByRole('button', { name: 'Open terminal resource' }).click()
  }
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-active-resource-kind', 'terminal')
}

async function openProjectsPage(page: import('@playwright/test').Page) {
  await page.getByTestId('corner-peek-anchor').click()
  await page.getByTestId('corner-peek-projects-action').click()
}

async function openSettingsPage(page: import('@playwright/test').Page) {
  await page.getByTestId('corner-peek-anchor').click()
  await page.getByTestId('corner-peek-settings-action').click()
}

async function openScratchpadResource(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Open scratchpad' }).click()
  await expect(page.getByTestId('scratchpad-float')).toBeVisible()
}

async function openAgentResource(page: import('@playwright/test').Page, title: string) {
  await page.getByRole('tab', { name: new RegExp(escapeRegExp(title)) }).click()
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-active-resource-kind', 'agent')
}

async function startUntitledSession(page: import('@playwright/test').Page) {
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  const existingSessionIds = await startedSessionIds()
  await pressShiftKey(page, 'KeyN')
  await page
    .getByTestId('session-launcher')
    .getByRole('button', { name: 'Start session' })
    .click()
  const row = await latestStartedSessionRow(existingSessionIds)
  await expect(page.getByTestId('selected-agent')).toHaveText(row.title)
  return row.title
}

async function selectedSessionTitle(page: import('@playwright/test').Page) {
  const selectedAgent = page.getByTestId('selected-agent')
  await expect(selectedAgent).not.toHaveText('No session')
  const title = (await selectedAgent.textContent())?.trim()
  if (!title) throw new Error('Selected session title was empty')
  return title
}

async function resourceTabOrder(page: import('@playwright/test').Page) {
  const labels = await page.getByTestId('resource-tab-strip').getByRole('tab').allTextContents()
  return labels.map((label) => label.trim()).filter(Boolean)
}

async function activeLayoutProjectId(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('kiri:resource-layout:v1')
    if (!raw) return null
    const parsed = JSON.parse(raw) as { activeProjectId?: unknown }
    return typeof parsed.activeProjectId === 'string' ? parsed.activeProjectId : null
  })
}

async function renameLatestSessionForTest(
  page: import('@playwright/test').Page,
  title: string,
  existingSessionIds: ReadonlySet<string>,
) {
  const row = await latestStartedSessionRow(existingSessionIds)
  await updateSessionTitleForTest(row.id, title)
  await page.reload()
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  await selectSessionByTitleForTest(page, title)
  await expect(page.getByTestId('selected-agent')).toHaveText(title)
}

async function updateSessionTitleForTest(agentId: string, title: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const database = new DatabaseSync(testDbPath)
    try {
      database.exec('PRAGMA busy_timeout = 100')
      database.prepare('UPDATE agent_slots SET title = ? WHERE id = ?').run(title, agentId)
      refreshReadModelEntriesIfChanged(database, {
        env: { ...process.env, KIRI_READ_MODEL_INDEXER: 'typescript' },
      })
      database.close()
      return
    } catch (error) {
      database.close()
      if (!(error instanceof Error) || !error.message.includes('database is locked')) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error(`Could not rename session ${agentId}`)
}

async function selectSessionByTitleForTest(page: import('@playwright/test').Page, title: string) {
  const resourceTab = page.getByRole('tab', { name: new RegExp(escapeRegExp(title)) }).first()
  if (await resourceTab.isVisible().catch(() => false)) {
    await resourceTab.click()
    return
  }
  const titleButton = page.getByRole('button', { name: new RegExp(escapeRegExp(title)) })
  const count = await titleButton.count()
  for (let index = 0; index < count; index += 1) {
    const button = titleButton.nth(index)
    if (await button.isVisible().catch(() => false)) {
      await button.click()
      return
    }
  }
  throw new Error(`Session ${title} was not visible after rename`)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function startedSessionIds() {
  const database = new DatabaseSync(testDbPath)
  try {
    const rows = database
      .prepare(`
        SELECT id
        FROM agent_slots
        WHERE slot LIKE 'session-%' AND archived_at IS NULL
      `)
      .all() as Array<{ id: string }>
    return new Set(rows.map((row) => row.id))
  } finally {
    database.close()
  }
}

async function latestStartedSessionRow(existingSessionIds: ReadonlySet<string>) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const database = new DatabaseSync(testDbPath)
    const rows = database
      .prepare(`
        SELECT id, title
        FROM agent_slots
        WHERE slot LIKE 'session-%' AND archived_at IS NULL
        ORDER BY position DESC, id DESC
      `)
      .all() as Array<{ id: string; title: string }>
    database.close()
    const row = rows.find((item) => !existingSessionIds.has(item.id))
    if (row) return row
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('No started session to rename')
}

async function showSelectedAgentChat(page: import('@playwright/test').Page) {
  const chatTabs = page.getByRole('tab', { name: /Chat/ })
  const count = await chatTabs.count()
  for (let index = 0; index < count; index += 1) {
    const tab = chatTabs.nth(index)
    if (await tab.isVisible().catch(() => false)) {
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      return
    }
  }
}

async function sessionInterfaceModePickerVisible(page: import('@playwright/test').Page) {
  const picker = page.getByTestId('session-interface-mode')
  return await picker.isVisible().catch(() => false)
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
  opencode: 'OpenCode',
} as const

async function clickRuntime(
  page: import('@playwright/test').Page,
  runtime: 'pi' | 'codex' | 'claude' | 'opencode',
) {
  await page
    .getByTestId('session-runtime')
    .getByRole('button', { name: new RegExp(`^${runtimeLabels[runtime]}\\b`) })
    .click()
}

async function expectRuntimeSelected(
  page: import('@playwright/test').Page,
  runtime: 'pi' | 'codex' | 'claude' | 'opencode',
) {
  await expect(
    page
      .getByTestId('session-runtime')
      .getByRole('button', { name: new RegExp(`^${runtimeLabels[runtime]}\\b`) }),
  ).toHaveAttribute('aria-pressed', 'true')
}

async function setThinkingLevel(
  page: import('@playwright/test').Page,
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
) {
  await showSelectedAgentChat(page)
  await expect(page.getByTestId('chat-input')).toBeVisible()
  await page.getByTestId('chat-input').fill(`/thinking ${thinkingLevel}`)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('thinking-level')).toContainText(`Thinking ${thinkingLevel === 'minimal' ? 'low' : thinkingLevel}`)
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
  `)
  database.close()
}

function seedChatTimelineSession(input: {
  agentId: string
  slot: string
  title: string
  messageCount: number
}) {
  const database = new DatabaseSync(testDbPath)
  const threadId = `${input.agentId}-thread`
  const timestamp = new Date(Date.UTC(2026, 4, 12, 12, 0, 0))
  const insertAgent = database.prepare(`
    INSERT INTO agent_slots (
      id, project_id, slot, title, runtime, model, status,
      session_dir, session_file, position
    )
    VALUES (?, 'e2e-kiri', ?, ?, 'pi', 'openai-codex/gpt-5.5', 'idle', ?, NULL, 0)
  `)
  const insertThread = database.prepare(`
    INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
    VALUES (?, ?, 1, ?, ?, ?)
  `)
  const insertMessage = database.prepare(`
    INSERT INTO messages (id, thread_id, role, text, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `)

  try {
    database.exec('BEGIN')
    insertAgent.run(input.agentId, input.slot, input.title, projectRoot)
    insertThread.run(
      threadId,
      input.agentId,
      `timeline message ${input.messageCount - 1}`,
      input.messageCount,
      new Date(timestamp.getTime() + input.messageCount * 1_000).toISOString(),
    )
    for (let index = 0; index < input.messageCount; index += 1) {
      insertMessage.run(
        `${input.agentId}-message-${index}`,
        threadId,
        index % 2 === 0 ? 'user' : 'assistant',
        `timeline message ${index}`,
        new Date(timestamp.getTime() + index * 1_000).toISOString(),
      )
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.close()
  }
}

function seedLargeSessionWithDetail(input: {
  agentId: string
  slot: string
  title: string
  messageCount: number
}) {
  const database = new DatabaseSync(testDbPath)
  const threadId = `${input.agentId}-thread`
  const timestamp = new Date().toISOString()
  const insertAgent = database.prepare(`
    INSERT INTO agent_slots (
      id, project_id, slot, title, runtime, model, status,
      session_dir, session_file, position
    )
    VALUES (?, 'e2e-kiri', ?, ?, 'pi', 'openai-codex/gpt-5.5', 'idle', ?, NULL, 0)
  `)
  const insertThread = database.prepare(`
    INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
    VALUES (?, ?, 1, ?, ?, ?)
  `)
  const insertMessage = database.prepare(`
    INSERT INTO messages (id, thread_id, role, text, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `)
  try {
    database.exec('BEGIN')
    insertAgent.run(input.agentId, input.slot, input.title, projectRoot)
    insertThread.run(
      threadId,
      input.agentId,
      `browser perf message ${input.messageCount - 1}`,
      input.messageCount,
      timestamp,
    )
    for (let index = 0; index < input.messageCount; index += 1) {
      insertMessage.run(
        `${input.agentId}-message-${index}`,
        threadId,
        index % 2 === 0 ? 'user' : 'assistant',
        `browser perf message ${index} ${'x'.repeat(80)}`,
        new Date(Date.UTC(2026, 4, 12, 12, 0, 0) + index * 1_000).toISOString(),
      )
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
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

function readLatestCodexSessionInterfaceMode() {
  const database = new DatabaseSync(testDbPath)
  try {
    const row = database
      .prepare(`
        SELECT interface_mode AS interfaceMode
        FROM agent_slots
        WHERE runtime = 'codex'
        ORDER BY position DESC, id DESC
        LIMIT 1
      `)
      .get() as { interfaceMode: string } | undefined
    return row?.interfaceMode ?? null
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

async function pressShiftKeyFromFocus(page: import('@playwright/test').Page, key: string) {
  await page.keyboard.down('Shift')
  await page.keyboard.press(key)
  await page.keyboard.up('Shift')
}

async function pressMetaKey(page: import('@playwright/test').Page, key: string) {
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.down('Meta')
  await page.keyboard.press(key)
  await page.keyboard.up('Meta')
}

async function pressMetaKeyFromFocus(page: import('@playwright/test').Page, key: string) {
  await page.keyboard.down('Meta')
  await page.keyboard.press(key)
  await page.keyboard.up('Meta')
}

async function pressMetaShiftKey(page: import('@playwright/test').Page, key: string) {
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.down('Meta')
  await page.keyboard.down('Shift')
  await page.keyboard.press(key)
  await page.keyboard.up('Shift')
  await page.keyboard.up('Meta')
}

async function showLatestActivity(page: import('@playwright/test').Page) {
  const collapsedActivityRows = page.getByRole('button', { name: 'Show' })
  if (await collapsedActivityRows.count()) {
    await collapsedActivityRows.last().click()
  }
}

async function expectActiveElementInside(page: import('@playwright/test').Page, selector: string) {
  await expect.poll(async () => page.evaluate((containerSelector) => {
    const container = document.querySelector(containerSelector)
    return Boolean(container && document.activeElement && container.contains(document.activeElement))
  }, selector)).toBe(true)
}

async function focusLastElementInside(page: import('@playwright/test').Page, selector: string) {
  await page.evaluate((containerSelector) => {
    const container = document.querySelector(containerSelector)
    if (!(container instanceof HTMLElement)) throw new Error(`Missing container: ${containerSelector}`)
    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(
        [
          'a[href]',
          'button:not([disabled])',
          'input:not([disabled])',
          'select:not([disabled])',
          'textarea:not([disabled])',
          '[tabindex]:not([tabindex="-1"])',
        ].join(','),
      ),
    ).filter((element) => element.offsetParent !== null)
    const last = focusable.at(-1)
    if (!last) throw new Error(`No focusable elements in: ${containerSelector}`)
    last.focus()
  }, selector)
}
