-- M8: industry_stocks 自動化準備
--
-- 加 metadata 欄位讓 Edge Function reselect-industry-stocks 寫入:
-- - market_cap_billion:用於排名(reselect 用)
-- - avg_20d_volume:用於排名(reselect 用)
-- - selected_at:這檔被選進來的時間,reselect 後會更新
-- - locked:true 代表手動鎖定,reselect 不會踢掉(預設 false)
--
-- 同時把 v2_score_rules 留下的 analyst_forecast_eps_growth_pct 欄位移除
-- (Andy 已棄用「法人預估」概念,改用 v_stock_score 內的「過去 4 季 EPS YoY 平均」估)

alter table public.industry_stocks
  add column if not exists market_cap_billion numeric(12,2);

alter table public.industry_stocks
  add column if not exists avg_20d_volume numeric(14,0);

alter table public.industry_stocks
  add column if not exists selected_at timestamptz not null default now();

alter table public.industry_stocks
  add column if not exists locked boolean not null default false;

-- 砍 analyst_forecast_eps_growth_pct 欄位(改成 v_stock_score 內動態算)
-- v_stock_score 還沒重建前先 drop column,因為它 reference 這欄
-- 用 CASCADE 把 dependent view 一併砍(下一個 migration 重建)
alter table public.industry_stocks
  drop column if exists analyst_forecast_eps_growth_pct cascade;

-- 確認 row count 在這個 migration 後不變(現有 99 檔)
-- reselect Edge Function 之後會把這 99 檔 row 全部 delete + 重新 insert 新清單

-- 鎖定既有 row(避免第一次 reselect cron 把這 99 檔誤踢)
-- 等 Andy 有觀察新清單品質再手動 unlock
update public.industry_stocks set locked = true where locked = false;
