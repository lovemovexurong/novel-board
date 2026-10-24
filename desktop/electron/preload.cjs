/**
 * preload：只暴露必要的桌面能力给页面，保持 contextIsolation。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('boardDesktop', {
  isDesktop: true,
  getInfo: () => ipcRenderer.invoke('board:info'),
  pickChaptersDir: () => ipcRenderer.invoke('board:pickChaptersDir'),
  setCloseBehavior: (v) => ipcRenderer.invoke('board:setCloseBehavior', v),
  openDataDir: () => ipcRenderer.invoke('board:openDataDir'),
  openChaptersDir: () => ipcRenderer.invoke('board:openChaptersDir'),
  setZoom: (f) => ipcRenderer.invoke('board:setZoom', f),
});
