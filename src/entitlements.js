'use strict';

/**
 * Entitlements — the single source of truth for what a user is allowed to do.
 *
 * Pure and dependency-free so it can be unit-tested in plain Node and reused by
 * both the main process (enforcement) and the renderer (UI).
 *
 * Business model (no card upfront):
 *   - New account => 30-day FREE TRIAL. Full features EXCEPT export.
 *   - Paid (Pro): an active Stripe subscription. Full features incl. export.
 *   - Unlocked (coupon/comp): a grant that unlocks Pro, optionally time-limited.
 *     Same powers as Pro.
 *   - Expired: trial is over and there's no subscription or grant. The app goes
 *     read-only — snippets stop expanding and no new ones can be added, but the
 *     user can still open the app, view, and (only if they later pay) export.
 *   - Signed out: nothing is unlocked; you must sign in to start/continue a trial.
 *
 * The trial clock is anchored to the account's creation time (from Supabase
 * auth: user.created_at), which is server-side and per-account, so it can't be
 * reset by reinstalling or clearing local data.
 *
 * `computeAccess()` takes a normalized snapshot and the current time and returns
 * a JSON-safe descriptor. Because the trial is time-based, callers should keep
 * the RAW snapshot and recompute with a fresh `now` rather than caching the
 * derived result (a trial can lapse while the app is offline).
 */

/** Length of the free trial, in days. Change this one constant to retune it. */
const TRIAL_DAYS = 30;

/** Stripe subscription statuses that count as paid/active. */
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse an ISO string or epoch-ms into epoch-ms, or null. */
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

/**
 * @param {object} s snapshot
 * @param {boolean} s.signedIn
 * @param {string|number|null} s.createdAt  account creation (ISO or ms)
 * @param {string|null} s.subStatus         Stripe subscription status
 * @param {boolean} s.hasGrant              a coupon/comp grant row exists
 * @param {string|number|null} s.grantUnlockedUntil  grant expiry (null => lifetime)
 * @param {boolean} s.isAdmin
 * @param {number} s.now                    current time (epoch ms)
 * @returns {object} JSON-safe access descriptor
 */
function computeAccess(s) {
  s = s || {};
  const now = typeof s.now === 'number' ? s.now : toMs(s.now) || 0;
  const signedIn = !!s.signedIn;
  const isAdmin = !!s.isAdmin;

  const createdAt = toMs(s.createdAt);
  const trialEndsAt = createdAt != null ? createdAt + TRIAL_DAYS * DAY_MS : null;

  const subActive = ACTIVE_STATUSES.includes(s.subStatus);

  const grantUntil = toMs(s.grantUnlockedUntil);
  const grantActive = !!s.hasGrant && (s.grantUnlockedUntil == null || grantUntil == null
    ? !!s.hasGrant // lifetime grant (no expiry)
    : grantUntil > now);

  const isPaid = signedIn && (subActive || grantActive);
  const trialing = signedIn && !isPaid && trialEndsAt != null && now < trialEndsAt;
  const hasAccess = isPaid || trialing;

  let state;
  if (!signedIn) state = 'signed_out';
  else if (subActive) state = 'pro';
  else if (grantActive) state = 'coupon';
  else if (trialing) state = 'trialing';
  else state = 'expired';

  const trialDaysLeft = trialing
    ? Math.max(0, Math.ceil((trialEndsAt - now) / DAY_MS))
    : 0;

  return {
    state,                                  // signed_out | trialing | pro | coupon | expired
    signedIn,
    isAdmin,
    isPaid,                                 // Pro powers (subscription OR grant)
    hasAccess,                              // may use the expander / add snippets
    canAdd: hasAccess,                      // can create new snippets
    canExport: isPaid,                      // export is paid-only (off during trial)
    trialEndsAt,                            // epoch ms | null
    trialDaysLeft,
    unlockedUntil: grantActive ? (grantUntil || null) : null,
    subStatus: s.subStatus || null,
  };
}

/** Convenience: does this descriptor allow using the expander right now? */
function hasAccess(desc) {
  return !!(desc && desc.hasAccess);
}

/** A safe default descriptor (used before the first cloud resolve). */
function unknown() {
  return {
    state: 'signed_out', signedIn: false, isAdmin: false,
    isPaid: false, hasAccess: false, canAdd: false, canExport: false,
    trialEndsAt: null, trialDaysLeft: 0, unlockedUntil: null, subStatus: null,
  };
}

module.exports = {
  TRIAL_DAYS,
  ACTIVE_STATUSES,
  computeAccess,
  hasAccess,
  unknown,
};
