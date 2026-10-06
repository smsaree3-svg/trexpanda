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

/**
 * Strip active content and remote resource loads from HTML that arrives from an
 * UNTRUSTED source (a team/cloud library shared by another user). This runs in
 * the Node main process, which has no DOMParser, so it is a conservative
 * regex pass rather than a full parser. Personal snippets created on this
 * machine are already sanitized in the renderer (see sanitizeHtml there) and
 * are left untouched.
 *
 * It removes script/style/iframe-style elements, inline event handlers, style
 * attributes, javascript:/vbscript: URLs, and remote (http/https/protocol-
 * relative) resource loads so a shared snippet can't run code, phone home, or
 * carry a tracking beacon into the user's clipboard/paste target. Self-
 * contained data: images are kept.
 */
function sanitizeUntrustedHtml(html) {
  let s = String(html);
  // Dangerous elements, with their contents. svg/math/applet/template/noscript
  // are included because they can host script/handlers or mutation-XSS vectors.
  const BAD = 'script|style|iframe|object|embed|link|meta|base|form|svg|math|applet|template|noscript';
  s = s.replace(new RegExp('<\\s*(' + BAD + ')\\b[^>]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>', 'gi'), '');
  // Self-closing or unclosed forms of the same tags.
  s = s.replace(new RegExp('<\\s*(?:' + BAD + ')\\b[^>]*/?>', 'gi'), '');
  // Inline event handlers. HTML allows either whitespace OR "/" as the attribute
  // separator, so `<img/onerror=...>` must be caught too; match quoted AND
  // unquoted values. (The old regex required a leading \s and a quoted value, so
  // `<img/onerror=alert(1) src=x>` slipped through.)
  s = s.replace(/[\s/]on[a-z][a-z0-9_-]*\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ' ');
  // Inline styles (can carry url() loads / legacy expression()), quoted OR not.
  s = s.replace(/[\s/]style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ' ');
  // Dangerous URL schemes (javascript:/vbscript:) in any URL-bearing attribute.
  // Normalize the value first (decode HTML entities, strip whitespace/control
  // chars) so entity/tab/newline obfuscation like `jav&#9;ascript:` can't hide
  // the scheme. Quoted and unquoted values are both handled.
  s = s.replace(
    /([\s/])(href|src|srcset|xlink:href|action|formaction|background|poster)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (m, sep, attr, val) => {
      const raw = val.replace(/^["']|["']$/g, '');
      const decoded = raw
        .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
        .replace(/&colon;/gi, ':');
      const norm = decoded.replace(/[\u0000- ]+/g, '').toLowerCase();
      if (/^(javascript|vbscript):/.test(norm)) return sep; // drop the whole attribute
      return m;
    }
  );
  // Remote resource loads on loader attributes (keep inline data: images),
  // quoted OR unquoted.
  s = s.replace(/[\s/](src|srcset|background|poster)\s*=\s*("\s*(?:https?:)?\/\/[^"]*"|'\s*(?:https?:)?\/\/[^']*'|(?:https?:)?\/\/[^\s>]+)/gi, ' ');
  return s;
}

/** Normalise/validate one snippet record; returns null if unusable. */
function normalizeSnippet(raw, origin) {
  if (!raw || typeof raw !== 'object') return null;
  const trigger = typeof raw.trigger === 'string' ? raw.trigger.trim() : '';
  if (!trigger) return null;
  const resolvedOrigin = origin || raw.origin || 'personal';
  const out = {
    trigger,
    replacement: typeof raw.replacement === 'string' ? raw.replacement : '',
    label: typeof raw.label === 'string' ? raw.label : trigger,
    enabled: raw.enabled !== false,
    origin: resolvedOrigin,
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
    // Team/cloud snippets come from other people, so their HTML is untrusted
    // and must be sanitized before it can reach the clipboard. Personal HTML is
    // already sanitized in the renderer.
    out.html = resolvedOrigin === 'team' ? sanitizeUntrustedHtml(raw.html) : raw.html;
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
    try {
      data = JSON.parse(payload);
    } catch (_) {
      // A non-JSON body (e.g. an HTML error page served at a "raw" URL, or a
      // truncated download) must not crash sync — surface a clear error instead.
      throw new Error('Team library is not valid JSON.');
    }
  }
  // Guard the shape: `null`, numbers, strings, etc. must not throw on .snippets.
  const list = Array.isArray(data)
    ? data
    : (data && typeof data === 'object' && Array.isArray(data.snippets)) ? data.snippets : [];
  return list.map((r) => normalizeSnippet(r, 'team')).filter(Boolean);
}

/**
 * UTC calendar day as YYYY-MM-DD. The free-tier counter is keyed to the UTC day
 * so it lines up with the server (Supabase records usage under its own UTC
 * date); a stored count from another day reads as 0.
 */
function utcDayKey(d = new Date()) {
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
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

  // Last-known RAW entitlement snapshot (account createdAt, subscription status,
  // grant, admin flag) from CloudService.getEntitlement(). We cache the RAW
  // inputs — never the derived access result — because the trial is time-based
  // and must be recomputed against the current clock (so a trial can lapse while
  // the app is offline). Lets a paying user keep access offline too.
  getPlanRaw() {
    return this.backend.get('planRaw', null);
  }
  setPlanRaw(raw) {
    this.backend.set('planRaw', raw || null);
  }

  // Free-tier daily expansion counter, account-linked with a local buffer.
  // We keep two numbers for the current UTC day: `local` (this device's
  // optimistic count, bumped instantly on every free expansion so gating works
  // offline) and `server` (the authoritative Supabase count, last fetched on
  // sync/sign-in). The effective count is the max of the two, so neither
  // clearing local data nor switching devices grants extra expansions. Offline
  // uses accumulate in `local` and are flushed to the server on the next sync
  // (see pendingFreeDelta / main.js resolveEntitlement).
  _getUsageRaw() {
    const today = utcDayKey();
    const raw = this.backend.get('dailyUsage', null);
    if (!raw || raw.date !== today) return { date: today, local: 0, server: 0 };
    return { date: today, local: Math.max(0, raw.local | 0), server: Math.max(0, raw.server | 0) };
  }
  /** Effective usage for today: { date, count } where count = max(local, server). */
  getDailyUsage() {
    const u = this._getUsageRaw();
    return { date: u.date, count: Math.max(u.local, u.server) };
  }
  /** Optimistically record one local expansion; returns the new effective usage. */
  bumpDailyUsage() {
    const u = this._getUsageRaw();
    u.local += 1;
    this.backend.set('dailyUsage', u);
    return { date: u.date, count: Math.max(u.local, u.server) };
  }
  /** Adopt the authoritative server count (never lower than what we have). */
  setServerUsage(n) {
    const u = this._getUsageRaw();
    u.server = Math.max(u.server, Math.max(0, n | 0));
    if (u.local < u.server) u.local = u.server; // server is ahead (other device / cleared data)
    this.backend.set('dailyUsage', u);
    return { date: u.date, count: Math.max(u.local, u.server) };
  }
  /** Local uses not yet acknowledged by the server (to flush on sync). */
  pendingFreeDelta() {
    const u = this._getUsageRaw();
    return Math.max(0, u.local - u.server);
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

module.exports = { normalizeSnippet, sanitizeUntrustedHtml, mergeSnippets, combineShared, parseLibrary, Store };
