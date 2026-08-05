'use strict';

/**
 * Snippet storage and merge logic.
 *
 * There are two sources of snippets:
 *   - personal: created by this user on this machine, fully editable here.
 *   - team:     pulled from the shared team library (read-only locally; the
 *               team owner edits the source and everyone re-syncs).
 *
 * mergeSnippets() combines them into the flat list the Expander consumes.
 * The merge and validation helpers are pure so they can be unit-tested without
 * Electron or the filesystem. The Store class (bottom) adds persistence and is
 * only used inside the running app.
 */

/** Normalise/validate one snippet record; returns null if unusable. */
function normalizeSnippet(raw, origin) {
  if (!raw || typeof raw !== 'object') return null;
  const trigger = typeof raw.trigger === 'string' ? raw.trigger.trim() : '';
  if (!trigger) return null;
  return {
    trigger,
    replacement: typeof raw.replacement === 'string' ? raw.replacement : '',
    label: typeof raw.label === 'string' ? raw.label : trigger,
    enabled: raw.enabled !== false,
    origin: origin || raw.origin || 'personal',
  };
}

/**
 * Merge personal + team snippets into one list.
 * On a trigger collision, `personal` wins by default so a user can locally
 * override a team snippet. Set { teamWins: true } to make team updates
 * authoritative instead.
 *
 * @returns {Array} merged, de-duplicated snippet list
 */
function mergeSnippets(personal = [], team = [], opts = {}) {
  const teamWins = !!opts.teamWins;
  const byTrigger = new Map();

  const primary = teamWins ? team : personal;
  const secondary = teamWins ? personal : team;
  const primaryOrigin = teamWins ? 'team' : 'personal';
  const secondaryOrigin = teamWins ? 'personal' : 'team';

  for (const raw of secondary) {
    const s = normalizeSnippet(raw, secondaryOrigin);
    if (s) byTrigger.set(s.trigger, s);
  }
  for (const raw of primary) {
    const s = normalizeSnippet(raw, primaryOrigin);
    if (s) byTrigger.set(s.trigger, s); // primary overwrites on conflict
  }
  return Array.from(byTrigger.values());
}

/** Parse a team-library JSON payload into a snippet array. */
function parseLibrary(payload) {
  let data = payload;
  if (typeof payload === 'string') {
    data = JSON.parse(payload);
  }
  const list = Array.isArray(data) ? data : Array.isArray(data.snippets) ? data.snippets : [];
  return list.map((r) => normalizeSnippet(r, 'team')).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Persistent store (runtime only — requires electron-store).
// ---------------------------------------------------------------------------

class Store {
  constructor(backend) {
    // `backend` is an electron-store instance (or any get/set-compatible object).
    this.backend = backend;
  }

  getPersonal() {
    return this.backend.get('personalSnippets', []);
  }
  setPersonal(list) {
    this.backend.set('personalSnippets', list);
  }

  getTeamCache() {
    return this.backend.get('teamSnippets', []);
  }
  setTeamCache(list) {
    this.backend.set('teamSnippets', list);
  }

  getSettings() {
    return this.backend.get('settings', {
      teamSource: '', // URL or folder path to the shared library
      syncIntervalMin: 30, // how often to auto-sync
      teamWins: false, // conflict resolution
      enabled: true, // master on/off for expansion
      launchAtLogin: false,
    });
  }
  setSettings(next) {
    this.backend.set('settings', { ...this.getSettings(), ...next });
  }

  /** The flat list the Expander should use right now. */
  effectiveSnippets() {
    const s = this.getSettings();
    return mergeSnippets(this.getPersonal(), this.getTeamCache(), { teamWins: s.teamWins });
  }
}

module.exports = { normalizeSnippet, mergeSnippets, parseLibrary, Store };
