-- Support tables for the notify-broker-recon Edge Function (Telegram alerts for broker
-- reconciliation problems). The cron job is added separately (20261008000003) after the
-- function is deployed and verified.
--
-- broker_recon_alerted: which alerts were already sent, so each one is sent once.
--   kind: inventory | settlement | sync   key: symbol@date | trade date | date   status: the recon status
--   Written by the function only after Telegram accepted the message.
--
-- data_source_expectation: without a row here a source that silently stops (cron dropped,
-- worker never runs) just disappears from /health instead of turning red.
--
-- Access: service_role only.
--
-- Rollback:
--   delete from public.data_source_expectation where source in ('broker-sync', 'broker_recon_notify');
--   drop table public.broker_recon_alerted;

create table public.broker_recon_alerted (
  kind text not null check (kind in ('inventory', 'settlement', 'sync')),
  key text not null,
  status text not null,
  alerted_at timestamptz not null default now(),
  primary key (kind, key, status)
);

alter table public.broker_recon_alerted enable row level security;
revoke all on public.broker_recon_alerted from anon, authenticated;
grant select, insert, update, delete on public.broker_recon_alerted to service_role;

-- 5 days: the worker and the notifier run on weekdays only, and a long weekend plus a holiday
-- (e.g. Thu evening to Mon evening) is just under 4 days.
insert into public.data_source_expectation (source, max_age_days, note) values
  ('broker-sync', 5, 'Fubon broker snapshot worker (Railway cron, weekdays 18:00 Taipei)'),
  ('broker_recon_notify', 5, 'notify-broker-recon Edge Function (pg_cron, weekdays 18:30 Taipei); logs every run, even with nothing to send');
