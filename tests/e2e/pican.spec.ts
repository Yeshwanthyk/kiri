import { expect, test } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'

test.describe.configure({ mode: 'serial' })

test.beforeEach(() => {
  const database = new DatabaseSync('.pican/pican.sqlite')
  database.exec(`
    PRAGMA foreign_keys = ON;
    INSERT OR IGNORE INTO projects (id, name, cwd, position)
    VALUES ('pi-mono', 'Pi Runtime Reference', '/Users/yesh/Documents/personal/reference/pi-mono', 1);
    DELETE FROM agent_slots;
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

test('sidebar switches between chat, diffs, and artifacts', async ({ page }, testInfo) => {
  const title = `Sidebar Session ${testInfo.project.name}`

  await page.goto('/')
  await createSession(page, title)

  await page.getByTestId('tab-diffs').click()
  await expect(page.getByTestId('diff-panel')).toContainText('No diffs')

  await page.getByTestId('tab-artifacts').click()
  await expect(page.getByTestId('artifacts-panel')).toContainText(
    'Reserved session dir:',
  )
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
