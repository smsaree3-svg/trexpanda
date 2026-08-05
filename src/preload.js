'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit bridge — the renderer never gets raw Node/Electron access.
contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  savePersonal: (list) => ipcRenderer.invoke('save-personal', list),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  syncNow: () => ipcRenderer.invoke('sync-now'),
  publishLibrary: (folder) => ipcRenderer.invoke('publish-library', folder),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
});
