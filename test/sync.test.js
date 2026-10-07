'use strict';

// Tests for merge/parse (store.js) and file-based sync (sync.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mergeSnippets, parseLibrary, normalizeSnippet, sanitizeUntrustedHtml, mergeSnippetsForSync, Store } = require('../src/store');
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

test('mergeSnippetsForSync: remote-only snippet is adopted, not pushed', () => {
  const now = Date.now();
  const r = mergeSnippetsForSync({ live: [], tombstones: [], now,
    remote: [{ id: 'a', trigger: ';a', replacement: 'A', updated_at: now - 1000, deleted_at: null }] });
  assert.strictEqual(r.live.length, 1);
  assert.strictEqual(r.live[0].trigger, ';a');
  assert.strictEqual(r.push.length, 0);
});

test('mergeSnippetsForSync: local-only snippet is pushed', () => {
  const now = Date.now();
  const r = mergeSnippetsForSync({ tombstones: [], remote: [], now,
    live: [{ id: 'b', trigger: ';b', replacement: 'B', updatedAt: now - 500 }] });
  assert.strictEqual(r.push.length, 1);
  assert.strictEqual(r.push[0].id, 'b');
  assert.strictEqual(r.push[0].deleted_at, null);
  assert.strictEqual(r.live.length, 1);
});

test('mergeSnippetsForSync: newer side wins (local newer => push, remote newer => adopt)', () => {
  const now = Date.now();
  const localWins = mergeSnippetsForSync({ tombstones: [], now,
    live: [{ id: 'c', trigger: ';c', replacement: 'NEW', updatedAt: now }],
    remote: [{ id: 'c', trigger: ';c', replacement: 'OLD', updated_at: now - 1000, deleted_at: null }] });
  assert.strictEqual(localWins.live[0].replacement, 'NEW');
  assert.strictEqual(localWins.push.length, 1);

  const remoteWins = mergeSnippetsForSync({ tombstones: [], now,
    live: [{ id: 'd', trigger: ';d', replacement: 'OLD', updatedAt: now - 1000 }],
    remote: [{ id: 'd', trigger: ';d', replacement: 'NEW', updated_at: now, deleted_at: null }] });
  assert.strictEqual(remoteWins.live[0].replacement, 'NEW');
  assert.strictEqual(remoteWins.push.length, 0);
});

test('mergeSnippetsForSync: deletions propagate both ways via tombstones', () => {
  const now = Date.now();
  // remote deletion (newer) removes the local live snippet
  const remoteDel = mergeSnippetsForSync({ tombstones: [], now,
    live: [{ id: 'e', trigger: ';e', replacement: 'X', updatedAt: now - 1000 }],
    remote: [{ id: 'e', trigger: ';e', updated_at: now, deleted_at: now }] });
  assert.strictEqual(remoteDel.live.length, 0);
  assert.strictEqual(remoteDel.tombstones.length, 1);
  assert.strictEqual(remoteDel.push.length, 0);

  // local deletion (newer) is pushed and the remote-live row does not resurrect
  const localDel = mergeSnippetsForSync({ live: [], now,
    tombstones: [{ id: 'f', trigger: ';f', deletedAt: now }],
    remote: [{ id: 'f', trigger: ';f', replacement: 'X', updated_at: now - 1000, deleted_at: null }] });
  assert.strictEqual(localDel.live.length, 0);
  assert.strictEqual(localDel.push.length, 1);
  assert(localDel.push[0].deleted_at, 'pushes a deletion');
});

test('Store.setPersonal assigns ids, stamps updatedAt, and tombstones deletions', () => {
  const data = {};
  const store = new Store({ get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; } });

  store.setPersonal([{ trigger: ';a', replacement: 'A' }]);
  let p = store.getPersonal();
  assert.strictEqual(p.length, 1);
  assert(p[0].id, 'assigns a stable id');
  assert(p[0].updatedAt, 'stamps updatedAt');
  const id = p[0].id;
  const ts = p[0].updatedAt;

  // Re-saving unchanged content must NOT bump updatedAt (avoids sync churn).
  store.setPersonal(store.getPersonal());
  assert.strictEqual(store.getPersonal()[0].updatedAt, ts, 'unchanged keeps timestamp');

  // Editing content bumps updatedAt.
  store.setPersonal([{ id, trigger: ';a', replacement: 'A2' }]);
  assert.notStrictEqual(store.getPersonal()[0].updatedAt, ts, 'edit bumps timestamp');

  // Deleting leaves a tombstone keyed by the same id.
  store.setPersonal([]);
  assert.strictEqual(store.getPersonal().length, 0);
  assert.strictEqual(store.getSnippetTombstones().length, 1);
  assert.strictEqual(store.getSnippetTombstones()[0].id, id);

  // Re-adding the same id cancels the tombstone.
  store.setPersonal([{ id, trigger: ';a', replacement: 'A' }]);
  assert.strictEqual(store.getSnippetTombstones().length, 0);
});

console.log('\nsync: ' + passed + ' passed');
