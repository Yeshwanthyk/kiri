import { defineConfig, devices } from '@playwright/test'
import { join } from 'node:path'

const e2eDbPath = join(process.cwd(), '.pican', 'pican.e2e.sqlite')
process.env.PICAN_DB_PATH = e2eDbPath

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  workers: 1,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: 'http://localhost:3109',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev -- --port 3109 --strictPort',
    env: {
      ...process.env,
      PICAN_DB_PATH: e2eDbPath,
    },
    url: 'http://localhost:3109',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 } },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
})
