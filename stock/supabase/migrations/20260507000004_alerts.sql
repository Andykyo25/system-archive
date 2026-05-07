-- 警示規則 + 觸發事件

create table public.alert_rules (
  id bigserial primary key,
  symbol text not null,
  condition text not null,
  threshold numeric(12,4),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  note text
);
create index idx_alert_rules_active on public.alert_rules (symbol) where enabled = true;

create table public.alert_events (
  id bigserial primary key,
  rule_id bigint references public.alert_rules(id) on delete cascade,
  symbol text not null,
  triggered_at timestamptz not null default now(),
  snapshot jsonb,
  notified boolean not null default false
);
create index idx_alert_events_recent on public.alert_events (triggered_at desc);
create index idx_alert_events_unsent
  on public.alert_events (notified, triggered_at desc)
  where notified = false;
