const { contextBridge, ipcRenderer } = require('electron')

const hostInfo = { mode: 'desktop', platform: process.platform }

function markHostChrome() {
  document.documentElement.dataset.kiriHostMode = hostInfo.mode
  document.documentElement.dataset.kiriHostPlatform = hostInfo.platform
}

if (document.documentElement) {
  markHostChrome()
} else {
  window.addEventListener('DOMContentLoaded', markHostChrome, { once: true })
}

contextBridge.exposeInMainWorld('kiriHost', {
  getHostInfo: () => ipcRenderer.invoke('kiri:get-host-info'),
  pickFolder: () => ipcRenderer.invoke('kiri:pick-folder'),
  openExternal: (url) => ipcRenderer.invoke('kiri:open-external', url),
  revealPath: (path) => ipcRenderer.invoke('kiri:reveal-path', path),
  onMenuAction: (handler) => {
    const listener = (_event, actionId) => handler(actionId)
    ipcRenderer.on('kiri:menu-action', listener)
    return () => ipcRenderer.removeListener('kiri:menu-action', listener)
  },
  browser: {
    create: (browserId, url) => ipcRenderer.send('kiri:browser:create', browserId, url),
    setBounds: (browserId, bounds) => ipcRenderer.send('kiri:browser:set-bounds', browserId, bounds),
    navigate: (browserId, url) => ipcRenderer.send('kiri:browser:navigate', browserId, url),
    goBack: (browserId) => ipcRenderer.send('kiri:browser:go-back', browserId),
    goForward: (browserId) => ipcRenderer.send('kiri:browser:go-forward', browserId),
    reload: (browserId) => ipcRenderer.send('kiri:browser:reload', browserId),
    stop: (browserId) => ipcRenderer.send('kiri:browser:stop', browserId),
    destroy: (browserId) => ipcRenderer.send('kiri:browser:destroy', browserId),
    onState: (handler) => {
      const listener = (_event, state) => handler(state)
      ipcRenderer.on('kiri:browser:state', listener)
      return () => ipcRenderer.removeListener('kiri:browser:state', listener)
    },
  },
})
