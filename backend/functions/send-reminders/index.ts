// Reminder worker. pg_cron pings it every 5 minutes (see cron.sql).
// Picks everything in due_reminders, sends it on the seller's own channel
// (Telegram or WhatsApp, whichever they connected), falls back to email,
// and marks the row. Quiet hours and "already answered" are handled by the view.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const SITE = Deno.env.get('SITE_ORIGIN') ?? 'https://okkocap.com';
const TG = Deno.env.get('TELEGRAM_BOT_TOKEN');
const WA_ID = Deno.env.get('WA_PHONE_NUMBER_ID');
const WA_TOKEN = Deno.env.get('WA_ACCESS_TOKEN');
const ADMIN = Deno.env.get('ADMIN_EMAIL') ?? 'sales@okkocap.com';

const fill = (t: string, v: Record<string, string>) =>
  t.replace(/{{(\w+)}}/g, (_, k) => v[k] ?? '');

async function mail(to: string, subject: string, html: string) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: Deno.env.get('MAIL_FROM') ?? 'OKKO CAP <deals@okkocap.com>', to, subject, html }),
  });
  return r.ok;
}

async function telegram(chat: string, text: string) {
  if (!TG) return false;
  const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
  });
  return r.ok;
}

async function whatsapp(to: string, text: string) {
  if (!WA_ID || !WA_TOKEN) return false;
  const r = await fetch(`https://graph.facebook.com/v20.0/${WA_ID}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${WA_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
  return r.ok;
}

Deno.serve(async () => {
  const { data: due } = await db.from('due_reminders').select('*').limit(100);
  if (!due?.length) return new Response(JSON.stringify({ sent: 0 }), { headers: { 'content-type': 'application/json' } });

  let sent = 0;
  for (const r of due) {
    const vars = {
      buyer: r.buyer ?? 'A buyer',
      listing: r.listing ?? 'your listing',
      link: `${SITE}/#/account/enquiries`,
    };
    const text = fill(r.body, vars);
    let ok = false;
    let channel: string | null = null;

    if (r.audience === 'seller') {
      const { data: ch } = await db.from('seller_channels')
        .select('channel, external_id').eq('user_id', r.owner_id)
        .eq('is_primary', true).not('verified_at', 'is', null).maybeSingle();

      if (ch?.channel === 'telegram') { ok = await telegram(ch.external_id, `⏰ ${text}\n\n<a href="${vars.link}">Open in the console</a>`); channel = 'telegram'; }
      if (!ok && ch?.channel === 'whatsapp') { ok = await whatsapp(ch.external_id, `⏰ ${text}\n\n${vars.link}`); channel = 'whatsapp'; }
      if (!ok) {
        const { data: u } = await db.auth.admin.getUserById(r.owner_id);
        if (u?.user?.email) { ok = await mail(u.user.email, `Waiting for your reply — ${vars.listing}`, `<p>${text}</p><p><a href="${vars.link}">Open the console</a></p>`); channel = 'email'; }
      }
    }

    if (r.audience === 'buyer' && r.buyer_email) {
      ok = await mail(r.buyer_email, `${vars.listing} — we have your request`, `<p>${text}</p>`);
      channel = 'email';
    }

    if (r.audience === 'admin') {
      ok = await mail(ADMIN, `SLA breach — ${vars.listing}`, `<p>${text}</p><p>${SITE}/#/deal/${r.slug}</p>`);
      channel = 'email';
    }

    await db.from('reminders').update({
      state: ok ? 'sent' : 'skipped',
      sent_at: new Date().toISOString(),
      channel,
      error: ok ? null : 'no channel available',
    }).eq('id', r.id);

    if (ok) sent++;
  }

  return new Response(JSON.stringify({ sent, considered: due.length }), { headers: { 'content-type': 'application/json' } });
});
