// ===========================================================================
// apple-revoke — revoke a user's Sign in with Apple tokens before their
// Trexpanda account is deleted (App Store Review Guideline 5.1.1(v)).
//
// The iPhone app asks Apple for a fresh authorization code, sends it here, and
// this function exchanges it for a refresh token and revokes it, so Trexpanda
// no longer appears under the user's "Sign in with Apple" apps.
//
// Deploy WITH JWT verification (the default):  supabase functions deploy apple-revoke
// Function secrets:
//   APPLE_TEAM_ID       e.g. KXT9A4CRLY
//   APPLE_KEY_ID        the Sign in with Apple key's Key ID
//   APPLE_PRIVATE_KEY   contents of that key's AuthKey_XXXX.p8
//   APPLE_CLIENT_ID     optional, default com.lumisha.trexpanda (the app's bundle id)
// Self-contained (no shared imports) so it can be deployed from the dashboard.
// ===========================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { importPKCS8, SignJWT } from 'https://esm.sh/jose@5.9.6';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function clientSecret(clientId: string): Promise<string> {
  const teamId = Deno.env.get('APPLE_TEAM_ID') ?? '';
  const keyId = Deno.env.get('APPLE_KEY_ID') ?? '';
  const pem = (Deno.env.get('APPLE_PRIVATE_KEY') ?? '').replace(/\\n/g, '\n').trim();
  if (!teamId || !keyId || !pem) throw new Error('Apple key is not configured.');
  const key = await importPKCS8(pem, 'ES256');
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setAudience('https://appleid.apple.com')
    .setSubject(clientId)
    .sign(key);
}

async function apple(path: string, form: Record<string, string>) {
  const res = await fetch(`https://appleid.apple.com/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* revoke returns an empty body */ }
  return { ok: res.ok, status: res.status, body };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return json({ error: 'Not authenticated.' }, 401);

    const { authorizationCode } = await req.json().catch(() => ({}));
    if (typeof authorizationCode !== 'string' || !authorizationCode) {
      return json({ error: 'authorizationCode is required.' }, 400);
    }
    const clientId = Deno.env.get('APPLE_CLIENT_ID') || 'com.lumisha.trexpanda';
    const secret = await clientSecret(clientId);

    const token = await apple('token', {
      client_id: clientId, client_secret: secret, code: authorizationCode, grant_type: 'authorization_code',
    });
    if (!token.ok) return json({ error: 'Apple rejected the authorization code.', detail: token.body }, 400);
    const refresh = token.body.refresh_token as string | undefined;
    const access = token.body.access_token as string | undefined;
    const revoke = await apple('revoke', {
      client_id: clientId, client_secret: secret,
      token: refresh ?? access ?? '', token_type_hint: refresh ? 'refresh_token' : 'access_token',
    });
    if (!revoke.ok) return json({ error: 'Apple did not revoke the token.', detail: revoke.body }, 502);
    return json({ ok: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
