-- M8: etf_metadata 自動化準備
--
-- 加 source / last_synced 區分:
-- - source='manual':Andy 手動透過 /settings 改的,fetch-etf-metadata cron 不會踢
-- - source='auto':從 FinMind/TWSE 自動抓的
--
-- expense_ratio / fund_size_billion 仍維持「需手動填」(免費 API 通常沒這資料)
-- name / category 可以從 FinMind TaiwanStockInfo 拉

alter table public.etf_metadata
  add column if not exists source text not null default 'manual';

alter table public.etf_metadata
  add column if not exists last_synced_at timestamptz;

-- 標記既有 row 為 manual(不要被 cron 覆蓋)
update public.etf_metadata set source = 'manual' where source is null;

-- index 加速 fetch-etf-metadata 查 stale row
create index if not exists idx_etf_source_synced on public.etf_metadata (source, last_synced_at);
