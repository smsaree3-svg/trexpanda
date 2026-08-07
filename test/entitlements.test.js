'use strict';

/**
 * Unit tests for the trial / paid / expired entitlement logic. Pure Node.
 * Run: node test/entitlements.test.js
 */

const assert = require('assert');
const ent = require('../src/entitlements');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-07T00:00:00Z');
// helper: an account created `d` days ago
const createdDaysAgo = (d) => NOW - d * DAY;

console.log('entitlements (trial model)');

ok('signed out => no access, must sign in', () => {
  const a = ent.computeAccess({ signedIn: false, now: NOW });
  assert.strictEqual(a.state, 'signed_out');
  assert.strictEqual(a.hasAccess, false);
  assert.strictEqual(a.canAdd, false);
  assert.strictEqual(a.canExport, false);
});

ok('fresh account is trialing with ~30 days left, full access but no export', () => {
  const a = ent.computeAccess({ signedIn: true, createdAt: NOW, now: NOW });
  assert.strictEqual(a.state, 'trialing');
  assert.strictEqual(a.hasAccess, true);
  assert.strictEqual(a.canAdd, true);
  assert.strictEqual(a.canExport, false, 'export is off during trial');
  assert.strictEqual(a.trialDaysLeft, ent.TRIAL_DAYS);
});

ok('trial with 5 days elapsed reports 25 days left', () => {
  const a = ent.computeAccess({ signedIn: true, createdAt: createdDaysAgo(5), now: NOW });
  assert.strictEqual(a.trialDaysLeft, 25);
  assert.strictEqual(a.state, 'trialing');
});

ok('trial lapses exactly at 30 days => expired, read-only', () => {
  const a = ent.computeAccess({ signedIn: true, createdAt: createdDaysAgo(30), now: NOW });
  assert.strictEqual(a.state, 'expired');
  assert.strictEqual(a.hasAccess, false);
  assert.strictEqual(a.canAdd, false);
  assert.strictEqual(a.canExport, false);
  assert.strictEqual(a.trialDaysLeft, 0);
});

ok('active subscription => pro, full access incl export (even after trial)', () => {
  const a = ent.computeAccess({ signedIn: true, createdAt: createdDaysAgo(400), subStatus: 'active', now: NOW });
  assert.strictEqual(a.state, 'pro');
  assert.strictEqual(a.isPaid, true);
  assert.strictEqual(a.canExport, true);
  assert.strictEqual(a.hasAccess, true);
});

ok('trialing/past_due subscriptions also count as paid', () => {
  for (const subStatus of ['trialing', 'past_due']) {
    const a = ent.computeAccess({ signedIn: true, createdAt: createdDaysAgo(400), subStatus, now: NOW });
    assert.strictEqual(a.isPaid, true, subStatus);
    assert.strictEqual(a.canExport, true, subStatus);
  }
});

ok('canceled subscription after trial => expired', () => {
  const a = ent.computeAccess({ signedIn: true, createdAt: createdDaysAgo(400), subStatus: 'canceled', now: NOW });
  assert.strictEqual(a.state, 'expired');
  assert.strictEqual(a.isPaid, false);
});

ok('lifetime coupon grant unlocks Pro forever (no expiry)', () => {
  const a = ent.computeAccess({
    signedIn: true, createdAt: createdDaysAgo(400), hasGrant: true, grantUnlockedUntil: null, now: NOW,
  });
  assert.strictEqual(a.state, 'coupon');
  assert.strictEqual(a.isPaid, true);
  assert.strictEqual(a.canExport, true);
  assert.strictEqual(a.unlockedUntil, null);
});

ok('time-limited grant: active before expiry, expired after', () => {
  const future = NOW + 10 * DAY;
  const past = NOW - 1 * DAY;
  const active = ent.computeAccess({ signedIn: true, createdAt: createdDaysAgo(400), hasGrant: true, grantUnlockedUntil: future, now: NOW });
  assert.strictEqual(active.state, 'coupon');
  assert.strictEqual(active.isPaid, true);
  const lapsed = ent.computeAccess({ signedIn: true, createdAt: createdDaysAgo(400), hasGrant: true, grantUnlockedUntil: past, now: NOW });
  assert.strictEqual(lapsed.state, 'expired');
  assert.strictEqual(lapsed.isPaid, false);
});

ok('coupon overrides an expired trial', () => {
  const a = ent.computeAccess({ signedIn: true, createdAt: createdDaysAgo(45), hasGrant: true, grantUnlockedUntil: null, now: NOW });
  assert.strictEqual(a.state, 'coupon');
  assert.strictEqual(a.hasAccess, true);
});

ok('isAdmin passes through independently of plan', () => {
  const a = ent.computeAccess({ signedIn: true, createdAt: NOW, isAdmin: true, now: NOW });
  assert.strictEqual(a.isAdmin, true);
  assert.strictEqual(a.state, 'trialing');
});

ok('descriptor is JSON-safe (round-trips)', () => {
  const a = ent.computeAccess({ signedIn: true, createdAt: NOW, subStatus: 'active', now: NOW });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(a)));
});

console.log('\n' + passed + ' entitlement tests passed.\n');
