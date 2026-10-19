const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bridge', {
  send: (msg) => ipcRenderer.send('sidebar', msg),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
});
