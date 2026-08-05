'use strict';

/**
 * Team-library sync.
 *
 * A "team source" is just a pointer to a JSON snippet library that a team
 * owner maintains. It can be:
 *   - an http(s) URL   e.g. a GitHub "raw" URL, an S3/CDN object, any endpoint
 *   - a local path     e.g. a synced Dropbox / Google Drive / OneDrive folder
 *                      or a network share everyone on the team mounts
 *
 * Both cases resolve to the same JSON shape:
 *   { "version": 3, "snippets": [ { "trigger": ";addr", "replacement": "...",
 *     "label": "Office address" }, ... ] }
 * (A bare array of snippets is also accepted.)
 *
 * Because the source is a plain file/URL, "teams update the tool" needs no
 * backend: the owner edits the JSON (in git, in the shared folder), everyone
 * else pulls it on their sync interval or on demand.
 */

const fs = require('fs');
const path = require('path');
const { parseLibrary } = require('./store');

const LIBRARY_FILENAME = 'team-library.json';

function looksLikeUrl(source) {
  return /^https?:\/\//i.test(String(source || '').trim());
}

/** Fetch and parse the team library. Returns { snippets, fetchedAt, source }. */
async function fetchTeamLibrary(source, opts = {}) {
  const src = String(source || '').trim();
  if (!src) throw new Error('No team source configured.');

  let raw;
  if (looksLikeUrl(src)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || 15000);
    try {
      const res = await fetch(src, {
        signal: controller.signal,
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching team library`);
      raw = await res.text();
    } finally {
      clearTimeout(timeout);
    }
  } else {
    raw = readLibraryFromPath(src);
  }

  const snippets = parseLibrary(raw);
  return { snippets, fetchedAt: new Date().toISOString(), source: src };
}

/** Read the library JSON from a file OR from a folder containing the file. */
function readLibraryFromPath(p) {
  let target = p;
  const stat = fs.existsSync(p) ? fs.statSync(p) : null;
  if (stat && stat.isDirectory()) {
    target = path.join(p, LIBRARY_FILENAME);
  }
  if (!fs.existsSync(target)) {
    throw new Error(`Team library not found at ${target}`);
  }
  return fs.readFileSync(target, 'utf8');
}

/**
 * Write a team library to a shared folder — used by a team owner who wants to
 * publish updates from within the app instead of hand-editing JSON.
 */
function writeTeamLibrary(folderPath, snippets, meta = {}) {
  const target = path.join(folderPath, LIBRARY_FILENAME);
  const payload = {
    version: (meta.version || 0) + 1,
    updatedAt: new Date().toISOString(),
    snippets,
  };
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
  return target;
}

module.exports = {
  fetchTeamLibrary,
  writeTeamLibrary,
  readLibraryFromPath,
  looksLikeUrl,
  LIBRARY_FILENAME,
};
