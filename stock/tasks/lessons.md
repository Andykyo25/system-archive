# Lessons Learned

> 每次被使用者糾正後,把該模式寫進這裡。每次開新 session 先翻這份。
> 格式:**問題模式** → **正確做法** → **為什麼**(必要時加日期/出處)

---

## 來自上個版本(系統重啟前)的核心教訓

### L01 — 不能掃全市場
**問題**:上個版本想處理全市場 → API quota 爆 / 被 rate limit / 資料不準
**做法**:這個版本只處理 `holdings ∪ watchlist`(< 30 檔),從架構上把資料量壓死
**為什麼**:免費 API 的 quota 撐不住全市場日 fetch

### L02 — 不可在 user-facing path 做外部 API 呼叫
**問題**:即時取數讓使用者看到 API 失敗 / 跳價 / 慢
**做法**:user 路徑只讀 Supabase,所有外部 fetch 都在排程裡完成
**為什麼**:user 體驗與 API 穩定性必須解耦

### L03 — Source 切換不可造成價格跳動
**問題**:多 source fallback 時,使用者會看到同一檔同一天價格在不同 source 之間跳
**做法**:Primary-Lock + Provisional Fill + Reconciliation
- 主力寫入後 lock,備案只能 fill 空缺且標記 `is_provisional`
- 主力恢復後 reconcile,所有變更進 `reconcile_audit`
**為什麼**:資料準確性 > 完整性。寧可標記「待確認」也不要呈現不一致數字

---

## M2 接 TWSE/TPEX 主力資料源實做後

### L04 — TWSE / TPEX 免費 OpenAPI 關鍵欄位差異
**摘要**:
- TWSE `/v1/exchangeReport/STOCK_DAY_ALL` ~1350 檔(含 ETF / 特別股)。欄位 `Code`、`OpeningPrice`、`HighestPrice`、`LowestPrice`、`ClosingPrice`、`TradeVolume`
- TPEX `/openapi/v1/tpex_mainboard_daily_close_quotes` ~5700+ 筆(含權證)。欄位 `SecuritiesCompanyCode`、`Open`、`High`、`Low`、`Close`、`TradingShares`
- 兩家 `Date` 都是民國年 7 碼字串(`1150506` = 2026-05-06),需轉 ISO
**做法**:Edge Function 內各自有 `parseTWSE` / `parseTPEX`,輸出 normalized `PriceRow`

### L05 — Edge Function 認證:不要拿 SUPABASE_SERVICE_ROLE_KEY env 直接比對 Authorization header
**問題**:`req.headers.get("authorization") === "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` 永遠 401(env 內值與外部 JWT 不一致,可能因 Supabase 內部 key rotation 或新格式)
**做法**:`verify_jwt: true` 已讓平台先驗簽,函式只 decode JWT payload 確認 `role === 'service_role'` 即可
**為什麼**:平台的 `SUPABASE_SERVICE_ROLE_KEY` 自動注入值不一定等於使用者 dashboard 拿到的那把 JWT

### L06 — TPEX endpoint payload 大(~5MB),偶發 "error reading a body from connection"
**做法**:**每個 source 一筆 fetch_log,獨立 try/catch**;TPEX 失敗不會中斷 TWSE。失敗的留 dead letter,讓 reconcile job 補洞
**為什麼**:多 source 整條 pipeline 死 = 資料缺口擴大;隔離才能 graceful degrade

### L07 — pg_net 是 async,回應在 `net._http_response` 表
**做法**:cron 觸發的 Edge Function 觀測點是 `public.fetch_log`,不是 `net._http_response`。寫入 fetch_log 是 Edge Function 的職責,讓監控有單一入口
**為什麼**:`net._http_response` 只記錄 HTTP 層狀態(200 / 5xx),不知道函式內部成不成功

---

## M3 接 FinMind 備案後

### L08 — 部署 Next.js 到 Railway 時,Supabase Edge Function 檔案不該被打包
**問題**:`supabase/functions/*.ts` 用 `jsr:` imports(Deno 專用),Next.js TS check 抓不到 type → Docker build 在 `npm run build` 階段 fail
**做法**:
- `.dockerignore` 排除 `supabase/`、`tasks/`、`.claude/` 等不屬於 Next.js runtime 的目錄
- `tsconfig.json` exclude 用簡單目錄名(`["node_modules", "supabase", "tasks"]`),glob `supabase/functions/**/*` 在 Linux 似乎沒生效
**為什麼**:Edge Function 是直接部到 Supabase 平台,跟 Next.js Docker image 完全無關;打包它只會壞 build

### L09 — FinMind v4 TaiwanStockPrice 欄位命名不一致(`max`/`min` 不是 `high`/`low`)
**摘要**:
- Endpoint:`GET https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=<symbol>&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&token=<token>`
- 回傳 `{msg: "success", status: 200, data: [{date, stock_id, open, max, min, close, Trading_Volume, Trading_money, spread, Trading_turnover}]}`
- **`max`/`min` 不是 `high`/`low`**,parser 別寫錯
- `date` 已是 ISO `YYYY-MM-DD`(不像 TWSE 是民國年 7 碼)
**為什麼**:踩過一次就一輩子,記下來下次新 source 接入時直接看欄位 mapping table

### L10 — Edge Function 取 secret 的最佳模式:vault + SECURITY DEFINER RPC
**問題**:Supabase MCP 沒有 `set_function_secret` tool;手動在 dashboard 設又麻煩、還會跟 Postgres 內已有的 vault 重複狀態
**做法**:
1. `select vault.create_secret(<value>, '<name>', '<description>');`(execute_sql,不入 migration)
2. `create function public.read_<name>() returns text language sql security definer set search_path = '' as $$ select decrypted_secret from vault.decrypted_secrets where name = '<name>' limit 1 $$;`
3. `revoke execute on function ... from public, anon, authenticated; grant execute on function ... to service_role;`
4. Edge Function 用 `await supabase.rpc('read_<name>')` 取值
**為什麼**:secret 集中在 vault(加密儲存)+ MCP 全自動可重建,不需 Andy 手動操作 dashboard

### L11 — 首寫贏(first-write-wins)是強約束「不跳價」的最簡實作
**做法**:`upsert(rows, { onConflict: '...', ignoreDuplicates: true })` = `ON CONFLICT DO NOTHING`。任何已存在的 (symbol, trade_date) 不被任何 source 覆蓋
**取捨**:Reconciliation 變難 — 一旦 fallback 先寫(例如主力今天恢復前 fallback 已執行),provisional 就永遠存在。要真的「primary 永遠最終勝出」需另外用 TWSE 單股歷史 endpoint(STOCK_DAY)在 reconcile job 抓回來覆蓋
**為什麼**:Andy 的硬約束是「不能因為切換 API 導致股價跳來跳去」,first-write-wins 完全保證這點。Reconciliation 是 nice-to-have,不是 must-have

---

## M5 Web UI 實做後

### L12 — Next.js 16 form action 簽章只接受 `Promise<void>`,不能回 `{ error }`
**問題**:`<form action={addHolding}>` 綁的 server action 必須回 `void | Promise<void>`,任何回傳 object 的版本 TS build 會擋
**做法**:server action 失敗時直接 `throw new Error(msg)`(Next.js 會走 error boundary);需要顯示錯誤狀態給使用者就改用 `useActionState`(client component)
**為什麼**:React 19 + Next.js 16 把 form actions 與 useActionState 拆開了 — 直接 bind 走 void 路徑,有 state 走 hook 路徑,別混

### L13 — Postgres NUMERIC 經 supabase-js 回 string,顯示前要轉
**問題**:`avg_cost numeric(12,4)` 在 SQL view 也是 numeric,supabase-js 為了精度回字串(不是 number),直接 `toLocaleString` 會炸
**做法**:`Number(value).toLocaleString(...)` 或 helper `fmtMoney(v: string | number | null)` 統一處理
**為什麼**:JavaScript number 是 double,大數字精度會丟。Postgres driver 預設保留為 string 是合理的,但前端要記得轉

### L14 — Tailwind v4 在 components 直接寫 utility class 比 @apply 簡單
**做法**:不寫 `.btn { @apply ... }` 抽象。直接在 JSX 用 `className="rounded-md bg-blue-600 ..."`,或用 const 字串複用(如 `const inputCls = "..."`)
**為什麼**:Tailwind v4 改了 @apply 行為 + JIT 編譯模式,@apply 偶有意外。inline 雖然冗長但 100% 可預期,debug 容易

---

## Watchlist 改產業視圖(M5 patch)後

### L15 — Edge Function deploy via MCP 要 JSON-encode 整個 source
**問題**:`deploy_edge_function.files[0].content` 接 string,要把 TS source 用 JSON-escape 後塞進 tool call。手動 escape 容易壞(quote / 換行 / 反斜線)
**做法**:用 Node 一行 `fs.writeFileSync('out.json', JSON.stringify(fs.readFileSync(src, 'utf8')))`,然後 Read out.json 拿到 escaped 字串,直接貼進 tool call
**為什麼**:Windows Bash 沒 jq,Python 是 Microsoft Store 假連結也不能跑;Node 一定有(我們在 Next.js 專案內),最穩

### L16 — Andy 要的「值得進場」是 institutional-grade 多因子模型,不是動能
**摘要**:Andy 給的 framework(EPS 10 年成長 / ROE>15% / 自由現金流 / PEG / P/B + 逆勢布局)需要財報數據,不是只有 OHLCV 能算
**做法**:
- 短期 MVP:用 5 日漲幅(動能 proxy)排序,UI 明確標示「待 fundamentals 補」
- 中期 M3.6:接 FinMind 的 `TaiwanStockFinancialStatements` 等 dataset,建 `stock_fundamentals` 表,改 view 用 6 條規則評分
**為什麼**:資料層先有什麼就用什麼,先把產業視圖跑起來;但長期不能用動能假裝是基本面

### L17 — TWSE OpenAPI `STOCK_DAY_ALL` 有 T+1 延遲(2026-05-07 17:30 Taipei 仍給 5-06 資料)
**問題**:Andy 反映「股價不是今日收盤價」。實測 TWSE endpoint 1356 筆全部 Date=1150506,FinMind 同時間有 5-07 資料(close 2310)。所以 TWSE OpenAPI 要等到「明天」才有「今天」的收盤
**做法**:
1. **L11 的「first-write-wins」是錯的**,改為 **「主力可覆蓋 provisional,但不能覆蓋主力」**(這才是 reconcile 真正含義)
2. fetch-daily-prices 寫入流程:`DELETE WHERE (symbol IN ...) AND trade_date=X AND is_provisional=true` → `UPSERT ignoreDuplicates`。被刪的 provisional 會被新主力填位,殘留的主力不動
3. 觀察 1-2 天 TWSE endpoint 是否會在當日晚上更新成當日資料(若會,加 22:00 / UTC 14:00 第二次 cron)
**為什麼**:即時報價 vs 最終正確收盤是兩種需求。TWSE 收盤檔遲到的話,fallback 補當日 provisional 給 user 看,等主力到再升級為 final。這就是 L11 提到的真正 reconcile 機制

---

## M8.3 Yahoo Finance 即時報價實做後

### L18 — `price_intraday_cache` 是「即時快取」,跟 `price_daily` 的 lock 邏輯完全不同
**摘要**:
- `price_daily`:first-write-wins,主力可覆蓋 provisional,**永不覆蓋主力**(L17)— 因為「收盤價是 ground truth,不能跳」
- `price_intraday_cache`:**每次 fetch 都 ON CONFLICT DO UPDATE 覆寫**,因為「即時報價必然會被下一秒的 quote 覆蓋,這是 cache 本質」
- PK 設計差異:`price_daily(symbol, trade_date)` 每天一格 / `price_intraday_cache(symbol, quoted_at)` 每筆 quote 一格
**做法**:EF 寫入用 `upsert(rows, { onConflict: 'symbol,quoted_at', ignoreDuplicates: false })`
**為什麼**:同一個 symbol 一秒之內可能來自不同 batch(若有 retry / partial overlap),同一 PK 出現多次要選最新版本,DO UPDATE 是正確語意

### L19 — 多個 subagent 並行寫 migration 時的 ordering 衝突
**問題**:M8.5 範圍(編號 30-39)寫的 migration 33 重建 `v_holdings_pnl` 時用了舊版 `v_latest_price`,因為 M8.5 並行時 `v_latest_price_realtime`(M8.3 範圍 22 號)還沒拍板。
**做法**:
1. 邊界寫得「**X agent 不能動 Y 範圍**」太硬,需多一條「**Y 內若引用 X 改動的 schema,要保持同步**」
2. 實務上 X agent(M8.3 data-pipeline)發現 Y 範圍 migration 內引用了 X 已 deprecated 的 view 時,**有權直接 patch Y 內 migration** 的 join source(不動 schema 邏輯),並在 todo review 明確標註
3. 並行設計可考慮:把 view 拆成 layered(layer 1 = price 來源、layer 2 = 業務邏輯),讓底層 view 升級時上層自動 cascade,不需要每個 agent 自己改 join 路徑
**為什麼**:嚴守邊界 = 最終狀態不一致(M8.5 33 號用舊 view 跑完,即時報價沒有意義)。Spec 內「Y 會處理新建的」這個高層意圖優先於字面分割。
**例外**:這只適用「**修補引用**」,不能動其他 agent 的 schema 結構 / 表設計 / 新邏輯。

---

## M8 資料層大改版實做後

### L20 — 「砍欄位」spec 在多 subagent 並行時要解讀為「永遠 null」而非物理 drop column(2026-05-12)
**問題**:M8 spec 寫「砍 forecast_eps_yoy_pct」。我若 `drop column ... cascade` 砍掉物理 column,M8.5 已預先寫好的 migration 33 內 `select ss.forecast_eps_yoy_pct` 會 fail
**做法**:v_stock_score 重建時保留欄位輸出但永遠 null(`null::numeric as forecast_eps_yoy_pct`),業務語意上「砍了」,物理 schema backward-compat
**為什麼**:多 subagent 並行 + migration 編號區段切分後,上下游 dependency 容易壞。物理 schema 越穩定越好,改業務邏輯就行。對外宣告「砍掉」實際是「不再計算」。

### L21 — Cron Taipei 月初早時段轉 UTC 困難,放寬到「月初任一非交易時段」(2026-05-12)
**問題**:spec 寫「每月 1 號 03:00 Taipei」對應 UTC 是「上月最後一天 19:00」,但月底 28/29/30/31 變動 → pg_cron 沒 `L`,寫成 `0 19 28-31 * *` 會月底跑 1-4 次(浪費 quota / log noise)
**做法**:跟 PM(Andy)反映「03:00 是否可放寬到 11:00」— 11:00 Taipei = UTC 03:00,寫 `0 3 1 * *` 一行搞定
**為什麼**:月度任務通常只在意「月初一次」這個粒度,精確小時不重要。對 UTC 換算敏感的時間,要在 spec 階段就避開月跨日邊界。

### L22 — FinMind 不同 dataset 的欄位風格差異大,backfill EF 不能套同一 parser(2026-05-12)
**摘要**:
- `TaiwanStockPrice`: `max/min` 而非 high/low(L09)
- `TaiwanStockInstitutionalInvestorsBuySell`: long format,每 (date, stock_id) 多 row,欄位 `name` 區分法人,需 pivot
- `TaiwanStockMarginPurchaseShortSale`: wide format,駝峰命名(`MarginPurchaseTodayBalance`)
- `TaiwanStockShareholding`: 駝峰 + 中文長欄位(`ForeignInvestmentSharesRatio`)
- `TaiwanStockSecuritiesLending`: 明細性質,同 (symbol, date) 多筆,要用 (symbol, date, type, volume, fee_rate) 做 dedup unique
**做法**:每個 dataset 對應一個 specific parser fn,backfill EF 內用 dataset 字串 switch,各 case 自己 normalize
**為什麼**:FinMind 不同 dataset 是不同團隊維護(可能不同年代寫的),欄位風格不一致。試圖共用 parser 會踩 corner case 一個一個爆出來,不如老老實實每個 dataset 一個 parser。
