-- M9.2: 基本面 ROE 因子門檻放進 app_settings(從 hardcode 15% 改為可調)
--
-- 變動原因(2026-05-12,華新科 2492 案例):
--   被動元件業 ROE 天生低(4.7%),原 15% 門檻會排除大量轉機股。
--   分析師建議放寬到 8-10% 抓「ROE 已從谷底翻揚但還沒回到 15%」的標的。
--
-- 為什麼 10 不 8:
--   8% 太寬鬆,會把單純的低毛利公司(ROE 一直 5-8%)也算過 — 那不是轉機,是恆常低 ROE。
--   10% 是個合理 cut:轉機股翻揚通常會跨過 10% 一次,然後再衝 15%+。
--
-- 跟 M9.1 一樣:用 app_settings 不 hardcode,
--   未來 backtest 證明 8 / 10 / 12 哪個好,改 row 即可,view 不需 rebuild。

insert into public.app_settings (key, value, description) values
  ('roe_threshold', 10, '基本面 ROE 因子門檻(ROE > threshold% 才算過關;M9.1 原 15,M9.2 放寬到 10 抓轉機股)')
on conflict (key) do update
  set value = excluded.value,
      description = excluded.description;

comment on table public.app_settings is
  'app 級設定。手續費 / 證交稅(M8.5)+ factor PEG/權重(M9.1)+ ROE 門檻(M9.2)。';
