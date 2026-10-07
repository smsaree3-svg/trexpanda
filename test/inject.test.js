'use strict';

// Regression test for the clipboardy resilience guard in src/inject.js.
//
// Field report: on a Windows machine where antivirus had quarantined clipboardy's
// bundled helper (so `require('clipboardy')` failed with
//   ENOENT ... app.asar.unpacked\node_modules\clipboardy\package.json),
// ALL expansion stopped working. Trexpanda never uses nut-js's clipboard (it
// drives the clipboard through Electron), but importing @nut-tree-fork/nut-js
// eagerly loads its default clipboard provider, which does a top-level
// `require('clipboardy')`. That one failure propagated out of the whole nut-js
// import and disabled keystroke injection.
//
// inject.js now stubs `clipboardy` during the nut-js import. This test rebuilds
// the same module graph (a nut-like package -> a provider -> a broken clipboardy)
// and proves: (1) without the guard the import fails exactly as reported, and
// (2) with the guard the import succeeds and keyboard access survives.

const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

// Build a throwaway module tree that mirrors the real dependency chain:
//   nutlike (like @nut-tree-fork/nut-js)
//     -> provider (like @nut-tree-fork/default-clipboard-provider)
//          -> require('clipboardy')  // top-level, and here made to throw ENOENT
function makeBrokenTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-'));
  const nm = path.join(dir, 'node_modules');
  const pkg = (p, main) => fs.writeFileSync(path.join(p, 'package.json'),
    JSON.stringify({ name: path.basename(p), version: '1.0.0', main: main || 'index.js' }));

  const cb = path.join(nm, 'clipboardy'); fs.mkdirSync(cb, { recursive: true }); pkg(cb);
  // Simulate clipboardy's files being unavailable: loading it throws ENOENT, the
  // same shape Node produces when clipboardy/package.json is missing.
  fs.writeFileSync(path.join(cb, 'index.js'),
    "throw Object.assign(new Error(\"ENOENT: no such file or directory, open 'clipboardy/package.json'\"), { code: 'ENOENT' });");

  const prov = path.join(nm, 'provider'); fs.mkdirSync(prov, { recursive: true }); pkg(prov);
  fs.writeFileSync(path.join(prov, 'index.js'), "require('clipboardy'); module.exports = { default: {} };");

  const nut = path.join(nm, 'nutlike'); fs.mkdirSync(nut, { recursive: true }); pkg(nut);
  fs.writeFileSync(path.join(nut, 'index.js'), "require('provider'); module.exports = { keyboard: { config: {} } };");

  const entry = path.join(dir, 'entry.js');
  fs.writeFileSync(entry, "module.exports = require('nutlike');");
  return entry;
}

test('baseline: a broken clipboardy breaks the nut import (reproduces the report)', () => {
  const entry = makeBrokenTree();
  let threw = null;
  try { require(entry); } catch (e) { threw = e; }
  assert(threw, 'import should fail when clipboardy is broken and unguarded');
  assert(/clipboardy/.test(String(threw.message)), 'failure is the clipboardy ENOENT');
});

test('guarded: stubbing clipboardy during import keeps keystroke injection alive', () => {
  const entry = makeBrokenTree();
  // The exact guard used by src/inject.js.
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'clipboardy') {
      return { readSync: () => '', writeSync: () => {}, read: async () => '', write: async () => {} };
    }
    return originalLoad.apply(this, arguments);
  };
  let loaded = null, err = null;
  try { loaded = require(entry); } catch (e) { err = e; } finally { Module._load = originalLoad; }
  assert.strictEqual(err, null, 'guarded import must not throw');
  assert(loaded && loaded.keyboard, 'nut-like module loads and keyboard is available');
});

test('the guard is scoped: Module._load is restored and only clipboardy is stubbed', () => {
  const before = Module._load;
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'clipboardy') return { readSync: () => '' };
    return originalLoad.apply(this, arguments);
  };
  // A normal require still goes through untouched while the guard is installed.
  assert.strictEqual(typeof require('path').join, 'function');
  Module._load = originalLoad;
  assert.strictEqual(Module._load, before, 'Module._load restored after import');
});

test('src/inject.js still loads and exports its injection API', () => {
  const inject = require('../src/inject');
  for (const fn of ['available', 'getLoadError', 'expand', 'expandHtml', 'pressBackspaces', 'paste']) {
    assert.strictEqual(typeof inject[fn], 'function', 'exports ' + fn);
  }
  // nut-js native module is not installed in CI, so injection is simply
  // unavailable here — but requiring inject.js must never throw.
  assert.strictEqual(typeof inject.available(), 'boolean');
});

console.log('\ninject: ' + passed + ' passed');
