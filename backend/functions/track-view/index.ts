// POST /functions/v1/track-view  { slug, source?, open? }
// Counts a listing view (and, with open=true, a card open) into listing_views /
// view_sources. No cookies, no personal data — just daily counters that feed the
// Analytics tab in the seller console.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('SITE_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const { slug, source = 'direct', open = false } = await req.json().catch(() => ({}));
  if (!slug) return new Response('slug required', { status: 400, headers: cors });

  const { data: l } = await db.from('listings').select('id').eq('slug', slug).eq('status', 'live').single();
  if (!l) return new Response('ok', { headers: cors });

  await db.rpc('bump_view', { l_id: l.id, src: String(source).slice(0, 40), is_open: !!open });
  return new Response('ok', { headers: cors });
});
