-- M9.3+: v_holdings_advice — 持股動態建議 view
--
-- 每筆持股 1 row,包含:
--   - 基本(symbol, lots = net_qty/1000, avg_cost, current_price, pct_change)
--   - 5 個價位 threshold(stop_loss -10% / add -5% / obs1 +20% / obs2 +30% / force_out +40%)
--   - 動態 factor pass-through(rsi14, fund/mom count, is_entry_signal, signal_strength 等)
--
-- 為什麼 view 不算 status / advice text:
--   UI 端 derive 更彈性 — 改 status 邏輯 / 翻譯 / icon / 顏色 都不需 rebuild view
--   Andy 風格(整張為單位、單張用觀察點)直接寫 component 邏輯

create or replace view public.v_holdings_advice as
select
  c.symbol,
  c.net_qty,
  c.avg_cost,
  (c.net_qty / 1000)::int as lots,
  lp.current_price,
  lp.as_of_ts,
  lp.source as price_source,
  lp.market_state,
  case when lp.current_price is not null and c.avg_cost > 0
    then ((lp.current_price - c.avg_cost) / c.avg_cost) * 100
  end as pct_change,
  case when lp.current_price is not null
    then (lp.current_price - c.avg_cost) * c.net_qty
  end as unrealized_pnl,
  (c.avg_cost * 0.90)::numeric(12,2) as stop_loss_price,
  (c.avg_cost * 0.95)::numeric(12,2) as add_position_price,
  (c.avg_cost * 1.20)::numeric(12,2) as obs1_price,
  (c.avg_cost * 1.30)::numeric(12,2) as obs2_price,
  (c.avg_cost * 1.40)::numeric(12,2) as force_out_price,
  r.expected_rank,
  r.weighted_score,
  r.fund_count_pos,
  r.fund_count_total,
  r.mom_count_pos,
  r.mom_count_total,
  r.chip_count_pos,
  r.chip_count_total,
  r.rsi14,
  r.fund_rev_yoy,
  r.mom_above_ma200,
  s.is_entry_signal,
  s.signal_strength
from public.v_holdings_current c
left join public.v_latest_price_realtime lp on lp.symbol = c.symbol
left join public.v_stock_rank r on r.symbol = c.symbol
left join public.v_entry_signal s on s.symbol = c.symbol;

comment on view public.v_holdings_advice is
  'M9.3+ 持股動態建議:每筆 1 row,5 個價位 threshold + factor pass-through。
   status / advice text 在 UI 端 derive(彈性)。/holdings 頁讀此 view 即時 reflect。';
