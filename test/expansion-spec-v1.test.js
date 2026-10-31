'use strict';

// Canonical cross-platform test vectors for SPEC-EXPANSION.md.
// These are the authoritative behaviors; the Android (Kotlin) and iOS (Swift)
// suites mirror them exactly. Each vector states its expected result explicitly.

const assert = require('assert');
const { Expander } = require('../src/expander');

let passed = 0, failed = 0;
function vec(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}
function typeString(engine, str) { let last = null; for (const ch of str) { const a = engine.onChar(ch); if (a) last = a; } return last; }

// TEST 1 — case insensitivity
vec('V1 case insensitivity: ";CH" fires ";ch" -> Hello, 3 backspaces', () => {
  const e = new Expander([{ trigger: ';ch', replacement: 'Hello' }]);
  const a = typeString(e, 'Please ;CH');
  assert.strictEqual(a.replacement, 'Hello');
  assert.strictEqual(a.backspaces, 3);
});

// TEST 2 — longest match
vec('V2 longest match: ";a" vs "x;a" -> x;a, 3 backspaces', () => {
  const e = new Expander([{ trigger: ';a', replacement: 'short' }, { trigger: 'x;a', replacement: 'long' }]);
  const a = typeString(e, 'test x;a');
  assert.strictEqual(a.trigger, 'x;a');
  assert.strictEqual(a.backspaces, 3);
  assert.strictEqual(a.replacement, 'long');
});

// TEST 3 — canonical trigger returned (user casing does not change it)
vec('V3 canonical trigger: stored ";CH", typed ";ch" -> matched trigger ";CH"', () => {
  const e = new Expander([{ trigger: ';CH', replacement: 'Hello' }]);
  const a = typeString(e, 'hi ;ch');
  assert.strictEqual(a.trigger, ';CH');
});

// TEST 4 — duplicate trigger (case-insensitive): last active definition wins
vec('V4 duplicate trigger: ";test"->First then ";TEST"->Second -> Second', () => {
  const e = new Expander([
    { trigger: ';test', replacement: 'First' },
    { trigger: ';TEST', replacement: 'Second' },
  ]);
  const a = typeString(e, ';test');
  assert.strictEqual(a.replacement, 'Second');
});

// TEST 5 — unknown token untouched
vec('V5 unknown token: "Hello {name}" -> unchanged', () => {
  const e = new Expander([{ trigger: ';v', replacement: 'Hello {name}' }]);
  assert.strictEqual(typeString(e, ';v').replacement, 'Hello {name}');
});

// TEST 6 — multiple tokens all resolve
vec('V6 multiple tokens resolve independently', () => {
  const e = new Expander([{ trigger: ';t', replacement: 'Date: {date} Time: {time} Full: {datetime}' }]);
  const r = typeString(e, ';t').replacement;
  assert(/Date: \d{4}-\d{2}-\d{2} Time: \d{2}:\d{2} Full: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(r), r);
});

// TEST 7 — cursor marker
vec('V7 cursor: "Dear $|,\\nRegards" -> "Dear ,\\nRegards", caretBack = len(",\\nRegards")', () => {
  const e = new Expander([{ trigger: ';sig', replacement: 'Dear $|,\nRegards' }]);
  const a = typeString(e, ';sig');
  assert.strictEqual(a.replacement, 'Dear ,\nRegards');
  assert.strictEqual(a.caretBack, ',\nRegards'.length);
});

// TEST 8 — multiple cursor markers: first controls, all removed
vec('V8 multiple markers: "Hello $|world $|" -> "Hello world ", caret after "Hello "', () => {
  const e = new Expander([{ trigger: ';m', replacement: 'Hello $|world $|' }]);
  const a = typeString(e, ';m');
  assert.strictEqual(a.replacement, 'Hello world ');
  assert.strictEqual(a.caretBack, 'world '.length);
});

// TEST 9 — empty replacement
vec('V9 empty replacement: ";delete" -> deletes trigger, inserts nothing', () => {
  const e = new Expander([{ trigger: ';delete', replacement: '' }]);
  const a = typeString(e, ';delete');
  assert.strictEqual(a.replacement, '');
  assert.strictEqual(a.backspaces, 7);
});

// TEST 10 — unknown token with underscore
vec('V10 unknown token underscore: "Hello {customer_name}" -> unchanged', () => {
  const e = new Expander([{ trigger: ';c', replacement: 'Hello {customer_name}' }]);
  assert.strictEqual(typeString(e, ';c').replacement, 'Hello {customer_name}');
});

// V11 — multiline + unicode verbatim
vec('V11 multiline + unicode verbatim', () => {
  const e = new Expander([{ trigger: ';u', replacement: 'Línea 1\n日本語 ✨\nالعربية' }]);
  assert.strictEqual(typeString(e, ';u').replacement, 'Línea 1\n日本語 ✨\nالعربية');
});

// V12 — suggestions ordering (shortest first, then alphabetical), case-insensitive
vec('V12 suggestions: shortest first then alphabetical, case-insensitive', () => {
  const e = new Expander([
    { trigger: ';signature', replacement: 'x' },
    { trigger: ';sig', replacement: 'y' },
    { trigger: ';sign', replacement: 'z' },
  ]);
  typeString(e, ';SI');
  assert.deepStrictEqual(e.suggestions().items.map(i => i.trigger), [';sig', ';sign', ';signature']);
});

// ---- Unicode / emoji cursor vectors: caretBack is GRAPHEME CLUSTERS ----
// Each "after $|" string below is one or more user-perceived characters; caretBack
// must equal the grapheme-cluster count so the caret lands exactly at the marker.
function cursorVec(name, after, expectedCaretBack, before = 'x') {
  vec(name, () => {
    const e = new Expander([{ trigger: ';c', replacement: before + '$|' + after }]);
    const a = typeString(e, ';c');
    assert.strictEqual(a.replacement, before + after, 'text: ' + JSON.stringify(a.replacement));
    assert.strictEqual(a.caretBack, expectedCaretBack, 'caretBack for ' + JSON.stringify(after));
  });
}
cursorVec('V13 cursor ASCII "abc"', 'abc', 3);
cursorVec('V14 cursor combining mark e+acute (1 grapheme)', 'é', 1);
cursorVec('V15 cursor accented word cafe+acute (4 graphemes)', 'café', 4);
cursorVec('V16 cursor single emoji', '😀', 1);
cursorVec('V17 cursor flag (2 code points, 1 grapheme)', '🇺🇸', 1);
cursorVec('V18 cursor ZWJ family (5 code points, 1 grapheme)', '👨‍👩‍👧', 1);
cursorVec('V19 cursor skin-tone (2 code points, 1 grapheme)', '👍🏽', 1);
cursorVec('V20 cursor emoji + text (3 graphemes)', '👍🏽ok', 3);
cursorVec('V21 unicode BEFORE marker does not affect caretBack', 'y', 1, 'café');

// ---- Fill-in fields: `{{label}}` / `{{label=default}}` (SPEC section 9) ----
// parseFields lists the fields to prompt for (first-appearance order, deduped);
// render(template, values) fills them. Fields resolve BEFORE {tokens}.

// F1 — parse order + dedupe + default captured
vec('F1 parseFields: first-appearance order, deduped, defaults captured', () => {
  const e = new Expander([{ trigger: ';f', replacement: 'Hi {{name}}, order {{order=#}} for {{name}}' }]);
  assert.deepStrictEqual(e.parseFields('Hi {{name}}, order {{order=#}} for {{name}}'),
    [{ name: 'name', default: '' }, { name: 'order', default: '#' }]);
});

// F2 — a plain snippet has no fields (fast path)
vec('F2 parseFields: plain snippet -> []', () => {
  const e = new Expander([{ trigger: ';p', replacement: 'Hello' }]);
  assert.deepStrictEqual(e.parseFields('Hello'), []);
  assert.deepStrictEqual(typeString(e, ';p').fields, []);
});

// F3 — match surfaces fields + template, and replacement is the default-filled text
vec('F3 match surfaces fields + template; replacement uses defaults', () => {
  const e = new Expander([{ trigger: ';hi', replacement: 'Hi {{name=there}}!' }]);
  const a = typeString(e, ';hi');
  assert.deepStrictEqual(a.fields, [{ name: 'name', default: 'there' }]);
  assert.strictEqual(a.template, 'Hi {{name=there}}!');
  assert.strictEqual(a.replacement, 'Hi there!'); // default used when not prompted
});

// F4 — no default falls back to empty
vec('F4 render: field with no value and no default -> empty', () => {
  const e = new Expander([]);
  assert.strictEqual(e.render('Hi {{name}}!').text, 'Hi !');
});

// F5 — render(values) fills every occurrence of the same label
vec('F5 render(values): same label filled everywhere', () => {
  const e = new Expander([]);
  assert.strictEqual(e.render('{{x}}-{{x}}', { x: 'A' }).text, 'A-A');
});

// F6 — an explicit empty value overrides the default
vec('F6 render(values): explicit empty overrides default', () => {
  const e = new Expander([]);
  assert.strictEqual(e.render('[{{x=def}}]', { x: '' }).text, '[]');
});

// F7 — a `{{field}}` named like a token does NOT collide with the `{token}`
vec('F7 fields resolve before tokens: {{date=X}} is a field, {date} is the token', () => {
  const e = new Expander([{ trigger: ';d', replacement: '{{date=X}}/{date}' }]);
  const a = typeString(e, ';d');
  assert(/^X\/\d{4}-\d{2}-\d{2}$/.test(a.replacement), a.replacement);
});

// F8 — $| caret marker works together with filled fields
vec('F8 render(values) + cursor marker: caretBack counts text after $|', () => {
  const e = new Expander([]);
  const r = e.render('Dear {{name}},$|\nBye', { name: 'Sam' });
  assert.strictEqual(r.text, 'Dear Sam,\nBye');
  assert.strictEqual(r.caretBack, '\nBye'.length);
});

// F9 — labels and defaults may contain spaces; they are trimmed around the braces
vec('F9 render/parse: spaces around label and default are trimmed', () => {
  const e = new Expander([]);
  assert.deepStrictEqual(e.parseFields('{{ full name = John Doe }}'),
    [{ name: 'full name', default: 'John Doe' }]);
  assert.strictEqual(e.render('{{ full name = John Doe }}').text, 'John Doe');
});

console.log('\nExpansionSpecificationV1: ' + passed + ' passed, ' + failed + ' failed');
