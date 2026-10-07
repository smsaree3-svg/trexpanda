'use strict';

/**
 * Keystroke injection — the "output" half of expansion.
 *
 * When a trigger matches we need to (1) delete the trigger the user just typed
 * and (2) insert the replacement. We do this by:
 *   - sending N Backspaces to remove the trigger, then
 *   - putting the replacement on the clipboard and sending Paste.
 *
 * Pasting (rather than typing character-by-character) is dramatically more
 * reliable across apps and international layouts, and it is fast. We restore
 * the user's previous clipboard afterwards.
 *
 * Injection uses @nut-tree-fork/nut-js. It is loaded lazily and wrapped so the
 * rest of the app still runs (as a snippet manager) even if the native module
 * failed to build on this machine.
 */

let nut = null;
let loadError = null;
try {
  // We drive the clipboard exclusively through Electron's own `clipboard`
  // module (see expand()/expandHtml() below). nut-js is used ONLY to send
  // keystrokes (Backspace, Paste, arrows), never to read or write the clipboard.
  //
  // Importing nut-js, however, eagerly loads its default clipboard provider,
  // which does a top-level `require('clipboardy')`. clipboardy ships a small
  // bundled Windows helper binary, and some antivirus products quarantine that
  // helper (or clipboardy's package files). When that happens, resolving
  // clipboardy fails with:
  //   ENOENT ... app.asar.unpacked\node_modules\clipboardy\package.json
  // and that single failure propagates out of the whole `require(nut-js)` call,
  // which left `nut` null and disabled ALL expansion for that user — even
  // though we never touch nut-js's clipboard.
  //
  // Stub `clipboardy` for the duration of the nut-js import so a missing or
  // blocked clipboardy can never take down keystroke injection. The stub is
  // only ever consulted by nut-js's unused clipboard provider.
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'clipboardy') {
      return { readSync: () => '', writeSync: () => {}, read: async () => '', write: async () => {} };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    nut = require('@nut-tree-fork/nut-js');
  } finally {
    Module._load = originalLoad;
  }
  // Tighten default delays for snappy expansion.
  nut.keyboard.config.autoDelayMs = 0;
} catch (err) {
  loadError = err;
}

const isMac = process.platform === 'darwin';

// How long to wait after the paste keystroke before restoring the user's
// clipboard. nut-js only DISPATCHES the Cmd/Ctrl+V; the target app consumes the
// clipboard asynchronously, often well after the key event returns (more so on
// remote-desktop/Citrix or a busy machine). Restoring too early makes the app
// paste the OLD clipboard instead of the replacement, intermittently. 400ms is a
// safe margin that still feels instant.
const RESTORE_MS = 400;
// Settle time between writing the clipboard / sending Backspaces and the paste,
// so the target has processed the deletions and sees the new clipboard first.
const SETTLE_MS = 35;

function available() {
  return !!nut;
}

function getLoadError() {
  return loadError ? String(loadError.message || loadError) : null;
}

// ---------------------------------------------------------------------------
// Clipboard snapshot / restore.
//
// The old code saved only clipboard.readText() and wrote it back on a short
// fixed timer. That had two defects: (1) it destroyed any image/HTML/RTF the
// user had copied (readText() returns "" for those), and (2) overlapping
// expansions would "restore" one expansion's replacement as if it were the
// user's clipboard. We now snapshot every common flavor, and use an in-flight
// counter so the ORIGINAL clipboard is captured once before the first expansion
// and restored only after the last overlapping expansion's window elapses.
// ---------------------------------------------------------------------------
function snapshotClipboard(clipboard) {
  const snap = { text: '', html: '', image: null };
  try { snap.text = clipboard.readText(); } catch (_) {}
  try { snap.html = clipboard.readHTML(); } catch (_) {}
  try { const img = clipboard.readImage(); if (img && !img.isEmpty()) snap.image = img; } catch (_) {}
  return snap;
}

function restoreClipboard(clipboard, snap) {
  if (!snap) return;
  try {
    if (snap.image) {
      // An image was the primary flavor; restore it (optionally with its text).
      clipboard.writeImage(snap.image);
    } else if (snap.html) {
      clipboard.write({ text: snap.text || '', html: snap.html });
    } else {
      clipboard.writeText(snap.text || '');
    }
  } catch (_) {}
}

let _inFlight = 0;
let _saved = null;

/** Capture the user's clipboard before an expansion (once per overlap group). */
function beginExpansion(clipboard) {
  if (_inFlight === 0) _saved = snapshotClipboard(clipboard);
  _inFlight++;
}

/** Schedule restoration of the user's clipboard after this expansion settles. */
function endExpansion(clipboard, delayMs) {
  setTimeout(() => {
    _inFlight = Math.max(0, _inFlight - 1);
    if (_inFlight === 0 && _saved) {
      restoreClipboard(clipboard, _saved);
      _saved = null;
    }
  }, delayMs == null ? RESTORE_MS : delayMs);
}

async function pressBackspaces(n) {
  if (!nut) return;
  const { keyboard, Key } = nut;
  for (let i = 0; i < n; i++) {
    await keyboard.pressKey(Key.Backspace);
    await keyboard.releaseKey(Key.Backspace);
  }
}

async function paste() {
  if (!nut) return;
  const { keyboard, Key } = nut;
  const mod = isMac ? Key.LeftCmd : Key.LeftControl;
  await keyboard.pressKey(mod, Key.V);
  await keyboard.releaseKey(mod, Key.V);
}

async function pressLeft(n) {
  if (!nut || n <= 0) return;
  const { keyboard, Key } = nut;
  for (let i = 0; i < n; i++) {
    await keyboard.pressKey(Key.Left);
    await keyboard.releaseKey(Key.Left);
  }
}

/**
 * Perform an expansion.
 * @param {object} action result from Expander.onChar()
 * @param {object} clipboard Electron clipboard module
 */
async function expand(action, clipboard) {
  if (!nut) return;
  beginExpansion(clipboard);
  try {
    await pressBackspaces(action.backspaces);
    clipboard.writeText(action.replacement);
    // small settle so the clipboard write is visible to the target app
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    await paste();
    await pressLeft(action.caretBack || 0);
  } finally {
    endExpansion(clipboard);
  }
}

/**
 * Perform a rich-text expansion: put BOTH plain text and HTML on the clipboard
 * so the target app pastes formatting (bold, lists, links, images) when it can,
 * and falls back to the plain text when it can't.
 * @param {object} action result from Expander.onChar() (has .html and .replacement)
 * @param {object} clipboard Electron clipboard module
 */
async function expandHtml(action, clipboard) {
  if (!nut) return;
  beginExpansion(clipboard);
  try {
    await pressBackspaces(action.backspaces);
    clipboard.write({ text: action.replacement || '', html: action.html });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    await paste();
  } finally {
    endExpansion(clipboard);
  }
}

module.exports = {
  available, getLoadError, expand, expandHtml, pressBackspaces, paste,
  beginExpansion, endExpansion, snapshotClipboard, restoreClipboard,
};
