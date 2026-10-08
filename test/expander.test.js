'use strict';

// Plain-Node unit tests for the pure expansion engine (no Electron needed).
const assert = require('assert');
const { Expander } = require('../src/expander');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

// Feed a whole string char-by-char, return the last action produced (or null).
function typeString(engine, str) {
  let last = null;
  for (const ch of str) {
    const a = engine.onChar(ch);
    if (a) last = a;
  }
  return last;
}

test('expands a simple trigger', () => {
  const eng = new Expander([{ trigger: ';addr', replacement: '123 Market St' }]);
  const a = typeString(eng, 'hello ;addr');
  assert(a, 'expected an expansion');
  assert.strictEqual(a.replacement, '123 Market St');
  assert.strictEqual(a.backspaces, 5); // length of ";addr"
});

test('does not expand a partial trigger', () => {
  const eng = new Expander([{ trigger: ';addr', replacement: 'X' }]);
  assert.strictEqual(typeString(eng, ';add'), null);
});

test('longest trigger wins on overlap', () => {
  const eng = new Expander([
    { trigger: ';a', replacement: 'short' },
    { trigger: 'x;a', replacement: 'long' },
  ]);
  const a = typeString(eng, 'x;a');
  assert.strictEqual(a.replacement, 'long');
  assert.strictEqual(a.backspaces, 3);
});

test('buffer resets after an expansion so triggers do not re-fire', () => {
  const eng = new Expander([{ trigger: ';x', replacement: 'Y' }]);
  typeString(eng, ';x');
  // typing another char should not immediately re-trigger from stale buffer
  assert.strictEqual(eng.onChar('z'), null);
});

test('backspace rolls the buffer back', () => {
  const eng = new Expander([{ trigger: 'abc', replacement: 'Z' }]);
  eng.onChar('a'); eng.onChar('b'); eng.onChar('x');
  eng.onBackspace(); // remove the 'x'
  const a = eng.onChar('c'); // now buffer is a,b,c
  assert(a, 'expected expansion after backspace correction');
  assert.strictEqual(a.replacement, 'Z');
});

test('disabled snippet does not expand', () => {
  const eng = new Expander([{ trigger: ';off', replacement: 'nope', enabled: false }]);
  assert.strictEqual(typeString(eng, ';off'), null);
});

test('{date} token renders as ISO date', () => {
  const eng = new Expander([{ trigger: ';d', replacement: 'Today {date}' }]);
  const a = typeString(eng, ';d');
  assert(/Today \d{4}-\d{2}-\d{2}/.test(a.replacement), 'got: ' + a.replacement);
});

test('{date} uses the LOCAL date, not UTC (parity with Android/iOS)', () => {
  const eng = new Expander([{ trigger: ';d', replacement: '{date}' }]);
  const now = new Date();
  const expected = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0');
  assert.strictEqual(typeString(eng, ';d').replacement, expected);
});

test('suggestion order is plain lexicographic (code unit), not locale', () => {
  // Uppercase sorts before lowercase by code unit, the opposite of locale order.
  const eng = new Expander([{ trigger: ';Zebra', replacement: 'x' }, { trigger: ';apple', replacement: 'y' }]);
  typeString(eng, ';');
  assert.deepStrictEqual(eng.suggestions().items.map((i) => i.trigger), [';Zebra', ';apple']);
});

test('caret marker $| sets caretBack and is removed', () => {
  const eng = new Expander([{ trigger: ';sig', replacement: 'Dear $|,\nRegards' }]);
  const a = typeString(eng, ';sig');
  assert(!a.replacement.includes('$|'), 'marker should be stripped');
  assert.strictEqual(a.caretBack, ',\nRegards'.length);
});

test('caret marker counts GRAPHEME CLUSTERS, not UTF-16 units', () => {
  const eng = new Expander([{ trigger: ';e', replacement: 'hi $|😀end' }]);
  const a = typeString(eng, ';e');
  assert(!a.replacement.includes('$|'), 'marker stripped');
  // "😀end" is 4 grapheme clusters; the caret moves back 4 Left presses, not 5.
  assert.strictEqual(a.caretBack, 4);
  // A flag is 2 code points but ONE grapheme: caret moves back 1, not 2.
  const eng2 = new Expander([{ trigger: ';f', replacement: 'x$|🇮🇳' }]);
  assert.strictEqual(typeString(eng2, ';f').caretBack, 1);
});

test('render strips EXTRA $| markers beyond the first', () => {
  const eng = new Expander([{ trigger: ';m', replacement: 'a$|b$|c' }]);
  const a = typeString(eng, ';m');
  assert.strictEqual(a.replacement, 'abc', 'all markers removed');
  assert.strictEqual(a.caretBack, 2); // caret before "bc"
});

test('reset() clears context (e.g. after Enter/click)', () => {
  const eng = new Expander([{ trigger: 'go', replacement: 'X' }]);
  eng.onChar('g');
  eng.reset();
  assert.strictEqual(eng.onChar('o'), null); // 'g' was cleared
});

test('setSnippets updates live without losing the instance', () => {
  const eng = new Expander([{ trigger: ';a', replacement: '1' }]);
  eng.setSnippets([{ trigger: ';b', replacement: '2' }]);
  assert.strictEqual(typeString(eng, ';a'), null);
  const a = typeString(eng, ';b');
  assert.strictEqual(a.replacement, '2');
});

// ---- case-insensitive matching --------------------------------------------

test('trigger matches regardless of typed case', () => {
  const eng = new Expander([{ trigger: ';ch', replacement: 'Chennai' }]);
  // Upper-case and mixed-case typing fire the same snippet.
  assert.strictEqual(typeString(eng, ';CH').replacement, 'Chennai');
  eng.reset();
  assert.strictEqual(typeString(eng, ';Ch').replacement, 'Chennai');
  eng.reset();
  assert.strictEqual(typeString(eng, ';ch').replacement, 'Chennai');
});

test('matched action keeps the stored trigger and full delete count', () => {
  const eng = new Expander([{ trigger: ';addr', replacement: 'X' }]);
  const a = typeString(eng, 'hi ;ADDR');
  assert.strictEqual(a.trigger, ';addr'); // canonical, not what was typed
  assert.strictEqual(a.backspaces, 5);
});

test('an upper-case stored trigger matches lower-case typing', () => {
  const eng = new Expander([{ trigger: ';BRB', replacement: 'be right back' }]);
  assert.strictEqual(typeString(eng, ';brb').replacement, 'be right back');
});

test('suggestions are case-insensitive on the typed token', () => {
  const eng = new Expander([{ trigger: ';Addr', replacement: '123 Market St' }]);
  typeString(eng, ';AD');
  assert.deepStrictEqual(eng.suggestions().items.map((i) => i.trigger), [';Addr']);
});

// ---- spec edge cases -------------------------------------------------------

test('spec: unknown token is left untouched', () => {
  const eng = new Expander([{ trigger: ';v', replacement: 'Hi {name}, on {date}' }]);
  const a = typeString(eng, ';v');
  assert(a.replacement.startsWith('Hi {name}, on '), 'unknown {name} kept: ' + a.replacement);
  assert(/\d{4}-\d{2}-\d{2}$/.test(a.replacement), 'known {date} resolved: ' + a.replacement);
});

test('spec: every occurrence of a known token is replaced', () => {
  const eng = new Expander([{ trigger: ';d2', replacement: '{date} to {date}' }]);
  const a = typeString(eng, ';d2');
  const parts = a.replacement.split(' to ');
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(parts[0], parts[1], 'both {date} resolved the same: ' + a.replacement);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(parts[0]), 'ISO date: ' + parts[0]);
});

test('spec: empty replacement expands to nothing but still deletes the trigger', () => {
  const eng = new Expander([{ trigger: ';x', replacement: '' }]);
  const a = typeString(eng, ';x');
  assert(a, 'empty replacement still produces an action');
  assert.strictEqual(a.replacement, '');
  assert.strictEqual(a.backspaces, 2); // ";x"
});

test('spec: duplicate trigger, the last one defined wins', () => {
  const eng = new Expander([
    { trigger: ';dup', replacement: 'first' },
    { trigger: ';dup', replacement: 'second' },
  ]);
  assert.strictEqual(typeString(eng, ';dup').replacement, 'second');
});

test('spec: multiline and unicode replacements are inserted verbatim', () => {
  const eng = new Expander([{ trigger: ';m', replacement: 'Line 1\nLíne 2 ✨\n日本語' }]);
  const a = typeString(eng, ';m');
  assert.strictEqual(a.replacement, 'Line 1\nLíne 2 ✨\n日本語');
});

// ---- live suggestions -----------------------------------------------------

test('suggestions: prefix match with previews', () => {
  const eng = new Expander([
    { trigger: ';addr', replacement: '123 Market St\nSan Francisco' },
    { trigger: ';addr2', replacement: 'PO Box 9' },
    { trigger: ';email', replacement: 'me@example.com' },
  ]);
  // type the partial token ";ad" (no expansion yet)
  assert.strictEqual(typeString(eng, ';ad'), null);
  const s = eng.suggestions();
  assert.strictEqual(s.token, ';ad');
  assert.deepStrictEqual(s.items.map((i) => i.trigger), [';addr', ';addr2']);
  // preview is one-line, whitespace-collapsed
  assert.strictEqual(s.items[0].preview, '123 Market St San Francisco');
});

test('suggestions: only the current word (after a space) is matched', () => {
  const eng = new Expander([{ trigger: ';addr', replacement: 'X' }]);
  typeString(eng, 'hi ;ad');
  assert.deepStrictEqual(eng.suggestions().items.map((i) => i.trigger), [';addr']);
  // a trailing space clears the current token
  eng.onChar(' ');
  assert.deepStrictEqual(eng.suggestions(), { token: '', items: [] });
});

test('suggestions: empty when nothing matches or buffer is empty', () => {
  const eng = new Expander([{ trigger: ';addr', replacement: 'X' }]);
  assert.deepStrictEqual(eng.suggestions().items, []);
  typeString(eng, ';zzz');
  assert.deepStrictEqual(eng.suggestions().items, []);
});

test('suggestions: flags attachment and rich-text snippets', () => {
  const eng = new Expander([
    { trigger: ';pic', replacement: '', attachment: { type: 'image', data: 'x' } },
    { trigger: ';rich', replacement: 'hi', html: '<b>hi</b>' },
  ]);
  typeString(eng, ';');
  const items = eng.suggestions().items;
  const pic = items.find((i) => i.trigger === ';pic');
  const rich = items.find((i) => i.trigger === ';rich');
  assert.strictEqual(pic.hasAttachment, true);
  assert.strictEqual(rich.isHtml, true);
});

test('suggestions: respects the limit', () => {
  const eng = new Expander(
    Array.from({ length: 10 }, (_, i) => ({ trigger: ';x' + i, replacement: String(i) }))
  );
  typeString(eng, ';x');
  assert.strictEqual(eng.suggestions(3).items.length, 3);
});

console.log('\nexpander: ' + passed + ' passed');
