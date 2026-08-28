-- 資金流水 + 時間加權報酬(TWR)權益曲線(2026-08-28)
--
-- 背景:Andy 確認 2026-08 帳戶現金轉負(08-27 為 -88,201)是「加碼入金」而非融資。
-- 影響:`app_settings.initial_capital`(203,004)是單一常數,入金後分母就錯了 ——
--       原 v_account_equity_daily 報的 +129.95% 報酬與 -30.22% 最大回撤**兩個數字都是錯的**。
--
-- 為什麼要 TWR 而不是簡單報酬:有外部金流時,「賺多少 %」有兩種答案 ——
--   1. 簡單報酬 (equity - 投入本金) / 投入本金:回答「這筆錢總共變多少」,但入金會稀釋 %
--   2. TWR(時間加權):把每次金流當天中性化,回答「這套操作方法本身的績效」
-- 最大回撤**必須**用 TWR,否則入金當天權益跳升會被記成「創新高」→ 回撤失真。
-- 兩個都輸出,讓 /performance 各取所需。
--
-- 口徑對齊([[L67]]):TWR 日報酬 = (當日權益 - 當日淨流入) / 前一日權益 - 1。
-- 分子扣掉今天剛匯進來的錢,才是「操作賺到的」。
--
-- append-only([[L37]]):既有 8 個欄位的名稱 / 型別 / 順序完全不動,
-- `drawdown_pct` 保留舊的權益基準算法當**稽核錨點**(與 08-17 保留 dev_ma20_at_close 同一手法),
-- 正確的回撤是新欄 `twr_drawdown_pct`。/performance 改讀新欄。
--
-- ⚠ 誠實標記([[L45]]):在 Andy 補入 capital_flows 實際紀錄之前,cash 仍會是負的。
-- 新欄 `capital_incomplete` 標出這些日子,UI 必須據此拒絕顯示報酬率,而不是顯示一個錯的數字。

create table if not exists public.capital_flows (
  id         uuid primary key default gen_random_uuid(),
  flow_date  date not null,
  amount     numeric(14,2) not null check (amount > 0),
  flow_type  text not null check (flow_type in ('deposit','withdrawal')),
  note       text,
  created_at timestamptz not null default now()
);

comment on table public.capital_flows is
  '證券戶外部金流(入金/出金)。initial_capital 只是起點,之後每次加碼都要記在這裡,'
  '否則 v_account_equity_daily 的分母會錯。amount 一律填正數,方向由 flow_type 決定。';

create index if not exists capital_flows_date_idx on public.capital_flows (flow_date);

alter table public.capital_flows enable row level security;

create or replace view public.v_account_equity_daily as
with cap as (
  select coalesce(max(value), 0) * 10000 as base
  from public.app_settings
  where key = 'initial_capital'
),
grid as (
  select p.trade_date
  from public.price_daily p
  where p.symbol = '0050' and p.close > 0
    and p.trade_date >= (select min(txn_date) from public.holdings_transactions)
),
flow_day as (
  select g.trade_date,
    coalesce((select sum(case when cf.flow_type = 'deposit' then cf.amount else -cf.amount end)
              from public.capital_flows cf where cf.flow_date = g.trade_date), 0) as net_flow_today,
    coalesce((select sum(case when cf.flow_type = 'deposit' then cf.amount else -cf.amount end)
              from public.capital_flows cf where cf.flow_date <= g.trade_date), 0) as net_flow_cum
  from grid g
),
pos as (
  select g.trade_date, t.symbol,
    sum(case when t.txn_type = 'BUY' then t.qty else -t.qty end) as qty
  from grid g
  join public.holdings_transactions t on t.txn_date <= g.trade_date
  group by g.trade_date, t.symbol
  having sum(case when t.txn_type = 'BUY' then t.qty else -t.qty end) > 0
),
mtm as (
  select p.trade_date,
    count(*) as position_count,
    count(*) filter (where mk.close is null) as missing_marks,
    coalesce(sum(p.qty::numeric * mk.close), 0) as market_value
  from pos p
  left join lateral (
    select pp.close from public.price_daily pp
    where pp.symbol = p.symbol and pp.close > 0 and pp.trade_date <= p.trade_date
    order by pp.trade_date desc limit 1
  ) mk on true
  group by p.trade_date
),
daily as (
  select g.trade_date,
    (select base from cap) + fd.net_flow_cum
      + coalesce((select sum(case when t.txn_type = 'BUY'
                                  then (-(t.qty::numeric * t.price)) - coalesce(t.fee, 0)
                                  else t.qty::numeric * t.price - coalesce(t.fee, 0) - coalesce(t.tax, 0)
                             end)
                  from public.holdings_transactions t where t.txn_date <= g.trade_date), 0)
      + coalesce((select sum(d1.qty::numeric * (d1.sell_price - d1.buy_price)
                             - coalesce(d1.buy_fee, 0) - coalesce(d1.sell_fee, 0) - coalesce(d1.tax, 0))
                  from public.day_trades d1 where d1.trade_date <= g.trade_date), 0) as cash,
    fd.net_flow_today,
    fd.net_flow_cum,
    coalesce(m.market_value, 0) as market_value,
    coalesce(m.position_count, 0) as position_count,
    coalesce(m.missing_marks, 0) = 0 as coverage_ok
  from grid g
  left join mtm m on m.trade_date = g.trade_date
  join flow_day fd on fd.trade_date = g.trade_date
),
eq as (
  select d.*, (d.cash + d.market_value) as equity from daily d
),
-- TWR 只在 coverage_ok 的日子上鏈接(價格有洞的期間無法 MTM,不可硬算)
twr_base as (
  select e.trade_date, e.equity, e.net_flow_today,
    lag(e.equity) over (order by e.trade_date) as prev_equity
  from eq e
  where e.coverage_ok
),
twr_ret as (
  select t.trade_date,
    case when t.prev_equity is null then 0
         when t.prev_equity <= 0 then null
         else (t.equity - t.net_flow_today) / t.prev_equity - 1
    end as r
  from twr_base t
),
twr_idx as (
  select r.trade_date,
    exp(sum(ln(greatest(1 + coalesce(r.r, 0), 0.000001)))
        over (order by r.trade_date rows between unbounded preceding and current row)) as twr_index
  from twr_ret r
)
select
  e.trade_date,
  round(e.cash, 0)                                                as cash,
  round(e.market_value, 0)                                        as market_value,
  round(e.equity, 0)                                              as equity,
  e.position_count,
  e.coverage_ok,
  -- 舊欄位:權益基準的 peak / drawdown。有外部金流時**會失真**,保留純為稽核錨點
  round(greatest((select base from cap),
        max(e.equity) filter (where e.coverage_ok)
          over (order by e.trade_date rows between unbounded preceding and current row)), 0) as peak_equity,
  case when e.coverage_ok then
    round((e.equity / nullif(greatest((select base from cap),
          max(e.equity) filter (where e.coverage_ok)
            over (order by e.trade_date rows between unbounded preceding and current row)), 0) - 1) * 100, 2)
  end                                                             as drawdown_pct,
  -- 以下為 append(2026-08-28)
  round((select base from cap) + e.net_flow_cum, 0)               as contributed_capital,
  round(e.net_flow_today, 0)                                      as net_flow_today,
  round(ti.twr_index, 6)                                          as twr_index,
  round((ti.twr_index - 1) * 100, 2)                              as twr_return_pct,
  round((ti.twr_index / nullif(max(ti.twr_index)
          over (order by e.trade_date rows between unbounded preceding and current row), 0) - 1) * 100, 2)
                                                                  as twr_drawdown_pct,
  -- 現金為負 = 有未登錄的入金,此列所有報酬率不可引用
  (e.cash < 0)                                                    as capital_incomplete
from eq e
left join twr_idx ti on ti.trade_date = e.trade_date
order by e.trade_date;

comment on view public.v_account_equity_daily is
  '每日 MTM 權益。drawdown_pct 是舊的權益基準算法(有金流時失真,僅供稽核對照);'
  '正確回撤看 twr_drawdown_pct。capital_incomplete=true 代表現金為負 = 有入金沒登錄到 '
  'capital_flows,該列報酬率不可引用。';
