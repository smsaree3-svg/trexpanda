'use strict';

// Bridge for the fill-in fields prompt. It receives the list of fields to ask
// for and returns the user's values (or a cancel) to the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fill', {
  onData: (cb) => ipcRenderer.on('fill-data', (_e, data) => cb(data)),
  submit: (values) => ipcRenderer.send('fill-submit', values),
  cancel: () => ipcRenderer.send('fill-cancel'),
});
