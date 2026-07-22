-- 補題材分類 + 題材熱度榜(2026-07-22)
--
-- 起因:Andy 反映「AI概念/記憶體/IC載板漲幅很大卻無法靠前」。查證後發現兩件事:
--   ① 排名機制:不是動能因子壞掉,是 fund 40% 權重把題材股拉下來
--      (fund 7 項全是價值/品質指標,題材股與循環股反轉初期天生不合)。
--      Andy 拍板不動權重(避開 L36 OOS 閘),改為加短線視角。
--   ② 分類缺口:76/167 檔未分類,industry_stocks 只認 10 個靜態產業,
--      無 IC載板/矽晶圓/銅箔基板/塑化 —— 這些正是近期在動的族群。
--
-- 為什麼不改 reselect-industry-stocks EF:
--   該 EF 的 delete 是 `.eq("industry", X).eq("locked", false)`,且迴圈只跑
--   TARGET_INDUSTRIES 那 10 個 → 新題材不在清單內,月更 cron 根本不會碰。
--   再設 locked=true 雙重保險。純 SQL 即可,零 EF 改動、零 deploy,
--   完全避開 L49 中文誤植風險(EF 的 classifyIndustry 正是 L49 踩雷處)。
--
-- 名稱一律從 stock_names join 取得,migration 內只出現 ASCII 股號 → 零形近誤植風險。

-- ── 1. 補 4 個題材分類 ─────────────────────────────────────────────
insert into public.industry_stocks
  (industry, symbol, name, display_order, selected_at, locked)
select
  c.grp,
  c.symbol,
  n.name,
  row_number() over (partition by c.grp order by c.ord),
  now(),
  true
from (values
  -- IC 載板 / ABF
  ('IC載板',   '8046', 1),
  ('IC載板',   '3037', 2),
  ('IC載板',   '3189', 3),
  -- 銅箔基板 CCL
  ('銅箔基板', '2383', 1),
  ('銅箔基板', '6213', 2),
  ('銅箔基板', '6274', 3),
  -- 矽晶圓
  ('矽晶圓',   '6488', 1),
  ('矽晶圓',   '5483', 2),
  ('矽晶圓',   '6182', 3),
  ('矽晶圓',   '3532', 4),
  -- 塑化(台塑四寶)
  ('塑化',     '1301', 1),
  ('塑化',     '1303', 2),
  ('塑化',     '1326', 3),
  ('塑化',     '6505', 4)
) as c(grp, symbol, ord)
left join public.stock_names n on n.symbol = c.symbol
-- 冪等:同 (industry, symbol) 已存在就不重複插入
where not exists (
  select 1 from public.industry_stocks e
  where e.industry = c.grp and e.symbol = c.symbol
);


-- ── 2. 題材熱度榜 ──────────────────────────────────────────────────
-- 「資金輪到哪」:各題材成分股的近 5/20/60 日平均報酬 + 最強成分股。
-- 用中位數而非只看平均,避免單一暴衝股把整個題材拉高造成假熱度。
create or replace view public.v_industry_heat as
with joined as (
  select
    i.industry,
    r.symbol,
    r.ret_5d_pct,
    r.ret_20d_pct,
    r.ret_60d_pct,
    r.rsi14,
    r.off_high_60d_pct
  from public.industry_stocks i
  join public.v_stock_rank r on r.symbol = i.symbol
),
agg as (
  select
    industry,
    count(*)                                                          as n_stocks,
    round(avg(ret_5d_pct)::numeric, 2)                                as avg_ret_5d,
    round(avg(ret_20d_pct)::numeric, 2)                               as avg_ret_20d,
    round(avg(ret_60d_pct)::numeric, 2)                               as avg_ret_60d,
    round(percentile_cont(0.5) within group (order by ret_20d_pct)::numeric, 2) as med_ret_20d,
    round(avg(rsi14)::numeric, 1)                                     as avg_rsi,
    round(avg(off_high_60d_pct)::numeric, 1)                          as avg_off_high,
    count(*) filter (where ret_20d_pct > 0)                           as n_up_20d
  from joined
  where ret_20d_pct is not null
  group by industry
),
leader as (
  select distinct on (industry) industry, symbol as top_symbol, ret_20d_pct as top_ret_20d
  from joined
  where ret_20d_pct is not null
  order by industry, ret_20d_pct desc
)
select
  a.industry,
  a.n_stocks,
  a.avg_ret_5d,
  a.avg_ret_20d,
  a.med_ret_20d,
  a.avg_ret_60d,
  a.avg_rsi,
  a.avg_off_high,
  a.n_up_20d,
  l.top_symbol,
  l.top_ret_20d
from agg a
left join leader l on l.industry = a.industry;

comment on view public.v_industry_heat is
  '題材熱度:各產業成分股近 5/20/60 日平均與中位報酬、上漲家數、最強成分股。'
  '純價格統計,不是買賣訊號 —— 熱度高代表資金已經在裡面,不代表還會繼續。';

grant select on public.v_industry_heat to service_role;
