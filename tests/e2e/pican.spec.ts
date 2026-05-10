import { expect, test } from '@playwright/test'

test('keyboard navigation moves projects and agents', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-pane')).toHaveAttribute('data-hydrated', 'true')

  await expect(page.getByTestId('selected-project')).toHaveText('Pican Orchestrator')
  await expect(page.getByTestId('selected-agent')).toHaveText('Planner')

  await pressShiftKey(page, 'ArrowDown')
  await expect(page.getByTestId('selected-project')).toHaveText('Pi Runtime Reference')
  await expect(page.getByTestId('selected-agent')).toHaveText('Inspector')

  await pressShiftKey(page, 'KeyL')
  await expect(page.getByTestId('selected-agent')).toHaveText('RPC Runtime')

  await pressShiftKey(page, 'ArrowUp')
  await expect(page.getByTestId('selected-project')).toHaveText('Pican Orchestrator')
  await expect(page.getByTestId('selected-agent')).toHaveText('Builder')

  await expect(page.locator('[data-selected="true"]')).toHaveAttribute(
    'data-agent-id',
    'pican-builder',
  )
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
