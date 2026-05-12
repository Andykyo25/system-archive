-- M8.5: 把現有 holdings rows 轉成 BUY transactions
--
-- 每筆 holdings row 對應一筆 BUY:
-- - qty = holdings.qty
-- - price = holdings.avg_cost(因為 avg_cost 是「不含手續費的成交價」,見 migration 19 註解)
-- - txn_date = holdings.opened_at
-- - fee = 0 / tax = 0(歷史資料用毛成本搬遷,新交易才會被計費)
-- - note = '從 holdings 搬遷' + 原 note
--
-- holdings 表「保留但棄用」:
-- - 後續 view 不再依賴它,DELETE/INSERT 之類都改走 transaction log
-- - 不立刻 drop 是為了萬一搬遷有問題可以回看資料
-- - 之後可以另起 migration 砍掉

insert into public.holdings_transactions (
  symbol, txn_type, qty, price, fee, tax, txn_date, note, created_at
)
select
  symbol,
  'BUY',
  qty,
  avg_cost,
  0,
  0,
  opened_at,
  case
    when note is null or note = '' then '從 holdings 搬遷'
    else '從 holdings 搬遷 · ' || note
  end,
  created_at
from public.holdings
where closed_at is null;
