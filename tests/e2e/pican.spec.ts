import { expect, test } from '@playwright/test'

test('keyboard navigation moves projects and agents', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  await expect(page.getByTestId('selected-project')).toHaveText('Pican Orchestrator')
  await expect(page.getByTestId('selected-agent')).toHaveText('Planner')

  await pressShiftKey(page, 'KeyJ')
  await expect(page.getByTestId('selected-project')).toHaveText('Pi Runtime Reference')
  await expect(page.getByTestId('selected-agent')).toHaveText('Inspector')

  await pressShiftKey(page, 'KeyL')
  await expect(page.getByTestId('selected-agent')).toHaveText('RPC Runtime')

  await pressShiftKey(page, 'KeyK')
  await expect(page.getByTestId('selected-project')).toHaveText('Pican Orchestrator')
  await expect(page.getByTestId('selected-agent')).toHaveText('Builder')

  await expect(page.locator('[data-selected="true"]')).toHaveAttribute(
    'data-agent-id',
    'pican-builder',
  )
})

test('keymap settings remap navigation', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByTestId('keymap-projectNext').selectOption('arrowdown')
  await page.getByRole('button', { name: 'Back to board' }).click()

  await pressShiftKey(page, 'KeyJ')
  await expect(page.getByTestId('selected-project')).toHaveText('Pican Orchestrator')

  await pressShiftKey(page, 'ArrowDown')
  await expect(page.getByTestId('selected-project')).toHaveText('Pi Runtime Reference')
})

test('settings choose agent runtime models', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByTestId('settings-page')).toBeVisible()

  const plannerModel = page.getByTestId('model-pican-planner')
  await expect(plannerModel).toContainText('openai-codex/gpt-5.5')
  await expect(plannerModel).toContainText('vibeproxy-anthropic/claude-opus-4-7')

  await plannerModel.selectOption('vibeproxy-anthropic/claude-opus-4-7')
  await expect(plannerModel).toHaveValue('vibeproxy-anthropic/claude-opus-4-7')

  await plannerModel.selectOption('openai-codex/gpt-5.5')
  await expect(plannerModel).toHaveValue('openai-codex/gpt-5.5')
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
  const text = `hello from ${testInfo.project.name}`

  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  await page.getByTestId('chat-input').fill(text)
  await page.getByRole('button', { name: 'Send prompt' }).click()

  await expect(page.getByTestId('chat-panel')).toContainText(text, {
    timeout: 30_000,
  })
  await expect(page.getByTestId('chat-input')).toHaveValue('')
})

test('sidebar switches between chat, diffs, and artifacts', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  await pressShiftKey(page, 'KeyL')
  await expect(page.getByTestId('selected-agent')).toHaveText('Builder')

  await expect(page.getByTestId('chat-panel')).toContainText('TanStack Start kanban shell')

  await page.getByTestId('tab-diffs').click()
  await expect(page.getByTestId('diff-panel')).toContainText('Initial pican contracts')
  await expect(page.getByTestId('diff-panel')).toContainText('src/lib/contracts.ts')

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
  await expect(page.getByTestId('selected-agent')).toHaveText('Planner')
})

async function pressShiftKey(page: import('@playwright/test').Page, key: string) {
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.down('Shift')
  await page.keyboard.press(key)
  await page.keyboard.up('Shift')
}
