// ===========================================================================
// create-portal-session — open the Stripe Customer Portal.
//
// A signed-in Pro user invokes this to manage their subscription (update card,
// cancel, view invoices). Returns a one-time portal URL the app opens in the
// browser.
//
// Deploy WITH JWT verification (the default):
//   supabase functions deploy create-portal-session
//
// Required function secrets: STRIPE_SECRET_KEY
// Optional: BILLING_PORTAL_RETURN_URL
// Prerequisite: enable the Customer Portal in Stripe
//   (Settings -> Billing -> Customer portal). See BILLING.md.
// ===========================================================================

import Stripe from 'https://esm.sh/stripe@16.12.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders, json } from '../_shared/cors.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) return json({ error: 'Not authenticated.' }, 401);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );
    const { data: sub } = await admin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!sub?.stripe_customer_id) {
      return json({ error: 'No billing account yet. Upgrade to Pro first.' }, 400);
    }

    const returnUrl = Deno.env.get('BILLING_PORTAL_RETURN_URL') ?? 'https://trexpanda.com/account';
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: returnUrl,
    });

    return json({ url: session.url });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
