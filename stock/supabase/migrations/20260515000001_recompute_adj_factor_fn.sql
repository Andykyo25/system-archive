-- Phase 0.3:back-adjust 還原係數計算函式(2026-05-15 已 apply DB via MCP migration 78)
--
-- adj_factor(symbol, trade_date) = Π(ratio for stock_corporate_action
--   where symbol 同 AND action_date > trade_date)
-- 嚴格 >:FinMind 慣例 action 日當天 close 已是 after_price(調整後),
--   只有 action 日「之前」的歷史價要乘 ratio 往下調讓序列連續。
--   最近價格(無更晚 action)→ factor=1.0(不調)。
-- 連乘積用 exp(sum(ln(ratio))),ratio 恆 > 0(價格皆正)。
-- p_symbol=null → 全 universe;給 symbol → 單檔(測試 / 單股 recompute)。
--
-- ⚠ 維護:日後 corporate_action backfill 抓到新除權息/分割後,
--   必須重跑 recompute_adj_factor()(全量或單股),否則 adj_factor 過時。
--   (Phase 0 收尾待辦:corporate_action backfill 後自動觸發 recompute)
--
-- 驗證(2026-05-15):0050 split 2025-06-18 前後 adj_close 連續無斷崖
--   (198→47 假性-76% 還原成 47.82→46.58 平滑);2492 dividend 同樣連續;
--   154 syms 有調整、invalid=0;線上 v_stock_rank 不受影響(0.5 才接 adj)。

create or replace function public.recompute_adj_factor(p_symbol text default null)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  with factors as (
    select
      pd.symbol,
      pd.trade_date,
      coalesce((
        select exp(sum(ln(ca.ratio)))
        from public.stock_corporate_action ca
        where ca.symbol = pd.symbol
          and ca.action_date > pd.trade_date
          and ca.ratio > 0
      ), 1.0) as new_factor
    from public.price_daily pd
    where p_symbol is null or pd.symbol = p_symbol
  )
  update public.price_daily pd
  set adj_factor = f.new_factor
  from factors f
  where pd.symbol = f.symbol
    and pd.trade_date = f.trade_date
    and pd.adj_factor is distinct from f.new_factor;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.recompute_adj_factor(text) is
  'Phase 0.3 back-adjust:依 stock_corporate_action 往回累乘算 price_daily.adj_factor。新 corporate action 進來後須重跑(全量或單股)。';
