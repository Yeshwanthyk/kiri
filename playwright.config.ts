import { defineConfig, devices } from '@playwright/test'
import { join } from 'node:path'

const e2eStateDir = join(process.cwd(), '.kiri')
const e2eDbPath = join(e2eStateDir, 'kiri.e2e.sqlite')
const e2eSettingsPath = join(process.cwd(), 'settings.json')
const fakeCodexTerminalPath = join(process.cwd(), 'tests/harness/fake-codex-terminal.mjs')
const fakeClaudeTerminalPath = join(process.cwd(), 'tests/harness/fake-claude-terminal.mjs')
process.env.KIRI_STATE_DIR = e2eStateDir
process.env.KIRI_DB_PATH = e2eDbPath
process.env.KIRI_ROOT_DIR = e2eStateDir
process.env.KIRI_SETTINGS_PATH = e2eSettingsPath

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
    command: 'pnpm dev --port 3109 --strictPort',
    env: {
      ...process.env,
      KIRI_ROOT_DIR: e2eStateDir,
      KIRI_STATE_DIR: e2eStateDir,
      KIRI_DB_PATH: e2eDbPath,
      KIRI_SETTINGS_PATH: e2eSettingsPath,
      KIRI_CODEX_APP_SERVER_URL: 'ws://127.0.0.1:39111',
      KIRI_CODEX_BIN: fakeCodexTerminalPath,
      KIRI_CODEX_HOME: join(e2eStateDir, 'codex-home'),
      KIRI_CLAUDE_BIN: fakeClaudeTerminalPath,
      KIRI_CLAUDE_HOME: join(e2eStateDir, 'claude-home'),
    },
    url: 'http://localhost:3109/@vite/client',
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
