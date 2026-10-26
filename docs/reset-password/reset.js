'use strict';
/*
 * Trexpanda password reset (served from trexpanda.com/reset-password/).
 *
 * The "Reset password" email template links here with ?token_hash=…&type=recovery
 * (see CLOUD_SETUP.md). This page:
 *   1. exchanges the one-time token_hash for a short-lived session (POST /auth/v1/verify),
 *   2. sets the new password with that session (PUT /auth/v1/user),
 *   3. signs out EVERY session for the account (POST /auth/v1/logout?scope=global),
 *      so a session an attacker may hold doesn't survive the reset.
 * The one-time token is verified once; the short-lived session is kept in memory
 * so a rejected password (too weak, same as before) can be retried without a new email.
 * No third-party scripts; the token is removed from the address bar immediately.
 * The publishable key below is the same public key shipped in every app build;
 * row-level security, not this key, protects data.
 */
(function () {
  var SUPABASE_URL = 'https://yiltfbpjubflwdajzrhe.supabase.co';
  var PUBLISHABLE_KEY = 'sb_publishable__QXUpFN58UPGk6eNgoVEIg_iAFfD-ju';
  var MIN_LENGTH = 8;

  var $ = function (id) { return document.getElementById(id); };
  function say(text, kind) { var m = $('msg'); m.textContent = text; m.className = 'msg' + (kind ? ' ' + kind : ''); }

  var params = new URLSearchParams(window.location.search);
  var tokenHash = params.get('token_hash');
  var type = params.get('type');
  // Keep the one-time token out of history, bookmarks and screenshots.
  if (window.history && window.history.replaceState) {
    window.history.replaceState(null, '', window.location.pathname);
  }

  // Refuse to run inside a frame (GitHub Pages can't send frame-ancestors headers).
  if (window.top !== window.self) {
    $('intro').textContent = 'Open this page directly from the email link.';
    return;
  }

  if (!tokenHash || type !== 'recovery') {
    $('intro').textContent = 'This reset link is incomplete or has already been used.';
    say('Open Trexpanda, choose "Forgot password?" and use the newest email we send you.', 'bad');
    return;
  }

  $('intro').textContent = 'Enter a new password for your Trexpanda account.';
  $('form').hidden = false;

  var accessToken = null;   // set after the one-time token is verified

  $('form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var pw1 = $('pw1').value, pw2 = $('pw2').value;
    if (pw1.length < MIN_LENGTH) { say('Use at least ' + MIN_LENGTH + ' characters.', 'bad'); return; }
    if (pw1 !== pw2) { say('The two passwords do not match.', 'bad'); return; }
    $('save').disabled = true; say('Saving…');

    var headers = { 'Content-Type': 'application/json', apikey: PUBLISHABLE_KEY };
    try {
      if (!accessToken) {
        var v = await fetch(SUPABASE_URL + '/auth/v1/verify', {
          method: 'POST', headers: headers,
          body: JSON.stringify({ type: 'recovery', token_hash: tokenHash }),
        });
        var session = await v.json().catch(function () { return {}; });
        if (!v.ok || !session.access_token) {
          throw new Error('This reset link has expired or was already used. Request a new one from the app.');
        }
        accessToken = session.access_token;
      }
      var auth = Object.assign({}, headers, { Authorization: 'Bearer ' + accessToken });
      var u = await fetch(SUPABASE_URL + '/auth/v1/user', {
        method: 'PUT', headers: auth, body: JSON.stringify({ password: pw1 }),
      });
      if (!u.ok) {
        var body = await u.json().catch(function () { return {}; });
        throw new Error(body.msg || body.message || 'Could not save the new password. Try a different one.');
      }
      await fetch(SUPABASE_URL + '/auth/v1/logout?scope=global', { method: 'POST', headers: auth }).catch(function () {});
      accessToken = null;
      $('form').hidden = true;
      $('intro').textContent = 'Your password has been updated.';
      say('Go back to Trexpanda and sign in with your new password.', 'good');
    } catch (err) {
      $('save').disabled = false;
      say(err.message || 'Something went wrong. Please try again.', 'bad');
    }
  });
})();
