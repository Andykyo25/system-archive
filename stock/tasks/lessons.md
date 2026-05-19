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

---

## M8 資料層大改版實做後

### L22 — FinMind 不同 dataset 的欄位風格差異大,backfill EF 不能套同一 parser(2026-05-12)
**摘要**:
- `TaiwanStockPrice`: `max/min` 而非 high/low(L09)
- `TaiwanStockInstitutionalInvestorsBuySell`: long format,每 (date, stock_id) 多 row,欄位 `name` 區分法人,需 pivot
- `TaiwanStockMarginPurchaseShortSale`: wide format,駝峰命名(`MarginPurchaseTodayBalance`)
- `TaiwanStockShareholding`: 駝峰 + 中文長欄位(`ForeignInvestmentSharesRatio`)
- `TaiwanStockSecuritiesLending`: 明細性質,同 (symbol, date) 多筆,要用 (symbol, date, type, volume, fee_rate) 做 dedup unique
**做法**:每個 dataset 對應一個 specific parser fn,backfill EF 內用 dataset 字串 switch,各 case 自己 normalize
**為什麼**:FinMind 不同 dataset 是不同團隊維護(可能不同年代寫的),欄位風格不一致。試圖共用 parser 會踩 corner case 一個一個爆出來,不如老老實實每個 dataset 一個 parser。

---

## M9 多因子排名實做後

### L23 — 多因子 view 的「資料量保護」必須先於「邏輯計算」(2026-05-12)
**問題**:寫 RSI14 / MA60 / 60d_high 等需要 N 個交易日的因子時,如果新股票或剛上市股票 price_daily 只有幾天,而沒有 day-count gate,view 仍會輸出值(只是極端不準),導致 entry signal 被汙染
**做法**:每個 factor 在 case when 鏈最前面先檢查 `count(...) filter (...) >= 必要天數`,不足直接 `null::boolean`(讓 v_factor_scores 把這個 factor 視為「不可評」,count_total 也對應扣)
**為什麼**:雷達圖 user 看到一個 factor 是綠色會以為「過關」,實際上資料量不夠根本不該評估。null 比 false 更誠實:false 代表「我看到資料 + 不及格」,null 代表「我看不到/沒辦法判斷」。entry signal 用 count_pos / count_total 也才合理(分母縮 = 該維度條件提高比例,不會被「滿目假 true」綁架)

### L24 — Tailwind v4 dynamic class names 必須改 prop 化(2026-05-12)
**問題**:`color.replace("text-", "bg-")` 動態算 class,JIT 在 build 時掃不到字面字串會 purge 掉
**做法**:把每個顏色變數獨立成 prop(text class + bar class),caller 明確傳兩個字面字串,讓 JIT 掃得到
**為什麼**:Tailwind v4 的 content 掃描需要看到字面字串才會生成 CSS,任何動態組裝都會被 tree-shake 掉

### L26 — 「歷史視角再現性」(point-in-time)用 PG function parametrize 比建 N 個 view 乾淨(2026-05-12)
**問題**:既有 v_stock_rank 用 current_date,backtest 要在 2024-06-01 站當天視角再 rank → 不能用同一個 view
**做法**:寫 PG function `score_universe_at(as_of_date date) returns table`,把 view 邏輯整包複製進來,所有 `>= current_date - interval '...'` 換成 `<= as_of_date and > as_of_date - interval`。EF 每輪 rebalance 呼叫一次
**為什麼**:
1. 邏輯只在一個地方 maintain(function),既有 view 用 current_date 視角當 wrapper 也行(這版我沒做)
2. 比建 14 個 dated view 乾淨(每月一個 view 不可行)
3. function 是 stable 不是 immutable,可以查 table — 對於 read-only 計算 OK
**取捨**:fundamentals / monthly_revenue / chip 等低頻數據,「as_of_date 之前最後一筆」是 soft point-in-time(資料可能有 lag),不是嚴格的 publish-time。對 backtest 而言可接受。

### L27 — Server action 呼叫 Edge Function 要把長時間執行的 EF 設計成可早期 return(2026-05-12)
**問題**:Backtest EF 可能跑 30s~2min,supabase-js `functions.invoke()` 預設 timeout 對長 EF 不友善
**做法**:
1. EF 開頭做 pre-check(資料量 / 參數合法性),不符就立刻 insert backtest_runs row 並 status=failed + return — 不要等到 walk-forward 中段才發現
2. server action `await` invoke,但 EF 必須在合理時間內(< 60s)回應;若真的長,把 invoke 改成「fire-and-forget」(寫 row → 不 await response → redirect 去 detail page,user 重新整理看結果)
**為什麼**:Edge runtime 有 hard timeout(150s),user 體驗 also 不容忍 form submit 卡 1 分鐘。pre-check 早 fail 是最佳實作。
**注意**:M10 v1 是 sync await。未來資料累積完,可能要改 fire-and-forget,但 row 狀態管理可同步(EF 內已寫 row,client 只是不等回應)。
**問題**:spec 寫「entry signal = fund≥4 AND mom≥2 AND chip≥2」,但 chip 4 個表都是 M8 cron 才剛跑、資料還沒進來。若嚴格 chip≥2 → 0 個 signal,整個 /rank tab 顯示空。
**做法**:在 v_entry_signal 加三層 fallback:
- `chip_count_total >= 3`:嚴格 `chip≥2`
- `chip_count_total > 0`:放寬到 `chip≥1`(部分資料 → 部分卡)
- `chip_count_total = 0`:完全不卡 chip,只看 fund + mom
**為什麼**:資料就緒前後規則「自動升級」,UI 不會閃斷(即使 chip 還沒進來,user 看到的 entry signal 仍有意義 = 基本面+動能對齊)。資料進來後規則自動嚴格化,backtest 也不需重寫。
**注意**:這違反「規則一致性」原則但符合「漸進式上線」實務 — 在 lesson 裡明確記下,將來 spec 寫類似 dependency 條件時,要主動問 PM「資料未就緒時想怎麼處理」。

---

## M11 UI 整合 + 收尾後

### L28 — 「現價 + timestamp」一行容易擠,改用兩行(主價 + 次行 timestamp)(2026-05-12)
**問題**:M8.3 後 view 多吐 `as_of_ts` / `price_source`,要把「15min ago · twse_mis」之類塞進 PriceCell。塞同一行會把主數字擠歪 + 對齊壞,塞 tooltip 又看不到
**做法**:
1. 用 `inline-flex flex-col items-end` 兩行:主價 + 灰色小字 timestamp(text-[10px] text-zinc-500)
2. 主價的 right-align tabular-nums 保持不變,不影響欄寬
3. 一個 helper `formatPriceTimestamp(asOfTs, source, fallbackDate)` 統一格式:`15 min ago · twse_mis` / `今日收盤` / `YYYY-MM-DD 收盤` / `YYYY-MM-DD · FinMind`
4. helper return `{ text, tooltip, provisional }`:provisional flag 從 source=finmind 推導,UI 端不用各自判斷
**為什麼**:dashboard 表格欄已經很多(10-13 欄),時間戳塞 inline 行高會炸;兩行版本在視覺重量上「主價在上 + 時間在下」很自然,也讓 user 知道「同一個數字在不同行/頁時間戳一致 = 一致來源」
**注意**:不要把 timestamp 顏色做太搶眼 — text-zinc-500 + 10px 是「附註資訊」,主價才是焦點

### L29 — Edge Function 個數從 12 漲到 15 後,「現價」query 從 view join 改成獨立 SELECT 比較清楚(2026-05-12)
**摘要**:個股頁原本從 `price_daily` 90 天歷史最後一筆當「現價」,M8.3 後該值不是即時(可能晚 1 天)。改成多 query 一筆 `v_latest_price_realtime` 拿即時,fallback 才用 historical
**做法**:不要為了「省一筆 query」把 latest 和歷史 K 線塞同一個 SELECT;前者要 surface `as_of_ts/source`,後者要時序連續,兩個取數邏輯本來就不同
**為什麼**:Promise.all 內多加一筆 query 邊際成本 ≈ 0(parallel),程式碼可讀性卻提升大量。N+1 心智成本 > query latency

---

## Phase 1 Admin Dashboard Layout 後

### L30 — flex layout 內 main column 必須 `min-w-0` 否則 overflow content 撐爆 sibling(2026-05-12)
**問題**:把 root layout 從 `<header> + <main>` 改成 `<aside> + <main>` flex 結構後,內含 `overflow-x-auto` 的 table(holdings analysis)會把 main column 撐到 table 全部寬度,Sidebar 因此被擠出 viewport / 整個頁面出現橫向卷軸
**做法**:main column wrapper 一定要寫 `flex min-w-0 flex-1 flex-col`,`min-w-0` 是 flex children 預設 min-width: auto 的關鍵覆寫,讓 overflow content 能在 column 內自己卷,不撐出去
**為什麼**:CSS 規範 flex item 預設 `min-width: auto`(根據 content),這對 sidebar + main 這種 1:N 比例 layout 是不友善的 default。`min-w-0` 改成 0 強制 column 收縮,內部 overflow 自己處理

### L31 — Dashboard 多 widget 並排不如直列(2026-05-12)
**問題**:Dashboard 同時放 Performance widget + Entry signal widget + Advice widget 時,想把它們 `grid-cols-2/3/5` 切分視覺更緊湊,但 Entry signal table 8 column + Advice 4 區 + Performance 大數字三張卡,任一個塞到 narrow column 都會擠壓
**做法**:全部 widget 全寬直列堆疊,內部各自有 `md:grid-cols-2/3` 把 narrow row 用 in-component 拆分。Dashboard 主軸是「向下捲」不是「左右並排」
**為什麼**:Admin dashboard 普遍認知是直向 timeline / feed,不是 multi-pane workspace。給 widget 全寬還能在內部按需切 column 是更彈性的設計,Dashboard component 只負責順序不負責 layout 細節

---

## M9.1 Factor 模型優化後(2026-05-12)

### L32 — factor view 版本升級時,必須同時改 score_universe_at(2026-05-12)
**問題**:M9.1 修 factor 計算邏輯(加 fund_gross_up + chip_inst_concentration + rename mom_rsi_ok)時,線上 view(`v_factor_scores` / `v_stock_rank` / `v_entry_signal`)與 backtest function(`score_universe_at`)是兩條獨立的計算路徑。如果只改 view 不改 function,backtest 結果用「舊邏輯看舊資料」,線上「新邏輯看現價」,兩條路徑不對稱 — backtest 結論失準,而且後續一個個發現很難 debug
**做法**:
1. 每次改 v_factor_scores 或 v_stock_rank 邏輯,**強制同步改 `score_universe_at`**(整段 function rewrite,不能只改一半)
2. spec 階段就把這條列為 hard requirement,migration 計畫包含「同步 function」這個獨立 milestone(不能漏掉)
3. function 內讀 `app_settings` 是 OK 的(stable 不是 immutable),settings 改變後新 backtest 立刻吃到新 weights
**為什麼**:view 是線上「現在」視角,function 是 backtest「歷史」視角,兩條邏輯必須語意一致才能 trust backtest。一致性檢查靠 spec 紀律(M10 spec 已說 function 同步,M9.1 spec 也再次強調)

### L33 — app_settings driven config 比 hardcode 彈性,但 backtest 凍結要靠 params jsonb(2026-05-12)
**問題**:M9.1 把 weights(40/30/10/20)從 view hardcode 改成 app_settings rows。好處:Andy 想 tune weights 不用 rebuild view。但 score_universe_at 也讀 settings → backtest 跑歷史用的是「當下 settings 值」,不是「跑時凍結值」。Andy 之後把 weight_chip 從 0.20 改 0.30,重跑同一個 backtest_run 結果就會不同 — 不 reproducible
**做法**(v1 簡化先這樣):
1. settings change = global,所有 view + function 立刻反映新值
2. Andy 自己留 weight 參數紀錄(在 backtest_runs.name 帶個 "v1-w40/30/10/20" 標籤)
3. **未來真要嚴格 reproducible**:`score_universe_at` 簽名改成 `score_universe_at(as_of_date date, weights jsonb default null)`,backtest EF 把當下 settings snapshot 進 `backtest_runs.params.weights` jsonb,跑歷史 walk-forward 時把 jsonb 傳進 function 用 coalesce(jsonb→numeric, settings→numeric)
**為什麼**:settings-driven 是 1 個維度的「靈活」trade off 「reproducibility」。MVP 階段彈性比嚴格重要,但設計時要意識到這個取捨,不要等使用者抱怨「我上週跑的 backtest 怎麼現在數字不一樣」才回頭加 params jsonb

---

## 分析系統行為被糾正後(2026-05-15)

### L34 — 分析「系統給使用者什麼」前,必須查完整 code path(SQL + application layer),不要只看一層就臆測
**問題**:Andy 問「3006 賣掉這決策怎樣」。我只查了 `v_holdings_advice` SQL view 發現它只算數字(pct / obs points / rsi14)沒有 status,就**臆測「系統還叫你抱 +40%、沒 RSI 過熱邏輯」**,還據此提了「M9.x 加 RSI 過熱凌駕」改進。實際上 status 邏輯在 application layer 的 `deriveStatus()`(Telegram EF + HoldingsAdvice.tsx 共用),規則 #9 早就有 `rsi>80 → 🔥 隨時準備出`。Andy 糾正「系統有給出場提示」後我才去看 EF。接著我又臆測「盤前 08:55 推時 RSI 還沒過熱、是盤中才變」,Andy 再次糾正「盤前就有過熱提示」(3006 是 5/13→5/14 隔夜急漲累積,盤前 RSI 已 >80)。**一個分析錯兩次,都是沒查證就推測**。
**做法**:
1. 回答「系統會給使用者什麼建議/提示/狀態」這類問題前,先把**完整 code path 攤開**:SQL view → application layer(EF / React component) → 推播/呈現端。status / 文案 / 決策邏輯常在 application layer 不在 SQL
2. 涉及「時間點」的推論(盤前 vs 盤中 RSI 是否過熱)→ 用實際資料反推(查 5/14 收盤 RSI、隔夜漲幅),不要用「感覺應該還沒過熱」臆測
3. 在還沒查證前,**不要提改進建議**(我提的「盤中過熱警報」是 over-engineering,因為過熱是隔夜累積、盤前推播已涵蓋)
4. 被糾正一次後,下一步要**更保守地查證**,而不是換個方向再臆測一次
**為什麼**:使用者問交易決策分析時,錯誤的系統行為描述會誤導他對「系統能不能信任」的判斷,比一般 code bug 更傷。Andy 要的是「隨時驗證、不要走偏」,臆測系統行為正是最容易走偏的地方。Trust but verify — 對自己的推論也要 verify。

---

## Phase 0.6 退版迴歸後(2026-05-16)

### L35 — 不要在同一個 SQL statement 內「呼叫 data-modifying function + 驗證它的結果」
**問題**:Phase 0.6 還原 adj_factor 時跑 `select recompute_adj_factor() as r, (select count(*) from price_daily where adj_factor<>1) as chk, ...`。`recompute_adj_factor()`(VOLATILE plpgsql,內含 UPDATE)回傳 92975(確實更新了),但同句的 `chk` 子查詢卻顯示 0、0050 = 1.0/1.0,看起來像「還原失敗」。差點誤判要 rollback / 重跑。實際上還原是成功的 — 獨立查詢一驗就對(adj≠1 = 92975、0050 0.226/1.0)。
**做法**:
1. mutation(function 內 UPDATE/INSERT)與「驗證該 mutation 的讀」**必須拆成兩個獨立 execute_sql 呼叫**,不要塞同一條 SELECT 的多個 expression
2. 看到「mutation 回報有改 N 列、但同句驗證顯示沒變」→ 先想 MVCC snapshot,不要立刻當成失敗去 rollback
3. 任何「跑完 X 再確認 X 生效」的 pattern,確認步驟另開一條 query
**為什麼**:單一 SQL statement 的 MVCC snapshot 在 query 開始時就固定。同 SELECT list 內的 sibling 子查詢看不到同句中 VOLATILE function 所做的 UPDATE(那是另一個 statement context 的變更),會讀到 mutation 前的舊狀態。誤判成「沒生效」可能觸發不必要且具破壞性的 rollback/重跑 — 對 adj_factor 這種全表還原尤其危險。驗證一定要在乾淨的後續 query 做。

---

## M9.4 階段 3 Step 1 (M9.4c) 試驗→revert 後(2026-05-16)

### L36 — 結構性 factor 改動「commit/上線前」必須過 OOS 閘;直覺好的 factor 可能殺掉已驗證的集中度 alpha
**問題**:M9.4c 加第 6 動能 factor mom_strong_persist(ret_60d>0 + close>MA20 + RSI14 50~75,直覺上「補捉 TSMC 類持續強勢」很合理,線上抽查 2330/2454/0050 都正確 =1)。但跑 OOS:**top5 2025 OOS alpha +17.75 → +10.42(-7.33pp)、top5 2024 -22.08 → -34.97(-12.89pp)**,top10 兩年大致持平。直覺與線上抽查完全看不出問題,只有 OOS backtest 揭穿。根因:RSI≤75 上限把「爆發性強勢」(2492 RSI77.7、3006 RSI83.4)相對降權,而那些正是 2025 推升 top5 的大贏家 → 稀釋了 top5 的純度(M9.4a 已驗證的 alpha 來源)。
**做法**:
1. 任何「加/改 factor、改 weight、改 entry 規則」這類結構性改動,**commit/宣告成功前一定要跑 in-sample + OOS 雙軌**,並與「當前已驗證基準」(Phase 0.7 honest)逐項比 alpha。in-sample 持平 / 線上抽查合理 **都不算數**
2. 特別警惕「集中度策略(top5)」:它的 alpha 來自少數爆發股,任何看似中性的新 factor 都可能換掉那幾檔 → 對 top5 比 top10 敏感得多。評估改動要分開看 top5 vs top10
3. 改動「先 append-only 上 DB 驗 OOS、git 先不 commit」;OOS 沒贏就 revert,**git 從頭就乾淨**(這次因此 revert 成本極低)
4. 試驗與 revert 都要留痕(migration + commit 都保留),backtest_runs 也留,方便日後審計「為什麼當初沒採用」
**為什麼**:Andy 要 institutional-grade。直覺合理 + 線上看起來對,是最危險的假陽性 — 會讓人想直接上線。M9.4a 的 top5 集中度 alpha 是整個系統最有價值的發現,任何結構改動的預設假設應是「可能弄壞它」,要 OOS 證明沒弄壞才採用。OOS 閘就是擋這種「看起來很好但實際侵蝕已驗證 edge」的改動。

### L37 — view 鏈改動優先用 append-only CREATE OR REPLACE,不要 drop cascade(revert 才會便宜)
**問題**:M9.4c 要動 v_price_factors→v_factor_scores→v_stock_rank 鏈。drop cascade 會波及 v_entry_signal/v_rank_with_cost/**v_holdings_advice(餵 /holdings + Telegram)**。若用 drop cascade,revert 時要一次重建整條鏈(含 v_holdings_advice),風險高且 /holdings+Telegram 有短暫破窗。
**做法**:
1. view 加 factor/欄位,優先設計成 **append-only**:新欄一律加在 select **最尾端**,既有欄名稱/型別/順序全不動,既有欄的「表達式」可改(如 mom_count 5→6)→ Postgres `create or replace view` 允許、**完全不 cascade**
2. 下游 view 用 `r.*` 的(如 v_rank_with_cost)不受影響:它在建立時就固定欄位集,上游 append 新欄不會自動傳染也不報錯
3. revert 時:把「計分表達式」改回舊版即可,append 的 dead 欄留著無害(要清 schema 才需 cascade — 通常不值得那風險)
**為什麼**:append-only 讓「上線試驗 → OOS 沒過 → 行為 revert」變成純表達式回滾,不碰 cascade、不碰 /holdings/Telegram。這次 revert 因此只改 2 個物件、4 backtest byte-exact 回基準,零生產風險。結構改動的可逆性要在「設計階段」就用 append-only 買起來。

---

## 顧問建議評估 + 回測誠實化 v2 後(2026-05-16)

### L38 — 所有回測 alpha 引用必附倖存者偏差 caveat;它不可測不代表不存在
**問題**:回測誠實化 v2 把 2025 top5 OOS alpha 修到 +24.19(更可信的執行/成本假設下)。但有效回測 universe = 154 檔,**100% 是 industry_stocks 在 2026-05-12 用「現在市值/流動」選出**,套到 2024-25 歷史 = 完整 membership lookahead。更糟:查 `price2024_not_in_universe_now=0` 一開始像「無偏差」,實則 **L01 設計上系統只存追蹤 universe 的價格,從沒收過中途陣亡股 → 倖存者偏差的「輸家側」結構性不可測**(0 是「沒資料看」不是「沒問題」)。
**做法**:
1. 任何對外/對 Andy 報 backtest 絕對 alpha(尤其 OOS)**一律附「受不可測倖存者偏差、為樂觀估計非可交易保證」**。相對比較(策略 A vs B 同 universe)受影響小、絕對值受影響大
2. 看到「反例數=0」先問是不是「資料根本沒收集那一側」,別當成沒問題(對照 L34:用資料反推,但也要知道資料的盲區)
3. 真要 de-bias:往後開始存 point-in-time universe 快照(每次 reselect 留歷史);廣歷史價會違反 L01 quota 模型,取捨要 Andy 拍板
**為什麼**:Andy 要 institutional-grade。「+24.19% alpha」聽起來像可交易保證,但它是「在我們今天精選的 154 檔上、用今天的名單回看」算出來的。誠實標註上限比報一個漂亮數字重要 — 這正是 trust but verify 對「自己的回測」也要套用。

### L39 — 大改回測引擎要留「退版錨點模式」;真實化修正可能讓 alpha 變高,別預設「更真實=更差」;外部建議要逐條查證
**問題**:依外部顧問建議重寫 run-backtest(隔日開盤成交+漲停過濾+ETF差別成本)。風險:大改寫可能引入邏輯漂移而不自知;且原以為「修掉 lookahead/同日收盤樂觀偏差後 alpha 會降」。
**做法**:
1. **退版錨點模式**:大改引擎時保留一個參數化舊行為(`exec_model='close'`+`cost_pct=0.585`),它必須 **byte-exact 重現舊基準**(Phase 0.7)。先過這關證明零邏輯漂移,才信新模式數字 —— 同 Phase 0「adj=1 迴歸」鐵律的精神,任何大改都要有這個 anchor
2. 真實化修正方向**不可預設**:這次隔日開盤 +4.35pp、ETF成本 +2.09pp,alpha 反而「上修」(舊的同日收盤其實偏保守、flat 0.585 過度懲罰)。誠實化 ≠ 變差,是「變對」。**結果變好變壞都要保留誠實版,不可因為變差就 rollback**(rollback 只給「程式壞掉」或「factor 實驗 OOS 沒過」;誠實揭露不同數字不是 rollback 對象)
3. 外部建議**逐條查證再採納**:這批 6 條 — ETF成本/漲停=真知灼見採納;adj重算trigger=顧問不知已自動化(別重做);RLS=框成多租戶失準(實為單人,已 deny-all 安全,不動已安全系統);分點籌碼=正確但踩 L36(須完整 OOS-gate)+ 可能無免費資料 → 延後。**好建議也要先對照自己系統現況與既有 lessons**
**為什麼**:大改寫最怕「靜默邏輯漂移」+「先入為主以為會變差」。退版錨點把前者擋掉(這次 close+flat byte-exact 回 Phase 0.7);不預設方向把後者擋掉。外部視角有價值但必須過「我們的現況 + lessons」這層濾鏡,不能照單全收也不能全否定。

### L40 — 工作量變大時主動節制 token,不可放任式燒(2026-05-16)
**問題**:長 session 連做多個大任務,為 deploy/apply 反覆整檔重貼 500+ 行 EF/function、過度重跑同類 backtest 驗證、回應冗長。Andy 糾正「不能因為事情越來越多,token 放任式越燒越快」。
**做法**:① 優先 surgical edit,非必要不重讀/重 emit 整檔;MCP 必須整檔時先縮範圍、一次做完不反覆 ② 驗證夠用即停(退版錨點/關鍵 OOS 各一次),別為「再確認」重跑 ③ 回應結論先行、表格代段落 ④ 工作多就切塊 defer、讓 Andy 定節奏,不默默 mega turn 全做完 ⑤ 昂貴動作前自問「對結論必要嗎?有更省的等價做法嗎?」
**為什麼**:Andy 要可持續協作,不是單次燒到爆。詳見 memory `feedback_token_discipline.md`。

---

## M9.5 低基期轉機 — 前提偽命題(2026-05-19)

### L41 — 為某案例設計新 factor 前,先用該案例真實數據驗證「它真的符合你預設的型態定義」;這個前提驗證要前置到寫 spec 之前
**問題**:M9.5 為「2492 漏網」設計 `mom_low_base_breakout`(低基期<X% + 量1.4x + 20日新高),spec/起草5檔/審查/apply/持股零影響驗證全做完,Gate 1 才發現 2492 在啟動段距 120d 低點 +30~90%(它是 2025 從 80 漲到 220 的長多股,**根本不是低基期型態**),低基期 gate 對它本質不通,放寬到 40% 也框不到。整個 factor 前提偽 → 大量白工(DB 因 append-only 還原便宜,但人力/算力/context 全廢)。記憶檔當初寫的「低基期=距低點 X% 內」是**從未經數據驗證的假設**。
**做法**:
1. 任何「為某觀察案例(2492 這種)新增 factor/規則組」,**第一步**(早於寫 spec、早於起草 migration)必須:把該案例的**逐日真實數據攤開**,驗證「它是否真的符合你要的型態定義」。例:設計前就該先查 2492 的 `low_120d`/距低點% 時間序列 → 一眼看出它不貼低點 → 整個方向當場否決,省下後面所有工
2. 把「案例契合度驗證」當 **Gate 0(設計前置閘)**,不是 Gate 1(實作後閘)。Gate 1 抓到也算成功(沒燒 Gate 2),但 Gate 0 抓到更省一個數量級
3. L36/L39 是「結構改動要 OOS-gate、方向不可預設」;L41 補的是**時序**:連「目標案例符不符合定義」這種最基本前提,都要前置查證,不能憑記憶檔/直覺假設就往下做 spec
4. 附帶:revert function 後驗證**以行為等價為準**(殘留字串=0 + 關鍵輸出回基線 + 下游 view md5 零變動),**勿用 `pg_get_functiondef` md5 byte-exact** — SQL language function 的 prosrc 原樣存字串,受 CRLF↔LF/空白物理表示影響,md5 不等常是良性,會誤判
**為什麼**:Andy 要 institutional-grade + token 紀律(L40)。最貴的浪費不是「做錯」,是「在錯誤前提上把整套流程做到很後面才發現前提錯」。前提驗證成本極低(一個 SQL 查案例時間序列),卻能在投入任何實作前砍掉偽命題 — 這個 ROI 比任何後置 gate 都高。「先確認你要打的靶真的長那樣,再上膛」。

---

## 持股分析殘缺 — 沉默 drift(2026-05-19)

### L42 — 局部換介面必掃全鏈一起升;沉默資料殘缺要主動告警;宣告「環境受限」前先窮舉系統既有機制
**問題**:M8.5 持股改 transaction-log(`holdings` 表 → `v_holdings_current`)。籌碼 4 EF 跟著升級讀 v_holdings_current,但**價格類 4 EF(daily-prices/fundamentals/monthly-revenue/valuation)沒跟上**,仍讀舊 holdings 表 → 沉默 drift。使用者持股 6285(用 transaction-log 記)恰好踩盲區:price/fundamentals/monthly_revenue 全 0 筆 → v_factor_scores fund/mom 0/0、signal=insufficient_data、rank #10(只籌碼撐的**假象**)。但 /holdings 靜靜顯示「持續抱、符合紀律」(無資料默認),使用者一直以為系統在分析他最重要的持股,實際是瞎的。真實 6285 補完料後 rank #10→#60。
**做法**:
1. 局部換介面(舊表→新 view)時,**grep 全部依賴舊介面的元件、列 drift 清單一次全升**,不可只改「當下在動的那幾個」。partial migration = 沉默 drift 溫床(這次籌碼升了價格沒升,半年沒人發現)
2. 使用者最在意資料(持股)的分析殘缺是**沉默失敗,要主動偵測告警**:signal=insufficient_data 的持股該醒目警示,而非靜靜顯示「持續抱」。無資料 ≠ 沒問題(對照 L34/L38:0 常是「沒收集」非「沒事」)
3. 根治用**單一事實來源 view**(v_fetch_universe)讓未來新元件無法再各自定義 → 勝過「逐一 copy 正確 pattern」(後者仍 N 份重複會再 drift)。Andy 拍板選這個
4. 宣告「環境受限」(如無 EF invoke 工具)**之前先窮舉系統既有機制**:這次差點輕易交 host,實際 pg_cron 本就用 `net.http_post + vault edge_function_auth` 呼叫 EF,經 execute_sql 複用同 pattern 即可自助觸發 backfill。受限是最後結論、不是第一反應
**為什麼**:Andy「持股最重要、分析最精準」。沉默 drift 最危險 — 系統「看起來在運作」(有 rank、有建議)卻對使用者最在意標的瞎分析,還用「無資料默認」偽裝成正常,差點讓使用者基於假 rank #10 安心。institutional:換介面全鏈掃、殘缺要告警、根治要單一來源;且「我做不到」前先把系統既有能力翻一遍。
