-- Counters used by the edge functions (service role only).

create or replace function bump_view(l_id uuid, src text default 'direct', is_open boolean default false)
returns void language sql security definer as $$
  insert into listing_views (listing_id, day, views, opens)
  values (l_id, current_date, 1, case when is_open then 1 else 0 end)
  on conflict (listing_id, day) do update
    set views = listing_views.views + 1,
        opens = listing_views.opens + case when is_open then 1 else 0 end;

  insert into view_sources (listing_id, day, source, views)
  values (l_id, current_date, src, 1)
  on conflict (listing_id, day, source) do update
    set views = view_sources.views + 1;
$$;

create or replace function bump_download(doc uuid)
returns void language sql security definer as $$
  update documents set downloads = downloads + 1 where id = doc;
$$;

-- A buyer signs the NDA -> legal documents open for that lead.
create or replace function sign_nda(lead_token text, signer_ip inet default null)
returns boolean language plpgsql security definer as $$
declare l record;
begin
  select * into l from leads where access_token = lead_token;
  if not found then return false; end if;

  update leads set nda_signed_at = now(), status = 'nda_signed' where id = l.id;
  insert into nda_signatures (lead_id, listing_id, ip) values (l.id, l.listing_id, signer_ip);
  insert into lead_messages (lead_id, author, body)
    values (l.id, 'system', 'NDA signed — full data room access granted');
  return true;
end $$;

-- Dashboard numbers for one seller, in one round trip.
create or replace function console_stats(l_id uuid)
returns json language sql stable as $$
  select json_build_object(
    'views_30',    coalesce((select sum(views) from listing_views
                             where listing_id = l_id and day > current_date - 30), 0),
    'views_prev',  coalesce((select sum(views) from listing_views
                             where listing_id = l_id and day between current_date - 60 and current_date - 30), 0),
    'leads',       (select count(*) from leads where listing_id = l_id),
    'ndas',        (select count(*) from leads where listing_id = l_id and nda_signed_at is not null),
    'viewings',    (select count(*) from leads where listing_id = l_id and status = 'viewing'),
    'loi',         (select count(*) from leads where listing_id = l_id and status = 'loi'),
    'unanswered',  (select count(*) from leads where listing_id = l_id and status = 'new'
                                                 and created_at < now() - interval '24 hours')
  );
$$;
