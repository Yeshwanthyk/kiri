const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('aetherHost', {
  getHostInfo: () => ipcRenderer.invoke('aether:get-host-info'),
  pickFolder: () => ipcRenderer.invoke('aether:pick-folder'),
  openExternal: (url) => ipcRenderer.invoke('aether:open-external', url),
  revealPath: (path) => ipcRenderer.invoke('aether:reveal-path', path),
  onMenuAction: (handler) => {
    const listener = (_event, actionId) => handler(actionId)
    ipcRenderer.on('aether:menu-action', listener)
    return () => ipcRenderer.removeListener('aether:menu-action', listener)
  },
})
