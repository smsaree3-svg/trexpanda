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
  nut = require('@nut-tree-fork/nut-js');
  // Tighten default delays for snappy expansion.
  nut.keyboard.config.autoDelayMs = 0;
} catch (err) {
  loadError = err;
}

const isMac = process.platform === 'darwin';

function available() {
  return !!nut;
}

function getLoadError() {
  return loadError ? String(loadError.message || loadError) : null;
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
  const previous = clipboard.readText();
  try {
    await pressBackspaces(action.backspaces);
    clipboard.writeText(action.replacement);
    // small settle so the clipboard write is visible to the target app
    await new Promise((r) => setTimeout(r, 20));
    await paste();
    await pressLeft(action.caretBack || 0);
  } finally {
    // Restore the user's clipboard shortly after the paste completes.
    setTimeout(() => {
      try {
        clipboard.writeText(previous);
      } catch (_) {}
    }, 120);
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
  const previous = clipboard.readText();
  try {
    await pressBackspaces(action.backspaces);
    clipboard.write({ text: action.replacement || '', html: action.html });
    await new Promise((r) => setTimeout(r, 25));
    await paste();
  } finally {
    setTimeout(() => {
      try {
        clipboard.writeText(previous);
      } catch (_) {}
    }, 140);
  }
}

module.exports = { available, getLoadError, expand, expandHtml, pressBackspaces, paste };
