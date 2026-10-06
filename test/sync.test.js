'use strict';

// Tests for merge/parse (store.js) and file-based sync (sync.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mergeSnippets, parseLibrary, normalizeSnippet, sanitizeUntrustedHtml, Store } = require('../src/store');
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

test('free-tier counter: local buffer + server reconciliation', () => {
  const data = {};
  const store = new Store({ get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; } });
  const eff = () => store.getDailyUsage().count;

  assert.strictEqual(eff(), 0);
  store.bumpDailyUsage(); store.bumpDailyUsage();
  assert.strictEqual(eff(), 2);
  assert.strictEqual(store.pendingFreeDelta(), 2);         // not yet on server

  store.setServerUsage(2);                                 // server acknowledges the flush
  assert.strictEqual(store.pendingFreeDelta(), 0);

  store.setServerUsage(5);                                 // another device used more
  assert.strictEqual(eff(), 5, 'adopts a higher server count');

  // Clearing local data must not grant a fresh allowance once the server knows.
  for (const k in data) delete data[k];
  store.setServerUsage(5);
  assert.strictEqual(eff(), 5, 'server count survives a cleared local store');

  store.bumpDailyUsage();                                  // one offline use
  assert.strictEqual(eff(), 6);
  assert.strictEqual(store.pendingFreeDelta(), 1);

  // A UTC-day rollover resets the effective count to 0.
  const y = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yk = y.getUTCFullYear() + '-' + String(y.getUTCMonth() + 1).padStart(2, '0') + '-' + String(y.getUTCDate()).padStart(2, '0');
  data.dailyUsage = { date: yk, local: 99, server: 99 };
  assert.strictEqual(eff(), 0, 'yesterday\'s count does not carry over');
});

test('parseLibrary tolerates null/garbage without crashing', () => {
  assert.deepStrictEqual(parseLibrary('null'), []);
  assert.deepStrictEqual(parseLibrary('42'), []);
  assert.deepStrictEqual(parseLibrary('"a string"'), []);
  assert.deepStrictEqual(parseLibrary(null), []);
  assert.throws(() => parseLibrary('<html>not json</html>'), /not valid JSON/);
});

test('sanitizeUntrustedHtml neutralizes handler/scheme/remote bypasses', () => {
  const S = sanitizeUntrustedHtml;
  assert(!/onerror/i.test(S('<img/onerror=alert(1) src=x>')), 'slash-separated handler');
  assert(!/onload/i.test(S('<svg/onload=alert(1)>')), 'svg wrapper + handler');
  assert(!/javascript:/i.test(S('<a href=javascript:alert(1)>x</a>')), 'unquoted javascript: href');
  assert(!/ascript/i.test(S('<a href="jav&#9;ascript:alert(1)">x</a>')), 'entity/tab-obfuscated scheme');
  assert(!/evil\.com/i.test(S('<img src=//evil.com/beacon.png>')), 'unquoted remote beacon');
  assert(!/evil\.com/i.test(S('<div style=background:url(//evil.com)>x</div>')), 'unquoted inline style');
  // Self-contained data: images are still allowed through.
  assert(/data:image\/png/i.test(S('<img src="data:image/png;base64,AAAA">')), 'keeps inline data image');
});

console.log('\nsync: ' + passed + ' passed');
