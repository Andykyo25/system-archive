-- 資料管線運維表(fetch log、quota、reconcile audit)

create table public.fetch_log (
  id bigserial primary key,
  source text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  success boolean,
  rows_written integer not null default 0,
  rows_skipped integer not null default 0,
  error text
);
create index idx_fetch_log_recent on public.fetch_log (started_at desc);
create index idx_fetch_log_source_recent on public.fetch_log (source, started_at desc);

create table public.api_quota_state (
  source text not null,
  quota_date date not null default current_date,
  used integer not null default 0,
  budget integer not null,
  primary key (source, quota_date)
);

create table public.reconcile_audit (
  id bigserial primary key,
  symbol text not null,
  trade_date date not null,
  old_source text,
  old_close numeric(12,4),
  new_source text not null,
  new_close numeric(12,4) not null,
  reconciled_at timestamptz not null default now()
);
create index idx_reconcile_audit_lookup on public.reconcile_audit (symbol, trade_date);
