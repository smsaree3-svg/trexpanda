'use strict';

/**
 * Supabase connection config.
 *
 * The project URL and the "anon" (public) key are NOT secrets — they are meant
 * to ship inside client apps. All real access control lives in the Row Level
 * Security policies in supabase/schema.sql, so a leaked anon key still can't
 * read another user's data.
 *
 * Resolution order (first hit wins):
 *   1. Environment variables  SUPABASE_URL / SUPABASE_ANON_KEY
 *   2. A cloud-config.json file sitting next to this file
 *      (copy cloud-config.example.json -> cloud-config.json and fill it in)
 *   3. Empty — the app runs fine, just with the cloud features switched off.
 */

const fs = require('fs');
const path = require('path');

function readJsonConfig() {
  try {
    const p = path.join(__dirname, 'cloud-config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    /* ignore malformed / missing file */
  }
  return {};
}

const file = readJsonConfig();

const url = (process.env.SUPABASE_URL || file.url || '').trim();
const anonKey = (process.env.SUPABASE_ANON_KEY || file.anonKey || '').trim();

function isConfigured() {
  return !!(url && anonKey);
}

module.exports = { url, anonKey, isConfigured };
