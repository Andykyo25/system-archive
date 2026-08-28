-- 產業排除清單搬出 view → industry_policy 表(2026-08-28)
--
-- ⚠ 先講清楚:**清單內容一個字都不改**。本次分析實測,排除傳產/金融在目前樣本裡是**有效的**:
--   被排除的傳產/金融 passes_all 5 日超額 −0.24%,保留的電子/生技 +2.06%
-- 所以這支 migration 改的是**形式**,不是內容。行為必須完全等價。
--
-- 要改形式的理由(這是真的會咬人的脆弱點):
-- 清單是**硬寫在 view 裡的 30+ 個中文字串比對**,而且已經因為 TWSE / TPEX 兩套命名
-- 而被迫同時列出變體:`農業科技`/`農業科技業`、`金融保險`/`金融業`、
-- `居家生活`/`居家生活類`、`運動休閒`/`運動休閒類`。
-- **保留側**同樣有變體(`綠能環保`/`綠能環保類`、`數位雲端`/`數位雲端類`、
-- `其他電子類`/`其他電子業`)。
-- → 只要上游新增或改一個產業別名稱,它就會**靜默進入掃描池**,沒有任何告警。
-- 這正是 [[L42]]/[[L46]]/[[L55]] 那一族的沉默 drift。
--
-- 設計:`industry_policy` 收**全部**產業別(不只被排除的),每一列標 excluded true/false。
-- 這樣「沒被分類過的新產業別」才有辦法被偵測 —— 只列排除清單的話,新名稱長什麼樣
-- 永遠不知道(對照 [[L65]]:沒有期望清單,「壞掉」跟「不存在」長得一樣)。
--
-- 種子資料**用機械方式從線上 view 定義萃取**,不手打中文([[L51]] 手打中文會壞)。
--
-- rollback:重跑 20260806000002_v_breakout_scan_scored.sql(view 回硬編碼版),
--           再 drop table public.industry_policy cascade;

create table if not exists public.industry_policy (
  industry text primary key,
  excluded boolean not null,
  note     text,
  added_at timestamptz not null default now()
);

comment on table public.industry_policy is
  '產業別政策。excluded=true 的不進 v_breakout_scan 掃描池。'
  '收錄全部產業別(不只排除的),才能偵測「上游新增了一個沒被分類過的產業別」。';

alter table public.industry_policy enable row level security;

-- 1) 從線上 view 定義萃取現行排除清單(零手打)
insert into public.industry_policy (industry, excluded, note)
select distinct trim(both '''' from replace(e, '::text', '')), true,
       'seeded from v_breakout_scan 2026-08-28'
from unnest(string_to_array(
  substring(pg_get_viewdef('public.v_breakout_scan'::regclass, true) from 'ARRAY\[([^\]]*)\]'),
  ', ')) as e
where e is not null and e <> ''
on conflict (industry) do nothing;

-- 2) 其餘出現在 stock_industry 的產業別一律標為保留
insert into public.industry_policy (industry, excluded, note)
select distinct si.industry_category, false, 'seeded from stock_industry 2026-08-28'
from public.stock_industry si
where si.industry_category is not null
on conflict (industry) do nothing;

-- 3) view 改讀表。只換那一段 ARRAY 比對,其餘一字不動;沒命中就 raise 中止
do $$
declare def text; newdef text;
begin
  select pg_get_viewdef('public.v_breakout_scan'::regclass, true) into def;

  newdef := regexp_replace(def,
    'si\.industry_category <> ALL \(ARRAY\[[^\]]*\]\)',
    'si.industry_category NOT IN (SELECT ip.industry FROM public.industry_policy ip WHERE ip.excluded)');

  if newdef = def then
    raise exception 'v_breakout_scan 產業排除清單沒有被替換到 — 線上定義與預期不符,中止';
  end if;

  execute 'create or replace view public.v_breakout_scan as ' || newdef;
end $$;

-- 4) 未分類產業別偵測。上游冒出新名稱時這裡會有列,可以掛進 /health
create or replace view public.v_industry_unclassified as
select si.industry_category as industry,
       count(*) as symbol_count,
       min(si.symbol) as sample_symbol
from public.stock_industry si
where si.industry_category is not null
  and not exists (
    select 1 from public.industry_policy ip where ip.industry = si.industry_category)
group by si.industry_category
order by count(*) desc;

comment on view public.v_industry_unclassified is
  '出現在 stock_industry 但沒有在 industry_policy 分類過的產業別。'
  '有列 = 上游新增或改名了產業別,而它正在靜默進入掃描池,需要人決定排除或保留。';
