'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, nativeImage, shell, dialog } = require('electron');
const path = require('path');

const { Expander } = require('./expander');
const { Store } = require('./store');
const { charFor, K } = require('./keymap');
const inject = require('./inject');
const { fetchTeamLibrary, writeTeamLibrary } = require('./sync');

// electron-store and uiohook are loaded lazily/defensively so a build issue in
// one native module doesn't take down the whole app.
let ElectronStore = null;
try { ElectronStore = require('electron-store'); } catch (_) {}
let uIOhook = null;
let uiohookError = null;
try { ({ uIOhook } = require('uiohook-napi')); } catch (err) { uiohookError = err; }

let store, expander, tray, win;
let hookRunning = false;
let syncTimer = null;
let stats = { expansionsThisSession: 0, lastSyncAt: null, lastSyncError: null };

// Shift tracking for the global hook.
const SHIFT_CODES = new Set([42, 54]);
let shiftDown = false;

// ---------------------------------------------------------------------------

function initStore() {
  const backend = ElectronStore
    ? new ElectronStore({ name: 'trexpanda' })
    : memoryBackend();
  store = new Store(backend);
}

// Fallback backend if electron-store is unavailable (keeps app usable).
function memoryBackend() {
  const data = {};
  return {
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
  };
}

function rebuildEngine() {
  const snippets = store.effectiveSnippets();
  if (!expander) expander = new Expander(snippets);
  else expander.setSnippets(snippets);
}

// ---------------------------------------------------------------------------
// Global keyboard hook
// ---------------------------------------------------------------------------

function startHook() {
  if (!uIOhook || hookRunning) return;
  uIOhook.on('keydown', onKeyDown);
  uIOhook.on('keyup', onKeyUp);
  uIOhook.start();
  hookRunning = true;
}

function stopHook() {
  if (!uIOhook || !hookRunning) return;
  try { uIOhook.stop(); } catch (_) {}
  hookRunning = false;
}

function onKeyUp(e) {
  if (SHIFT_CODES.has(e.keycode)) shiftDown = false;
}

async function onKeyDown(e) {
  const settings = store.getSettings();
  if (!settings.enabled) return;

  if (SHIFT_CODES.has(e.keycode)) { shiftDown = true; return; }

  // Keys that break/adjust the typing context.
  if (e.keycode === K.Backspace) { expander.onBackspace(); return; }
  if (e.keycode === K.Enter || e.keycode === K.Tab || e.keycode === K.Escape) {
    expander.reset();
    return;
  }

  const ch = charFor(e.keycode, shiftDown);
  if (ch == null) { expander.reset(); return; }

  const action = expander.onChar(ch);
  if (!action) return;

  // Expansion matched — inject the replacement.
  if (inject.available()) {
    try {
      await inject.expand(action, clipboard);
      stats.expansionsThisSession++;
      pushState();
    } catch (err) {
      console.error('Injection failed:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Team sync
// ---------------------------------------------------------------------------

async function syncNow() {
  const settings = store.getSettings();
  if (!settings.teamSource) {
    stats.lastSyncError = 'No team source configured.';
    pushState();
    return { ok: false, error: stats.lastSyncError };
  }
  try {
    const { snippets, fetchedAt } = await fetchTeamLibrary(settings.teamSource);
    store.setTeamCache(snippets);
    stats.lastSyncAt = fetchedAt;
    stats.lastSyncError = null;
    rebuildEngine();
    pushState();
    return { ok: true, count: snippets.length };
  } catch (err) {
    stats.lastSyncError = String(err.message || err);
    pushState();
    return { ok: false, error: stats.lastSyncError };
  }
}

function scheduleSync() {
  if (syncTimer) clearInterval(syncTimer);
  const settings = store.getSettings();
  const mins = Math.max(1, Number(settings.syncIntervalMin) || 30);
  if (settings.teamSource) {
    syncNow();
    syncTimer = setInterval(syncNow, mins * 60 * 1000);
  }
}

// ---------------------------------------------------------------------------
// Windows & tray
// ---------------------------------------------------------------------------

function createWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 920,
    height: 680,
    show: true,
    title: 'Trexpanda',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
  win.webContents.on('did-finish-load', pushState);
}

function trayIcon() {
  // Load the branded tray/menubar icon; fall back to a tiny transparent image
  // if the asset is missing so the app still runs.
  const p = path.join(__dirname, '..', 'assets', 'tray.png');
  const img = nativeImage.createFromPath(p);
  if (!img.isEmpty()) return img;
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  );
}

function buildTray() {
  tray = new Tray(trayIcon());
  refreshTrayMenu();
  tray.setToolTip('Trexpanda — Type Less. Do More.');
  tray.on('click', () => createWindow());
}

function refreshTrayMenu() {
  const settings = store.getSettings();
  const menu = Menu.buildFromTemplate([
    { label: 'Open Snippet Manager', click: () => createWindow() },
    { type: 'separator' },
    {
      label: settings.enabled ? 'Expansion: On' : 'Expansion: Off',
      type: 'checkbox',
      checked: settings.enabled,
      click: () => { store.setSettings({ enabled: !settings.enabled }); refreshTrayMenu(); pushState(); },
    },
    { label: 'Sync team library now', click: () => syncNow() },
    { type: 'separator' },
    { label: 'Quit', click: () => { stopHook(); app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ---------------------------------------------------------------------------
// State push to renderer
// ---------------------------------------------------------------------------

function pushState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state', {
    personal: store.getPersonal(),
    team: store.getTeamCache(),
    settings: store.getSettings(),
    stats,
    engine: {
      injectionAvailable: inject.available(),
      injectionError: inject.getLoadError(),
      hookAvailable: !!uIOhook,
      hookError: uiohookError ? String(uiohookError.message || uiohookError) : null,
    },
  });
}

// ---------------------------------------------------------------------------
// IPC (renderer -> main)
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('get-state', () => ({
    personal: store.getPersonal(),
    team: store.getTeamCache(),
    settings: store.getSettings(),
    stats,
    engine: {
      injectionAvailable: inject.available(),
      injectionError: inject.getLoadError(),
      hookAvailable: !!uIOhook,
      hookError: uiohookError ? String(uiohookError.message || uiohookError) : null,
    },
  }));

  ipcMain.handle('save-personal', (_e, list) => {
    store.setPersonal(Array.isArray(list) ? list : []);
    rebuildEngine();
    pushState();
    return { ok: true };
  });

  ipcMain.handle('save-settings', (_e, next) => {
    store.setSettings(next || {});
    rebuildEngine();
    refreshTrayMenu();
    scheduleSync();
    if (typeof next.launchAtLogin === 'boolean') {
      app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
    }
    pushState();
    return { ok: true };
  });

  ipcMain.handle('sync-now', () => syncNow());

  // Team owner: publish current personal snippets to a shared folder.
  ipcMain.handle('publish-library', async (_e, folder) => {
    try {
      const target = writeTeamLibrary(folder, store.getPersonal());
      return { ok: true, target };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('choose-folder', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => createWindow());

  app.whenReady().then(() => {
    initStore();
    rebuildEngine();
    registerIpc();
    buildTray();
    createWindow();

    if (store.getSettings().enabled) startHook();
    scheduleSync();

    // Auto-update (no-op until you configure a publish target + code signing).
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    } catch (_) {}
  });

  app.on('window-all-closed', (e) => {
    // Keep running in the tray; do not quit when the manager window closes.
    e.preventDefault?.();
  });

  app.on('activate', () => createWindow());
  app.on('before-quit', stopHook);
}
