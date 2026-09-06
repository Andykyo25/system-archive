alter table public.alert_events add column delivery_token uuid;
alter table public.alert_events add column delivery_after timestamptz not null default now();
alter table public.alert_events add column delivery_attempts integer not null default 0;
alter table public.alert_events add column delivery_error text;

-- The platform-injected service key can differ from the JWT used by pg_cron.
-- Only a server already holding service_role may read the configured cron
-- secret to compare the incoming bearer; never trust an unverified JWT role.
create or replace function public.read_edge_function_auth()
returns text language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets
  where name = 'edge_function_auth' limit 1;
$$;
revoke all on function public.read_edge_function_auth() from public, anon, authenticated;
grant execute on function public.read_edge_function_auth() to service_role;

-- Rule lock, enqueue and disable happen in one transaction; concurrent cron calls
-- cannot create duplicate events. Leases allow retries after crashed workers.
create or replace function public.claim_price_alerts(p_token uuid)
returns setof public.alert_events language plpgsql security definer set search_path = public as $$
declare r record; local_now timestamp;
begin
  local_now := now() at time zone 'Asia/Taipei';
  if extract(isodow from local_now) between 1 and 5
     and local_now::time between time '09:00' and time '13:40' then
    for r in
      select a.id, a.symbol, a.condition, a.threshold, a.note,
        p.current_price, p.as_of_ts, p.source
      from public.alert_rules a join public.v_latest_price_realtime p on p.symbol = a.symbol
      where a.enabled and p.market_state = 'REGULAR' and p.source = 'twse_mis'
        and p.as_of_ts between now() - interval '10 minutes' and now()
        and (p.as_of_ts at time zone 'Asia/Taipei')::date = local_now::date
        and ((a.condition = 'price_below' and p.current_price <= a.threshold)
          or (a.condition = 'price_above' and p.current_price >= a.threshold))
      for update of a skip locked
    loop
      insert into public.alert_events(rule_id,symbol,snapshot,notified)
      values(r.id,r.symbol,jsonb_build_object('price',r.current_price,'threshold',r.threshold,
        'condition',r.condition,'note',r.note,'as_of_ts',r.as_of_ts,'source',r.source,'delivery_version',2),false);
      update public.alert_rules set enabled = false where id = r.id;
    end loop;
  end if;
  return query
    update public.alert_events e set delivery_token = p_token,
      delivery_after = now() + interval '10 minutes', delivery_attempts = delivery_attempts + 1
    where e.id in (
      select q.id from public.alert_events q
      where not q.notified and q.delivery_after <= now() and q.snapshot->>'delivery_version' = '2'
      order by q.triggered_at, q.id limit 20 for update skip locked
    ) returning e.*;
end $$;
revoke all on function public.claim_price_alerts(uuid) from public, anon, authenticated;
grant execute on function public.claim_price_alerts(uuid) to service_role;

comment on column public.alert_events.delivery_token is
  'Delivery lease. Mark notified only after Telegram confirms ok; network ambiguity may cause duplicate delivery (at-least-once).';

-- The existing cron only invokes the worker while a rule is enabled. Claiming
-- the last rule disables it, so a failed delivery otherwise never gets retried.
-- Keep the existing HTTP call (including its URL/auth) byte-for-byte and change
-- only the known gate. Unexpected deployed commands must be reviewed explicitly.
do $$
declare
  j record;
  old_gate constant text := 'if exists (select 1 from public.alert_rules where enabled) then';
  new_gate constant text := 'if exists (select 1 from public.alert_rules where enabled)
        or exists (select 1 from public.alert_events
          where not notified and delivery_after <= now()
            and snapshot->>''delivery_version'' = ''2'') then';
  found_job boolean := false;
begin
  for j in select jobid, command from cron.job where jobname = 'check-price-alerts'
  loop
    found_job := true;
    if j.command is null or position(old_gate in j.command) = 0
      or position(old_gate in substring(j.command from position(old_gate in j.command) + length(old_gate))) > 0 then
      raise exception 'check-price-alerts cron command is unexpected; inspect its URL/auth and gate before applying alert delivery migration';
    end if;
    -- Pending deliveries can recover after close and on weekends. New alert
    -- events remain restricted to the regular session inside claim_price_alerts.
    perform cron.alter_job(j.jobid, schedule := '*/10 * * * *',
      command := replace(j.command, old_gate, new_gate));
  end loop;
  if not found_job then
    raise exception 'check-price-alerts cron job is missing; restore the configured worker schedule before applying alert delivery migration';
  end if;
end $$;
