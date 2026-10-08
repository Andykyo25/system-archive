-- Daily reconciliation of the broker's settlement figures (broker_settlement, written by the
-- broker-sync worker from querySettlement('3d')) against the system's own trade records
-- (holdings_transactions + day_trades).
--
-- One row per query day that exists in broker_settlement (the broker side drives; days the
-- worker never fetched cannot be compared and do not appear). All *_diff columns are
-- system minus broker.
--
--   match              values equal; fees and tax within 1 TWD per trade leg (rounding)
--   pending            snapshot fetched before 14:00 Taipei on that day, so it may be incomplete
--                      (avoids false alarms for trades recorded earlier the same day)
--   missing_in_system  broker has trades that day, the system has none
--   missing_at_broker  the system has trades that day, the broker has none
--   value_diff         buy or sell amount differs (missing / extra / wrong price or quantity)
--   tax_diff           sell tax differs beyond rounding (e.g. day-trade half tax not recorded)
--   fee_diff           brokerage fee differs beyond rounding
--
-- A day trade (day_trades row) counts as two legs. Margin / short interest and collateral
-- flows are not modelled. Access: service_role only (views bypass RLS, so a default grant
-- would expose trades through the public anon key).
--
-- Rollback:  drop view public.v_broker_settlement_recon;

create or replace view public.v_broker_settlement_recon as
with b as (
  select s.query_date as trade_date,
         max(s.settlement_date) as settlement_date,
         coalesce(sum(s.buy_value), 0) as buy_value,
         coalesce(sum(s.buy_fee), 0) as buy_fee,
         coalesce(sum(s.sell_value), 0) as sell_value,
         coalesce(sum(s.sell_fee), 0) as sell_fee,
         coalesce(sum(s.sell_tax), 0) as sell_tax,
         coalesce(sum(s.total_settlement_amount), 0) as net_settlement,
         max(s.fetched_at) as fetched_at
  from public.broker_settlement s
  group by s.query_date
),
sys_rows as (
  select t.txn_date as trade_date,
         case when t.txn_type = 'BUY' then t.qty * t.price else 0 end as buy_value,
         case when t.txn_type = 'BUY' then coalesce(t.fee, 0) else 0 end as buy_fee,
         case when t.txn_type = 'SELL' then t.qty * t.price else 0 end as sell_value,
         case when t.txn_type = 'SELL' then coalesce(t.fee, 0) else 0 end as sell_fee,
         case when t.txn_type = 'SELL' then coalesce(t.tax, 0) else 0 end as sell_tax,
         1 as legs
  from public.holdings_transactions t
  union all
  select d.trade_date, d.qty * d.buy_price, d.buy_fee, d.qty * d.sell_price, d.sell_fee, d.tax, 2
  from public.day_trades d
),
sys as (
  select trade_date,
         sum(buy_value) as buy_value,
         sum(buy_fee) as buy_fee,
         sum(sell_value) as sell_value,
         sum(sell_fee) as sell_fee,
         sum(sell_tax) as sell_tax,
         sum(legs)::integer as legs
  from sys_rows
  group by trade_date
),
j as (
  select b.trade_date,
         b.settlement_date,
         b.fetched_at,
         b.buy_value as b_buy_value,
         b.buy_fee as b_buy_fee,
         b.sell_value as b_sell_value,
         b.sell_fee as b_sell_fee,
         b.sell_tax as b_sell_tax,
         b.net_settlement as b_net,
         coalesce(s.buy_value, 0) as s_buy_value,
         coalesce(s.buy_fee, 0) as s_buy_fee,
         coalesce(s.sell_value, 0) as s_sell_value,
         coalesce(s.sell_fee, 0) as s_sell_fee,
         coalesce(s.sell_tax, 0) as s_sell_tax,
         coalesce(s.legs, 0) as legs
  from b
  left join sys s on s.trade_date = b.trade_date
)
select trade_date,
       settlement_date,
       b_buy_value as broker_buy_value,
       s_buy_value as system_buy_value,
       s_buy_value - b_buy_value as buy_value_diff,
       b_sell_value as broker_sell_value,
       s_sell_value as system_sell_value,
       s_sell_value - b_sell_value as sell_value_diff,
       b_buy_fee as broker_buy_fee,
       s_buy_fee as system_buy_fee,
       s_buy_fee - b_buy_fee as buy_fee_diff,
       b_sell_fee as broker_sell_fee,
       s_sell_fee as system_sell_fee,
       s_sell_fee - b_sell_fee as sell_fee_diff,
       b_sell_tax as broker_sell_tax,
       s_sell_tax as system_sell_tax,
       s_sell_tax - b_sell_tax as sell_tax_diff,
       b_net as broker_net_settlement,
       (s_sell_value - s_sell_fee - s_sell_tax - s_buy_value - s_buy_fee) as system_net_settlement,
       (s_sell_value - s_sell_fee - s_sell_tax - s_buy_value - s_buy_fee) - b_net as net_diff,
       case
         when s_buy_value = b_buy_value
              and s_sell_value = b_sell_value
              and abs(s_buy_fee - b_buy_fee) <= legs
              and abs(s_sell_fee - b_sell_fee) <= legs
              and abs(s_sell_tax - b_sell_tax) <= legs then 'match'
         when fetched_at < ((trade_date + time '14:00') at time zone 'Asia/Taipei') then 'pending'
         when legs = 0 then 'missing_in_system'
         when b_buy_value = 0 and b_sell_value = 0 then 'missing_at_broker'
         when s_buy_value <> b_buy_value or s_sell_value <> b_sell_value then 'value_diff'
         when abs(s_sell_tax - b_sell_tax) > legs then 'tax_diff'
         else 'fee_diff'
       end as status,
       fetched_at as snapshot_fetched_at
from j;

revoke all on public.v_broker_settlement_recon from anon, authenticated;
grant select on public.v_broker_settlement_recon to service_role;
