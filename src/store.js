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
  const out = {
    trigger,
    replacement: typeof raw.replacement === 'string' ? raw.replacement : '',
    label: typeof raw.label === 'string' ? raw.label : trigger,
    enabled: raw.enabled !== false,
    origin: origin || raw.origin || 'personal',
  };
  // Optional attachment: an image (pasted inline) or a file (copied to clipboard
  // so it can be pasted as an attachment). Stored as base64 so it syncs with the
  // team library JSON.
  const a = raw.attachment;
  if (a && typeof a === 'object' && (a.type === 'image' || a.type === 'file') &&
      typeof a.data === 'string' && a.data) {
    out.attachment = {
      type: a.type,
      name: typeof a.name === 'string' ? a.name : (a.type === 'image' ? 'image.png' : 'file'),
      mime: typeof a.mime === 'string' ? a.mime : '',
      data: a.data, // base64, no data-URL prefix
    };
  }
  // Optional rich-text HTML variant of the replacement (bold/italic/lists/
  // links/inline images). Kept as a string so it syncs in the team library.
  if (typeof raw.html === 'string' && raw.html.trim()) {
    out.html = raw.html;
  }
  return out;
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

/**
 * Combine several shared snippet lists (e.g. the file-based team library plus
 * one or more cloud libraries shared with you) into a single normalized,
 * de-duplicated list tagged as team-origin. Later lists win on a collision.
 */
function combineShared(lists = []) {
  const byTrigger = new Map();
  for (const list of lists) {
    for (const raw of list || []) {
      const s = normalizeSnippet(raw, 'team');
      if (s) byTrigger.set(s.trigger, s);
    }
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

  // Cloud cache: snippets pulled from libraries friends have shared with you
  // (kept separate from the file-based team library so the two can't clobber
  // each other's cache).
  getCloudCache() {
    return this.backend.get('cloudSnippets', []);
  }
  setCloudCache(list) {
    this.backend.set('cloudSnippets', list);
  }

  getSettings() {
    return this.backend.get('settings', {
      teamSource: '', // URL or folder path to the shared library
      syncIntervalMin: 30, // how often to auto-sync
      teamWins: false, // conflict resolution
      enabled: true, // master on/off for expansion
      launchAtLogin: false,
      showSuggestions: true, // live autocomplete popup while typing a trigger
      cloudSubscriptions: [], // library ids (shared with me) to pull on sync
      publishToCloud: false, // auto-publish personal snippets to my cloud library
    });
  }
  setSettings(next) {
    this.backend.set('settings', { ...this.getSettings(), ...next });
  }

  /** The flat list the Expander should use right now. */
  effectiveSnippets() {
    const s = this.getSettings();
    // Everything shared with this user — file-based team library plus any cloud
    // libraries friends have shared — is merged into one "team" pool first, then
    // the personal list is layered on top per the conflict setting.
    const shared = combineShared([this.getTeamCache(), this.getCloudCache()]);
    return mergeSnippets(this.getPersonal(), shared, { teamWins: s.teamWins });
  }
}

module.exports = { normalizeSnippet, mergeSnippets, combineShared, parseLibrary, Store };
