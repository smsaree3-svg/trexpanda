'use strict';

/**
 * Pure helpers for the cloud/social layer — no network, no Supabase, so they
 * can be unit-tested in plain Node (see test/cloud.test.js).
 */

const { normalizeSnippet } = require('../store');

/**
 * Turn a flat list of friendship rows into the three buckets the UI needs.
 * Each row: { id, requester_id, addressee_id, status }.
 *
 * @returns {{friends: Array, incoming: Array, outgoing: Array}}
 *   friends  -> accepted links               [{ friendshipId, userId }]
 *   incoming -> pending requests sent TO me   [{ friendshipId, userId }]
 *   outgoing -> pending requests I sent       [{ friendshipId, userId }]
 */
function classifyFriendships(rows = [], myId) {
  const friends = [];
  const incoming = [];
  const outgoing = [];
  for (const r of rows || []) {
    if (!r) continue;
    const other = r.requester_id === myId ? r.addressee_id : r.requester_id;
    const entry = { friendshipId: r.id, userId: other };
    if (r.status === 'accepted') {
      friends.push(entry);
    } else if (r.status === 'pending') {
      if (r.addressee_id === myId) incoming.push(entry);
      else outgoing.push(entry);
    }
  }
  return { friends, incoming, outgoing };
}

/**
 * Flatten multiple cloud library rows ({ snippets: [...] }) into one normalized,
 * de-duplicated snippet list tagged as team-origin (read-only locally). Later
 * libraries win on a trigger collision.
 */
function combineLibrarySnippets(libraries = []) {
  const byTrigger = new Map();
  for (const lib of libraries || []) {
    const list = lib && Array.isArray(lib.snippets) ? lib.snippets : [];
    for (const raw of list) {
      const s = normalizeSnippet(raw, 'team');
      if (s) byTrigger.set(s.trigger, s);
    }
  }
  return Array.from(byTrigger.values());
}

/** Human label for a profile row, falling back gracefully. */
function profileLabel(profile) {
  if (!profile) return 'Unknown user';
  return profile.display_name || profile.username || 'Unknown user';
}

/** Basic username policy: 3-24 chars, letters/numbers/._- , case-insensitive. */
function isValidUsername(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9._-]{3,24}$/.test(name.trim());
}

module.exports = {
  classifyFriendships,
  combineLibrarySnippets,
  profileLabel,
  isValidUsername,
};
