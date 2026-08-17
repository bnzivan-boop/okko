-- OKKO CAP — database schema
-- Postgres / Supabase. Run once: supabase db push  (or paste into the SQL editor)

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enums
create type listing_type    as enum ('sale','raise');
create type listing_status  as enum ('draft','in_review','changes_requested','live','paused','sold','expired');
create type doc_category    as enum ('deck','financials','legal','other');
create type doc_gate        as enum ('public','contacts','nda');
create type lead_status     as enum ('new','replied','nda_sent','nda_signed','viewing','loi','lost');
create type lead_source     as enum ('form','whatsapp','email','phone','import');
create type msg_author      as enum ('buyer','seller','system');
create type team_role       as enum ('owner','manager','advisor');
create type plan_code       as enum ('m1','m3');

-- ---------------------------------------------------------------- people
create table profiles (
  id          uuid primary key references auth.users on delete cascade,
  full_name   text,
  phone       text,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table companies (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references profiles(id) on delete cascade,
  legal_name    text not null,
  trade_licence text,
  website       text,
  instagram     text,
  logo_path     text,                        -- public-media/logos/<id>.png
  created_at    timestamptz not null default now()
);
create index on companies(owner_id);

create table team_members (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  role       team_role not null default 'manager',
  created_at timestamptz not null default now(),
  unique (company_id, user_id)
);

-- ---------------------------------------------------------------- listings
create table listings (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  company_id    uuid references companies(id) on delete set null,
  owner_id      uuid not null references profiles(id) on delete cascade,
  type          listing_type not null,
  status        listing_status not null default 'draft',

  name          text not null,
  tagline       text,
  industry      text,
  location      text,
  website       text,

  ask           text,                        -- 'AED 3.5M'
  ask_label     text,                        -- 'Asking price'
  ask_note      text,
  chip          text,                        -- '100% share sale'

  metrics       jsonb not null default '[]', -- [["Revenue / yr","AED 2.4M"], …]
  facts         jsonb not null default '[]',
  financials    jsonb not null default '[]',
  terms         jsonb not null default '[]',
  about         text[] not null default '{}',
  model         text[] not null default '{}',
  traction      text[] not null default '{}',

  cover_path    text,
  completeness  int not null default 0,      -- 0…100, drives the console bar
  published_at  timestamptz,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on listings(status);
create index on listings(owner_id);
create index on listings(type, industry);

create table listing_media (
  id         uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  kind       text not null default 'photo',  -- photo | video
  path       text not null,                  -- public-media/<slug>/1.jpg
  position   int  not null default 0,
  created_at timestamptz not null default now()
);
create index on listing_media(listing_id, position);

create table moderation_notes (
  id         uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  author_id  uuid references profiles(id) on delete set null,
  body       text not null,
  resolved   boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- documents
create table documents (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references listings(id) on delete cascade,
  category    doc_category not null default 'other',
  gate        doc_gate     not null default 'contacts',
  file_name   text not null,
  storage_path text not null,                -- documents/<listing>/<uuid>.pdf (private bucket)
  size_bytes  bigint,
  mime        text,
  downloads   int not null default 0,
  created_at  timestamptz not null default now()
);
create index on documents(listing_id, category);

-- ---------------------------------------------------------------- demand side
create table leads (
  id              uuid primary key default gen_random_uuid(),
  listing_id      uuid not null references listings(id) on delete cascade,
  name            text not null,
  email           text not null,
  phone           text,
  company         text,
  message         text,
  source          lead_source not null default 'form',
  status          lead_status not null default 'new',
  quality         int not null default 1,     -- 1…3, scored on insert
  ticket          text,
  horizon         text,
  contacts_shared boolean not null default false,  -- seller revealed their own contacts
  access_token    text not null default encode(gen_random_bytes(24),'hex'), -- buyer's download link
  unlocked_at     timestamptz,                -- when 'contacts' docs opened
  nda_signed_at   timestamptz,                -- when 'nda' docs opened
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on leads(listing_id, status);
create unique index on leads(access_token);

create table lead_messages (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references leads(id) on delete cascade,
  author     msg_author not null,
  body       text not null,
  created_at timestamptz not null default now()
);
create index on lead_messages(lead_id, created_at);

create table nda_signatures (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references leads(id) on delete cascade,
  listing_id uuid not null references listings(id) on delete cascade,
  signed_at  timestamptz not null default now(),
  ip         inet,
  doc_path   text
);

create table document_downloads (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  lead_id     uuid references leads(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- analytics
create table listing_views (
  listing_id uuid not null references listings(id) on delete cascade,
  day        date not null default current_date,
  views      int not null default 0,
  opens      int not null default 0,
  primary key (listing_id, day)
);

create table view_sources (
  listing_id uuid not null references listings(id) on delete cascade,
  day        date not null default current_date,
  source     text not null default 'direct',
  views      int  not null default 0,
  primary key (listing_id, day, source)
);

-- ---------------------------------------------------------------- billing
create table subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  listing_id             uuid not null references listings(id) on delete cascade,
  owner_id               uuid not null references profiles(id) on delete cascade,
  plan                   plan_code not null default 'm1',
  status                 text not null default 'incomplete', -- incomplete|active|past_due|canceled
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  stripe_customer_id     text,
  stripe_subscription_id text,
  created_at             timestamptz not null default now()
);
create index on subscriptions(owner_id);

create table invoices (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid references subscriptions(id) on delete set null,
  owner_id        uuid not null references profiles(id) on delete cascade,
  number          text,
  amount_cents    int not null,
  currency        text not null default 'aed',
  status          text not null default 'paid',
  pdf_url         text,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------- helpers
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger listings_touch before update on listings
  for each row execute function touch_updated_at();
create trigger leads_touch before update on leads
  for each row execute function touch_updated_at();

-- new auth user -> profile
create or replace function handle_new_user() returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, full_name, phone)
  values (new.id, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'phone')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- lead quality: stated ticket + timeline + whether contacts look real
create or replace function score_lead() returns trigger language plpgsql as $$
declare s int := 1;
begin
  if new.ticket is not null and new.ticket <> '' then s := s + 1; end if;
  if new.phone  is not null and length(new.phone) >= 9 then s := s + 1; end if;
  new.quality := least(s,3);
  return new;
end $$;

create trigger leads_score before insert on leads
  for each row execute function score_lead();

-- public view of a live listing (what the marketplace reads)
create or replace view public_listings as
  select l.id, l.slug, l.type, l.name, l.tagline, l.industry, l.location, l.website,
         l.ask, l.ask_label, l.ask_note, l.chip, l.metrics, l.facts, l.financials,
         l.terms, l.about, l.model, l.traction, l.cover_path, l.published_at,
         c.logo_path,
         coalesce((select json_agg(m.path order by m.position) from listing_media m
                   where m.listing_id = l.id and m.kind = 'photo'), '[]') as photos,
         coalesce((select count(*) from documents d where d.listing_id = l.id), 0) as document_count
  from listings l
  left join companies c on c.id = l.company_id
  where l.status = 'live';
