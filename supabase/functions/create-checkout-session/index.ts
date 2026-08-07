// ===========================================================================
// create-checkout-session — start a Trexpanda Pro subscription.
//
// The app (signed-in user) invokes this; it returns a Stripe Checkout URL that
// the app opens in the user's browser. On successful payment, Stripe fires the
// webhook (see ../stripe-webhook) which writes the user's Pro status.
//
// Deploy WITH JWT verification (the default) so only signed-in users can call it:
//   supabase functions deploy create-checkout-session
//
// Required function secrets (see BILLING.md):
//   STRIPE_SECRET_KEY, STRIPE_PRICE_PRO
// Optional:
//   BILLING_SUCCESS_URL, BILLING_CANCEL_URL
// Auto-provided by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
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
    // Identify the caller from their Supabase JWT.
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

    // Reuse an existing Stripe customer for this user if we've made one before.
    let customerId: string | null = null;
    const { data: existing } = await admin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();
    customerId = existing?.stripe_customer_id ?? null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      // Persist the mapping now so the webhook can resolve the user even if the
      // subscription metadata is ever missing.
      await admin.from('subscriptions').upsert(
        { user_id: user.id, stripe_customer_id: customerId, status: 'incomplete' },
        { onConflict: 'user_id' },
      );
    }

    const priceId = Deno.env.get('STRIPE_PRICE_PRO');
    if (!priceId) return json({ error: 'Server missing STRIPE_PRICE_PRO.' }, 500);

    const successUrl = Deno.env.get('BILLING_SUCCESS_URL') ?? 'https://trexpanda.com/billing/success';
    const cancelUrl = Deno.env.get('BILLING_CANCEL_URL') ?? 'https://trexpanda.com/billing/cancel';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: user.id,
      subscription_data: { metadata: { supabase_user_id: user.id } },
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return json({ url: session.url });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
