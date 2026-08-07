// ===========================================================================
// stripe-webhook — the ONLY writer of the subscriptions table.
//
// Stripe calls this endpoint on subscription lifecycle events. It verifies the
// Stripe signature, then mirrors the subscription's status into Supabase. The
// app reads that row to know whether the user is Pro.
//
// IMPORTANT — deploy WITHOUT JWT verification, because Stripe (not a signed-in
// user) calls it:
//   supabase functions deploy stripe-webhook --no-verify-jwt
//
// Required function secrets (see BILLING.md):
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
// Auto-provided by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Subscribe the Stripe webhook endpoint to at least these events:
//   checkout.session.completed
//   customer.subscription.created
//   customer.subscription.updated
//   customer.subscription.deleted
// ===========================================================================

import Stripe from 'https://esm.sh/stripe@16.12.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});
// Deno needs the async (SubtleCrypto) signature verifier.
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature ?? '',
      webhookSecret,
      undefined,
      cryptoProvider,
    );
  } catch (e) {
    return new Response(
      `Webhook signature verification failed: ${String((e as Error)?.message ?? e)}`,
      { status: 400 },
    );
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription as string);
          await upsertSubscription(sub);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await upsertSubscription(event.data.object as Stripe.Subscription);
        break;
      }
      default:
        // Ignore everything else.
        break;
    }
  } catch (e) {
    // Return 500 so Stripe retries the delivery.
    return new Response(`Handler error: ${String((e as Error)?.message ?? e)}`, {
      status: 500,
    });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

/** Mirror a Stripe subscription into the subscriptions table, keyed by user. */
async function upsertSubscription(sub: Stripe.Subscription): Promise<void> {
  const userId =
    (sub.metadata && sub.metadata.supabase_user_id) ||
    (await userIdFromCustomer(sub.customer as string));
  if (!userId) {
    console.error('No supabase_user_id for subscription', sub.id, 'customer', sub.customer);
    return;
  }

  const priceId = sub.items?.data?.[0]?.price?.id ?? null;
  const row = {
    user_id: userId,
    stripe_customer_id: String(sub.customer),
    stripe_subscription_id: sub.id,
    price_id: priceId,
    status: sub.status, // active | trialing | past_due | canceled | ...
    current_period_end: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  };

  const { error } = await admin
    .from('subscriptions')
    .upsert(row, { onConflict: 'user_id' });
  if (error) throw error;
}

/** Fallback: resolve the user id from the customer (our row, then Stripe metadata). */
async function userIdFromCustomer(customerId: string): Promise<string | null> {
  const { data } = await admin
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  if (data?.user_id) return data.user_id;

  try {
    const cust = await stripe.customers.retrieve(customerId);
    // Deleted customers come back as { deleted: true } with no metadata.
    const meta = (cust as Stripe.Customer)?.metadata;
    return meta?.supabase_user_id ?? null;
  } catch {
    return null;
  }
}
