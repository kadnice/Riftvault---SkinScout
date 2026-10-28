// Safe bridge between the Skin Scout window and the main process.
// The scout page can only do the things listed here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scoutAPI', {
  onUpdate: (callback) => ipcRenderer.on('scout-update', (event, data) => callback(data)),
  onWindowState: (callback) => ipcRenderer.on('scout-window-state', (event, state) => callback(state)),
  windowAction: (action, headerHeight) => ipcRenderer.send('scout-window', action, headerHeight),
  // Reuses RiftVault's existing "select-skin" handler in main.js
  equipSkin: (skinId) => ipcRenderer.invoke('select-skin', skinId),
  dismiss: () => ipcRenderer.send('scout-dismiss'),
  openGuide: (championKey, role) => ipcRenderer.send('scout-open-guide', championKey, role),
  openUrl: (url, title) => ipcRenderer.send('scout-open-url', url, title),
  setGuideMode: (keepOpen) => ipcRenderer.send('scout-guide-mode', keepOpen),
  onGameStart: (callback) => ipcRenderer.on('scout-game', (event, info) => callback(info)),
  onShowSpotlight: (callback) => ipcRenderer.on('scout-spotlight', (event, info) => callback(info)),
  openMainWindow: () => ipcRenderer.send('scout-open-main'),
  getUnownedSkins: (champId) => ipcRenderer.invoke('scout-unowned-skins', champId),
  searchSkins: (text) => ipcRenderer.invoke('scout-search-skins', text),
});
