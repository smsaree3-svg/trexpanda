'use strict';

/**
 * Maps uiohook-napi keycodes to the character they produce, with and without
 * Shift. This is a US-QWERTY layout map — it covers the common case and is
 * deliberately simple. Full international-layout support is a known follow-up
 * (see README "Known limitations"): the correct long-term fix is to read the
 * character from the OS keyboard-layout API rather than a static table.
 *
 * uiohook exposes UiohookKey constants; we key off the numeric codes it emits
 * on 'keydown' events (event.keycode).
 */

// uiohook-napi keycodes (stable across its releases).
const K = {
  Backspace: 14,
  Enter: 28,
  Space: 57,
  Tab: 15,
  Escape: 1,
};

// keycode -> [unshifted, shifted]
const TABLE = {
  // number row
  2: ['1', '!'], 3: ['2', '@'], 4: ['3', '#'], 5: ['4', '$'], 6: ['5', '%'],
  7: ['6', '^'], 8: ['7', '&'], 9: ['8', '*'], 10: ['9', '('], 11: ['0', ')'],
  12: ['-', '_'], 13: ['=', '+'],
  // top letter row
  16: ['q', 'Q'], 17: ['w', 'W'], 18: ['e', 'E'], 19: ['r', 'R'], 20: ['t', 'T'],
  21: ['y', 'Y'], 22: ['u', 'U'], 23: ['i', 'I'], 24: ['o', 'O'], 25: ['p', 'P'],
  26: ['[', '{'], 27: [']', '}'],
  // home row
  30: ['a', 'A'], 31: ['s', 'S'], 32: ['d', 'D'], 33: ['f', 'F'], 34: ['g', 'G'],
  35: ['h', 'H'], 36: ['j', 'J'], 37: ['k', 'K'], 38: ['l', 'L'],
  39: [';', ':'], 40: ["'", '"'], 41: ['`', '~'],
  43: ['\\', '|'],
  // bottom row
  44: ['z', 'Z'], 45: ['x', 'X'], 46: ['c', 'C'], 47: ['v', 'V'], 48: ['b', 'B'],
  49: ['n', 'N'], 50: ['m', 'M'], 51: [',', '<'], 52: ['.', '>'], 53: ['/', '?'],
  57: [' ', ' '],
};

/**
 * @param {number} keycode uiohook event.keycode
 * @param {boolean} shift  is a Shift modifier held?
 * @returns {string|null} the character produced, or null for non-printing keys
 */
function charFor(keycode, shift) {
  const entry = TABLE[keycode];
  if (!entry) return null;
  return shift ? entry[1] : entry[0];
}

module.exports = { charFor, K };
