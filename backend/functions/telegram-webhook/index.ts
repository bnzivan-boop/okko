// Telegram bridge. One bot, two kinds of chats:
//
//   buyer  → bot        : /start <lead_token> from the deal page deep link
//   seller ↔ bot        : lead cards arrive as messages, the seller answers with
//                         a normal reply (or inside a forum topic) and the answer
//                         is relayed to the buyer
//
// Everything lands in lead_messages, so the console shows one thread.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')!;
const SITE = Deno.env.get('SITE_ORIGIN') ?? 'https://okkocap.com';

const tg = (method: string, body: unknown) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

Deno.serve(async (req) => {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== SECRET)
    return new Response('forbidden', { status: 403 });

  const u = await req.json().catch(() => ({}));
  const m = u.message ?? u.edited_message;
  if (!m) return new Response('ok');

  const chatId = String(m.chat.id);
  const text: string = m.text ?? m.caption ?? '';
  const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || m.from?.username || 'Telegram user';

  // ------------------------------------------------------------ /start
  if (text.startsWith('/start')) {
    const payload = text.split(' ')[1]?.trim();

    // seller links their own Telegram: token comes from the console
    if (payload?.startsWith('s_')) {
      const code = payload.slice(2);
      const { data: v } = await db.from('channel_verifications')
        .select('id, user_id').eq('code', code).eq('channel', 'telegram')
        .is('used_at', null).gt('expires_at', new Date().toISOString()).single();
      if (!v) { await tg('sendMessage', { chat_id: chatId, text: 'This link has expired. Open Settings → Channels again.' }); return new Response('ok'); }

      await db.from('seller_channels').upsert({
        user_id: v.user_id, channel: 'telegram', external_id: chatId,
        display_name: name, is_primary: true, verified_at: new Date().toISOString(),
      }, { onConflict: 'channel,external_id' });
      await db.from('channel_verifications').update({ used_at: new Date().toISOString() }).eq('id', v.id);

      await tg('sendMessage', {
        chat_id: chatId,
        text: '✅ Telegram connected.\n\nEnquiries will arrive here. Reply to a card and the buyer gets your answer — your number and theirs stay private.',
      });
      return new Response('ok');
    }

    // buyer opens the chat from a deal page
    if (payload) {
      const { data: lead } = await db.from('leads')
        .select('id, listing_id, listings(name)').eq('access_token', payload).single();
      if (lead) {
        await db.from('lead_channels').upsert({
          lead_id: lead.id, channel: 'telegram', external_id: chatId,
          display_name: name, last_inbound_at: new Date().toISOString(),
        }, { onConflict: 'channel,external_id' });
        // deno-lint-ignore no-explicit-any
        const listingName = (lead as any).listings?.name ?? 'the deal';
        await tg('sendMessage', {
          chat_id: chatId,
          text: `You are now connected with the owner of ${listingName}. Write your question here — I will pass it on and bring back the answer.`,
        });
        return new Response('ok');
      }
    }
    await tg('sendMessage', { chat_id: chatId, text: `Open a deal on ${SITE} and press “Telegram” to start a conversation with its owner.` });
    return new Response('ok');
  }

  // ------------------------------------------------------------ seller replying
  const threadId = m.message_thread_id ? String(m.message_thread_id) : null;
  const replyTo = m.reply_to_message ? String(m.reply_to_message.message_id) : null;

  const { data: seller } = await db.from('seller_channels')
    .select('user_id').eq('channel', 'telegram').eq('external_id', chatId).maybeSingle();

  // "MANDATE" from the 48-hour offer: the owner wants OKKO to run the deal
  if (seller && /^\s*mandate\b/i.test(text)) {
    await db.from('mandate_requests').insert({ user_id: seller.user_id, source: 'telegram' });
    await tg('sendMessage', { chat_id: chatId,
      text: 'Noted — the OKKO Capital team will call you today to scope the mandate.' });
    return new Response('ok');
  }

  if (seller && (threadId || replyTo)) {
    const { data: map } = await db.from('relay_map')
      .select('lead_id')
      .eq('channel', 'telegram')
      .or(`tg_thread_id.eq.${threadId ?? '-'},seller_msg_id.eq.${replyTo ?? '-'}`)
      .maybeSingle();

    if (!map) {
      await tg('sendMessage', { chat_id: chatId, reply_to_message_id: m.message_id,
        text: 'I could not tell which enquiry this answers. Reply directly to the enquiry card.' });
      return new Response('ok');
    }

    await db.from('lead_messages').insert({
      lead_id: map.lead_id, author: 'seller', body: text,
      channel: 'telegram', direction: 'out', external_id: `tg_${m.message_id}`, state: 'sent',
    });

    // deliver to the buyer on whichever channel they used
    const { data: bc } = await db.from('lead_channels')
      .select('channel, external_id').eq('lead_id', map.lead_id)
      .order('last_inbound_at', { ascending: false }).limit(1).maybeSingle();

    if (bc?.channel === 'telegram') {
      await tg('sendMessage', { chat_id: bc.external_id, text });
    } else {
      await db.functions.invoke('send-message', { body: { lead_id: map.lead_id, body: text, from: 'seller' } })
        .catch(() => {});
    }
    await tg('setMessageReaction', { chat_id: chatId, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] })
      .catch(() => {});
    return new Response('ok');
  }

  // ------------------------------------------------------------ buyer writing
  const { data: leadId } = await db.rpc('ingest_message', {
    p_channel: 'telegram', p_external_id: chatId, p_from: chatId,
    p_name: name, p_body: text, p_msg_id: `tg_${m.message_id}`, p_token: null,
  });

  if (!leadId) {
    await db.from('unmatched_messages').insert({
      channel: 'telegram', external_id: `tg_${m.message_id}`, from_id: chatId,
      display_name: name, body: text, payload: u,
    });
    await tg('sendMessage', { chat_id: chatId, text: `Open the deal on ${SITE} and press “Telegram” so I know which listing you are asking about.` });
    return new Response('ok');
  }

  // forward to the seller's own Telegram
  const { data: lead } = await db.from('leads')
    .select('id, name, listings(name, owner_id)').eq('id', leadId).single();
  // deno-lint-ignore no-explicit-any
  const owner = (lead as any).listings.owner_id;
  const { data: sc } = await db.from('seller_channels')
    .select('external_id, tg_group_id').eq('user_id', owner).eq('channel', 'telegram').maybeSingle();

  if (sc) {
    const card = `📩 <b>${lead.name}</b> · ${(lead as any).listings.name}\n\n${text}\n\n<i>Reply to this message and the buyer gets your answer.</i>`;
    const sent = await tg('sendMessage', {
      chat_id: sc.tg_group_id ?? sc.external_id,
      text: card, parse_mode: 'HTML',
    });
    if (sent?.result?.message_id) {
      await db.from('relay_map').upsert({
        lead_id: leadId, channel: 'telegram', seller_msg_id: String(sent.result.message_id),
      }, { onConflict: 'channel,seller_msg_id' });
    }
  }

  return new Response('ok');
});
