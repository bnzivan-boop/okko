// POST /functions/v1/checkout   — start a Stripe Checkout for a listing fee
// POST /functions/v1/checkout/webhook — Stripe calls this back
//
// Plans: m1 = AED 499 / month, m3 = AED 999 / 3 months (both + 5% VAT, set on the
// Stripe price). On payment the listing moves draft → in_review and moderation
// takes it live.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14?target=deno';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
const site = Deno.env.get('SITE_ORIGIN') ?? 'https://okkocap.com';

const PRICE: Record<string, string> = {
  m1: Deno.env.get('STRIPE_PRICE_M1')!,
  m3: Deno.env.get('STRIPE_PRICE_M3')!,
};

const cors = {
  'Access-Control-Allow-Origin': site,
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const path = new URL(req.url).pathname;

  // ------------------------------------------------------------ webhook
  if (path.endsWith('/webhook')) {
    const sig = req.headers.get('stripe-signature')!;
    const raw = await req.text();
    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(raw, sig, Deno.env.get('STRIPE_WEBHOOK_SECRET')!);
    } catch (e) {
      return new Response(`bad signature: ${e.message}`, { status: 400 });
    }

    if (event.type === 'checkout.session.completed') {
      const s = event.data.object as Stripe.Checkout.Session;
      const { listing_id, owner_id, plan } = s.metadata ?? {};
      if (listing_id) {
        await db.from('subscriptions').insert({
          listing_id, owner_id, plan: plan ?? 'm1', status: 'active',
          stripe_customer_id: String(s.customer ?? ''),
          stripe_subscription_id: String(s.subscription ?? ''),
          current_period_end: new Date(Date.now() + (plan === 'm3' ? 90 : 30) * 864e5).toISOString(),
        });
        await db.from('listings').update({
          status: 'in_review',
          expires_at: new Date(Date.now() + (plan === 'm3' ? 90 : 30) * 864e5).toISOString(),
        }).eq('id', listing_id);
      }
    }

    if (event.type === 'invoice.paid') {
      const inv = event.data.object as Stripe.Invoice;
      const { data: sub } = await db.from('subscriptions')
        .select('id, owner_id').eq('stripe_subscription_id', String(inv.subscription ?? '')).single();
      if (sub) {
        await db.from('invoices').insert({
          subscription_id: sub.id, owner_id: sub.owner_id,
          number: inv.number, amount_cents: inv.amount_paid,
          currency: inv.currency, status: 'paid', pdf_url: inv.invoice_pdf,
        });
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const s = event.data.object as Stripe.Subscription;
      const { data: sub } = await db.from('subscriptions')
        .select('id, listing_id').eq('stripe_subscription_id', s.id).single();
      if (sub) {
        await db.from('subscriptions').update({ status: 'canceled' }).eq('id', sub.id);
        await db.from('listings').update({ status: 'paused' }).eq('id', sub.listing_id);
      }
    }

    return new Response('ok');
  }

  // ------------------------------------------------------------ create session
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const jwt = req.headers.get('authorization')?.replace('Bearer ', '');
  const { data: u } = await db.auth.getUser(jwt ?? '');
  if (!u?.user) return json({ error: 'sign in first' }, 401);

  const { listing_id, plan } = await req.json().catch(() => ({}));
  if (!listing_id || !PRICE[plan]) return json({ error: 'listing_id and plan (m1|m3) required' }, 400);

  const { data: listing } = await db.from('listings')
    .select('id, name, owner_id').eq('id', listing_id).single();
  if (!listing || listing.owner_id !== u.user.id) return json({ error: 'not your listing' }, 403);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: PRICE[plan], quantity: 1 }],
    customer_email: u.user.email,
    success_url: `${site}/#/account/listings?paid=1`,
    cancel_url: `${site}/#/list`,
    metadata: { listing_id, owner_id: u.user.id, plan },
  });

  return json({ url: session.url });
});
