'use strict';

// Minimal bridge for the suggestion popup. It only needs to receive the list of
// matches and tell the main process which one was clicked.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('suggest', {
  onData: (cb) => ipcRenderer.on('suggest-data', (_e, data) => cb(data)),
  pick: (trigger) => ipcRenderer.send('suggest-pick', trigger),
  dismiss: () => ipcRenderer.send('suggest-dismiss'),
});
