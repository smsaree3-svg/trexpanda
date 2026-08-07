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

const DYNAMIC = {
  // {date}          -> 2026-08-05
  date: () => new Date().toISOString().slice(0, 10),
  // {time}          -> 14:09
  time: () => new Date().toTimeString().slice(0, 5),
  // {datetime}      -> 2026-08-05 14:09
  datetime: () => {
    const d = new Date();
    return d.toISOString().slice(0, 10) + ' ' + d.toTimeString().slice(0, 5);
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
    let max = 1;
    for (const s of snippets) {
      if (!s || !s.trigger || s.enabled === false) continue;
      // Store the whole snippet so expansion can access text AND any attachment.
      this.map.set(s.trigger, s);
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
    let best = null;
    for (const trigger of this.map.keys()) {
      if (this.buffer.endsWith(trigger)) {
        if (!best || trigger.length > best.length) best = trigger;
      }
    }
    if (!best) return null;

    const snippet = this.map.get(best);
    const rendered = this.render(snippet.replacement || '');
    this.buffer = ''; // consumed
    return {
      trigger: best,
      replacement: rendered.text,
      // Optional rich HTML variant, with {tokens} resolved. When present the
      // caller writes both text and HTML to the clipboard so formatting
      // (bold, lists, links, images) survives a paste into rich apps.
      html: snippet.html ? this.renderHtml(snippet.html) : null,
      backspaces: best.length, // how many chars of the trigger to delete
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

    const items = [];
    for (const [trigger, snippet] of this.map) {
      if (trigger.length >= token.length && trigger.startsWith(token)) {
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
    // Shortest (closest) trigger first, then alphabetical — feels predictable.
    items.sort((a, b) => a.trigger.length - b.trigger.length || a.trigger.localeCompare(b.trigger));
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
      caretBack = text.length - marker - 2; // chars to the right of the marker
      text = text.slice(0, marker) + text.slice(marker + 2);
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
