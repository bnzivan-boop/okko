-- Schedules. Run once, after the functions are deployed.
-- Requires the pg_cron and pg_net extensions (Database → Extensions in Supabase).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Keep the service key out of the SQL: store it once in Vault.
--   select vault.create_secret('<service_role_key>', 'service_key');
--   select vault.create_secret('https://<ref>.functions.supabase.co', 'functions_url');

create or replace function call_function(name text, payload jsonb default '{}')
returns bigint language plpgsql security definer as $$
declare url text; key text;
begin
  select decrypted_secret into url from vault.decrypted_secrets where name = 'functions_url';
  select decrypted_secret into key from vault.decrypted_secrets where name = 'service_key';
  return net.http_post(
    url || '/' || name,
    payload,
    headers => jsonb_build_object('content-type','application/json','authorization','Bearer '||key)
  );
end $$;

-- reminders: every five minutes
select cron.schedule('okko-reminders', '*/5 * * * *', $$select call_function('send-reminders')$$);

-- viewings and expiries: schedule the negative-offset rules once an hour
select cron.schedule('okko-schedule-ahead', '7 * * * *', $$
  insert into reminders (rule, listing_id, user_id, due_at)
  select 'listing_expiry', l.id, l.owner_id, l.expires_at - interval '3 days'
  from listings l
  where l.status = 'live' and l.expires_at is not null
    and l.expires_at - interval '3 days' between now() and now() + interval '1 hour'
  on conflict do nothing;
$$);

-- weekly digest, Monday 09:00 Dubai (05:00 UTC)
select cron.schedule('okko-digest', '0 5 * * 1', $$select call_function('send-reminders', '{"digest":true}')$$);

-- housekeeping: drop verification codes older than a day
select cron.schedule('okko-cleanup', '30 3 * * *', $$
  delete from channel_verifications where created_at < now() - interval '1 day';
$$);
