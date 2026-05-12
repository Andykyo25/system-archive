-- M10: backtest_runs — 回測任務元資料
--
-- 一筆 = 一次 backtest run。
-- - params: { start_date, end_date, rebalance_days, top_n, benchmark_symbol, weight_strategy }
-- - summary: { win_rate, total_return_pct, annual_return_pct, max_drawdown_pct, sharpe,
--              alpha_vs_benchmark, benchmark_return_pct, n_trades, n_rebalances, reason? }
-- - status: running / finished / failed
--
-- run-backtest EF:
--   1. INSERT row(status=running, started_at=now())
--   2. walk-forward 跑完
--   3. UPDATE summary + status=finished + finished_at=now()
--   失敗時 status=failed,summary.reason 寫原因(insufficient_data / api_error / etc)

create table if not exists public.backtest_runs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  params jsonb not null,
  summary jsonb,
  status text not null default 'running' check (status in ('running', 'finished', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists idx_backtest_runs_created on public.backtest_runs (created_at desc);
create index if not exists idx_backtest_runs_status on public.backtest_runs (status);

comment on table public.backtest_runs is
  'M10 回測任務 metadata。一筆 = 一次 walk-forward backtest。params/summary 為 jsonb。';
comment on column public.backtest_runs.params is
  'JSON: { start_date, end_date, rebalance_days, top_n, benchmark_symbol, weight_strategy }';
comment on column public.backtest_runs.summary is
  'JSON: { win_rate, total_return_pct, annual_return_pct, max_drawdown_pct, sharpe, alpha_vs_benchmark, benchmark_return_pct, n_trades, n_rebalances, reason? }';
