-- 市場體溫盤 v_market_temp — M10 Phase 1(2026-08-04)
--
-- 把 Andy 的五條擇時指標算成布林訊號 + 0-5 分。
--
-- ⚠️ 這是「未驗證的儀表板」,不是 gate。Phase 2 的 PIT 驗證(訊號日 → 後 5/10/20 日
-- 大盤報酬 vs 全樣本基準)通過之後,才決定哪幾條有資格影響決策。在那之前任何
-- 決策路徑(選股 / 買賣建議 / telegram)都不得引用本 view([[L41]] 華新科偽命題殷鑑)。
--
-- 為什麼是分數不是 AND 開關:五條同時成立一年只會出現 1-2 次,樣本少到驗不動,
-- 且訊號必然遲到。分數化才測得出「分數越高後續報酬越好」是否單調。
--
-- 缺料誠實化:每條訊號可為 null(該來源當日無資料),score 只計 true、
-- signals_available 計非 null。**不把「沒資料」偽裝成「訊號不成立」**([[L45]])。
--
-- 日期對齊:海外源(^SOX 前夜美股 / 韓股當日盤中快照)的 quoted_date 未必落在每個
-- 台股交易日(美股假日、韓股休市),故用 lateral 取「<= 該台股交易日的最新一筆」,
-- 承接最近一次可得的隔夜資訊,而不是留 null。

create or replace view public.v_market_temp as
with chips as (
  select
    trade_date,
    fut_foreign_oi_net,
    margin_balance_shares,
    margin_balance_amount,
    foreign_net_buy,
    lag(fut_foreign_oi_net,    5) over (order by trade_date) as fut_net_5d_ago,
    lag(margin_balance_shares, 5) over (order by trade_date) as margin_5d_ago
  from public.market_chips_daily
),
tsmc as (
  -- 台積電外資近 5 日(含當日)累計買賣超。foreign_net 口徑含 Foreign_Dealer_Self,
  -- 與 fetch-finmind-institutional 一致。
  select
    trade_date,
    sum(foreign_net) over (
      order by trade_date rows between 4 preceding and current row
    ) as tsmc_fgn_5d,
    count(*) over (
      order by trade_date rows between 4 preceding and current row
    ) as tsmc_5d_n
  from public.stock_institutional
  where symbol = '2330'
),
sox as (
  select
    quoted_date,
    last_price,
    lag(last_price, 5) over (order by quoted_date) as px_5d_ago
  from public.overseas_indicators
  where symbol = '^SOX'
),
kr as (
  select
    quoted_date,
    max(change_pct) filter (where symbol = '005930.KS') as samsung_pct,
    max(change_pct) filter (where symbol = '000660.KS') as hynix_pct
  from public.overseas_indicators
  where symbol in ('005930.KS', '000660.KS')
  group by quoted_date
),
base as (
  select
    c.trade_date,
    c.fut_foreign_oi_net,
    c.fut_net_5d_ago,
    c.margin_balance_shares,
    c.margin_5d_ago,
    c.margin_balance_amount,
    c.foreign_net_buy,
    t.tsmc_fgn_5d,
    t.tsmc_5d_n,
    sx.last_price  as sox_price,
    sx.px_5d_ago   as sox_5d_ago,
    k.samsung_pct,
    k.hynix_pct
  from chips c
  left join tsmc t on t.trade_date = c.trade_date
  left join lateral (
    select s.last_price, s.px_5d_ago
    from sox s where s.quoted_date <= c.trade_date
    order by s.quoted_date desc limit 1
  ) sx on true
  left join lateral (
    select k2.samsung_pct, k2.hynix_pct
    from kr k2 where k2.quoted_date <= c.trade_date
    order by k2.quoted_date desc limit 1
  ) k on true
),
sig as (
  select
    b.*,
    -- ① 外資台指期淨未平倉較 5 日前上升 = 空單回補 / 翻多方向
    case when b.fut_net_5d_ago is null then null
         else b.fut_foreign_oi_net > b.fut_net_5d_ago end            as sig_fut_covering,
    -- ② 台積電外資近 5 日累計不再賣超
    case when b.tsmc_fgn_5d is null or b.tsmc_5d_n < 5 then null
         else b.tsmc_fgn_5d >= 0 end                                 as sig_tsmc_foreign,
    -- ③ 全市場融資餘額較 5 日前下降 = 散戶槓桿在退
    case when b.margin_5d_ago is null then null
         else b.margin_balance_shares < b.margin_5d_ago end          as sig_margin_down,
    -- ④ 費半近 5 日上漲。⚠ 本系統實證:上檔買訊勝率僅約 48%,這條的真實效力
    --    Phase 2 才會知道;放進來是為了「可被驗證」,不是因為它已被證明有效。
    case when b.sox_5d_ago is null or b.sox_5d_ago <= 0 then null
         else b.sox_price > b.sox_5d_ago end                         as sig_sox_up,
    -- ⑤ 韓股記憶體雙雄未見急殺(-2% 為既有 overseas gate 已在用的門檻)。
    --    「熔斷」照字面做會是永不觸發的訊號,故轉譯成跌幅門檻。
    case when b.samsung_pct is null or b.hynix_pct is null then null
         else (b.samsung_pct > -2 and b.hynix_pct > -2) end           as sig_kr_stable
  from base b
)
select
  trade_date,
  sig_fut_covering,
  sig_tsmc_foreign,
  sig_margin_down,
  sig_sox_up,
  sig_kr_stable,
  (   (sig_fut_covering  is true)::int
    + (sig_tsmc_foreign  is true)::int
    + (sig_margin_down   is true)::int
    + (sig_sox_up        is true)::int
    + (sig_kr_stable     is true)::int )                              as score,
  (   (sig_fut_covering  is not null)::int
    + (sig_tsmc_foreign  is not null)::int
    + (sig_margin_down   is not null)::int
    + (sig_sox_up        is not null)::int
    + (sig_kr_stable     is not null)::int )                          as signals_available,
  -- 原始值(前端顯示 / Phase 2 分析用)
  fut_foreign_oi_net,
  fut_foreign_oi_net - fut_net_5d_ago                                 as fut_net_5d_chg,
  margin_balance_shares,
  margin_balance_shares - margin_5d_ago                               as margin_5d_chg,
  round(margin_balance_amount / 1e8, 1)                               as margin_amount_yi,
  round(foreign_net_buy / 1e8, 1)                                     as foreign_net_buy_yi,
  tsmc_fgn_5d,
  round(100.0 * (sox_price / nullif(sox_5d_ago, 0) - 1), 2)           as sox_5d_ret_pct,
  samsung_pct,
  hynix_pct
from sig;

comment on view public.v_market_temp is
  'M10 Phase 1 market-temperature dashboard: Andy five timing signals (foreign TX futures short covering, TSMC foreign net buy, market margin deleveraging, SOX 5d return, Korean memory not crashing) as booleans + 0-5 score. UNVALIDATED - display only. Phase 2 point-in-time test decides which signals earn a decision role. score counts only true; signals_available counts non-null so missing data is never disguised as a negative signal.';
