const { contextBridge, ipcRenderer } = require('electron');

/**
 * Minimal preload bridge for the v0.11.0 WebDAV password.
 *
 * Only the safeStorage-backed secret channel is exposed; no filesystem, shell
 * or arbitrary IPC access is handed to the renderer. The password never leaves
 * this process pair except as ciphertext on disk.
 */
contextBridge.exposeInMainWorld('rijiDesktop', {
  platform: process.platform,
  secure: {
    isAvailable: () => true,
    set: (key, value) => ipcRenderer.invoke('riji-secure:set', key, value),
    get: (key) => ipcRenderer.invoke('riji-secure:get', key),
    remove: (key) => ipcRenderer.invoke('riji-secure:remove', key),
  },
});
