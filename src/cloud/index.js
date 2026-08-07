'use strict';

/**
 * CloudService — the single object the Electron main process talks to for all
 * account / friends / sharing features. It wraps the Supabase client and hides
 * every query behind small, intention-revealing methods.
 *
 * Design rules:
 *  - Runs in the MAIN process only. The renderer reaches these methods through
 *    the preload bridge + a single 'cloud' IPC channel (see main.js/preload.js).
 *  - Never throws for "cloud isn't set up" — callers get a clear status object
 *    and the rest of the app keeps working (same spirit as the native-module
 *    fallbacks elsewhere in the codebase).
 *  - Snippets travel as plain JSON, reusing the exact library shape the
 *    file-based team sync already uses.
 */

const { getClient, getLoadError, sdkAvailable } = require('./client');
const config = require('./config');
const { classifyFriendships, combineLibrarySnippets, isValidUsername, deriveUsername } = require('./helpers');

const DEFAULT_LIBRARY_NAME = 'My Snippets';

class CloudService {
  constructor(backend) {
    this.backend = backend;
    this.client = getClient(backend);
  }

  // -- capability / status ---------------------------------------------------

  configured() {
    return config.isConfigured() && sdkAvailable && !!this.client;
  }

  /** Why the cloud features can't run, or null if they can. */
  unavailableReason() {
    if (!sdkAvailable) return 'The @supabase/supabase-js package is not installed.';
    if (!config.isConfigured()) return 'No Supabase project configured (set SUPABASE_URL / SUPABASE_ANON_KEY or fill in src/cloud/cloud-config.json).';
    return null;
  }

  async status() {
    const base = {
      configured: this.configured(),
      reason: this.unavailableReason(),
      sdkError: getLoadError(),
      signedIn: false,
      user: null,
    };
    if (!this.configured()) return base;
    const { data } = await this.client.auth.getSession();
    const session = data && data.session;
    if (!session) return base;
    const user = session.user;
    let profile = null;
    try {
      const { data: prof } = await this.client
        .from('profiles')
        .select('id, username, display_name')
        .eq('id', user.id)
        .maybeSingle();
      profile = prof || null;
    } catch (_) {}
    return {
      ...base,
      signedIn: true,
      user: {
        id: user.id,
        email: user.email,
        username: profile ? profile.username : (user.user_metadata || {}).username || null,
        displayName: profile ? profile.display_name : (user.user_metadata || {}).display_name || null,
      },
    };
  }

  // -- billing / subscription ------------------------------------------------

  /**
   * Read the caller's RAW entitlement snapshot: account creation time (the
   * trial anchor), Stripe subscription status, any coupon/comp grant, and admin
   * flag. The caller (main process) turns this into an access descriptor via
   * src/entitlements.js computeAccess() using the current time — the trial is
   * time-based, so the derived result must be recomputed with a fresh clock,
   * not cached. All three rows are readable only for the caller (RLS).
   */
  async getEntitlement() {
    const client = this._requireClient();
    const { data: { user } } = await client.auth.getUser();
    if (!user) throw new Error('Not signed in.');
    const me = user.id;

    const [subRes, grantRes, adminRes] = await Promise.all([
      client.from('subscriptions').select('status, current_period_end, cancel_at_period_end').eq('user_id', me).maybeSingle(),
      client.from('grants').select('unlocked_until, source').eq('user_id', me).maybeSingle(),
      client.from('admins').select('user_id').eq('user_id', me).maybeSingle(),
    ]);
    const sub = subRes.data || null;
    const grant = grantRes.data || null;

    return {
      signedIn: true,
      createdAt: user.created_at || null,
      subStatus: sub ? sub.status : null,
      currentPeriodEnd: (sub && sub.current_period_end) || null,
      cancelAtPeriodEnd: !!(sub && sub.cancel_at_period_end),
      hasGrant: !!grant,
      grantUnlockedUntil: grant ? grant.unlocked_until : null,
      grantSource: grant ? grant.source : null,
      isAdmin: !!adminRes.data,
    };
  }

  /** Redeem a coupon code (server validates + records + grants). */
  async redeemCoupon(code) {
    const client = this._requireClient();
    const { data, error } = await client.rpc('redeem_coupon', { p_code: String(code || '') });
    if (error) throw new Error(error.message || 'Could not redeem code.');
    return data; // { ok, ... } | { ok:false, error }
  }

  // -- admin (all server-enforced; non-admins get "Not authorized") ----------

  async adminListUsers(limit = 200, offset = 0) {
    const client = this._requireClient();
    const { data, error } = await client.rpc('admin_list_users', { p_limit: limit, p_offset: offset });
    if (error) throw new Error(error.message || 'Failed to list users.');
    return data || [];
  }

  async adminListCoupons(limit = 500) {
    const client = this._requireClient();
    const { data, error } = await client.rpc('admin_list_coupons', { p_limit: limit });
    if (error) throw new Error(error.message || 'Failed to list coupons.');
    return data || [];
  }

  async adminTrialEnding(days = 5) {
    const client = this._requireClient();
    const { data, error } = await client.rpc('admin_trial_ending', { p_days: days });
    if (error) throw new Error(error.message || 'Failed to load trial list.');
    return data || [];
  }

  async adminCreateCoupon({ code = null, kind = 'lifetime', days = null, maxRedemptions = null, expiresAt = null, batch = null } = {}) {
    const client = this._requireClient();
    const { data, error } = await client.rpc('admin_create_coupon', {
      p_code: code, p_kind: kind, p_days: days,
      p_max_redemptions: maxRedemptions, p_expires_at: expiresAt, p_batch: batch,
    });
    if (error) throw new Error(error.message || 'Failed to create coupon.');
    return data;
  }

  async adminCreateCouponsBulk({ count, prefix = '', kind = 'lifetime', days = null, maxRedemptions = 1, expiresAt = null, batch = null } = {}) {
    const client = this._requireClient();
    const { data, error } = await client.rpc('admin_create_coupons_bulk', {
      p_count: count, p_prefix: prefix, p_kind: kind, p_days: days,
      p_max_redemptions: maxRedemptions, p_expires_at: expiresAt, p_batch: batch,
    });
    if (error) throw new Error(error.message || 'Failed to create coupons.');
    return data;
  }

  async adminGrantUser(userId, days = null, note = null) {
    const client = this._requireClient();
    const { data, error } = await client.rpc('admin_grant_user', { p_user: userId, p_days: days, p_note: note });
    if (error) throw new Error(error.message || 'Failed to grant access.');
    return data;
  }

  async adminRevokeUser(userId) {
    const client = this._requireClient();
    const { data, error } = await client.rpc('admin_revoke_user', { p_user: userId });
    if (error) throw new Error(error.message || 'Failed to revoke access.');
    return data;
  }

  /**
   * Ask the create-checkout-session Edge Function for a Stripe Checkout URL.
   * The main process opens the returned URL in the user's browser.
   */
  async startCheckout() {
    const client = this._requireClient();
    const { data, error } = await client.functions.invoke('create-checkout-session', { body: {} });
    if (error) throw new Error(error.message || 'Could not start checkout.');
    if (!data || !data.url) throw new Error((data && data.error) || 'No checkout URL returned.');
    return data; // { url }
  }

  /** Ask the create-portal-session Edge Function for a Stripe Billing Portal URL. */
  async openBillingPortal() {
    const client = this._requireClient();
    const { data, error } = await client.functions.invoke('create-portal-session', { body: {} });
    if (error) throw new Error(error.message || 'Could not open the billing portal.');
    if (!data || !data.url) throw new Error((data && data.error) || 'No portal URL returned.');
    return data; // { url }
  }

  // -- auth ------------------------------------------------------------------

  _requireClient() {
    if (!this.configured()) throw new Error(this.unavailableReason() || 'Cloud not available.');
    return this.client;
  }

  async signUp({ email, password, username, displayName }) {
    const client = this._requireClient();
    const uname = String(username || '').trim();
    if (!isValidUsername(uname)) {
      throw new Error('Username must be 3-24 characters: letters, numbers, dot, dash or underscore.');
    }
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { username: uname, display_name: displayName || uname } },
    });
    if (error) throw error;
    // If email confirmation is disabled, we get a session immediately and can
    // create the profile row now. Otherwise the profile is created on first
    // successful sign-in via ensureProfile().
    if (data.session) {
      await this._ensureProfile(uname, displayName || uname);
    }
    return { needsConfirmation: !data.session };
  }

  async signIn({ email, password }) {
    const client = this._requireClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const meta = (data.user && data.user.user_metadata) || {};
    await this._ensureProfile(meta.username, meta.display_name);
    return { ok: true };
  }

  /**
   * Sign in with Google via a browser + loopback redirect (PKCE). Opens the
   * user's default browser, waits for the redirect, and creates a profile with
   * a derived username on first login. Requires the Google provider to be
   * enabled in the Supabase project (see CLOUD_SETUP.md).
   */
  async signInWithGoogle() {
    const client = this._requireClient();
    let shell = null;
    try { ({ shell } = require('electron')); } catch (_) {}
    const openExternal = shell
      ? (u) => shell.openExternal(u)
      : () => { throw new Error('Cannot open a browser in this environment.'); };

    const { loopbackOAuth } = require('./oauth');
    await loopbackOAuth({ client, provider: 'google', openExternal });

    const { data: { user } } = await client.auth.getUser();
    const meta = (user && user.user_metadata) || {};
    await this._ensureProfile(deriveUsername(meta, user || {}), meta.full_name || meta.name);
    return { ok: true };
  }

  async signOut() {
    if (!this.configured()) return { ok: true };
    await this.client.auth.signOut();
    return { ok: true };
  }

  /** Create/refresh the caller's profile row (idempotent). */
  async _ensureProfile(username, displayName) {
    const client = this.client;
    const { data: { user } } = await client.auth.getUser();
    if (!user) return;
    // Does a profile already exist? If so, don't clobber the chosen username.
    const { data: existing } = await client
      .from('profiles')
      .select('id, username')
      .eq('id', user.id)
      .maybeSingle();
    if (existing) return;

    const base = isValidUsername(username) ? username.trim() : 'user_' + user.id.slice(0, 8);
    // A derived username (e.g. from a Google email) may already be taken, so
    // retry with a short suffix until one sticks.
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = attempt === 0
        ? base
        : `${base.slice(0, 16)}_${user.id.slice(0, 3 + attempt)}`;
      const { error } = await client.from('profiles').insert({
        id: user.id,
        username: candidate,
        display_name: displayName || candidate,
      });
      if (!error) return;
      if (error.code === '23505') {
        // Unique violation: either the profile id already exists (someone else
        // created it concurrently) — stop — or the username is taken — retry.
        const { data: now } = await client
          .from('profiles').select('id').eq('id', user.id).maybeSingle();
        if (now) return;
        continue;
      }
      throw error;
    }
  }

  async _uid() {
    const { data: { user } } = await this.client.auth.getUser();
    if (!user) throw new Error('Not signed in.');
    return user.id;
  }

  /** Fetch profile rows for a set of user ids -> map id => profile. */
  async _profilesByIds(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return {};
    const { data, error } = await this.client
      .from('profiles')
      .select('id, username, display_name')
      .in('id', unique);
    if (error) throw error;
    const map = {};
    for (const p of data || []) map[p.id] = p;
    return map;
  }

  // -- friends ---------------------------------------------------------------

  /** Look up people by username (prefix match), excluding yourself. */
  async searchProfiles(query) {
    const client = this._requireClient();
    const q = String(query || '').trim();
    if (!q) return [];
    const me = await this._uid();
    const { data, error } = await client
      .from('profiles')
      .select('id, username, display_name')
      .ilike('username', `${q}%`)
      .neq('id', me)
      .limit(10);
    if (error) throw error;
    return data || [];
  }

  /** Send a friend request to a username. */
  async sendFriendRequest(username) {
    const client = this._requireClient();
    const me = await this._uid();
    const uname = String(username || '').trim();
    const { data: prof, error: pErr } = await client
      .from('profiles')
      .select('id, username')
      .ilike('username', uname)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!prof) throw new Error(`No user found with username "${uname}".`);
    if (prof.id === me) throw new Error("You can't add yourself.");
    const { error } = await client.from('friendships').insert({
      requester_id: me,
      addressee_id: prof.id,
      status: 'pending',
    });
    if (error) {
      if (error.code === '23505') throw new Error('You already have a request or friendship with this user.');
      throw error;
    }
    return { ok: true, to: prof.username };
  }

  /** Everything friend-related, resolved with profiles for the UI. */
  async listFriends() {
    const client = this._requireClient();
    const me = await this._uid();
    const { data, error } = await client
      .from('friendships')
      .select('id, requester_id, addressee_id, status');
    if (error) throw error;
    const { friends, incoming, outgoing } = classifyFriendships(data, me);
    const ids = [...friends, ...incoming, ...outgoing].map((x) => x.userId);
    const profiles = await this._profilesByIds(ids);
    const attach = (arr) => arr.map((x) => ({ ...x, profile: profiles[x.userId] || null }));
    return {
      friends: attach(friends),
      incoming: attach(incoming),
      outgoing: attach(outgoing),
    };
  }

  /** Accept or decline an incoming request. */
  async respondToRequest(friendshipId, accept) {
    const client = this._requireClient();
    if (accept) {
      const { error } = await client
        .from('friendships')
        .update({ status: 'accepted' })
        .eq('id', friendshipId);
      if (error) throw error;
    } else {
      const { error } = await client.from('friendships').delete().eq('id', friendshipId);
      if (error) throw error;
    }
    return { ok: true };
  }

  async removeFriend(friendshipId) {
    const client = this._requireClient();
    const { error } = await client.from('friendships').delete().eq('id', friendshipId);
    if (error) throw error;
    return { ok: true };
  }

  // -- libraries & sharing ---------------------------------------------------

  /** The caller's own libraries. */
  async myLibraries() {
    const client = this._requireClient();
    const me = await this._uid();
    const { data, error } = await client
      .from('libraries')
      .select('id, name, snippets, updated_at')
      .eq('owner_id', me)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  /** Public: ensure the caller has a default library and return its id. */
  async ensureDefaultLibrary() {
    this._requireClient();
    const id = await this._defaultLibraryId();
    return { id };
  }

  /** Get (or lazily create) the caller's default library id. */
  async _defaultLibraryId() {
    const client = this.client;
    const me = await this._uid();
    const { data } = await client
      .from('libraries')
      .select('id')
      .eq('owner_id', me)
      .order('updated_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
    const { data: created, error } = await client
      .from('libraries')
      .insert({ owner_id: me, name: DEFAULT_LIBRARY_NAME, snippets: [] })
      .select('id')
      .single();
    if (error) throw error;
    return created.id;
  }

  /**
   * Publish the caller's personal snippets to their default cloud library so
   * friends who have it shared with them receive the update on next sync.
   */
  async publishSnippets(snippets) {
    const client = this._requireClient();
    const libId = await this._defaultLibraryId();
    const clean = Array.isArray(snippets) ? snippets : [];
    const { error } = await client
      .from('libraries')
      .update({ snippets: clean })
      .eq('id', libId);
    if (error) throw error;
    return { ok: true, libraryId: libId, count: clean.length };
  }

  /** Who a library is currently shared with (owner view). */
  async listShares(libraryId) {
    const client = this._requireClient();
    const { data, error } = await client
      .from('library_shares')
      .select('id, shared_with')
      .eq('library_id', libraryId);
    if (error) throw error;
    const profiles = await this._profilesByIds((data || []).map((s) => s.shared_with));
    return (data || []).map((s) => ({
      shareId: s.id,
      userId: s.shared_with,
      profile: profiles[s.shared_with] || null,
    }));
  }

  /** Share a library with a friend (by their user id). */
  async shareLibrary(libraryId, friendUserId) {
    const client = this._requireClient();
    const { error } = await client
      .from('library_shares')
      .insert({ library_id: libraryId, shared_with: friendUserId });
    if (error && error.code !== '23505') throw error; // ignore already-shared
    return { ok: true };
  }

  async unshareLibrary(libraryId, friendUserId) {
    const client = this._requireClient();
    const { error } = await client
      .from('library_shares')
      .delete()
      .eq('library_id', libraryId)
      .eq('shared_with', friendUserId);
    if (error) throw error;
    return { ok: true };
  }

  /** Libraries other people have shared WITH the caller (with owner profile). */
  async sharedWithMe() {
    const client = this._requireClient();
    const { data, error } = await client
      .from('libraries')
      .select('id, name, owner_id, updated_at');
    if (error) throw error;
    const me = await this._uid();
    const notMine = (data || []).filter((l) => l.owner_id !== me);
    const profiles = await this._profilesByIds(notMine.map((l) => l.owner_id));
    return notMine.map((l) => ({
      id: l.id,
      name: l.name,
      updatedAt: l.updated_at,
      owner: profiles[l.owner_id] || null,
    }));
  }

  /**
   * Fetch and combine the snippets from a set of library ids (the caller's
   * subscriptions). Returns a normalized, de-duplicated snippet array ready to
   * drop into the local team cache.
   */
  async fetchLibrarySnippets(libraryIds = []) {
    const client = this._requireClient();
    const ids = (libraryIds || []).filter(Boolean);
    if (!ids.length) return [];
    const { data, error } = await client
      .from('libraries')
      .select('id, snippets')
      .in('id', ids);
    if (error) throw error;
    return combineLibrarySnippets(data || []);
  }
}

module.exports = { CloudService };
