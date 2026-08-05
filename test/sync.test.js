'use strict';

// Tests for merge/parse (store.js) and file-based sync (sync.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mergeSnippets, parseLibrary, normalizeSnippet } = require('../src/store');
const { fetchTeamLibrary, writeTeamLibrary, looksLikeUrl } = require('../src/sync');

let passed = 0;
function test(name, fn) {
  const done = () => { passed++; console.log('  ok  ' + name); };
  try {
    const r = fn();
    if (r && r.then) return r.then(done).catch((e) => { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; });
    done();
  } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

test('normalizeSnippet rejects junk, keeps valid', () => {
  assert.strictEqual(normalizeSnippet(null), null);
  assert.strictEqual(normalizeSnippet({ replacement: 'x' }), null); // no trigger
  const s = normalizeSnippet({ trigger: ' ;a ', replacement: 'hi' }, 'team');
  assert.strictEqual(s.trigger, ';a'); // trimmed
  assert.strictEqual(s.origin, 'team');
});

test('mergeSnippets: personal wins by default', () => {
  const merged = mergeSnippets(
    [{ trigger: ';x', replacement: 'MINE' }],
    [{ trigger: ';x', replacement: 'TEAM' }, { trigger: ';y', replacement: 'TEAMY' }]
  );
  const map = Object.fromEntries(merged.map((s) => [s.trigger, s.replacement]));
  assert.strictEqual(map[';x'], 'MINE');
  assert.strictEqual(map[';y'], 'TEAMY');
  assert.strictEqual(merged.length, 2);
});

test('mergeSnippets: teamWins flips the conflict winner', () => {
  const merged = mergeSnippets(
    [{ trigger: ';x', replacement: 'MINE' }],
    [{ trigger: ';x', replacement: 'TEAM' }],
    { teamWins: true }
  );
  assert.strictEqual(merged[0].replacement, 'TEAM');
});

test('parseLibrary accepts {snippets:[...]} and bare arrays', () => {
  assert.strictEqual(parseLibrary('{"snippets":[{"trigger":";a","replacement":"1"}]}').length, 1);
  assert.strictEqual(parseLibrary('[{"trigger":";b","replacement":"2"}]').length, 1);
  assert.strictEqual(parseLibrary('{"snippets":[]}').length, 0);
});

test('looksLikeUrl distinguishes URLs from paths', () => {
  assert.strictEqual(looksLikeUrl('https://example.com/x.json'), true);
  assert.strictEqual(looksLikeUrl('/Users/me/Dropbox/Team'), false);
});

test('writeTeamLibrary + fetchTeamLibrary round-trips via a folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tte-'));
  writeTeamLibrary(dir, [{ trigger: ';hello', replacement: 'Hi there' }]);
  const res = await fetchTeamLibrary(dir); // folder -> reads team-library.json
  assert.strictEqual(res.snippets.length, 1);
  assert.strictEqual(res.snippets[0].trigger, ';hello');
  assert.strictEqual(res.snippets[0].origin, 'team');
});

test('fetchTeamLibrary errors clearly on a missing source', async () => {
  let threw = false;
  try { await fetchTeamLibrary(''); } catch (e) { threw = true; }
  assert.strictEqual(threw, true);
});

console.log('\nsync: ' + passed + ' passed');
