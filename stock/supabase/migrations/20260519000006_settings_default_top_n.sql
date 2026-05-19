-- M9.4a: default_top_n — /rank 預設精選檔數(可在 /settings 切 5/30)
--
-- 背景:回測證實 top5 集中度 2025 OOS alpha +24.19 vs top10 +13.80(誠實化 v2),
--   兩年一致勝 top10 約 +10pp、sharpe 更高、maxDD 不更差,非 overfit。
--   但受倖存者偏差 caveat(154 檔全 2026-05-12 selected,樂觀估計非可交易保證)。
-- 形式 A:加 setting 讓 /rank 可切預設精選檔數,預設留 30
--   (不強迫只看 5,倖存者偏差 caveat 下較穩健)。?focus= 仍可臨時覆寫。
--
-- updateSetting(app/settings/actions.ts)是 .update().eq("key") 非 upsert —
--   key 必須先存在,故此處 insert。
-- on conflict 只更新 description(刻意不覆蓋 value)— 保護 Andy 已切的值
--   不被 migration 重套打回 30(與 roe/budget 範本的 set value 不同,故意)。

insert into public.app_settings (key, value, description) values
  ('default_top_n', 30, '/rank 預設精選檔數(整數 5~50;Top 5 集中度 vs Top 30 全覽)。top5 集中度 2025 OOS alpha +24.19 vs top10 +13.80(誠實化 v2;含倖存者偏差 caveat,樂觀估計非保證)。?focus= 可臨時覆寫')
on conflict (key) do update
  set description = excluded.description;
