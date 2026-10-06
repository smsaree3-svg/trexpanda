'use strict';

// Unit tests for the US-QWERTY keycode map, incl. Caps Lock handling.
const assert = require('assert');
const { charFor, CAPS_LOCK } = require('../src/keymap');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

test('letters respect Shift', () => {
  assert.strictEqual(charFor(34, false, false), 'g'); // 'g' key
  assert.strictEqual(charFor(34, true, false), 'G');
});

test('Caps Lock inverts Shift for letters', () => {
  assert.strictEqual(charFor(34, false, true), 'G'); // caps on, no shift -> uppercase
  assert.strictEqual(charFor(34, true, true), 'g');  // caps on + shift -> lowercase
});

test('Caps Lock does NOT affect digits or punctuation', () => {
  assert.strictEqual(charFor(5, false, true), '4');  // not '$'
  assert.strictEqual(charFor(5, true, true), '$');   // shift still produces the symbol
  assert.strictEqual(charFor(39, false, true), ';'); // ';' key unaffected by caps
  assert.strictEqual(charFor(39, true, false), ':');
});

test('caps arg is optional (defaults to off)', () => {
  assert.strictEqual(charFor(34, false), 'g');
});

test('non-printing / unknown keycode returns null', () => {
  assert.strictEqual(charFor(999, false, false), null);
  assert.strictEqual(charFor(14, false, false), null); // Backspace is not in TABLE
});

test('CAPS_LOCK keycode is exported', () => {
  assert.strictEqual(CAPS_LOCK, 58);
});

console.log('\nkeymap: ' + passed + ' passed');
