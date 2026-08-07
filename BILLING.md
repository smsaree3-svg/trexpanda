# Trial, Subscriptions, Coupons & Admin (Trexpanda Pro)

Trexpanda uses a **30-day free trial, then subscribe** model — no card upfront.

- **Trial** — 30 days of full features from account creation. **Export is disabled during the trial.**
- **Pro** — an active Stripe subscription. Everything, including export.
- **Unlocked** — a coupon/comp grant (same powers as Pro), optionally time-limited.
- **Expired** — trial over, no subscription/grant. The app goes read-only: snippets stop
  expanding and no new ones can be added, but nothing is deleted and the user can still
  subscribe or redeem a code to switch it back on.

The trial length is one constant, `TRIAL_DAYS` in `src/entitlements.js`.

Everything a machine can do is coded. The steps below need **your** Stripe account and a
one-time Supabase deploy.

---

## How it fits together

```
 app ──(signed-in user)──► create-checkout-session ─► Stripe Checkout (browser)
   ▲                                                          │ pays
   │ reads its own plan (trial from account age,              ▼
   │ subscription, grant, admin flag — all RLS own-row)   stripe-webhook ─► subscriptions
   │
   ├─ redeem_coupon(code) ─► grants        (RPC, server-validated)
   └─ admin_* RPCs ─► coupons / grants / user list   (only if you're an admin)
```

- The app **reads** its own status. Trial is derived from the account's creation time
  (server-side, per account — can't be reset by reinstalling).
- **Pro status is tamper-proof**: the `subscriptions` row is written only by the Stripe
  webhook (service role); `grants` are written only by the `redeem_coupon` / `admin_*`
  functions. A user can't grant themselves anything from the client.
- The 30-day cap and the export gate are enforced in the app (personal snippets live on the
  device); Pro *status* is verified server-side.

---

## What you need

- The Supabase project Trexpanda already uses (same as `CLOUD_SETUP.md`).
- A **Stripe account** (stripe.com — this is Lumisha LLC's billing account; you create it).
- The **Supabase CLI** (`npm i -g supabase`, then `supabase login`).

Do Steps 1–6 in Stripe **test mode** first; switch to live keys once a test purchase works.

---

## Step 1 — Create all the tables & functions

Supabase Dashboard → **SQL Editor** → paste **`supabase/billing.sql`** → **Run**
(after `schema.sql`). Idempotent. This creates `subscriptions`, `grants`, `coupons`,
`coupon_redemptions`, `admins`, and every RPC (`redeem_coupon`, `admin_*`).

## Step 2 — Create the Pro product & price in Stripe

Stripe → **Product catalog → Add product** → **Trexpanda Pro**, recurring price(s). Copy the
**Price ID** (`price_…`) for Step 4 (`STRIPE_PRICE_PRO`).

## Step 3 — Deploy the Edge Functions

```bash
supabase link --project-ref <your-project-ref>
supabase functions deploy create-checkout-session
supabase functions deploy create-portal-session
supabase functions deploy stripe-webhook --no-verify-jwt   # Stripe calls this, not a user
```

## Step 4 — Set the function secrets

```bash
supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_xxx \
  STRIPE_PRICE_PRO=price_xxx \
  STRIPE_WEBHOOK_SECRET=whsec_xxx \
  BILLING_SUCCESS_URL=https://trexpanda.com/billing/success \
  BILLING_CANCEL_URL=https://trexpanda.com/billing/cancel \
  BILLING_PORTAL_RETURN_URL=https://trexpanda.com/account
```

(`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.
`STRIPE_WEBHOOK_SECRET` comes from Step 5. The `BILLING_*` URLs are optional.)

## Step 5 — Register the Stripe webhook

Stripe → **Developers → Webhooks → Add endpoint**:

- URL: `https://<your-project-ref>.supabase.co/functions/v1/stripe-webhook`
- Events: `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`

Copy the endpoint's **Signing secret** (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` (re-run Step 4).

## Step 6 — Enable the Customer Portal

Stripe → **Settings → Billing → Customer portal** → activate (allow cancel / update card).
This is what the app's **Manage subscription** button opens.

---

## Step 7 — Make hello@trexpanda.com an admin

Admins are stored in the `admins` table. Seed it **after** that account has signed into the app
once (so its `auth.users` row exists). `billing.sql` already includes this line at the bottom —
just re-run it in the SQL editor once hello@trexpanda.com has signed in:

```sql
insert into public.admins(user_id)
  select id from auth.users where lower(email) = 'hello@trexpanda.com'
  on conflict (user_id) do nothing;
```

The next time that account opens the app, an **Admin** tab appears (hidden for everyone else).

---

## What the admin can do (in the Admin tab)

- **See every user** with their status (Trial + days left / Pro / Unlocked / Expired) and join date.
- **Generate coupon codes.** Choose what each grants — **Lifetime** or **N days** of Pro — plus an
  optional max-uses and a custom code. Codes unlock Pro with no card.
- **Bulk-generate** a batch of codes with a shared prefix (e.g. `LAUNCH…`) for a campaign; the list
  is shown for copy/paste.
- **Grant / revoke** a specific user: a lifetime comp, +30 days, or revoke coupon/comp access.
  (Revoke removes coupon/comp access only — a paid Stripe subscription is canceled in Stripe.)
- **Trials ending soon** — users whose trial lapses in the next 5 days, for outreach.
- **Redemption stats** — each code shows used / max.

Every admin action is enforced **server-side** (the RPCs check `is_admin()`), so being admin can't
be faked from the app.

### How a user redeems a code

Account tab → **“Have a code?”** field → **Redeem**. One redemption per user per code; expired or
maxed-out codes are refused. On success the app unlocks Pro immediately.

---

## Test it end-to-end

1. Create a fresh account in the app → you're **Trialing** with ~30 days left; export is disabled.
2. **Redeem path:** as the admin, generate a lifetime code, sign in as a normal user, redeem it →
   unlocks Pro (export enabled).
3. **Payment path:** Account → **Upgrade to Pro** → pay with Stripe test card
   `4242 4242 4242 4242` (any future expiry/CVC/ZIP) → refocus the app → **Pro**.
4. **Manage subscription** opens the Stripe portal; cancel there → app returns to trial/expired on
   the next refresh.
5. **Expiry:** to eyeball the expired state without waiting 30 days, temporarily lower `TRIAL_DAYS`
   in `src/entitlements.js` and rebuild — expansion stops, adding is blocked, data is intact.

If Pro doesn't appear after paying, check **Stripe → Webhooks → recent deliveries** and
`supabase functions logs stripe-webhook`.

---

## Going live

1. Swap Stripe **test** keys/price/webhook for **live** ones (live mode has its own webhook secret).
2. Before charging real cards, add Terms of Service, a Privacy Policy, and a Refund policy. For a
   text expander the Privacy Policy matters most — state plainly what is and isn't captured.
3. Keep all Stripe keys out of the repo — they live only in Supabase function secrets.

## Reference: secrets

| Secret | Where | What it is |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Supabase fn secret | Stripe secret key (`sk_…`) |
| `STRIPE_PRICE_PRO` | Supabase fn secret | Pro plan Price ID (`price_…`) |
| `STRIPE_WEBHOOK_SECRET` | Supabase fn secret | Webhook signing secret (`whsec_…`) |
| `BILLING_SUCCESS_URL` / `BILLING_CANCEL_URL` / `BILLING_PORTAL_RETURN_URL` | optional | Return URLs |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | auto | Provided to functions |
