// POST /functions/v1/submit-enquiry
// The one endpoint the public site writes to: a buyer leaves contacts.
// Creates the lead, unlocks the "after contacts" documents, notifies the seller,
// and returns a token the browser uses to download those files.
//
// Body: { slug, name, email, phone?, message?, ticket?, horizon?, intent?: 'docs'|'enquiry' }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('SITE_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

async function sendMail(to: string, subject: string, html: string) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: Deno.env.get('MAIL_FROM') ?? 'OKKO CAP <deals@okkocap.com>', to, subject, html }),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const b = await req.json().catch(() => null);
  if (!b?.slug || !b?.name || !b?.email) return json({ error: 'slug, name and email are required' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) return json({ error: 'invalid email' }, 400);
  if (String(b.name).length > 200 || String(b.message ?? '').length > 4000) return json({ error: 'too long' }, 400);

  // listing + owner
  const { data: listing } = await db
    .from('listings')
    .select('id, name, slug, owner_id, status')
    .eq('slug', b.slug)
    .single();
  if (!listing || listing.status !== 'live') return json({ error: 'listing not found' }, 404);

  // simple rate limit: same email, same listing, 5 minutes
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  const { count } = await db
    .from('leads').select('id', { count: 'exact', head: true })
    .eq('listing_id', listing.id).eq('email', b.email).gt('created_at', since);
  if ((count ?? 0) > 0) return json({ error: 'already sent, check your inbox' }, 429);

  const unlock = b.intent === 'docs';
  const { data: lead, error } = await db
    .from('leads')
    .insert({
      listing_id: listing.id,
      name: b.name, email: b.email, phone: b.phone ?? null,
      company: b.company ?? null, message: b.message ?? null,
      ticket: b.ticket ?? null, horizon: b.horizon ?? null,
      source: 'form',
      unlocked_at: unlock ? new Date().toISOString() : null,
    })
    .select('id, access_token')
    .single();
  if (error) return json({ error: error.message }, 500);

  await db.from('lead_messages').insert([
    { lead_id: lead.id, author: 'buyer', body: b.message ?? 'Left contacts to open the documents.' },
    ...(unlock ? [{ lead_id: lead.id, author: 'system', body: 'Contacts left — presentation and financials unlocked automatically' }] : []),
  ]);

  // documents the buyer may now open
  const { data: docs } = await db
    .from('documents')
    .select('id, file_name, category, gate, size_bytes')
    .eq('listing_id', listing.id)
    .in('gate', unlock ? ['public', 'contacts'] : ['public']);

  // notify the seller
  const { data: owner } = await db.auth.admin.getUserById(listing.owner_id);
  const site = Deno.env.get('SITE_ORIGIN') ?? 'https://okkocap.com';
  if (owner?.user?.email) {
    await sendMail(
      owner.user.email,
      `New enquiry on ${listing.name} — ${b.name}`,
      `<p><b>${b.name}</b>${b.company ? ` · ${b.company}` : ''} left contacts on <b>${listing.name}</b>.</p>
       <p>${(b.message ?? '').replace(/</g, '&lt;')}</p>
       <p>Email: ${b.email}<br>Phone: ${b.phone ?? '—'}</p>
       <p><a href="${site}/#/account/enquiries">Open it in the console</a></p>`,
    );
  }
  await sendMail(
    b.email,
    `${listing.name} — your documents`,
    `<p>Thank you for your interest in <b>${listing.name}</b>.</p>
     <p>The presentation and financials are open here:</p>
     <p><a href="${site}/#/deal/${listing.slug}?t=${lead.access_token}">Open the documents</a></p>
     <p>Legal documents open after a signed NDA. The owner will be in touch shortly.</p>`,
  );

  return json({ ok: true, token: lead.access_token, documents: docs ?? [] });
});
