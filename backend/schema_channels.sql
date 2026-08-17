-- OKKO CAP — seller channels (the bridge) and reminders
-- Run after schema.sql and schema_messaging.sql.
--
-- The bridge: the buyer writes to the platform number / bot, the platform
-- forwards it to the seller's OWN WhatsApp or Telegram, the seller answers from
-- the phone as usual, and the answer is relayed back to the buyer. Both numbers
-- stay private and the whole thread is mirrored into the console.

-- ---------------------------------------------------------------- seller side
create table seller_channels (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  company_id    uuid references companies(id) on delete cascade,
  channel       msg_channel not null,          -- whatsapp | telegram | email
  external_id   text not null,                 -- E.164 phone · telegram chat_id · address
  display_name  text,
  is_primary    boolean not null default true, -- "основной контакт"
  verified_at   timestamptz,
  -- telegram only: forum group where every lead gets its own topic
  tg_group_id   text,
  -- own Cloud API / own bot instead of the platform bridge (optional upgrade)
  own_waba_id       text,
  own_phone_id      text,
  own_bot_token     text,
  created_at    timestamptz not null default now(),
  unique (channel, external_id)
);
create index on seller_channels(user_id);

create table channel_verifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  channel    msg_channel not null,
  external_id text not null,
  code       text not null,
  attempts   int not null default 0,
  expires_at timestamptz not null default now() + interval '15 minutes',
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index on channel_verifications(user_id, channel);

-- Which outbound message in the seller's chat corresponds to which lead.
-- WhatsApp: the seller swipes-to-reply, the webhook returns context.id → lead.
-- Telegram: one forum topic per lead → thread_id → lead.
create table relay_map (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references leads(id) on delete cascade,
  channel       msg_channel not null,
  seller_msg_id text,        -- provider id of the message we sent to the seller
  tg_thread_id  text,        -- forum topic id
  created_at    timestamptz not null default now()
);
create unique index on relay_map(channel, seller_msg_id) where seller_msg_id is not null;
create unique index on relay_map(channel, tg_thread_id)  where tg_thread_id  is not null;
create index on relay_map(lead_id);

-- ---------------------------------------------------------------- preferences
create table notification_prefs (
  user_id        uuid primary key references profiles(id) on delete cascade,
  new_lead       boolean not null default true,
  nda_signed     boolean not null default true,
  weekly_digest  boolean not null default false,
  reminders      boolean not null default true,
  timezone       text not null default 'Asia/Dubai'   -- for timestamps in digests only
);

-- ---------------------------------------------------------------- reminders
create type reminder_state as enum ('scheduled','sent','skipped','cancelled');

create table reminder_rules (
  code        text primary key,
  after_mins  int  not null,
  audience    text not null default 'seller',   -- seller | buyer | admin
  body        text not null,
  active      boolean not null default true
);

-- The buyer is never told that the seller is slow: nothing in this ladder goes
-- to the buyer's side. At 48 hours the seller is offered a mandate and the OKKO
-- team is told, so a stalling deal gets picked up by a human instead.
insert into reminder_rules (code, after_mins, audience, body) values
  ('lead_1h',   60,   'seller', '{{buyer}} sent an enquiry on {{listing}} an hour ago and is still waiting. Reply right here — I will pass it on.'),
  ('lead_6h',   360,  'seller', '{{buyer}} has been waiting 6 hours on {{listing}}. Buyers answered after six hours reply half as often.'),
  ('lead_24h',  1440, 'seller', '24 hours without an answer to {{buyer}} on {{listing}}. This is the point where most deals go cold.'),
  ('mandate_48h', 2880, 'seller', '{{buyer}} has been waiting two days on {{listing}}. If you would rather not run the conversations yourself, OKKO Capital can take the deal under a mandate: we qualify buyers, handle the calls and drive it to close. Reply MANDATE and we will call you.'),
  ('lead_48h',  2880, 'admin',  '{{listing}}: enquiry from {{buyer}} unanswered for 48 hours. Mandate offer sent to the owner — worth a call.'),
  ('nda_docs',  120,  'seller', '{{buyer}} signed the NDA on {{listing}} 2 hours ago but has not opened the data room. Send the documents?'),
  ('viewing_24h', -1440, 'seller', 'Viewing with {{buyer}} on {{listing}} is tomorrow at {{time}}.'),
  ('viewing_2h',  -120,  'seller', 'Viewing with {{buyer}} in 2 hours.'),
  ('listing_expiry', -4320, 'seller', '{{listing}} goes off the marketplace in 3 days. Renew to keep the enquiries coming.'),
  ('moderation_48h', 2880, 'seller', 'The moderator left a comment on {{listing}} 48 hours ago. Fix it and the listing goes live.')
on conflict (code) do nothing;

create table reminders (
  id          uuid primary key default gen_random_uuid(),
  rule        text not null references reminder_rules(code),
  lead_id     uuid references leads(id) on delete cascade,
  listing_id  uuid references listings(id) on delete cascade,
  user_id     uuid references profiles(id) on delete cascade,
  due_at      timestamptz not null,
  state       reminder_state not null default 'scheduled',
  sent_at     timestamptz,
  channel     msg_channel,
  error       text,
  created_at  timestamptz not null default now(),
  unique (rule, lead_id)
);
create index on reminders(state, due_at);

-- A new lead schedules the whole ladder at once; the first reply cancels it.
create or replace function schedule_lead_reminders() returns trigger language plpgsql as $$
declare r record;
begin
  for r in select * from reminder_rules
           where active and code in ('lead_1h','lead_6h','lead_24h','mandate_48h','lead_48h')
  loop
    insert into reminders (rule, lead_id, listing_id, due_at)
    values (r.code, new.id, new.listing_id, new.created_at + make_interval(mins => r.after_mins))
    on conflict do nothing;
  end loop;
  return new;
end $$;

create trigger leads_schedule_reminders after insert on leads
  for each row execute function schedule_lead_reminders();

-- The seller answered (or the lead was closed) -> nothing more to nag about.
create or replace function cancel_lead_reminders() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status and new.status <> 'new' then
    update reminders set state = 'cancelled'
    where lead_id = new.id and state = 'scheduled'
      and rule in ('lead_1h','lead_6h','lead_24h','mandate_48h','lead_48h');
  end if;
  return new;
end $$;

create trigger leads_cancel_reminders after update on leads
  for each row execute function cancel_lead_reminders();

create or replace function cancel_on_reply() returns trigger language plpgsql as $$
begin
  if new.author = 'seller' then
    update reminders set state = 'cancelled'
    where lead_id = new.lead_id and state = 'scheduled'
      and rule in ('lead_1h','lead_6h','lead_24h','mandate_48h','lead_48h');
    update leads set status = case when status = 'new' then 'replied' else status end
    where id = new.lead_id;
  end if;
  return new;
end $$;

create trigger messages_cancel_reminders after insert on lead_messages
  for each row execute function cancel_on_reply();

-- What the worker picks up: due and still relevant. No quiet hours — a waiting
-- buyer does not wait for office hours, so reminders go out around the clock.
create or replace view due_reminders as
  select r.id, r.rule, r.lead_id, r.listing_id, rr.audience, rr.body,
         l.name as buyer, l.email as buyer_email, l.status as lead_status,
         li.name as listing, li.slug, li.owner_id
  from reminders r
  join reminder_rules rr on rr.code = r.rule
  left join leads l   on l.id = r.lead_id
  left join listings li on li.id = coalesce(r.listing_id, l.listing_id)
  left join notification_prefs np on np.user_id = li.owner_id
  where r.state = 'scheduled'
    and r.due_at <= now()
    and coalesce(np.reminders, true)
    and (l.id is null or l.status = 'new');

-- Response time, the number the console shows and the digest reports.
create or replace function response_stats(l_id uuid)
returns json language sql stable as $$
  with firsts as (
    select l.id,
           l.created_at,
           (select min(m.created_at) from lead_messages m
            where m.lead_id = l.id and m.author = 'seller') as first_reply
    from leads l where l.listing_id = l_id
  )
  select json_build_object(
    'median_reply_mins', coalesce(percentile_disc(0.5) within group (
       order by extract(epoch from (first_reply - created_at))/60)::int, null),
    'answered',   count(*) filter (where first_reply is not null),
    'unanswered', count(*) filter (where first_reply is null),
    'breached',   count(*) filter (where first_reply is null and created_at < now() - interval '24 hours')
  ) from firsts;
$$;

alter table seller_channels      enable row level security;
alter table channel_verifications enable row level security;
alter table notification_prefs   enable row level security;
alter table reminders            enable row level security;
alter table relay_map            enable row level security;

create policy "own channels" on seller_channels for all
  using (user_id = auth.uid() or is_admin()) with check (user_id = auth.uid());
create policy "own verifications" on channel_verifications for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own prefs" on notification_prefs for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own reminders" on reminders for select
  using (exists (select 1 from listings l where l.id = reminders.listing_id and can_edit_listing(l.id)));
create policy "own relay" on relay_map for select
  using (exists (select 1 from leads l where l.id = relay_map.lead_id and can_edit_listing(l.listing_id)));

-- The owner answered MANDATE to the 48-hour offer: OKKO Capital picks the deal up.
create table mandate_requests (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  listing_id uuid references listings(id) on delete set null,
  source     text not null default 'telegram',
  state      text not null default 'new',      -- new | called | signed | declined
  created_at timestamptz not null default now()
);
alter table mandate_requests enable row level security;
create policy "own mandate requests" on mandate_requests for select
  using (user_id = auth.uid() or is_admin());
