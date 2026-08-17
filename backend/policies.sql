-- OKKO CAP — row level security
-- Run after schema.sql. Everything is denied by default; the rules below are the
-- only ways data leaves the database. Edge functions use the service_role key
-- and bypass RLS on purpose (they do their own checks).

alter table profiles          enable row level security;
alter table companies         enable row level security;
alter table team_members      enable row level security;
alter table listings          enable row level security;
alter table listing_media     enable row level security;
alter table moderation_notes  enable row level security;
alter table documents         enable row level security;
alter table leads             enable row level security;
alter table lead_messages     enable row level security;
alter table nda_signatures    enable row level security;
alter table document_downloads enable row level security;
alter table listing_views     enable row level security;
alter table view_sources      enable row level security;
alter table subscriptions     enable row level security;
alter table invoices          enable row level security;

-- ---------------------------------------------------------------- helpers
create or replace function is_admin() returns boolean language sql stable as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false);
$$;

-- the current user can act on this listing: owner, team member, or admin
create or replace function can_edit_listing(l_id uuid) returns boolean language sql stable as $$
  select exists (
    select 1 from listings l
    left join team_members tm on tm.company_id = l.company_id and tm.user_id = auth.uid()
    where l.id = l_id and (l.owner_id = auth.uid() or tm.id is not null)
  ) or is_admin();
$$;

-- ---------------------------------------------------------------- profiles
create policy "own profile"        on profiles for select using (id = auth.uid() or is_admin());
create policy "update own profile" on profiles for update using (id = auth.uid());

-- ---------------------------------------------------------------- companies
create policy "own companies" on companies for all
  using (owner_id = auth.uid() or is_admin())
  with check (owner_id = auth.uid());

create policy "team reads company" on team_members for select
  using (user_id = auth.uid() or exists (
    select 1 from companies c where c.id = company_id and c.owner_id = auth.uid()));

-- ---------------------------------------------------------------- listings
-- anyone (including anon) may read live listings
create policy "public reads live" on listings for select
  using (status = 'live');

create policy "seller reads own" on listings for select
  using (can_edit_listing(id));

create policy "seller writes own" on listings for insert
  with check (owner_id = auth.uid());

create policy "seller updates own" on listings for update
  using (can_edit_listing(id));

-- media follows its listing
create policy "public reads live media" on listing_media for select
  using (exists (select 1 from listings l where l.id = listing_id and l.status = 'live'));
create policy "seller manages media" on listing_media for all
  using (can_edit_listing(listing_id)) with check (can_edit_listing(listing_id));

create policy "seller reads moderation" on moderation_notes for select
  using (can_edit_listing(listing_id));
create policy "admin writes moderation" on moderation_notes for insert
  with check (is_admin());

-- ---------------------------------------------------------------- documents
-- The metadata of a document on a live listing is public (buyers see the list and
-- the lock state). The FILE itself lives in a private bucket: it is only ever
-- handed out as a short-lived signed URL by the document-url edge function.
create policy "public reads doc list" on documents for select
  using (exists (select 1 from listings l where l.id = listing_id and l.status = 'live'));
create policy "seller manages docs" on documents for all
  using (can_edit_listing(listing_id)) with check (can_edit_listing(listing_id));

-- ---------------------------------------------------------------- leads
-- Buyers never read leads. Only the listing owner / team / admin.
create policy "seller reads leads" on leads for select
  using (can_edit_listing(listing_id));
create policy "seller updates leads" on leads for update
  using (can_edit_listing(listing_id));

create policy "seller reads messages" on lead_messages for select
  using (exists (select 1 from leads l where l.id = lead_id and can_edit_listing(l.listing_id)));
create policy "seller writes messages" on lead_messages for insert
  with check (exists (select 1 from leads l where l.id = lead_id and can_edit_listing(l.listing_id)));

create policy "seller reads ndas" on nda_signatures for select
  using (can_edit_listing(listing_id));
create policy "seller reads downloads" on document_downloads for select
  using (exists (select 1 from documents d where d.id = document_id and can_edit_listing(d.listing_id)));

-- ---------------------------------------------------------------- analytics
create policy "seller reads views" on listing_views for select
  using (can_edit_listing(listing_id));
create policy "seller reads sources" on view_sources for select
  using (can_edit_listing(listing_id));
-- writes go through the track-view function (service role)

-- ---------------------------------------------------------------- billing
create policy "own subscriptions" on subscriptions for select
  using (owner_id = auth.uid() or is_admin());
create policy "own invoices" on invoices for select
  using (owner_id = auth.uid() or is_admin());

-- ---------------------------------------------------------------- storage
-- Buckets: public-media (public read), documents (private, signed URLs only).
insert into storage.buckets (id, name, public)
values ('public-media','public-media', true), ('documents','documents', false)
on conflict (id) do nothing;

create policy "public media is readable" on storage.objects for select
  using (bucket_id = 'public-media');

create policy "sellers upload media" on storage.objects for insert
  with check (bucket_id = 'public-media' and auth.uid() is not null);

create policy "sellers upload documents" on storage.objects for insert
  with check (bucket_id = 'documents' and auth.uid() is not null);

create policy "sellers read own documents" on storage.objects for select
  using (bucket_id = 'documents' and auth.uid() is not null
         and exists (select 1 from documents d
                     where d.storage_path = storage.objects.name
                       and can_edit_listing(d.listing_id)));
