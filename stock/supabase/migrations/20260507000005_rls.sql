-- 全表 RLS enable + deny by default
-- 所有讀寫走 server-side(service_role 自動 bypass RLS)
-- 之後若需 client-side 讀,再針對單表加 select policy

alter table public.holdings              enable row level security;
alter table public.watchlist             enable row level security;
alter table public.paper_orders          enable row level security;
alter table public.price_daily           enable row level security;
alter table public.price_intraday_cache  enable row level security;
alter table public.fetch_log             enable row level security;
alter table public.api_quota_state       enable row level security;
alter table public.reconcile_audit       enable row level security;
alter table public.alert_rules           enable row level security;
alter table public.alert_events          enable row level security;
