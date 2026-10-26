'use strict';

// Runs docs/reset-password/reset.js against a fake DOM and fake fetch.
// No browser, no network: it checks the request sequence the page makes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'reset-password', 'reset.js'), 'utf8');

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => { passed++; console.log('  ok  ' + name); },
    (e) => { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }));
}

function el() { return { textContent: '', className: '', hidden: true, disabled: false, value: '', listeners: {},
  addEventListener(t, f) { this.listeners[t] = f; } }; }

function load({ search = '?token_hash=pkce_abc&type=recovery', framed = false, responses = [] } = {}) {
  const els = { intro: el(), form: el(), pw1: el(), pw2: el(), save: el(), msg: el() };
  const calls = [];
  const queue = responses.slice();
  const win = { location: { search, pathname: '/reset-password/' }, history: { replaced: null,
    replaceState(_s, _t, url) { this.replaced = url; } } };
  win.self = win; win.top = framed ? {} : win;
  const sandbox = {
    window: win, URLSearchParams,
    document: { getElementById: (id) => els[id] },
    fetch: async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.Authorization });
      const r = queue.shift() || { ok: true, json: {} };
      return { ok: r.ok, json: async () => r.json };
    },
  };
  vm.runInNewContext(SRC, sandbox);
  const submit = async (pw) => { els.pw1.value = pw; els.pw2.value = pw;
    await els.form.listeners.submit({ preventDefault() {} }); };
  return { els, calls, win, submit };
}

test('strips the token from the address bar and shows the form', () => {
  const { els, win } = load();
  assert.strictEqual(win.history.replaced, '/reset-password/');
  assert.strictEqual(els.form.hidden, false);
});

test('refuses to run inside a frame', () => {
  const { els } = load({ framed: true });
  assert.strictEqual(els.form.hidden, true);
  assert.match(els.intro.textContent, /directly from the email/);
});

test('rejects a link without a recovery token', () => {
  const { els } = load({ search: '?type=signup' });
  assert.strictEqual(els.form.hidden, true);
  assert.match(els.msg.textContent, /Forgot password/);
});

test('verify once, update password, then sign out every session', async () => {
  const { els, calls, submit } = load({ responses: [
    { ok: true, json: { access_token: 'AT' } }, { ok: true, json: {} }, { ok: true, json: {} }] });
  await submit('correct horse battery');
  assert.deepStrictEqual(calls.map((c) => c.method + ' ' + c.url.replace(/^https:\/\/[^/]+/, '')), [
    'POST /auth/v1/verify', 'PUT /auth/v1/user', 'POST /auth/v1/logout?scope=global']);
  assert.deepStrictEqual(calls[0].body, { type: 'recovery', token_hash: 'pkce_abc' });
  assert.strictEqual(calls[1].auth, 'Bearer AT');
  assert.deepStrictEqual(calls[1].body, { password: 'correct horse battery' });
  assert.match(els.msg.textContent, /sign in with your new password/);
});

test('a rejected password can be retried without re-verifying the one-time token', async () => {
  const { els, calls, submit } = load({ responses: [
    { ok: true, json: { access_token: 'AT' } },
    { ok: false, json: { msg: 'New password should be different from the old password.' } },
    { ok: true, json: {} }, { ok: true, json: {} }] });
  await submit('same-as-before');
  assert.match(els.msg.textContent, /different from the old/);
  await submit('a brand new password');
  assert.strictEqual(calls.filter((c) => c.url.endsWith('/verify')).length, 1, 'token verified exactly once');
  assert.strictEqual(calls.filter((c) => c.method === 'PUT').length, 2);
});

test('short or mismatched passwords never reach the server', async () => {
  const { els, calls, submit } = load();
  await submit('short');
  assert.match(els.msg.textContent, /at least 8/);
  els.pw1.value = 'long enough one'; els.pw2.value = 'long enough two';
  await els.form.listeners.submit({ preventDefault() {} });
  assert.match(els.msg.textContent, /do not match/);
  assert.strictEqual(calls.length, 0);
});

Promise.all(pending).then(() => console.log(`\nreset-page: ${passed} passed`));
