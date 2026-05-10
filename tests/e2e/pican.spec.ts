import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

test.describe.configure({ mode: 'serial' })

const testDbPath = resolve(process.env.PICAN_DB_PATH ?? '.pican/pican.e2e.sqlite')
const projectRoot = process.cwd()

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  const database = new DatabaseSync(testDbPath)
  database.exec(`
    PRAGMA foreign_keys = ON;
    DELETE FROM agent_slots;
    DELETE FROM projects;
    INSERT INTO projects (id, name, cwd, position)
    VALUES ('pican', 'Pican Orchestrator', '${projectRoot.replaceAll("'", "''")}', 0);
    INSERT INTO projects (id, name, cwd, position)
    VALUES ('test-reference', 'Test Reference', '/Users/yesh/Documents/personal/reference/test', 1);
  `)
  database.close()
})

test('keyboard navigation moves projects without default sessions', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  const firstProject = await page.getByTestId('selected-project').textContent()
  await expect(page.getByTestId('selected-project')).toContainText(/pican/i)
  await expect(page.getByTestId('selected-agent')).toHaveText('No session')
  await expect(page.getByTestId('empty-project-sessions').first()).toBeVisible()

  await pressShiftKey(page, 'KeyJ')
  await expect(page.getByTestId('selected-project')).not.toHaveText(firstProject ?? '')
  await expect(page.getByTestId('selected-agent')).toHaveText('No session')

  await pressShiftKey(page, 'KeyK')
  await expect(page.getByTestId('selected-project')).toContainText(/pican/i)
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
  await expect(page.getByTestId('selected-project')).toContainText(/pican/i)

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
  await expect(sessionModel).toContainText('openai-codex/gpt-5.5')
  await expect(sessionModel).toContainText('vibeproxy-anthropic/claude-opus-4-7')

  await sessionModel.selectOption('vibeproxy-anthropic/claude-opus-4-7')
  await page.getByTestId('session-title').fill(title)
  await page
    .getByTestId('session-launcher')
    .getByRole('button', { name: 'Start session' })
    .click()

  await expect(page.getByTestId('selected-agent')).toHaveText(title)
  await expect(page.getByTestId('board-pane')).toContainText(
    'vibeproxy-anthropic/claude-opus-4-7',
  )

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain(title)
    await dialog.accept()
  })
  await pressShiftKey(page, 'KeyX')

  await expect(page.getByTestId('selected-agent')).toHaveText('No session')
  await expect(page.getByTestId('board-pane')).not.toContainText(title)
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
    .getByRole('button', { name: 'Start session' })
    .click()

  await expect(page.getByTestId('selected-agent')).toHaveText(firstTitle)
  await createSession(page, secondTitle)

  await page.keyboard.press('Control+K')
  await page.getByTestId('command-search').fill(firstTitle)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('selected-agent')).toHaveText(firstTitle)

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain(firstTitle)
    await dialog.accept()
  })
  await page.keyboard.press('Control+K')
  await page.getByTestId('command-search').fill('end selected')
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('board-pane')).not.toContainText(firstTitle)
  await expect(page.getByTestId('selected-agent')).toHaveText(secondTitle)
})

test('settings add and remove projects', async ({ page }, testInfo) => {
  const id = `e2e-${testInfo.project.name}`
  const name = `E2E ${testInfo.project.name}`

  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByTestId('project-name-input').fill(name)
  await page
    .getByTestId('project-cwd-input')
    .fill('/Users/yesh/Documents/personal/pican')
  await page.getByTestId('project-id-input').fill(id)
  await page.getByRole('button', { name: 'Add' }).click()

  await expect(page.getByTestId('project-settings-list')).toContainText(name)
  await page.getByRole('button', { name: 'Back to board' }).click()
  await expect(page.getByTestId('board-pane')).toContainText(name)
  await page.getByRole('button', { name: 'Settings' }).click()

  await page.getByRole('button', { name: `Delete ${name}` }).click()
  await expect(page.getByTestId('project-settings-list')).not.toContainText(name)
  await page.getByRole('button', { name: 'Back to board' }).click()
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

test('sidebar switches between chat and diffs', async ({ page }, testInfo) => {
  const title = `Sidebar Session ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  await page.getByTestId('tab-diffs').click()
  await expect(page.getByTestId('diff-panel')).toContainText('No diffs')

  await pressShiftKey(page, 'KeyC')
  await expect(page.getByTestId('chat-panel')).toBeVisible()
  await expect(page.getByTestId('chat-input')).toBeFocused()
})

test('escape leaves chat composer so board keymaps work', async ({ page }, testInfo) => {
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

test('agent switching does not refocus chat after explicit chat focus', async ({ page }, testInfo) => {
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

test('mobile layout keeps board and sidebar usable', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile project only')

  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  await expect(page.getByTestId('board-pane')).toBeVisible()
  await expect(page.getByTestId('sidebar-pane')).toBeVisible()
  await expect(page.getByTestId('selected-agent')).toHaveText('No session')
})

async function createSession(page: import('@playwright/test').Page, title: string) {
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')
  await pressShiftKey(page, 'KeyN')
  await page.getByTestId('session-title').fill(title)
  await page
    .getByTestId('session-launcher')
    .getByRole('button', { name: 'Start session' })
    .click()
  await expect(page.getByTestId('selected-agent')).toHaveText(title)
}

async function pressShiftKey(page: import('@playwright/test').Page, key: string) {
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.down('Shift')
  await page.keyboard.press(key)
  await page.keyboard.up('Shift')
}
