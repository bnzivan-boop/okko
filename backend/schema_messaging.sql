-- OKKO CAP — omnichannel messaging
-- One thread per lead. WhatsApp, Telegram, email and the site form all write
-- into lead_messages; the console reads one list and replies back through
-- whichever channel the buyer used.
-- Run after schema.sql.

create type msg_channel   as enum ('site','email','whatsapp','telegram','phone');
create type msg_direction as enum ('in','out');
create type msg_state     as enum ('queued','sent','delivered','read','failed');

-- ---------------------------------------------------------------- identities
-- How to reach one buyer on one channel. A lead can have several rows: the same
-- person may arrive by form and continue in WhatsApp.
create table lead_channels (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references leads(id) on delete cascade,
  channel      msg_channel not null,
  external_id  text not null,          -- wa: phone in E.164 · tg: chat_id · email: address
  display_name text,
  opted_in     boolean not null default true,
  last_inbound_at timestamptz,         -- drives the WhatsApp 24-hour window
  created_at   timestamptz not null default now(),
  unique (channel, external_id)
);
create index on lead_channels(lead_id);

-- ---------------------------------------------------------------- messages
alter table lead_messages
  add column channel      msg_channel   not null default 'site',
  add column direction    msg_direction not null default 'in',
  add column external_id  text,                    -- provider message id, for dedupe
  add column state        msg_state     not null default 'delivered',
  add column media_path   text,                    -- documents/<lead>/<file> in the private bucket
  add column media_name   text,
  add column error        text,
  add column author_user  uuid references profiles(id) on delete set null;

-- webhooks retry: the same provider message must never land twice
create unique index lead_messages_external on lead_messages(channel, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------- templates
-- Outside the 24-hour window WhatsApp only accepts pre-approved templates.
create table message_templates (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,      -- 'deal_followup_v1'
  channel    msg_channel not null default 'whatsapp',
  language   text not null default 'en',
  body       text not null,             -- with {{1}}, {{2}} placeholders
  approved   boolean not null default false,
  created_at timestamptz not null default now()
);

insert into message_templates (code, body, approved) values
  ('deal_followup_v1', 'Hi {{1}}, this is {{2}} from {{3}} on OKKO CAP. You asked about the deal — happy to answer any questions or arrange a viewing.', false),
  ('nda_reminder_v1',  'Hi {{1}}, the full data room for {{2}} opens as soon as the NDA is signed. Here is the link: {{3}}', false)
on conflict (code) do nothing;

-- ---------------------------------------------------------------- routing
-- Which channel a reply should go out on: the last one the buyer actually used.
create or replace function preferred_channel(l_id uuid)
returns table (channel msg_channel, external_id text, window_open boolean)
language sql stable as $$
  select c.channel, c.external_id,
         (c.last_inbound_at is not null and c.last_inbound_at > now() - interval '24 hours')
  from lead_channels c
  where c.lead_id = l_id
  order by c.last_inbound_at desc nulls last, c.created_at desc
  limit 1;
$$;

-- Attach an inbound message to a lead, creating the identity if it is new.
-- Deep links carry the lead token, so a WhatsApp or Telegram chat is matched to
-- the exact deal instead of guessing by phone number.
create or replace function ingest_message(
  p_channel msg_channel, p_external_id text, p_from text, p_name text,
  p_body text, p_msg_id text, p_token text default null,
  p_media_path text default null, p_media_name text default null
) returns uuid language plpgsql security definer as $$
declare v_lead uuid; v_chan uuid;
begin
  -- 1. token from the deep link wins
  if p_token is not null then
    select id into v_lead from leads where access_token = p_token;
  end if;

  -- 2. otherwise an identity we already know
  if v_lead is null then
    select lead_id into v_lead from lead_channels
    where channel = p_channel and external_id = p_from;
  end if;

  -- 3. or the phone / email on an existing lead
  if v_lead is null then
    select id into v_lead from leads
    where (p_channel = 'whatsapp' and regexp_replace(coalesce(phone,''),'\D','','g')
                                     = regexp_replace(p_from,'\D','','g'))
       or (p_channel = 'email' and lower(email) = lower(p_from))
    order by created_at desc limit 1;
  end if;

  if v_lead is null then
    return null;   -- unmatched: the caller parks it in unmatched_messages
  end if;

  insert into lead_channels (lead_id, channel, external_id, display_name, last_inbound_at)
  values (v_lead, p_channel, p_from, p_name, now())
  on conflict (channel, external_id)
    do update set last_inbound_at = now(), display_name = coalesce(excluded.display_name, lead_channels.display_name)
  returning id into v_chan;

  insert into lead_messages (lead_id, author, body, channel, direction, external_id, state, media_path, media_name)
  values (v_lead, 'buyer', coalesce(p_body,''), p_channel, 'in', p_msg_id, 'delivered', p_media_path, p_media_name)
  on conflict do nothing;

  update leads set updated_at = now(),
                   status = case when status = 'lost' then 'replied' else status end
  where id = v_lead;

  return v_lead;
end $$;

-- Messages we could not attach to any lead — the admin links them by hand.
create table unmatched_messages (
  id          uuid primary key default gen_random_uuid(),
  channel     msg_channel not null,
  external_id text,
  from_id     text,
  display_name text,
  body        text,
  payload     jsonb,
  linked_lead uuid references leads(id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table lead_channels       enable row level security;
alter table message_templates   enable row level security;
alter table unmatched_messages  enable row level security;

create policy "seller reads channels" on lead_channels for select
  using (exists (select 1 from leads l where l.id = lead_id and can_edit_listing(l.listing_id)));
create policy "everyone reads templates" on message_templates for select using (true);
create policy "admin reads unmatched" on unmatched_messages for select using (is_admin());
