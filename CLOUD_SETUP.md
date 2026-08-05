# Trexpanda Cloud — Accounts, Friends & Sharing

This adds optional **sign-in**, a **friends** system, and **library sharing** so
you and your coworkers can send each other snippets. It's built on
[Supabase](https://supabase.com) (hosted Postgres + auth). No server code of
your own to run, and there's a generous free tier.

Everything here is **optional**: if you don't configure a Supabase project, the
app runs exactly as before (personal snippets + file/URL team library). The
"Friends & Sharing" tab just shows a "not set up" notice.

## What you get

- **Login / signup** with email + password.
- **Add friends** by username, with accept/decline requests.
- **Share your snippet library** with specific friends. They receive your
  snippets — and your future updates — right in their app.
- **Subscribe** to libraries friends share with you; those snippets merge into
  your Team Library and expand like any other snippet.

Your snippets stay private until you explicitly turn on **Share** for a friend.

## One-time setup (about 5 minutes)

### 1. Create a Supabase project
Go to <https://supabase.com>, create a free project, and wait for it to finish
provisioning.

### 2. Create the database tables
In the dashboard: **SQL Editor → New query**, paste the contents of
[`supabase/schema.sql`](supabase/schema.sql), and click **Run**. This creates
the tables and the Row Level Security policies that keep each user's data
private. Re-running it later is safe.

### 3. (Recommended) Turn off email confirmation for instant sign-in
**Authentication → Providers → Email** → turn **Confirm email** off. With it on,
new users must click a link in their inbox before they can sign in — the app
handles that too, it's just an extra step.

### 4. Point the app at your project
Grab two values from **Project Settings → API**: the **Project URL** and the
**anon public** key. (The anon key is meant to be shipped in client apps —
access is controlled by the RLS policies, not by hiding the key.)

Give them to the app in either way:

**Option A — config file (easiest):**
```bash
cp src/cloud/cloud-config.example.json src/cloud/cloud-config.json
# then edit cloud-config.json and paste your url + anonKey
```

**Option B — environment variables:**
```bash
export SUPABASE_URL="https://YOUR-ref.supabase.co"
export SUPABASE_ANON_KEY="YOUR-anon-public-key"
npm start
```

For packaged builds distributed to a team, commit a `cloud-config.json` (the
anon key is safe to bundle) so everyone's app points at the same project.

## Optional: Google sign-in

The app has a **Continue with Google** button. It uses a desktop-friendly PKCE
flow: the app opens your browser, you sign in with Google, and the session is
handed back to the app automatically. To enable it:

1. **Create a Google OAuth client.** In the
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
   *APIs & Services → Credentials → Create credentials → OAuth client ID →
   Web application*. Under **Authorized redirect URIs** add your Supabase
   callback:
   ```
   https://YOUR-ref.supabase.co/auth/v1/callback
   ```
   Copy the generated **Client ID** and **Client secret**.

2. **Enable Google in Supabase.** *Authentication → Providers → Google* → turn
   it on and paste the Client ID + secret → Save.

3. **Allowlist the desktop redirect.** *Authentication → URL Configuration →
   Redirect URLs* → add:
   ```
   http://localhost:8765/callback
   ```
   The app listens on that fixed loopback address to catch the sign-in. (If port
   8765 is ever busy, close whatever is using it — the app will tell you.)

That's it. New Google users get an auto-generated username from their email that
their friends can use to add them.

## Using it

1. Open the app → **Friends & Sharing** tab → **Create account** (pick a
   username your coworkers will use to find you).
2. Add a friend by their username and have them accept.
3. Hit **Share** next to a friend to give them your library, or **Publish my
   snippets** to push your latest snippets up.
4. When a friend shares with you, their library appears under **Libraries
   shared with you** — click **Use these** to pull their snippets into your
   expander.

Shared snippets sync on the same interval as the team library (Settings →
Auto-sync), and on demand via **Sync now**.

## How it fits the existing app

- All cloud code lives in [`src/cloud/`](src/cloud/) and runs in the Electron
  **main** process; the renderer only talks to it through the existing preload
  bridge (`window.api.cloud`).
- Shared snippets are cached locally (`cloudSnippets`) and merged into the same
  "shared" pool as the file-based team library. Your **personal** snippets still
  win on a trigger collision by default (Settings → *On trigger conflict*).
- Data model: `profiles`, `libraries` (snippets stored as JSON, same shape as
  `team-library.json`), `friendships`, and `library_shares`. See
  `supabase/schema.sql`.

## Notes & limits

- This shares **snippets** (including the text/date tokens and attachments the
  app already supports). Macro/click recording is still the Phase-2 roadmap
  item — once built, macros ride this same sharing system.
- Google sign-in is wired in (see above). GitHub or other providers would work
  the same way — enable the provider in Supabase and add a button that calls the
  same loopback flow. Password reset isn't wired into the UI yet.
- One "default library" per user is used for sharing today; the schema already
  supports multiple named libraries if you want to expand the UI later.
