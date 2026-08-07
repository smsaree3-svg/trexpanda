'use strict';

/**
 * Lazily builds a single Supabase client for the main process.
 *
 * Everything cloud-related runs in the Electron MAIN process (never the
 * renderer), matching the app's existing "renderer only talks through the
 * preload bridge" security model. The auth session is persisted through
 * electron-store via a tiny storage adapter so users stay signed in across
 * restarts.
 *
 * supabase-js is loaded defensively: if the dependency is missing (e.g. someone
 * cloned without `npm install`), the app still boots — cloud features just
 * report themselves as unavailable, exactly like the native modules do.
 */

let createClient = null;
let loadError = null;
try {
  ({ createClient } = require('@supabase/supabase-js'));
} catch (err) {
  loadError = err;
}

const config = require('./config');

/** electron-store-backed storage adapter for the Supabase auth session. */
function makeStorage(backend) {
  const key = (k) => 'sbSession.' + String(k).replace(/[.]/g, '_');
  return {
    getItem: (k) => {
      const v = backend.get(key(k), null);
      return v == null ? null : String(v);
    },
    setItem: (k, v) => backend.set(key(k), String(v)),
    removeItem: (k) => backend.set(key(k), null),
  };
}

let client = null;

/**
 * supabase-js eagerly constructs a Realtime client, which requires a global
 * WebSocket. Electron's MAIN process (Node 20) has no global WebSocket, so
 * createClient() would throw "native WebSocket not found" and take the whole
 * cloud service down. We never open realtime connections, but we must satisfy
 * the check — provide the pure-JS `ws` implementation as the global.
 */
function ensureWebSocket() {
  if (typeof globalThis.WebSocket !== 'undefined') return;
  try { globalThis.WebSocket = require('ws'); } catch (_) { /* surfaced via the createClient catch below */ }
}

/**
 * @param {object} backend  an electron-store (or get/set compatible) instance,
 *                          used to persist the auth session.
 * @returns {import('@supabase/supabase-js').SupabaseClient|null}
 */
function getClient(backend) {
  if (client) return client;
  if (!createClient || !config.isConfigured()) return null;
  ensureWebSocket();
  try {
    client = createClient(config.url, config.anonKey, {
      auth: {
        storage: makeStorage(backend),
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        // PKCE so the desktop OAuth flow can exchange a ?code= on a loopback
        // redirect for a session (see cloud/oauth.js). Password sign-in is
        // unaffected.
        flowType: 'pkce',
      },
    });
  } catch (err) {
    // Never let client construction crash the whole cloud service — record it
    // and degrade to a clear "unavailable" state instead of a broken IPC layer.
    loadError = err;
    client = null;
  }
  return client;
}

function getLoadError() {
  if (loadError) return String(loadError.message || loadError);
  return null;
}

module.exports = { getClient, getLoadError, sdkAvailable: !!createClient };
