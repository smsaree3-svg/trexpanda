'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');

const { Expander } = require('./expander');
const { Store } = require('./store');
const { charFor, K } = require('./keymap');
const inject = require('./inject');
const { fetchTeamLibrary, writeTeamLibrary } = require('./sync');
const { CloudService } = require('./cloud');

// electron-store and uiohook are loaded lazily/defensively so a build issue in
// one native module doesn't take down the whole app.
let ElectronStore = null;
try { ElectronStore = require('electron-store'); } catch (_) {}
let uIOhook = null;
let uiohookError = null;
try { ({ uIOhook } = require('uiohook-napi')); } catch (err) { uiohookError = err; }

let store, expander, tray, win;
let cloud = null;
let storeBackend = null;
let hookRunning = false;
let syncTimer = null;
let cloudSyncTimer = null;
let stats = {
  expansionsThisSession: 0,
  lastSyncAt: null,
  lastSyncError: null,
  lastCloudSyncAt: null,
  lastCloudSyncError: null,
};

// Shift tracking for the global hook.
const SHIFT_CODES = new Set([42, 54]);
let shiftDown = false;

// ---------------------------------------------------------------------------

function initStore() {
  const backend = ElectronStore
    ? new ElectronStore({ name: 'trexpanda' })
    : memoryBackend();
  storeBackend = backend;
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
      if (action.attachment) {
        await expandAttachment(action);
      } else if (action.html) {
        await inject.expandHtml(action, clipboard);
      } else {
        await inject.expand(action, clipboard);
      }
      stats.expansionsThisSession++;
      pushState();
    } catch (err) {
      console.error('Injection failed:', err);
    }
  }
}

/**
 * Expand a snippet that carries an image or file attachment.
 *  - image: place the image on the clipboard and paste it inline.
 *  - file:  write it to a temp file and copy that file onto the OS clipboard so
 *           it can be pasted as an attachment (email, chat, file dialogs).
 * Any accompanying replacement text is pasted first.
 */
async function expandAttachment(action) {
  const att = action.attachment;
  const previousText = clipboard.readText();

  // Delete the typed trigger first.
  await inject.pressBackspaces(action.backspaces);

  // If the snippet also has text, paste that first.
  if (action.replacement) {
    clipboard.writeText(action.replacement);
    await delay(20);
    await inject.paste();
    await delay(60);
  }

  const buffer = Buffer.from(att.data, 'base64');

  if (att.type === 'image') {
    const img = nativeImage.createFromBuffer(buffer);
    if (!img.isEmpty()) {
      clipboard.writeImage(img);
      await delay(30);
      await inject.paste();
    }
  } else {
    // Write to a stable temp path and copy the FILE to the clipboard.
    const dir = path.join(os.tmpdir(), 'trexpanda');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const filePath = path.join(dir, att.name || 'attachment');
    fs.writeFileSync(filePath, buffer);
    const copied = await copyFileToClipboard(filePath);
    if (copied) {
      await delay(60);
      await inject.paste();
    } else {
      // Fallback: paste the file path as text so the user still gets something.
      clipboard.writeText(filePath);
      await delay(20);
      await inject.paste();
    }
  }

  // Restore the user's previous text clipboard shortly after.
  setTimeout(() => { try { clipboard.writeText(previousText); } catch (_) {} }, 250);
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Put an actual file on the OS clipboard (so paste attaches the file). */
function copyFileToClipboard(filePath) {
  return new Promise((resolve) => {
    let cmd;
    if (process.platform === 'darwin') {
      const escaped = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      cmd = `osascript -e 'set the clipboard to POSIX file "${escaped}"'`;
    } else if (process.platform === 'win32') {
      const escaped = filePath.replace(/'/g, "''");
      cmd = `powershell -NoProfile -Command "Set-Clipboard -Path '${escaped}'"`;
    } else {
      return resolve(false); // Linux file-clipboard varies; fall back to path text.
    }
    exec(cmd, (err) => resolve(!err));
  });
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

/**
 * Pull snippets from the cloud libraries the user has subscribed to (libraries
 * friends have shared with them) into the local cloud cache, then rebuild the
 * engine. No-op / clears the cache when cloud isn't configured or signed out.
 */
async function syncCloud() {
  if (!cloud || !cloud.configured()) return { ok: false, error: 'Cloud not configured.' };
  let signedIn = false;
  try {
    const st = await cloud.status();
    signedIn = st.signedIn;
  } catch (_) {}
  if (!signedIn) {
    store.setCloudCache([]);
    rebuildEngine();
    pushState();
    return { ok: false, error: 'Not signed in.' };
  }
  const settings = store.getSettings();
  try {
    if (settings.publishToCloud) {
      try { await cloud.publishSnippets(store.getPersonal()); } catch (_) {}
    }
    const ids = settings.cloudSubscriptions || [];
    const snippets = ids.length ? await cloud.fetchLibrarySnippets(ids) : [];
    store.setCloudCache(snippets);
    stats.lastCloudSyncAt = new Date().toISOString();
    stats.lastCloudSyncError = null;
    rebuildEngine();
    pushState();
    return { ok: true, count: snippets.length };
  } catch (err) {
    stats.lastCloudSyncError = String(err.message || err);
    pushState();
    return { ok: false, error: stats.lastCloudSyncError };
  }
}

function scheduleSync() {
  if (syncTimer) clearInterval(syncTimer);
  if (cloudSyncTimer) clearInterval(cloudSyncTimer);
  const settings = store.getSettings();
  const mins = Math.max(1, Number(settings.syncIntervalMin) || 30);
  if (settings.teamSource) {
    syncNow();
    syncTimer = setInterval(syncNow, mins * 60 * 1000);
  }
  if (cloud && cloud.configured()) {
    syncCloud();
    cloudSyncTimer = setInterval(syncCloud, mins * 60 * 1000);
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

  ipcMain.handle('sync-now', async () => {
    const res = await syncNow();
    await syncCloud();
    return res;
  });

  // ---- Cloud (accounts / friends / sharing) -------------------------------
  // A few methods are handled locally because they touch the on-disk settings
  // and the expansion engine; the rest are forwarded to the CloudService.
  const cloudLocal = {
    getSubscriptions: () => store.getSettings().cloudSubscriptions || [],
    setSubscriptions: async (ids) => {
      store.setSettings({ cloudSubscriptions: Array.isArray(ids) ? ids : [] });
      return syncCloud();
    },
    setPublishToCloud: async (on) => {
      store.setSettings({ publishToCloud: !!on });
      return syncCloud();
    },
    syncCloud: () => syncCloud(),
    // Publish the user's current personal snippets to their cloud library.
    publishPersonal: () => cloud.publishSnippets(store.getPersonal()),
  };

  ipcMain.handle('cloud', async (_e, payload) => {
    const { method, args = [] } = payload || {};
    try {
      if (typeof cloudLocal[method] === 'function') {
        return { ok: true, data: await cloudLocal[method](...args) };
      }
      if (cloud && typeof cloud[method] === 'function') {
        return { ok: true, data: await cloud[method](...args) };
      }
      return { ok: false, error: 'Unknown cloud method: ' + method };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

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
    try { cloud = new CloudService(storeBackend); } catch (err) { console.error('Cloud init failed:', err); cloud = null; }
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
