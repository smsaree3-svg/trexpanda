'use strict';

// Tests for the pure cloud/social helpers and the shared-snippet merge.
// No network, no Supabase, no Electron — just plain Node.
const assert = require('assert');
const {
  classifyFriendships,
  combineLibrarySnippets,
  profileLabel,
  isValidUsername,
} = require('../src/cloud/helpers');
const { combineShared, mergeSnippets } = require('../src/store');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

const ME = 'me-id';

test('classifyFriendships splits accepted / incoming / outgoing', () => {
  const rows = [
    { id: 'a', requester_id: ME, addressee_id: 'x', status: 'accepted' },
    { id: 'b', requester_id: 'y', addressee_id: ME, status: 'accepted' },
    { id: 'c', requester_id: 'z', addressee_id: ME, status: 'pending' }, // incoming
    { id: 'd', requester_id: ME, addressee_id: 'w', status: 'pending' }, // outgoing
  ];
  const { friends, incoming, outgoing } = classifyFriendships(rows, ME);
  assert.strictEqual(friends.length, 2);
  assert.deepStrictEqual(friends.map((f) => f.userId).sort(), ['x', 'y']);
  assert.strictEqual(incoming.length, 1);
  assert.strictEqual(incoming[0].userId, 'z');
  assert.strictEqual(incoming[0].friendshipId, 'c');
  assert.strictEqual(outgoing.length, 1);
  assert.strictEqual(outgoing[0].userId, 'w');
});

test('classifyFriendships tolerates empty / junk input', () => {
  const r = classifyFriendships(null, ME);
  assert.deepStrictEqual(r, { friends: [], incoming: [], outgoing: [] });
});

test('combineLibrarySnippets flattens, normalizes, and de-dupes (later wins)', () => {
  const libs = [
    { snippets: [{ trigger: ';a', replacement: 'A1' }, { trigger: ' ;b ', replacement: 'B' }] },
    { snippets: [{ trigger: ';a', replacement: 'A2' }] }, // overrides ;a
    { snippets: 'not-an-array' }, // ignored safely
  ];
  const out = combineLibrarySnippets(libs);
  const map = Object.fromEntries(out.map((s) => [s.trigger, s.replacement]));
  assert.strictEqual(map[';a'], 'A2');
  assert.strictEqual(map[';b'], 'B'); // trimmed trigger
  assert.strictEqual(out.length, 2);
  assert.ok(out.every((s) => s.origin === 'team'));
});

test('combineShared merges file-team + cloud caches with later winning', () => {
  const fileTeam = [{ trigger: ';x', replacement: 'FILE' }];
  const cloud = [{ trigger: ';x', replacement: 'CLOUD' }, { trigger: ';y', replacement: 'Y' }];
  const shared = combineShared([fileTeam, cloud]);
  const map = Object.fromEntries(shared.map((s) => [s.trigger, s.replacement]));
  assert.strictEqual(map[';x'], 'CLOUD'); // cloud listed later -> wins
  assert.strictEqual(map[';y'], 'Y');
});

test('personal still overrides shared cloud snippets by default', () => {
  const shared = combineShared([[], [{ trigger: ';x', replacement: 'CLOUD' }]]);
  const merged = mergeSnippets([{ trigger: ';x', replacement: 'MINE' }], shared);
  assert.strictEqual(merged.find((s) => s.trigger === ';x').replacement, 'MINE');
});

test('profileLabel prefers display name, falls back gracefully', () => {
  assert.strictEqual(profileLabel({ display_name: 'Jo', username: 'jo99' }), 'Jo');
  assert.strictEqual(profileLabel({ username: 'jo99' }), 'jo99');
  assert.strictEqual(profileLabel(null), 'Unknown user');
});

test('isValidUsername enforces the 3-24 char policy', () => {
  assert.strictEqual(isValidUsername('jordan'), true);
  assert.strictEqual(isValidUsername('a.b_c-1'), true);
  assert.strictEqual(isValidUsername('ab'), false); // too short
  assert.strictEqual(isValidUsername('has space'), false);
  assert.strictEqual(isValidUsername(''), false);
  assert.strictEqual(isValidUsername(null), false);
});

console.log('\ncloud: ' + passed + ' passed');
