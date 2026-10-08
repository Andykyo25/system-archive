-- Schedule notify-broker-recon: weekdays 18:30 Taipei (10:30 UTC), 30 minutes after the
-- broker-sync worker (18:00 Taipei, ~1 minute of work, hard-killed at 180 s).
-- Same auth pattern as the other cron jobs: the Edge Function key is read from the Vault.
--
-- Also registers the notifier in data_source_expectation now that it is deployed and has
-- logged a successful run (20261008000002 only registered broker-sync).
--
-- Rollback:
--   select cron.unschedule('notify-broker-recon');
--   delete from public.data_source_expectation where source = 'broker_recon_notify';

select cron.schedule(
  'notify-broker-recon',
  '30 10 * * 1-5',
  $job$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/notify-broker-recon',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);

insert into public.data_source_expectation (source, max_age_days, note) values
  ('broker_recon_notify', 5, 'notify-broker-recon Edge Function (pg_cron, weekdays 18:30 Taipei); logs every run, even with nothing to send')
on conflict (source) do nothing;
