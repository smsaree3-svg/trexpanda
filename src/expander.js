'use strict';

/**
 * Expander — pure, dependency-free text-expansion engine.
 *
 * It knows nothing about the operating system, keyboard hooks, or Electron.
 * You feed it characters one at a time (as the user types) and it tells you
 * when a trigger has matched and what to do about it. That separation is what
 * makes the whole expansion behaviour unit-testable in plain Node.
 *
 * Typical wiring (see main.js):
 *   engine.onChar('h')  -> null
 *   engine.onChar('i')  -> null
 *   ... until a full trigger is in the buffer ...
 *   engine.onChar(';')  -> { trigger: ';addr', replacement: '...', backspaces: 5, caretBack: 0 }
 */

// Dynamic tokens resolve in the user's LOCAL time zone, matching the Android
// (LocalDate/LocalTime) and iOS (DateFormatter) engines. Using UTC here would
// make {date} disagree with the phone near midnight, so local is correct.
const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const localTime = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

// Grapheme-cluster count (user-perceived characters) via the platform's native
// Unicode segmenter. This is the unit the OS uses to move the caret one step, so
// it is the correct unit for caretBack. Falls back to code points only on very
// old runtimes without Intl.Segmenter.
const GRAPHEME_SEG = (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function')
  ? new Intl.Segmenter('und', { granularity: 'grapheme' })
  : null;
function graphemeCount(s) {
  if (!s) return 0;
  if (GRAPHEME_SEG) { let n = 0; for (const _ of GRAPHEME_SEG.segment(s)) n++; return n; }
  return Array.from(s).length; // fallback: code points
}
const DYNAMIC = {
  // {date}          -> 2026-08-05 (local)
  date: () => localDate(new Date()),
  // {time}          -> 14:09 (local, 24-hour)
  time: () => localTime(new Date()),
  // {datetime}      -> 2026-08-05 14:09 (local)
  datetime: () => {
    const d = new Date();
    return `${localDate(d)} ${localTime(d)}`;
  },
};

class Expander {
  /**
   * @param {Array<{trigger:string, replacement:string, enabled?:boolean}>} snippets
   * @param {object} [opts]
   * @param {(name:string)=>string} [opts.dynamicResolver] custom {var} resolver
   */
  constructor(snippets = [], opts = {}) {
    this.opts = opts;
    this.buffer = '';
    this.setSnippets(snippets);
  }

  setSnippets(snippets) {
    this.map = new Map();
    // Case-insensitive active index: lowercased trigger -> { trigger, snippet }.
    // Triggers match case-insensitively, so ";ch", ";CH" and ";Ch" are the SAME
    // trigger; exactly one active snippet exists per lowercased trigger and the
    // LAST definition wins (SPEC-EXPANSION.md section 5). Lowercasing the key
    // once here also keeps the per-keystroke match path free of toLowerCase on
    // every trigger. The canonical (as-typed) spelling is kept for display and
    // for counting how many characters to delete on expansion.
    this.byLower = new Map();
    let max = 1;
    for (const s of snippets) {
      if (!s || !s.trigger || s.enabled === false) continue;
      // Keep the whole snippet so expansion can access text AND any attachment.
      this.map.set(s.trigger, s);
      this.byLower.set(s.trigger.toLowerCase(), { trigger: s.trigger, snippet: s });
      if (s.trigger.length > max) max = s.trigger.length;
    }
    // Longest trigger determines how much recent typing we need to remember.
    this.maxTrigger = max;
    // Keep the buffer within bounds after a snippet set change.
    this.buffer = this.buffer.slice(-this.maxTrigger);
  }

  /** Clear the rolling buffer (call on focus change, Enter, mouse click, etc.). */
  reset() {
    this.buffer = '';
  }

  /**
   * Feed a single printable character.
   * @returns {null | {trigger, replacement, backspaces, caretBack}}
   */
  onChar(ch) {
    if (typeof ch !== 'string' || ch.length !== 1) return null;
    this.buffer = (this.buffer + ch).slice(-this.maxTrigger);

    // Prefer the longest matching trigger so ";addr2" wins over ";addr".
    // Matching is case-insensitive: compare the lowercased buffer against each
    // precomputed lowercased trigger. On a length tie the last-defined wins,
    // which is already guaranteed because byLower holds one entry per trigger.
    const lowerBuf = this.buffer.toLowerCase();
    let best = null; // { lower, trigger, snippet }
    for (const [lower, entry] of this.byLower) {
      if (lowerBuf.endsWith(lower)) {
        if (!best || lower.length > best.lower.length) best = { lower, trigger: entry.trigger, snippet: entry.snippet };
      }
    }
    if (!best) return null;

    const snippet = best.snippet;
    const rendered = this.render(snippet.replacement || '');
    this.buffer = ''; // consumed
    return {
      trigger: best.trigger,
      replacement: rendered.text,
      // Optional rich HTML variant, with {tokens} resolved. When present the
      // caller writes both text and HTML to the clipboard so formatting
      // (bold, lists, links, images) survives a paste into rich apps.
      html: snippet.html ? this.renderHtml(snippet.html) : null,
      backspaces: best.trigger.length, // how many chars of the trigger to delete
      caretBack: rendered.caretBack, // how far to move the caret left after insert
      // Optional {type:'image'|'file', name, mime, data(base64)} — pasted on expansion.
      attachment: snippet.attachment || null,
    };
  }

  /** Handle a Backspace keypress so the buffer stays in sync with the field. */
  onBackspace() {
    this.buffer = this.buffer.slice(0, -1);
  }

  /**
   * Live autocomplete: given what the user is currently typing, return the
   * snippets whose trigger STARTS WITH the current token (the run of non-space
   * characters at the end of the buffer). Pure and dependency-free so it can be
   * unit-tested; the UI layer decides when/where to show the results.
   *
   * @param {number} [limit=6] max items to return
   * @returns {{token:string, items:Array<{trigger, preview, hasAttachment, isHtml}>}}
   */
  suggestions(limit = 6) {
    const m = this.buffer.match(/(\S+)$/);
    const token = m ? m[1] : '';
    if (!token) return { token: '', items: [] };

    const tokenLower = token.toLowerCase();
    const items = [];
    for (const [lower, entry] of this.byLower) {
      const trigger = entry.trigger, snippet = entry.snippet;
      if (trigger.length >= token.length && lower.startsWith(tokenLower)) {
        const raw = String(snippet.replacement || '');
        items.push({
          trigger,
          // One-line, whitespace-collapsed preview of what the snippet inserts.
          preview: raw.replace(/\s+/g, ' ').trim().slice(0, 140),
          hasAttachment: !!snippet.attachment,
          isHtml: !!snippet.html,
        });
      }
    }
    // Shortest (closest) trigger first, then plain lexicographic order. Not
    // localeCompare: Android and iOS order by code unit, so desktop must too, or
    // suggestions could be ordered differently on the same account.
    items.sort((a, b) =>
      a.trigger.length - b.trigger.length ||
      (a.trigger < b.trigger ? -1 : a.trigger > b.trigger ? 1 : 0));
    return { token, items: items.slice(0, Math.max(1, limit)) };
  }

  /**
   * Expand dynamic tokens and locate the optional caret marker "$|".
   * Supported: {date} {time} {datetime} and any custom via opts.dynamicResolver.
   * "$|" marks where the caret should land after insertion (it is removed).
   * @returns {{text:string, caretBack:number}}
   */
  render(replacement) {
    let text = String(replacement);

    text = text.replace(/\{(\w+)\}/g, (whole, name) => {
      if (this.opts.dynamicResolver) {
        const custom = this.opts.dynamicResolver(name);
        if (custom != null) return custom;
      }
      if (DYNAMIC[name]) return DYNAMIC[name]();
      return whole; // leave unknown tokens untouched
    });

    let caretBack = 0;
    const marker = text.indexOf('$|');
    if (marker !== -1) {
      // Everything after the FIRST marker, with any further "$|" markers also
      // stripped (consistent with renderHtml, which strips all of them).
      const after = text.slice(marker + 2).split('$|').join('');
      // Count caret-back in GRAPHEME CLUSTERS (user-perceived characters): the
      // caller moves the caret one Left-arrow press per step, and the OS moves one
      // grapheme per press, so a flag, a skin-tone emoji, or a ZWJ sequence is a
      // single step even though it spans several code points. Uses the platform's
      // native segmenter (Intl.Segmenter), the same unit the OS cursor uses, so
      // desktop, Android, and iOS all land the caret at the same visual spot.
      caretBack = graphemeCount(after);
      text = text.slice(0, marker) + after;
    }
    return { text, caretBack };
  }

  /**
   * Resolve {tokens} inside an HTML replacement and strip the "$|" caret
   * marker (caret placement isn't supported for rich paste). Returns HTML.
   */
  renderHtml(html) {
    let out = String(html);
    out = out.replace(/\{(\w+)\}/g, (whole, name) => {
      if (this.opts.dynamicResolver) {
        const custom = this.opts.dynamicResolver(name);
        if (custom != null) return custom;
      }
      if (DYNAMIC[name]) return DYNAMIC[name]();
      return whole;
    });
    return out.split('$|').join('');
  }
}

module.exports = { Expander };
