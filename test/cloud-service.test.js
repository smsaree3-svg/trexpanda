'use strict';

// Tests for CloudService's friend lookup and password-reset calls, using a fake
// Supabase client. No network, no Electron.
const assert = require('assert');
const { CloudService, MIN_SEARCH_CHARS, PASSWORD_RESET_URL } = require('../src/cloud/index');

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => { passed++; console.log('  ok  ' + name); },
    (e) => { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }));
}

const ME = 'me-id';
const MISSING = { code: 'PGRST202', message: 'Could not find the function public.search_profiles' };

/** A fake supabase-js client that records calls. */
function fakeClient({ rpc = {}, profiles = [] } = {}) {
  const calls = { rpc: [], from: [], inserts: [], reset: [] };
  const client = {
    calls,
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      const r = rpc[name];
      return typeof r === 'function' ? r(args) : (r || { data: null, error: MISSING });
    },
    from: (table) => {
      calls.from.push(table);
      const q = {
        select: () => q, ilike: () => q, neq: () => q, limit: async () => ({ data: profiles, error: null }),
        maybeSingle: async () => ({ data: profiles[0] || null, error: null }),
        insert: async (row) => { calls.inserts.push({ table, row }); return { error: null }; },
      };
      return q;
    },
    auth: {
      getUser: async () => ({ data: { user: { id: ME } } }),
      resetPasswordForEmail: async (email, opts) => { calls.reset.push({ email, opts }); return { error: null }; },
      signOut: async (opts) => { calls.signOut = (calls.signOut || []).concat([opts]); return { error: null }; },
    },
  };
  return client;
}

function service(client) {
  const svc = new CloudService(null);
  svc.client = client;
  svc._requireClient = () => client;
  return svc;
}

test('searchProfiles ignores queries shorter than the minimum without calling the server', async () => {
  const c = fakeClient();
  const out = await service(c).searchProfiles('ab');
  assert.deepStrictEqual(out, []);
  assert.strictEqual(c.calls.rpc.length, 0);
  assert.strictEqual(MIN_SEARCH_CHARS, 3);
});

test('searchProfiles uses the search_profiles RPC', async () => {
  const rows = [{ id: 'x', username: 'alice', display_name: 'Alice' }];
  const c = fakeClient({ rpc: { search_profiles: { data: rows, error: null } } });
  const out = await service(c).searchProfiles('  ali ');
  assert.deepStrictEqual(out, rows);
  assert.deepStrictEqual(c.calls.rpc[0], { name: 'search_profiles', args: { p_prefix: 'ali' } });
  assert.strictEqual(c.calls.from.length, 0, 'must not query the profiles table directly');
});

test('searchProfiles falls back to the legacy query only when the RPC is missing', async () => {
  const c = fakeClient({ profiles: [{ id: 'x', username: 'alice' }] });
  const out = await service(c).searchProfiles('ali');
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(c.calls.from, ['profiles']);
});

test('searchProfiles surfaces real RPC errors instead of falling back', async () => {
  const c = fakeClient({ rpc: { search_profiles: { data: null, error: { code: '42501', message: 'denied' } } } });
  await assert.rejects(() => service(c).searchProfiles('ali'), (e) => e.code === '42501' && e.message === 'denied');
  assert.strictEqual(c.calls.from.length, 0);
});

test('sendFriendRequest resolves the user via find_profile and inserts a pending request', async () => {
  const c = fakeClient({ rpc: { find_profile: { data: [{ id: 'bob', username: 'bob.real' }], error: null } } });
  const out = await service(c).sendFriendRequest('Bob.Real');
  assert.deepStrictEqual(out, { ok: true, to: 'bob.real' });
  assert.deepStrictEqual(c.calls.rpc[0], { name: 'find_profile', args: { p_username: 'Bob.Real' } });
  assert.deepStrictEqual(c.calls.inserts[0].row, { requester_id: ME, addressee_id: 'bob', status: 'pending' });
});

test('sendFriendRequest reports an unknown username', async () => {
  const c = fakeClient({ rpc: { find_profile: { data: [], error: null } } });
  await assert.rejects(() => service(c).sendFriendRequest('nobody'), /No user found/);
  assert.strictEqual(c.calls.inserts.length, 0);
});

test('requestPasswordReset sends the reset email with the reset-page redirect', async () => {
  const c = fakeClient();
  const out = await service(c).requestPasswordReset({ email: ' me@example.test ' });
  assert.deepStrictEqual(out, { sent: true });
  assert.deepStrictEqual(c.calls.reset[0], { email: 'me@example.test', opts: { redirectTo: PASSWORD_RESET_URL } });
  assert.strictEqual(PASSWORD_RESET_URL, 'https://trexpanda.com/reset-password/');
});

test('requestPasswordReset rejects a missing or malformed address without calling the server', async () => {
  const c = fakeClient();
  await assert.rejects(() => service(c).requestPasswordReset({ email: '' }), /Enter the email/);
  await assert.rejects(() => service(c).requestPasswordReset({ email: 'not-an-email' }), /Enter the email/);
  assert.strictEqual(c.calls.reset.length, 0);
});

test('deleteAccount calls the RPC and signs out locally on success', async () => {
  const c = fakeClient({ rpc: { delete_my_account: { data: { ok: true }, error: null } } });
  const out = await service(c).deleteAccount();
  assert.deepStrictEqual(out, { ok: true });
  assert.strictEqual(c.calls.rpc[0].name, 'delete_my_account');
  assert.deepStrictEqual(c.calls.signOut, [{ scope: 'local' }]);
});

test('deleteAccount passes the server refusal through and stays signed in', async () => {
  const msg = 'Cancel your Trexpanda subscription first';
  const c = fakeClient({ rpc: { delete_my_account: { data: { ok: false, error: 'active_subscription', message: msg }, error: null } } });
  const out = await service(c).deleteAccount();
  assert.deepStrictEqual(out, { ok: false, message: msg });
  assert.strictEqual(c.calls.signOut, undefined);
});

Promise.all(pending).then(() => console.log(`\ncloud-service: ${passed} passed`));
