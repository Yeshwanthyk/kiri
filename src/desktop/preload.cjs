const { contextBridge, ipcRenderer } = require('electron')

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
