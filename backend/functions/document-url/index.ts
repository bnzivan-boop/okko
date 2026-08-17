// POST /functions/v1/document-url
// Hands out a 60-second signed URL for one document — the only way a file ever
// leaves the private bucket. Checks the gate against what this buyer has earned:
//   public   → anyone
//   contacts → a lead with unlocked_at set (they left contacts)
//   nda      → a lead with nda_signed_at set
// Sellers and admins get their own files with their session JWT instead of a token.
//
// Body: { document_id, token? }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL')!;
const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('SITE_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const { document_id, token } = await req.json().catch(() => ({}));
  if (!document_id) return json({ error: 'document_id required' }, 400);

  const { data: doc } = await db
    .from('documents')
    .select('id, listing_id, gate, file_name, storage_path, listings!inner(status, owner_id)')
    .eq('id', document_id)
    .single();
  if (!doc) return json({ error: 'not found' }, 404);

  let allowed = doc.gate === 'public';
  let leadId: string | null = null;

  // buyer path — token issued by submit-enquiry
  if (!allowed && token) {
    const { data: lead } = await db
      .from('leads')
      .select('id, listing_id, unlocked_at, nda_signed_at')
      .eq('access_token', token)
      .single();
    if (lead && lead.listing_id === doc.listing_id) {
      leadId = lead.id;
      if (doc.gate === 'contacts') allowed = !!lead.unlocked_at;
      if (doc.gate === 'nda') allowed = !!lead.nda_signed_at;
    }
  }

  // seller / admin path — normal Supabase session
  if (!allowed) {
    const jwt = req.headers.get('authorization')?.replace('Bearer ', '');
    if (jwt) {
      const { data: u } = await db.auth.getUser(jwt);
      if (u?.user) {
        const { data: prof } = await db.from('profiles').select('is_admin').eq('id', u.user.id).single();
        // deno-lint-ignore no-explicit-any
        allowed = (doc as any).listings.owner_id === u.user.id || !!prof?.is_admin;
      }
    }
  }

  if (!allowed) return json({ error: 'locked', gate: doc.gate }, 403);

  const { data: signed, error } = await db.storage.from('documents').createSignedUrl(doc.storage_path, 60, {
    download: doc.file_name,
  });
  if (error) return json({ error: error.message }, 500);

  await db.from('document_downloads').insert({ document_id: doc.id, lead_id: leadId });
  await db.rpc('bump_download', { doc: doc.id }).catch(() => {});

  return json({ url: signed.signedUrl, expires_in: 60 });
});
