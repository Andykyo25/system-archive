-- M10: backtest_trades — 回測逐筆交易明細
--
-- 一筆 = 一個 (run_id, symbol, entry_date) 的買進+持有+賣出組合。
-- run-backtest EF 在每輪 rebalance 後 batch insert top_n 筆。
--
-- entry_rank: 進場時 v_stock_rank.expected_rank(歷史視角下的排名)
--             供 attribution 分析:rank 1-3 vs 4-10 的勝率差?
-- is_benchmark: 標 benchmark trade(0050 同期),供 UI 區分

create table if not exists public.backtest_trades (
  id bigserial primary key,
  run_id uuid not null references public.backtest_runs(id) on delete cascade,
  symbol text not null,
  entry_date date not null,
  exit_date date not null,
  entry_price numeric(12, 4) not null,
  exit_price numeric(12, 4) not null,
  qty numeric(18, 4) not null default 1,
  return_pct numeric(10, 4) generated always as (
    case when entry_price > 0
      then ((exit_price - entry_price) / entry_price) * 100
    end
  ) stored,
  entry_rank int,
  is_benchmark boolean not null default false
);

create index if not exists idx_backtest_trades_run_entry on public.backtest_trades (run_id, entry_date);
create index if not exists idx_backtest_trades_symbol on public.backtest_trades (symbol);

comment on table public.backtest_trades is
  'M10 backtest 逐筆 trade。每輪 rebalance 寫入 top_n 筆 + benchmark 1 筆。';
comment on column public.backtest_trades.return_pct is
  'generated:(exit - entry) / entry × 100';
comment on column public.backtest_trades.entry_rank is
  'entry_date 那一刻 score_universe_at 算出的 expected_rank(歷史視角)';
comment on column public.backtest_trades.is_benchmark is
  'true = benchmark trade(預設 0050),不算進策略勝率';
