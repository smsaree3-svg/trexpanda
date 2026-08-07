'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, nativeImage, shell, dialog, screen } = require('electron');
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
let suggestWin = null; // live autocomplete popup
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
  uIOhook.on('mousedown', onMouseDown);
  uIOhook.start();
  hookRunning = true;
}

// A click elsewhere means the typing context is gone — reset the buffer and
// dismiss the suggestion popup. Clicks that land inside the popup are ignored
// here so the renderer can handle the selection.
function onMouseDown(e) {
  if (suggestWin && !suggestWin.isDestroyed() && suggestWin.isVisible()) {
    const b = suggestWin.getBounds();
    if (e && e.x >= b.x && e.x <= b.x + b.width && e.y >= b.y && e.y <= b.y + b.height) {
      return; // inside the popup — let the click become a selection
    }
  }
  expander.reset();
  hideSuggest();
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
  if (e.keycode === K.Backspace) { expander.onBackspace(); refreshSuggestions(settings); return; }
  if (e.keycode === K.Enter || e.keycode === K.Tab || e.keycode === K.Escape) {
    expander.reset();
    hideSuggest();
    return;
  }

  const ch = charFor(e.keycode, shiftDown);
  if (ch == null) { expander.reset(); hideSuggest(); return; }

  const action = expander.onChar(ch);
  if (!action) { refreshSuggestions(settings); return; }

  // Expansion matched — inject the replacement.
  hideSuggest();
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
// Live autocomplete popup
// ---------------------------------------------------------------------------

// Fixed metrics — kept in sync with src/renderer/suggest.html.
const SUGGEST = { width: 440, rowH: 50, headH: 32, pad: 10, maxItems: 6 };

function createSuggestWindow() {
  if (suggestWin && !suggestWin.isDestroyed()) return suggestWin;
  suggestWin = new BrowserWindow({
    width: SUGGEST.width,
    height: 200,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // never steal focus from the app the user is typing in
    alwaysOnTop: true,
    hasShadow: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'suggest-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  suggestWin.setAlwaysOnTop(true, 'screen-saver');
  try { suggestWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  suggestWin.loadFile(path.join(__dirname, 'renderer', 'suggest.html'));
  suggestWin.on('closed', () => { suggestWin = null; });
  return suggestWin;
}

/** Place the popup near the mouse cursor, flipping/clamping to stay on-screen. */
function positionSuggest(count) {
  const w = SUGGEST.width;
  const h = SUGGEST.headH + Math.min(count, SUGGEST.maxItems) * SUGGEST.rowH + SUGGEST.pad;
  let pt;
  try { pt = screen.getCursorScreenPoint(); } catch (_) { pt = { x: 300, y: 300 }; }
  const area = screen.getDisplayNearestPoint(pt).workArea;
  let x = pt.x + 14;
  let y = pt.y + 20;
  if (x + w > area.x + area.width) x = area.x + area.width - w - 8;
  if (y + h > area.y + area.height) y = pt.y - h - 8; // flip above the cursor
  if (x < area.x) x = area.x + 8;
  if (y < area.y) y = area.y + 8;
  suggestWin.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: Math.round(h) });
}

function showSuggest(sugg) {
  createSuggestWindow();
  positionSuggest(sugg.items.length);
  suggestWin.webContents.send('suggest-data', sugg);
  if (!suggestWin.isVisible()) suggestWin.showInactive(); // show WITHOUT focusing
}

function hideSuggest() {
  if (suggestWin && !suggestWin.isDestroyed() && suggestWin.isVisible()) suggestWin.hide();
}

/** Only pop up for a token that begins a trigger and reads like one. */
function shouldSuggest(token) {
  if (!token) return false;
  // Symbol-prefixed triggers (the recommended style) show from the first char;
  // plain-word triggers show after 2 characters to avoid noise while writing.
  const startsWithSymbol = /^[^\p{L}\p{N}\s]/u.test(token);
  return token.length >= (startsWithSymbol ? 1 : 2);
}

function refreshSuggestions(settings) {
  if (!settings || settings.showSuggestions === false) { hideSuggest(); return; }
  const sugg = expander.suggestions(SUGGEST.maxItems);
  if (!sugg.items.length || !shouldSuggest(sugg.token)) { hideSuggest(); return; }
  showSuggest(sugg);
}

/** Insert the snippet the user clicked in the popup. */
async function insertSuggestion(trigger) {
  const token = (expander.suggestions(1).token) || '';
  const snippet = expander.map.get(trigger);
  hideSuggest();
  expander.reset();
  if (!snippet || !inject.available()) return;

  const rendered = expander.render(snippet.replacement || '');
  const action = {
    trigger,
    replacement: rendered.text,
    html: snippet.html ? expander.renderHtml(snippet.html) : null,
    backspaces: token.length, // delete only what the user has typed so far
    caretBack: rendered.caretBack,
    attachment: snippet.attachment || null,
  };
  try {
    if (action.attachment) await expandAttachment(action);
    else if (action.html) await inject.expandHtml(action, clipboard);
    else await inject.expand(action, clipboard);
    stats.expansionsThisSession++;
    pushState();
  } catch (err) {
    console.error('Suggestion insert failed:', err);
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

  // Live autocomplete popup: renderer tells us which suggestion was clicked.
  ipcMain.on('suggest-pick', (_e, trigger) => { insertSuggestion(trigger); });
  ipcMain.on('suggest-dismiss', () => { expander.reset(); hideSuggest(); });
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
    createSuggestWindow(); // pre-warm the popup so first show is instant

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
