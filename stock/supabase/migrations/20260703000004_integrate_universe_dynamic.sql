-- B-3(2026-07-03):universe_dynamic 整合進 rank 鏈 + score_universe_at PIT gate
--
-- 兩處同步(L32:線上 view 與回測 function 必須一起改):
--   1. v_price_factors universe CTE + universe_dynamic(active)
--      → mv_factor_scores(cron refresh)→ v_factor_scores/v_stock_rank/v_entry_signal/
--        v_entry_quality 全下游自動涵蓋。動態股 chip/fund 未到料時 v_factor_scores
--        缺維 reallocate(L23 既有),到料自動升級。
--   2. score_universe_at + universe_dynamic 的 **PIT gate**:
--      `added_at <= as_of_date and (deactivated_at is null or deactivated_at > as_of_date)`
--      沒有這個 gate = 把今天的熱股灌進歷史回測 = L48 事後選擇偏誤。
--      這同時開始累積 L38 要的 point-in-time universe 快照(added_at/deactivated_at)。
--
-- 實作方式:pg_get_viewdef / pg_get_functiondef + 字串替換 + execute(機械改寫,
--   L49 精神 — 不手抄 200+ 行 SQL;替換目標已前置驗證各恰出現 1 次)。
--   idempotent:已含 universe_dynamic 就跳過。
--
-- 迴歸驗證(apply 後必查,L39 錨點):
--   score_universe_at('2025-06-30') / ('2024-06-28') 輸出 md5 必須與改動前一致
--   (基準:fp_2025=b5b26e8255b987504f10d8c6b39de2ad,fp_2024=0ba8e554da7e410be0706cd6a1695e79)
--   — 因 dynamic 股 added_at=2026-07-03 全在歷史時點之後,PIT gate 應使其零影響。
--
-- rollback:反向 replace(把 union universe_dynamic 段拿掉)re-execute,或 restore
--   舊 migration 的 view/function 定義。

do $$
declare
  src text;
begin
  -- 1) v_price_factors:universe_symbols CTE 加 active dynamic
  src := pg_get_viewdef('public.v_price_factors');
  if position('universe_dynamic' in src) = 0 then
    src := replace(
      src,
      'FROM etf_metadata',
      'FROM etf_metadata UNION SELECT universe_dynamic.symbol FROM universe_dynamic WHERE universe_dynamic.active'
    );
    execute 'create or replace view public.v_price_factors as ' || src;
  end if;

  -- 2) score_universe_at:PIT-gated dynamic universe
  src := pg_get_functiondef('public.score_universe_at(date)'::regprocedure);
  if position('universe_dynamic' in src) = 0 then
    src := replace(
      src,
      'select symbol from public.etf_metadata',
      'select symbol from public.etf_metadata
  union
  select symbol from public.universe_dynamic
  where added_at <= as_of_date
    and (deactivated_at is null or deactivated_at > as_of_date)'
    );
    execute src;
  end if;
end $$;
