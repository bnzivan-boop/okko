// WhatsApp bridge on the platform's Cloud API number.
//
//   buyer  → platform number : wa.me link from the deal page carries #token
//   platform → seller        : the enquiry arrives in the seller's OWN WhatsApp
//   seller → platform        : swipe-to-reply on that message; context.id tells
//                              us which lead it answers, and we relay it back
//
// The seller keeps using the normal WhatsApp app on their phone. Nobody sees
// anybody's number: the buyer talks to the platform, so does the seller.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const PHONE_ID = Deno.env.get('WA_PHONE_NUMBER_ID')!;
const WA_TOKEN = Deno.env.get('WA_ACCESS_TOKEN')!;
const VERIFY = Deno.env.get('WA_VERIFY_TOKEN')!;

async function wa(payload: Record<string, unknown>) {
  const r = await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${WA_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  return r.json();
}
const send = (to: string, body: string) => wa({ to, type: 'text', text: { body, preview_url: false } });

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Meta webhook handshake
  if (req.method === 'GET') {
    return url.searchParams.get('hub.verify_token') === VERIFY
      ? new Response(url.searchParams.get('hub.challenge') ?? '')
      : new Response('forbidden', { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  if (!value) return new Response('ok');

  // delivery receipts -> message state in the console
  for (const s of value.statuses ?? []) {
    await db.from('lead_messages').update({ state: s.status })
      .eq('channel', 'whatsapp').eq('external_id', s.id);
  }

  for (const m of value.messages ?? []) {
    const from: string = m.from;                       // E.164 without +
    const text: string = m.text?.body ?? m.button?.text ?? m.interactive?.list_reply?.title ?? '';
    const name = value.contacts?.[0]?.profile?.name ?? null;
    const quoted = m.context?.id ?? null;

    // -------------------------------------------------- seller answering
    if (quoted) {
      const { data: map } = await db.from('relay_map')
        .select('lead_id').eq('channel', 'whatsapp').eq('seller_msg_id', quoted).maybeSingle();
      const { data: sc } = await db.from('seller_channels')
        .select('user_id').eq('channel', 'whatsapp').eq('external_id', from).maybeSingle();

      if (map && sc) {
        await db.from('lead_messages').insert({
          lead_id: map.lead_id, author: 'seller', body: text,
          channel: 'whatsapp', direction: 'out', external_id: m.id, state: 'sent',
        });
        const { data: bc } = await db.from('lead_channels')
          .select('channel, external_id').eq('lead_id', map.lead_id)
          .order('last_inbound_at', { ascending: false }).limit(1).maybeSingle();
        if (bc?.channel === 'whatsapp') await send(bc.external_id, text);
        continue;
      }
    }

    // "MANDATE" from the 48-hour offer
    if (/^\s*mandate\b/i.test(text)) {
      const { data: sc } = await db.from('seller_channels')
        .select('user_id').eq('channel', 'whatsapp').eq('external_id', from).maybeSingle();
      if (sc) {
        await db.from('mandate_requests').insert({ user_id: sc.user_id, source: 'whatsapp' });
        await send(from, 'Noted — the OKKO Capital team will call you today to scope the mandate.');
        continue;
      }
    }

    // -------------------------------------------------- seller verifying a number
    const code = /(?:^|\s)(\d{6})(?:\s|$)/.exec(text)?.[1];
    if (code) {
      const { data: v } = await db.from('channel_verifications')
        .select('id, user_id').eq('code', code).eq('channel', 'whatsapp')
        .is('used_at', null).gt('expires_at', new Date().toISOString()).maybeSingle();
      if (v) {
        await db.from('seller_channels').upsert({
          user_id: v.user_id, channel: 'whatsapp', external_id: from,
          display_name: name, is_primary: true, verified_at: new Date().toISOString(),
        }, { onConflict: 'channel,external_id' });
        await db.from('channel_verifications').update({ used_at: new Date().toISOString() }).eq('id', v.id);
        await send(from, '✅ Number connected. Enquiries will arrive here — reply to a card and the buyer gets your answer. Your number stays private.');
        continue;
      }
    }

    // -------------------------------------------------- buyer writing
    const token = /#([a-f0-9]{8,})/i.exec(text)?.[1] ?? null;
    const { data: leadId } = await db.rpc('ingest_message', {
      p_channel: 'whatsapp', p_external_id: from, p_from: from,
      p_name: name, p_body: text, p_msg_id: m.id, p_token: token,
    });

    if (!leadId) {
      await db.from('unmatched_messages').insert({
        channel: 'whatsapp', external_id: m.id, from_id: from, display_name: name, body: text, payload: m,
      });
      await send(from, 'Which deal are you asking about? Open it on okkocap.com and press “WhatsApp” — that way your question reaches the right owner.');
      continue;
    }

    const { data: lead } = await db.from('leads')
      .select('id, name, listings(name, owner_id)').eq('id', leadId).single();
    // deno-lint-ignore no-explicit-any
    const owner = (lead as any).listings.owner_id;
    const { data: sc } = await db.from('seller_channels')
      .select('external_id').eq('user_id', owner).eq('channel', 'whatsapp').maybeSingle();

    if (sc) {
      const card = `📩 *${lead.name}* · ${(lead as any).listings.name}\n\n${text}\n\n_Reply to this message and the buyer gets your answer._`;
      const sent = await send(sc.external_id, card);
      const id = sent?.messages?.[0]?.id;
      if (id) {
        await db.from('relay_map').upsert(
          { lead_id: leadId, channel: 'whatsapp', seller_msg_id: id },
          { onConflict: 'channel,seller_msg_id' },
        );
      }
    }
  }

  return new Response('ok');
});
