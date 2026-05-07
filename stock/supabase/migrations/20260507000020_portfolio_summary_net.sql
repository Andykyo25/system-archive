-- v_portfolio_summary 加 net 欄位(扣手續費 + 證交稅)
-- 因為 v_portfolio_summary 改成 base 從 v_holdings_full(內含 net 計算)

drop view if exists public.v_portfolio_summary cascade;

create view public.v_portfolio_summary as
select
  count(*) as positions,
  -- 毛(沒扣費用,給對照用)
  coalesce(sum(cost_basis), 0) as total_cost,
  coalesce(sum(market_value), 0) as total_value,
  coalesce(sum(unrealized_pnl), 0) as total_pnl,
  case when coalesce(sum(cost_basis), 0) > 0
    then sum(unrealized_pnl) / sum(cost_basis) * 100 else 0
  end as total_pct,
  -- 淨(扣手續費 + 證交稅)
  coalesce(sum(total_cost_with_fee), 0) as net_total_cost,
  coalesce(sum(net_proceeds_if_sold_now), 0) as net_total_value,
  coalesce(sum(net_pnl_est), 0) as net_total_pnl,
  case when coalesce(sum(total_cost_with_fee), 0) > 0
    then sum(net_pnl_est) / sum(total_cost_with_fee) * 100 else 0
  end as net_total_pct
from public.v_holdings_full
where current_price is not null;
