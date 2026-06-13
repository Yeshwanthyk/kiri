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
})
