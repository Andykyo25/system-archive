-- M8: 擴股池到 ~200 檔(MSCI Taiwan + 大型成分股 + holdings/watchlist auto-merge)
--
-- 為什麼用獨立表而不直接擴 industry_stocks:
-- - industry_stocks 仍是「10 產業 × 10 檔」結構(自動重選)
-- - stock_universe 是「fetcher 全餵」對象,不限產業歸屬,更大池子
-- - fetcher targetSymbols 改成多表 union(holdings ∪ watchlist ∪ industry_stocks ∪ etf_metadata ∪ stock_universe)
--
-- universe ~200 檔來源:
-- - TWSE 上市市值前 ~150(2026 Q1 排序)
-- - TPEX 上櫃前 ~30
-- - MSCI Taiwan 成分股(2026 半年度)中沒在前面的補進
-- 維護:Edge Function reselect-industry-stocks 月底順便重新評估這個表(staleness > 30 天就重新計算)

create table if not exists public.stock_universe (
  symbol text primary key,
  name text,
  market text,                       -- 'twse' / 'tpex'
  industry_category text,            -- FinMind TaiwanStockInfo 的 industry_category
  market_cap_billion numeric(12,2),  -- 約略市值(億 NTD,可選填,reselect-industry-stocks 會更新)
  avg_20d_volume numeric(14,0),      -- 20 日平均成交量(股,可選填)
  selected_at timestamptz not null default now(),
  source text not null default 'seed' -- 'seed' / 'auto' / 'manual'
);
create index if not exists idx_universe_market on public.stock_universe (market);
create index if not exists idx_universe_industry on public.stock_universe (industry_category);
alter table public.stock_universe enable row level security;

-- Seed:~200 檔大盤 + MSCI Taiwan + 各產業中流動性高個股
-- 來源:作者依 2026 Q1 觀察值列(現有 industry_stocks 99 + 額外 ~100)
-- 後續 reselect-industry-stocks EF 月底會自動補/汰
insert into public.stock_universe (symbol, name, market, source) values
  -- 半導體(完整鏈)
  ('2330','台積電','twse','seed'),
  ('2454','聯發科','twse','seed'),
  ('2379','瑞昱','twse','seed'),
  ('3034','聯詠','twse','seed'),
  ('3443','創意','twse','seed'),
  ('3035','智原','twse','seed'),
  ('3661','世芯-KY','twse','seed'),
  ('6643','M31','tpex','seed'),
  ('8016','矽創','twse','seed'),
  ('5274','信驊','tpex','seed'),
  ('4966','譜瑞-KY','twse','seed'),
  ('3711','日月光投控','twse','seed'),
  ('2449','京元電子','twse','seed'),
  ('6239','力成','twse','seed'),
  ('6271','同欣電','twse','seed'),
  ('8150','南茂','twse','seed'),
  ('8110','華東','twse','seed'),
  ('6451','訊芯-KY','twse','seed'),
  ('6257','矽格','twse','seed'),
  ('3583','辛耘','twse','seed'),
  ('3131','弘塑','tpex','seed'),
  ('2303','聯電','twse','seed'),
  ('2347','聯強','twse','seed'),
  ('2308','台達電','twse','seed'),
  ('2474','可成','twse','seed'),
  ('2408','南亞科','twse','seed'),
  ('2337','旺宏','twse','seed'),
  ('2344','華邦電','twse','seed'),
  ('6770','力積電','twse','seed'),
  ('8299','群聯','tpex','seed'),
  ('5351','鈺創','tpex','seed'),
  ('3006','晶豪科','twse','seed'),
  ('3260','威剛','twse','seed'),
  ('2451','創見','twse','seed'),
  ('8271','宇瞻','twse','seed'),
  -- 被動元件
  ('2327','國巨','twse','seed'),
  ('2492','華新科','twse','seed'),
  ('2456','奇力新','twse','seed'),
  ('2472','立隆電','twse','seed'),
  ('3068','美磊','twse','seed'),
  ('2428','興勤','twse','seed'),
  ('2422','乾坤','twse','seed'),
  ('2478','大毅','twse','seed'),
  ('3527','麗智','twse','seed'),
  ('3622','洋華','twse','seed'),
  -- AI 伺服器 / 系統廠 / EMS
  ('2382','廣達','twse','seed'),
  ('3231','緯創','twse','seed'),
  ('6669','緯穎','twse','seed'),
  ('2317','鴻海','twse','seed'),
  ('2356','英業達','twse','seed'),
  ('2324','仁寶','twse','seed'),
  ('2376','技嘉','twse','seed'),
  ('2357','華碩','twse','seed'),
  ('2345','智邦','twse','seed'),
  ('2377','微星','twse','seed'),
  ('3017','奇鋐','twse','seed'),
  ('3653','健策','twse','seed'),
  ('2383','台光電','twse','seed'),
  ('6213','聯茂','twse','seed'),
  ('5269','祥碩','twse','seed'),
  -- 車用 EV
  ('3023','信邦','twse','seed'),
  ('8255','朋程','twse','seed'),
  ('3252','為昇科','twse','seed'),
  ('2497','怡利電','twse','seed'),
  ('3552','同致','twse','seed'),
  ('3003','健和興','twse','seed'),
  ('6412','群電','twse','seed'),
  ('4915','致伸','twse','seed'),
  ('2227','裕日車','twse','seed'),
  -- 面板 / 顯示
  ('2409','友達','twse','seed'),
  ('3481','群創','twse','seed'),
  ('6116','彩晶','twse','seed'),
  ('8069','元太','tpex','seed'),
  ('3714','富采','twse','seed'),
  ('6120','達運','tpex','seed'),
  ('3450','聯鈞','twse','seed'),
  ('2371','大同','twse','seed'),
  ('8105','凌巨','twse','seed'),
  ('3673','TPK-KY','twse','seed'),
  -- 航運
  ('2603','長榮','twse','seed'),
  ('2609','陽明','twse','seed'),
  ('2615','萬海','twse','seed'),
  ('2637','慧洋-KY','twse','seed'),
  ('2606','裕民','twse','seed'),
  ('2605','新興','twse','seed'),
  ('5608','四維航','twse','seed'),
  ('2612','中航','twse','seed'),
  ('2617','台航','twse','seed'),
  ('2618','長榮航','twse','seed'),
  ('2610','華航','twse','seed'),
  -- 生技醫療
  ('8436','大江','tpex','seed'),
  ('6472','保瑞','tpex','seed'),
  ('1795','美時','twse','seed'),
  ('1707','葡萄王','twse','seed'),
  ('4128','中天','tpex','seed'),
  ('4162','智擎','tpex','seed'),
  ('6535','順藥','tpex','seed'),
  ('1734','杏輝','twse','seed'),
  ('3705','永信','twse','seed'),
  ('4175','杏一','tpex','seed'),
  ('4754','國光生','twse','seed'),
  ('6446','藥華藥','twse','seed'),
  -- 金融
  ('2882','國泰金','twse','seed'),
  ('2881','富邦金','twse','seed'),
  ('2891','中信金','twse','seed'),
  ('2884','玉山金','twse','seed'),
  ('2886','兆豐金','twse','seed'),
  ('2892','第一金','twse','seed'),
  ('2885','元大金','twse','seed'),
  ('2883','開發金','twse','seed'),
  ('2890','永豐金','twse','seed'),
  ('5880','合庫金','twse','seed'),
  ('2887','台新金','twse','seed'),
  ('2888','新光金','twse','seed'),
  ('2880','華南金','twse','seed'),
  ('2867','三商壽','twse','seed'),
  -- 食品 / 民生
  ('1216','統一','twse','seed'),
  ('1301','台塑','twse','seed'),
  ('1303','南亞','twse','seed'),
  ('1326','台化','twse','seed'),
  ('6505','台塑化','twse','seed'),
  ('2207','和泰車','twse','seed'),
  ('1101','台泥','twse','seed'),
  ('1102','亞泥','twse','seed'),
  ('9904','寶成','twse','seed'),
  ('9921','巨大','twse','seed'),
  ('9914','美利達','twse','seed'),
  ('2912','統一超','twse','seed'),
  ('2915','潤泰全','twse','seed'),
  -- 電信 / 公用
  ('2412','中華電','twse','seed'),
  ('3045','台灣大','twse','seed'),
  ('4904','遠傳','twse','seed'),
  ('9917','中保科','twse','seed'),
  -- 鋼鐵 / 工業
  ('2002','中鋼','twse','seed'),
  ('2014','中鴻','twse','seed'),
  ('1722','台肥','twse','seed'),
  ('2105','正新','twse','seed'),
  ('1504','東元','twse','seed'),
  ('2049','上銀','twse','seed'),
  ('1605','華新','twse','seed'),
  ('1517','利奇','twse','seed'),
  -- 重電 / 散熱 / 電源
  ('2301','光寶科','twse','seed'),
  ('2360','致茂','twse','seed'),
  ('2393','億光','twse','seed'),
  -- ICT 系統 / 通路 / 軟體
  ('2353','宏碁','twse','seed'),
  ('2352','佳世達','twse','seed'),
  ('6230','超眾','twse','seed'),
  ('3596','智易','twse','seed'),
  ('2330','台積電','twse','seed')  -- 落地佔位,on conflict 會去重
on conflict (symbol) do nothing;
