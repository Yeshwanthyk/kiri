import { app, BrowserWindow, dialog, ipcMain, Menu, shell, WebContentsView } from 'electron'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = dirname(fileURLToPath(import.meta.url))
const preloadPath = join(desktopDir, 'preload.cjs')

let mainWindow = null
let backendProcess = null
let backendUrlPromise = null

/** browserId -> { view: WebContentsView, favicon: string | null } */
const browserViews = new Map()

app.setName('kiri')

app.whenReady().then(async () => {
  installIpcHandlers()
  const appUrl = await resolveAppUrl()
  mainWindow = createWindow(appUrl)
  installApplicationMenu(mainWindow)
  await mainWindow.loadURL(appUrl)
  if (process.env.KIRI_DESKTOP_SMOKE === '1') {
    console.log(JSON.stringify({ type: 'desktop-ready', url: appUrl }))
    app.quit()
    return
  }
  mainWindow.show()
}).catch((error) => {
  console.error(error)
  dialog.showErrorBox('kiri failed to start', error instanceof Error ? error.message : String(error))
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void app.whenReady().then(async () => {
      const appUrl = await resolveAppUrl()
      mainWindow = createWindow(appUrl)
      installApplicationMenu(mainWindow)
      await mainWindow.loadURL(appUrl)
      mainWindow.show()
    })
  }
})

app.on('before-quit', () => {
  if (backendProcess && !backendProcess.killed) backendProcess.kill()
})

function createWindow(appUrl) {
  const trustedOrigin = new URL(appUrl).origin
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 920,
    minHeight: 680,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url)
    if (target) void shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === trustedOrigin) return
    event.preventDefault()
    const target = safeExternalUrl(url)
    if (target) void shell.openExternal(target)
  })

  win.on('closed', () => {
    for (const browserId of [...browserViews.keys()]) destroyBrowserView(browserId)
  })

  return win
}

async function resolveAppUrl() {
  if (process.env.KIRI_DESKTOP_DEV_URL) return process.env.KIRI_DESKTOP_DEV_URL
  if (backendUrlPromise) return backendUrlPromise
  backendUrlPromise = resolvePackagedBackendUrl()
  return backendUrlPromise
}

async function resolvePackagedBackendUrl() {
  const existing = await existingBackendUrl()
  if (existing) return existing
  return startBackend()
}

async function existingBackendUrl() {
  const url = 'http://127.0.0.1:3090/'
  return probeExistingBackendUrl(url)
}

async function probeExistingBackendUrl(url) {
  try {
    const response = await fetch(new URL('/.well-known/kiri/environment', url), {
      signal: AbortSignal.timeout(250),
    })
    if (!response.ok) return null
    const environment = await response.json()
    return environment?.name === 'kiri' && environment?.mode === 'desktop' ? url : null
  } catch {
    return null
  }
}

async function startBackend() {
  const userData = app.getPath('userData')
  const appPath = resolveApplicationRoot()
  const backendCwd = appPath.endsWith('.asar') ? dirname(appPath) : appPath
  const settingsPath = join(userData, 'settings.json')
  const preferencesPath = join(userData, 'preferences.json')
  const sourceSettings = join(appPath, 'settings.json')
  if (!existsSync(settingsPath) && existsSync(sourceSettings)) {
    mkdirSync(dirname(settingsPath), { recursive: true })
    copyFileSync(sourceSettings, settingsPath)
  }

  const backendScript = join(appPath, 'scripts', 'kiri-desktop-backend.mjs')
  backendProcess = spawn(process.execPath, [backendScript], {
    cwd: backendCwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      KIRI_HOST_MODE: 'desktop',
      KIRI_ROOT_DIR: appPath,
      KIRI_HOME: join(app.getPath('home'), '.kiri'),
      KIRI_SETTINGS_PATH: settingsPath,
      KIRI_PREFERENCES_PATH: preferencesPath,
      KIRI_DEFAULT_PROJECT_CWD: app.getPath('home'),
      KIRI_BACKEND_HOST: '0.0.0.0',
      KIRI_BACKEND_PORT: '0',
      KIRI_BACKEND_BROWSER_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  backendProcess.stderr.on('data', (chunk) => {
    console.error(`[kiri-backend] ${chunk.toString().trimEnd()}`)
  })

  return waitForBackendUrl(backendProcess)
}

function resolveApplicationRoot() {
  const packagedRoot = app.getAppPath()
  if (existsSync(join(packagedRoot, 'scripts', 'kiri-desktop-backend.mjs'))) {
    return packagedRoot
  }
  if (existsSync(join(process.cwd(), 'scripts', 'kiri-desktop-backend.mjs'))) {
    return process.cwd()
  }
  return packagedRoot
}

function waitForBackendUrl(child) {
  return new Promise((resolve, reject) => {
    let output = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill()
      reject(new Error('kiri backend did not become ready'))
    }, 30_000)

    child.once('exit', (code) => {
      clearTimeout(timeout)
      const detail = stderr.trim()
      reject(new Error(`kiri backend exited before ready: ${code ?? 'unknown'}${detail ? `\n\n${detail}` : ''}`))
    })

    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_000)
    })

    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
      const lines = output.split('\n')
      output = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const message = JSON.parse(line)
          if (message.type === 'ready' && typeof message.url === 'string') {
            clearTimeout(timeout)
            resolve(message.url)
          }
        } catch {
          console.log(`[kiri-backend] ${line}`)
        }
      }
    })
  })
}

function installIpcHandlers() {
  ipcMain.handle('kiri:get-host-info', () => ({
    mode: 'desktop',
    platform: process.platform,
  }))
  ipcMain.handle('kiri:pick-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose a project directory',
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('kiri:open-external', async (_event, url) => {
    const target = safeExternalUrl(String(url))
    if (!target) throw new Error('Unsupported external URL')
    await shell.openExternal(target)
  })
  ipcMain.handle('kiri:reveal-path', async (_event, path) => {
    const target = String(path)
    if (!isAbsolute(target)) throw new Error('Path must be absolute')
    shell.showItemInFolder(target)
  })

  ipcMain.on('kiri:browser:create', (_event, browserId, url) => {
    createBrowserView(String(browserId), safeBrowserUrl(url))
  })
  ipcMain.on('kiri:browser:set-bounds', (_event, browserId, bounds) => {
    const entry = browserViews.get(String(browserId))
    if (!entry) return
    if (!bounds || typeof bounds !== 'object') {
      entry.view.setVisible(false)
      return
    }
    entry.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    })
    entry.view.setVisible(true)
  })
  ipcMain.on('kiri:browser:navigate', (_event, browserId, url) => {
    const entry = browserViews.get(String(browserId))
    if (!entry) return
    const target = safeBrowserUrl(url)
    if (target) entry.view.webContents.loadURL(target).catch(() => {})
  })
  ipcMain.on('kiri:browser:go-back', (_event, browserId) => {
    browserViews.get(String(browserId))?.view.webContents.navigationHistory.goBack()
  })
  ipcMain.on('kiri:browser:go-forward', (_event, browserId) => {
    browserViews.get(String(browserId))?.view.webContents.navigationHistory.goForward()
  })
  ipcMain.on('kiri:browser:reload', (_event, browserId) => {
    browserViews.get(String(browserId))?.view.webContents.reload()
  })
  ipcMain.on('kiri:browser:stop', (_event, browserId) => {
    browserViews.get(String(browserId))?.view.webContents.stop()
  })
  ipcMain.on('kiri:browser:destroy', (_event, browserId) => {
    destroyBrowserView(String(browserId))
  })
}

function createBrowserView(browserId, url) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (browserViews.has(browserId)) return
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  view.setBackgroundColor('#ffffff')
  const entry = { view, favicon: null }
  browserViews.set(browserId, entry)
  mainWindow.contentView.addChildView(view)
  view.setVisible(false)

  const wc = view.webContents
  const emit = () => sendBrowserState(browserId)
  wc.on('did-start-loading', emit)
  wc.on('did-stop-loading', emit)
  wc.on('did-navigate', emit)
  wc.on('did-navigate-in-page', emit)
  wc.on('did-fail-load', emit)
  wc.on('page-title-updated', emit)
  wc.on('page-favicon-updated', (_e, favicons) => {
    entry.favicon = Array.isArray(favicons) && favicons.length > 0 ? favicons[0] : null
    emit()
  })
  // Open popups (target=_blank) in the same view instead of a new OS window.
  wc.setWindowOpenHandler(({ url: popupUrl }) => {
    const target = safeBrowserUrl(popupUrl)
    if (target) wc.loadURL(target).catch(() => {})
    return { action: 'deny' }
  })

  if (url) wc.loadURL(url).catch(() => {})
}

function destroyBrowserView(browserId) {
  const entry = browserViews.get(browserId)
  if (!entry) return
  browserViews.delete(browserId)
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(entry.view)
    }
  } catch {
    // view may already be detached
  }
  try {
    entry.view.webContents.close()
  } catch {
    // already closed
  }
}

function sendBrowserState(browserId) {
  const entry = browserViews.get(browserId)
  if (!entry) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  const wc = entry.view.webContents
  if (wc.isDestroyed()) return
  mainWindow.webContents.send('kiri:browser:state', {
    browserId,
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    isLoading: wc.isLoading(),
    favicon: entry.favicon,
  })
}

function safeBrowserUrl(value) {
  try {
    const url = new URL(String(value))
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'about:') {
      return url.toString()
    }
  } catch {
    return null
  }
  return null
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      return url.toString()
    }
  } catch {
    return null
  }
  return null
}

function installApplicationMenu(win) {
  const send = (actionId) => win.webContents.send('kiri:menu-action', actionId)
  const template = [
    ...(process.platform === 'darwin'
      ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Start Session', accelerator: 'CmdOrCtrl+N', click: () => send('start-session') },
        { label: 'Add Project', accelerator: 'CmdOrCtrl+O', click: () => send('add-project') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Open Terminal', accelerator: 'CmdOrCtrl+`', click: () => send('terminal') },
        { label: 'Open Browser', accelerator: 'CmdOrCtrl+Shift+B', click: () => send('browser') },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
