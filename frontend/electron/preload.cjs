const { contextBridge, ipcRenderer } = require('electron');

/** Desktop identity plus the legacy v0.11.0 migration channel. */
contextBridge.exposeInMainWorld('rijiDesktop', {
  platform: process.platform,
  secure: {
    isAvailable: () => true,
    set: (key, value) => ipcRenderer.invoke('riji-secure:set', key, value),
    get: (key) => ipcRenderer.invoke('riji-secure:get', key),
    remove: (key) => ipcRenderer.invoke('riji-secure:remove', key),
  },
});
