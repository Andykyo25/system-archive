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

---

## 策略迭代:參數失敗時換形式化,不是暴力掃寬(2026-05-19)

### L43 — 固定/粗糙策略參數過不了 robustness 閘時,優先換「結構更好的形式化」(波動正規化 / 時限 / regime-aware),別預設把同一個粗參數暴力掃寬
**問題**:M9.4b 固定 -10% 停損未過完整 OOS 閘(2024 t5 惡化 -10.93pp)。我的預設下一步寫成「掃更寬門檻 {-15,-20%}」。Andy 指正:方向**不是**放寬同一個固定 %,而是引進**動態標準差(ATR 停損)**——波動大的股停損寬、波動小的股停損緊;或改**時限停損(Time Stop)**,而非價格固定比例。
**做法**:
1. 固定比例參數失敗,**先問「失敗機制」再決定下一步**:M9.4b 敗因是 2024(0050 超級年)被 volatility-blind 的固定 % 在正常洗盤洗掉最終大贏家(whipsaw),不是「門檻數字不對」。對症解法是把參數**正規化到每檔自身波動**(k×ATR / Chandelier)或改**時間維度**(Time Stop / vol-target),不是同一個波動盲參數換數字
2. 「暴力掃寬同一參數」只在「形式已對、只是 grid 沒掃到最佳值」時才合理;若失敗根因是**形式本身太粗**(忽略波動/時間/regime),掃寬是死路 + 浪費算力,且常只是把 overfit 換位置
3. 提策略改良方向前,先想「**機構級會怎麼做**」(ATR/Chandelier stop、time stop、vol-target、regime filter)再回答,不要預設最粗的 fixed-% grid sweep
4. 任何新停損/出場形式仍須過 [[L36]] 完整 OOS 閘(4 格 vs 誠實v2、不得顯著惡化、預設假設「會弄壞已驗證 edge」)
**為什麼**:Andy 要 institutional-grade。把「-10% 不行 → 試 -15/-20%」當預設,是**把參數搜尋誤當策略設計**。真正槓桿在改變參數的「形式化」(normalize by volatility / 換到時間域 / 加 regime 條件),不是在錯的形式上多試幾個值。這是「先診斷失敗機制、再對症換形式」對策略迭代的版本,呼應 L41(先驗前提)/ L36(完整閘)。

---

## 歷史 backfill 對齊回測週期 — partial backfill 是沉默 drift 另一面(2026-05-20)

### L44 — 新增 factor/維度時,「邏輯一致」≠「歷史資料覆蓋一致」;partial backfill = drift 溫床
**問題**:Phase 0 系統性 backfill 還原權值 + 清 close=0,但**籌碼 4 表(institutional/margin/lending/shareholding)歷史只回到 2026-04-16 / 05-04**(EF cron 首次啟動時點),2024/2025 backtest 期間 chip 5 條因子對全 154 檔皆 null。結果:
- 5-factor 模型在歷史回測中**實際只跑 14 條**(fund 7 + mom 5 + rev 2),chip 5 全 null;
- 但 chip 維度 10% 權重仍佔分母 → weighted_score 天花板 ~90% 而非 100%(L1 表中 TSMC 進 top5 的 ws 都卡在 72.5 = 此天花板的 ~80%);
- 線上(現 19-factor 含 chip)vs backtest(歷史 14-factor 無 chip)**系統性 ranking 不對齊**;
- +24.19 OOS alpha 是 **14-factor 達成的**,不是「19-factor」。一直以為的「五維因子模型」在歷史回測裡的真實面貌是「四維 + 一維權重空轉」。
- L32 對齊驗證(score_universe_at vs v_factor_scores 0 不一致)只證**邏輯一致**,沒驗**歷史資料覆蓋一致** → 假陽性 alignment。

**做法**:
1. 新增 factor/維度時,**必須評估「此 factor 所依賴的原始資料表,在回測週期(通常 ≥1 年)是否有完整歷史」**。若沒,三選一:(a) backfill 對齊 (b) 該因子權重設 0 直到資料齊 (c) 明確標註「該因子歷史不可評,backtest 偏粗」並記入 caveat
2. L32 對齊驗證要擴展為**兩層**:
   - **邏輯一致**(view/function 公式對齊,L32 既有)
   - **歷史資料覆蓋一致**(score_universe_at(some_history_date) 結果上 group by 各因子的 null 率,任何 factor 在歷史時點 > 50% null → 該因子權重空轉,要決策)
3. 系統性 audit:回測週期 N 年若涉籌碼/法人/月營收/EPS 等**外部資料 backfill 而來的因子**,在 backfill 之前要建「覆蓋率表」(各表 × 年份 × 全 universe 涵蓋 %),低覆蓋的因子在該 backtest run 標 N/A
4. 同 [[L42]] partial migration 精神:partial backfill 是沉默 drift 溫床。要 backfill 就掃全鏈(price + adj + fund + rev + 籌碼 4 表 全部對齊回測週期),不能只補「當下最痛的那個」

**為什麼**:Andy 要 institutional-grade backtest。一個五維模型在歷史回測中實際只用四維而你不知道,等於用「錯誤的 alpha 號稱」做決策。+24.19 alpha 是 14-factor 算出來的,線上 19-factor 排名 vs backtest 14-factor 不對齊 → paper-track 真實表現可能與 backtest 預測有 systematic gap。partial backfill 跟 partial migration([[L42]])一樣是「看起來都對、實際底層缺資料」的沉默失敗類型。institutional 紀律:覆蓋率審查與邏輯審查同樣是必經步驟。

---

## EF fallback 不該偽造資料(2026-05-20)

### L45 — 即時資料 EF 在「真實值不存在」時應 skip 不寫,**不可 fallback 到衍生/類似值**;否則就是 sliently 寫假新聞
**問題**:fetch-yahoo-intraday(MIS 即時揭示)寫入 price_intraday_cache 時,
```ts
const price = toN(q.z) ?? toN(q.o);  // ❌
```
`q.z` 是「最新成交價」、`q.o` 是「當日開盤」。**twse_mis 在盤中 5 分鐘無新成交瞬間 / 盤前 / 盤後 z="-"**(完全合理,免費 API 內建)。**舊版 fallback 到 open**(整天不變的當日開盤價)→ cache 寫進大量 stale 296 quote → v_latest_price_realtime 取 max(quoted_at) 選到 stale 偽造值 → 推播 / /holdings UI 看到「現價=當日 open」假象。**直接結果**:Andy 2026-05-20 13:35 收到推播「6285 現價 296」,實際 13:30 收盤 279,落差 −17 元(−5.7%)→ 使用者完全被誤導。

**做法**:
1. **即時 cache 寫入鐵律**:**只寫「該欄位的真實 source 值」,該欄位空就 skip 整列**(`return null`),**不要 fallback 到「看似合理」的衍生值**(如取 open / 取 high / 取 prev close)。寧可 cache 該瞬間沒寫,讓上層 view 走它已有的 fallback chain(cache → today close → yesterday close)
2. **cache 是「即時瞬間真實值」**(L18 ON CONFLICT DO UPDATE),寫進去就會被信任。fabricate 一旦進 cache,view 邏輯再對也會選錯
3. EF 容錯設計時辨清「**有資料但異常**」vs「**真實資料空**」:
   - 有資料但異常(數字奇怪/單位錯)→ 修 parser
   - 真實資料空(API 給「-」/null)→ **skip 寫入**,讓更上層 fallback 自然發生
4. 同類風險檢查清單:任何「`?? fallback_value`」在寫入即時資料的 path 上都要審視 — fallback 值是真實同義(eg 換 fetch path 取同一物理量)還是相關但不等價(open ≠ 即時成交)。**只接受前者**

**為什麼**:這是 [[L42]] 沉默 drift / [[L34]] 0 不是沒事 / [[L17]] 缺資料用 provisional 的延伸版。fabricate 進 cache 是「主動寫錯」比「被動缺資料」**更危險**——後者上層 fallback 看得到 NULL 會走 fallback,前者上層看到一個「真的 value」會直接 trust。容錯設計的預設假設是「上層永遠看得到 fallback 鏈」,絕不能因為「寧可給點什麼也不要空」就 fabricate。Andy 13:35 看到錯誤推播是 institutional-grade 系統的最低底線崩塌——這次發現靠 Andy 親口糾錯,**未來要有自動偵測機制**(若任一 symbol 同一 quoted_at 寫入後價格與其他 source 落差 > X%,自動 dead-letter)。

---

## L42 類修法要 grep 全鏈,不能憑記憶 — fetch-finmind-fallback 漏網 24 小時(2026-05-21)

### L46 — 「統一 N 個 EF 讀 view」這類掃全鏈修法,必須 grep 全部相關 EF 列「待升級清單」,憑印象/記憶必漏網
**問題**:L42 修法把「價格類」4 EF(fetch-daily-prices / fetch-finmind-fundamentals / fetch-finmind-monthly-revenue / fetch-finmind-valuation)收料 universe 統一改讀 `v_fetch_universe`(根治 6285 transaction-log 持股漏收 drift)。**但 `fetch-finmind-fallback` 是第 5 個價格 EF,沒納入** L42 修法,仍讀舊 `holdings`(closed_at null)+ watchlist + industry + etf 四源,**漏 holdings_transactions + stock_universe**。
- 2026-05-20 14:30 TWSE primary fetch T+1 延遲(L17)沒抓到 5-20 → 主力 0 row 5-20
- 5-20 15:30 finmind fallback 跑:149 universe 但 quota 只剩 ~107,**末段持股/熱門股(2330 / 6285 等 51 檔)被 quota 砍斷**;且 **6285 在 holdings_transactions 完全沒進 set**(EF 沒讀此表)→ 即使 quota 充足也漏
- 5-21 08:55 推播 6285「現價 292(⚠資料延遲 2026-05-19)」→ stale 1 天的價格被 user 看到,雖標警示但「292 不是真昨收 279」(279 沒寫進 price_daily)
- 同類 L42 損害在 user 面前**再重演一次**,且**靠 user 親口糾錯**(L42 也是 Andy 截圖才發現)

**做法**:
1. **「統一 N EF 收料/讀某 view/換 schema」這類掃全鏈修法,必須機械式 grep**:
   ```bash
   grep -l "holdings\b\|closed_at is null\|watchlist\|industry_stocks" supabase/functions/*/index.ts
   ```
   列出所有 match 的 EF,**逐一比對是否要升級**,**不能憑記憶**(L42 commit 訊息只列 4 EF,漏了 fallback 顯然是「想到的時候只想到 daily-prices/fund/rev/val 四個」)
2. **Quota 緊張時持股優先**:Set add 順序決定迭代順序 → 先 add `v_holdings_current`,再 union 其他。**保證 quota 砍斷時持股一定先寫**
3. **防護層 cron**:每日早盤前(08:45 Taipei)cron 自動 invoke `fetch-finmind-backfill` 補持股最近 3 日 price_daily(token_2 獨立 quota,~5 calls/day,idempotent first-write-wins skip)。即使 fallback EF 又漏,防護層補上
4. **修法 commit 訊息列「全鏈 EF 清單」**:L42 的 commit `c4e850f` 訊息列出「fetch-daily-prices/fundamentals/monthly-revenue/valuation」,但實際漏 fallback。**未來掃全鏈修法 commit 必含 grep 結果列表**,有審計痕跡

**為什麼**:Andy 要 institutional-grade。partial migration([[L42]])、partial backfill([[L44]])、partial fallback fabrication([[L45]])是同一類型「掃了一些但沒掃完」的沉默 drift。每次重演成本:user 看到錯資料 → 親口糾錯 → 工程修補 → 寫 lesson → 仍可能下次又漏一個。**機械式 grep 是治本——它不靠記憶,可重複,可審計**。下次任何「統一/全鏈/掃一遍」性質的修法,**先跑 grep 列待修清單寫進 commit message**,prevent L42 第 N 次重演。

---

## 免費即時 API 文件行為 ≠ 實際行為,要實證(2026-05-21)

### L47 — 「假設 API 文件描述符合行為」必須實證,免費 API 常有 throttle/cache 偏離文件
**問題**:fetch-yahoo-intraday(twse mis)EF v4「z="-" skip」(L45)是邏輯正確。但 mis 文件雖說 z 是「最新成交價(尚未成交 = "-")」,實際**對個股 z 有 throttle**:即使該股持續成交(v 累積金額在跳、mis_t 持續更新),z/pz 仍長期回 "-"。Andy 2026-05-21 早盤看 /holdings 6285「16 min ago · twse_mis」糾錯:「不可能 17 min 沒成交,台股不是這樣運作」。我當時答「mis 常態回 z="-"」是把 throttle 誤當「真的沒成交」。
- PowerShell 5 次連續 query mis(6285/2330/2454):v 累積金額在跳(=有交易)、mis_t 持續變,但 **z 對 3 個熱門股都一直 "-"**
- mis 對 z 欄位有特殊 throttle(可能因為 z 是「會錢」資訊敏感欄位免費限縮),但 **a/b 五檔買賣盤**完整給(掛單反映即時)

**做法**:
1. 「免費 API + 即時資料」場景做**兩種對照驗證**:
   - 連續 query N 次同 endpoint(間隔 5-30 秒),看「該動的欄位」(z)是否真動
   - 同時觀察「該不動的欄位」(v 累積金額、mis_t 時間)是否正常變化
   - 兩者對照才能斷定「該動的沒動」是 throttle 還是真實無變化
2. **多源 fallback 設計**:即時 EF 不該只依賴單一欄位。要 plan 備用 source(mis a/b 中價、tv、v 推算)。z 有真值 → 用 z;z="-" 但 a/b 有值 → 用中價;**清楚標 source 區分**(twse_mis 真成交 vs twse_mis_mid 中價)
3. **時間軸 vs 數值軸分離**:即時 cache 的 quoted_at 用「我們抓到資料的時間」(fetched_at)而非「該數值在源端的時間」(tlong)。理由:
   - tlong 反映源端 cache 狀態,免費 API 常 stuck(2454 z=3550 多次 query mis_t 都同個)
   - fetched_at 是我們系統真實「拉到此值的時點」
   - user 看「N min ago」反映系統 freshness;**price 仍是源端真實值**(z 或 a/b 中價),source 標清楚 → 不矇騙
4. 不違反 [[L45]] 「不偽造資料」:fallback 到中價是 mis **真實五檔算出來的數字**,不是憑空捏造。L45 是「該欄位真空就 skip 不寫」,L47 是「該欄位 throttle 時用同源另一個真實欄位」。差別:「沒有資料 vs 同源不同欄位資料」

**為什麼**:Andy 要 institutional-grade。**API 文件常不寫真實 throttle/cache 行為**,程式碼按文件寫但 user 看到 stale。[[L34]] 教訓「不臆測系統行為」+ [[L45]] 「不偽造資料」延伸:**不只「資料表查證」,還要對「即時 API 動態行為」實證驗證**。Free-tier API 有 throttle 是常態,不該被假設成「文件 = 行為」。Andy 的「不可能 17 min 沒成交」是台股實務直覺糾錯,我憑 mis API 文件回應就是錯誤前提。下次設計即時 EF 前,**先做 30 秒 PowerShell 連續 query 對照測試**,確認 API 欄位真實更新頻率,再寫 EF。

---

### L48 — 審查 subagent 的 P0 不可照單全收 + 任何亮眼回測 alpha 必須查 point-in-time 前視偏誤
**問題**(2026-06-01 夜間自主全系統審查):
- 4 個審查 subagent 報的 P0 既有**誤報**也有**嚴重低估**:① A5「ETF 還原價 vs 未還原價假偏離 8-10%」實證為**誤報**(adj_factor[今天]=1 → current(raw)=current(adj),0050/0056 過去20天 adj=1,8-10% 是真實偏離)— 照單全收會為不存在的 bug 加複雜度 ② C1「財報前視偏誤」agent 評「可信度中偏低」,實證修後 2025 OOS alpha 從 +20.02 **暴跌到 −9.02**(比 agent 定性嚴重得多)
- M9.4a top5 的 **+24.19 alpha 長期被當「策略 edge」引用**,實證是 score_universe_at 用「會計期間當可得日」→ 選股偷看未公告財報的**前視偏誤假象**(2330 在 4/30 就看到 Q1,實際 5/15 公告)。修掉後跑輸大盤 9pp

**做法**:
1. **審查 P0 落地前自己實證 + 量化歸因**:不直接照 subagent 報告改。A5 查「過去 20 天 adj_factor 是否真 <1」推翻誤報;C1+C2 合改後,查「C2 移除幾檔」(只 2 檔)確認 −29pp 暴跌歸因於 C1 非 C2。**每個 P0 都要有自己的實證數據支撐**
2. **任何亮眼回測 alpha 必過 point-in-time 三問**:① 選股時點是否用到「未來才公告」的資料(財報/月營收公告落差、籌碼 T+1)② universe 是否含「事後才進視野」的名單(watchlist/持股)③ 回測生效維度是否 = 線上維度(C3:回測三維 vs 線上四維)。三問任一中招 → alpha 打折甚至翻負
3. 改策略因子/universe 必兩處同步(線上 + 回測)+ 重跑 OOS 對照 + benchmark 一致性檢查(確認純效果非資料變動)

**為什麼**:Andy institutional-grade 要求「回測數字禁得起拷問」。「照單全收 subagent」會誤改不存在的 bug(A5)+ 繼續相信假 alpha。亮眼回測最常見的虛假來源就是前視偏誤(look-ahead bias)+ 事後選擇 + 存活者偏差。+24.19 三項全中(L48 自己 + C3 三維 + L38 倖存者)。**夜間自主時尤其要守:沒有 Andy 即時把關,更要自己當最嚴格的 QA**。

---

### L49 — deploy EF 用 MCP `deploy_edge_function` 時,content **必用機械方式產生**,絕不可手打(尤其含中文)
**問題**(2026-06-02 deploy 7 個 B1 EF):用 MCP `deploy_edge_function` 時,我把 `files[].content` 用「閱讀 repo → 手寫重現」的方式輸出。前 6 個 EF(中文僅在註解、執行字串全英文)功能正確;但 `reselect-industry-stocks` 的 `classifyIndustry` 把**中文股名 keyword 寫在執行路徑的正則裡**,手寫重現時產生 **8 處形近誤植/漏字**:`鈺創→鈕創`、`宇瞻→宇瞩`、`辛耘→辛耀`、`富采→富採`、`聯鈞→聯鈔`、`為昇科→為昃科`、註解 `妥協→妄協`,且**整個漏掉 `華東`**。這些會讓對應個股無法分類進產業(silent failure,月底 cron 才生效、半年才可能發現)。Deno deploy 的 type-check **不會擋**(字串字面值內容合法)。
**做法**:
1. **content 一律機械產生,不經「我重新打字」**:PowerShell 讀磁碟正確檔 → 轉 JSON-ready ASCII-escaped(`"`→`\"`、`\`→`\\`、換行→`\n`、所有非 ASCII→`\uXXXX`)→ Read 回來當 content。中文變碼點,複製 ASCII 無形近誤植風險。(memory [[stock_ef_invoke_via_pgnet]] / B1 deploy 指示**早就寫明**用 `node -e "JSON.stringify(readFileSync(...))"` 產生精確 escaped content — 我沒遵循,改手寫,就中標。)
2. **deploy 後一定 `get_edge_function` 拉回核對執行路徑內的字串**(dataset 名 / table 名 / 欄位名 / 中文 keyword),逐字比對 repo。不能只看「version +1 + ACTIVE」就當完成(那只證明語法/型別過,不證明字串字面值正確)。
3. 機械式辨識風險檔:**grep EF 內「非註解行是否含中文/非 ASCII」**(L46 機械式不憑記憶)。中文只在 `//` 註解 → 手寫錯也不影響執行;中文在字串字面值/正則 → 必須機械產生 + 拉回核對。
**為什麼**:LLM 對中文是 token 級「語義壓縮」,手寫長中文必然形近誤植 + 漏字(如同 [[L46]] 「憑記憶必漏網」的字元版)。English 識別字逐字母複製可靠度高、且打錯多半會讓 API/DB 報錯(非 silent);中文 keyword 打錯是**合法字串、靜默錯分類**,危害最大卻最難發現。`deploy_edge_function` 的 content 是純資料搬運,沒有任何理由經過「我的理解再重打」——能機械搬運就機械搬運,把人為 transcription 從流程裡徹底移除。

---

### L50 — 本機 dev server 連不到外網 Supabase,前端視覺只能 Railway 部署後驗;別花步驟試本機 preview
**問題**(2026-06-05 權益曲線 /performance 頁):實作完前端想本機截圖驗視覺,起 dev server(`preview_start`)+ 導航 + screenshot + eval fetch,折騰多步才從 server log 發現**所有頁面(含既有 dashboard `/`)都 `TypeError: fetch failed`** — **沙箱環境連不到外網 Supabase API**,非 code 問題。本機 dev 拿不到任何資料,頁面只走 error boundary,截圖全黑,無從驗視覺。
**做法**:
1. 這專案前端視覺驗證**只能靠 Railway 部署後**(線上環境才連得到 Supabase)。本機 `npm run dev` + preview 對「需要 Supabase 資料的頁面」一律無效,**別再花步驟試**(memory `stock_current_state` 早寫「Railway 部署後實際看前端」,此為根因實證)。
2. 本機驗證上限 = `npm run build`(編譯+tsc+靜態生成)+ MCP `execute_sql` 驗資料層(view 數字對)+ 讀 server log 確認「頁面邏輯走到正確 `unwrap`」。三者齊備即可 commit/部署,視覺缺口交給部署後人眼(Andy 第一個看)。
3. 真要本機驗視覺需 mock 或本機 supabase stack(此專案沒設,不值得為單次視覺臨時搭)。
**為什麼**:Andy 要 token 紀律([[L40]])。「起 dev server 截圖」直覺上是「實際展示正確性」(CLAUDE.md #4),但此環境網路阻斷讓它**必然失敗** — 投入多步換 0 資訊。先認清「本機連不到 Supabase」是環境常數,把驗證預算放在 build + MCP 資料驗證(此環境有效且充分),視覺等部署。[[L42]]「宣告環境受限前先窮舉」的反面:這次是**實證**受限(非臆測),確認後就不該再耗。

---

## 無 node 環境下 EF 機械 deploy(2026-07-11)

### L51 — PowerShell 5.1 做 L49 機械 escape 的三個坑:ConvertTo-Json 不 escape CJK、bare string 會被包 {"value":}、ASCII 寫檔靜默毀中文
**問題**:L49 要求 deploy_edge_function 的 content 機械產生(原 pattern 用 node JSON.stringify),但本機 sandbox 無 node/npm。改用 PowerShell 5.1 `ConvertTo-Json` 時踩三坑:
1. **CJK 不會被 escape 成 \uXXXX**(`-EscapeHandling` 是 PS 7 才有)→ 產出仍含中文
2. **bare string 輸入會被包成 `{"value":"..."}` wrapper**(PS 5.1 對 [string] 的怪異行為)→ 不是合法的「字串 literal」
3. `[IO.File]::WriteAllText(..., [Text.Encoding]::ASCII)` 對殘留非 ASCII 字元**靜默替換成 `?`** → 中文全毀且無報錯
**做法**:
1. 放棄 ConvertTo-Json,**手動 StringBuilder 全量 escape**:`\`→`\`、`"`→`\"`、CR→`\r`、LF→`\n`、TAB→`\t`、其餘 <32 或 >127 → `AppendFormat('\u{0:x4}', [int]$ch)`,首尾補 `"` — 產出就是合法 JSON string literal
2. 寫檔後**必驗 `nonAscii=0`**(`[regex]::Matches($s, "[^\x00-\x7F]").Count`),非零 = 有東西沒 escape 到,ASCII 寫檔必毀
3. Read 回 escaped 檔直接貼進 tool call 當 JSON 值(工具呼叫參數本身是 JSON,\uXXXX 由 parser 解回中文)
4. deploy 後除了 get_edge_function 拉回核對,**行為驗證更強**:例 fetch-intl-news 的「記憶體」中文 key 若誤植,topics 會 fallback 成 1(GENERIC)而非 3 — 觸發一次看輸出數量即證明 key 正確
**為什麼**:L49 的核心是「中文不經我重打」;工具鏈換到 PowerShell 5.1 後,「機械」本身也有坑 — escape 工具的行為同樣要實證([[L47]] 精神),且要有一個零信任的終端檢查(nonAscii=0 + 行為驗證)。

---

## 規畫③ ATR 出場回測結案(2026-07-17)

### L52 — 出場優化有結構性前提:報酬右尾集中 + 無 re-entry 的輪動策略,任何「盤中觸發式停損」都在誤殺大贏家;三案全敗後此路關閉
**問題**:M9.4b(fixed −10%)敗 → L43 指路「換形式化:ATR 正規化 / Chandelier」→ 規畫③ 完整測 ATR-static k=2 與 Chandelier k=2/3 × t5/t10(3yr 同底床,L36 閘)→ **六格 alpha 全惡化 −7.7~−70.9pp,全數不過閘**。MDD 確實全格大砍(風控功能成立),但報酬損失遠大於風控收益。
**機制**(三案統一解釋:fixed% / ATR 停損 / E 等回 MA20 全敗):
1. 策略報酬集中於**少數大贏家的長波段**(top5 尤甚)— 把贏家提早洗出的成本 >> 躲掉輸家的收益
2. 高波動動能股「持有期內正常回撤」本來就是 2-3×ATR 級 → k=2/3 剛好落在誤殺區(chand2-t10 觸發 327/351 = 93% 交易被洗)
3. 引擎誠實無 re-entry:停損後現金閒置到下次 rebalance → 錯過反彈段(現實中人也很難接回,參 Andy 回追 0 勝)
**做法**:
1. **20 日輪動 + 動能選股之下,最好的出場就是下次 rebalance 本身** — 出場優化這條線關閉,除非策略形式先變(更長持有週期 / 報酬分佈不再右尾集中 / 有系統性 re-entry 機制),否則不再嘗試新停損形式
2. 誠實記錄反面:若目標函數是「風險調整報酬 / 睡得著」而非絕對報酬,atr2-t10(sharpe 1.348 vs 1.232、MDD 14.8 vs 25.7、報酬 −7.7pp)是已知可選配置 — 判定不採是因為系統閘以 alpha 優先,不是它「壞」
3. 錨點迴歸非 byte-exact 時先 diff 結構(bench/期數/交易數)再判:結構全同 + 只有數值微變 + 有除權息 cron 事證 → 資料底床演進,基準改用**同底床 anchor**,不跨底床比較(L39 的資料演進 case law)
**為什麼**:L43 說「參數失敗換形式化」— 這輪證明形式化(波動正規化)也救不了,因為敗因再上一層:**是策略結構(輪動+動能+右尾集中)與「盤中觸發式出場」根本互斥**,不是停損參數或形式的問題。連續三案(fixed%/ATR/等回檔)在同一機制上敗,足以把整條線關閉 — 這比找到有效停損更有價值:省掉未來所有同型嘗試。

---

## UI Phase A 撞 stale checkout(2026-07-22)

### L53 — 多 session 共用 repo:動工前必 `git fetch` 比對 origin,盤點/audit 一律以 origin/main 為準,不能信本機樹
**問題**:UI Phase A 全程(盤點 → plan → 實作 → commit)基於本機 checkout,push 才發現**落後 origin/main 13 個 commits**(cloud session 7/17 已做過另一輪 UI 玻璃感改版 + 砍 ETF 頁 + 新增 /swing/MorningPanel/BuyForm 等)。後果:① 給 Andy 的 UI 盤點含錯誤事實(「/performance 無導覽入口」— remote 早加了;「ETF 在導覽」— remote 早砍了;「背景死平」— remote 早加漸層)② Phase A 視覺方向(實色面板)與線上已部署 5 天的玻璃感直接衝突,需 Andy 額外拍板 + rebase 逐檔語意合併(取 remote 結構 + 我的 token 層)。
**做法**:
1. **任何盤點/audit/plan 動工前,先 `git fetch` + `git status -sb`(或 `git log HEAD..origin/main --oneline`)確認本機不落後**;落後就先看 remote 增量再開工。此 repo 有 cloud session 並行 push main,本機樹過期是常態不是例外
2. 對「現況」的所有事實描述(UI 長怎樣、哪頁存在、nav 有什麼)以 **origin/main** 為準;本機樹只是工作副本
3. 撞上 divergent 改版時:視覺/產品方向衝突**交 Andy 拍板**(這次:保留線上玻璃感、token 化之),機械衝突照「remote 結構 + 本次系統化層」語意合併,不盲目 --ours/--theirs
**為什麼**:多 session 工作流(本機 + cloud)下,「我看到的 repo」≠「Andy 看到的產品」。基於過期樹的 audit 會對 Andy 輸出錯誤事實(比 code bug 更傷,同 [[L34]] 臆測系統行為);基於過期樹的實作會推翻別的 session 已交付、Andy 已在用的成果。一個 `git fetch` 成本 3 秒,省掉整輪 rebase 協商 — 與 [[L41]] Gate 0 同精神:**先確認靶長怎樣,再上膛**。

---

## 錯誤日誌自身是盲區(2026-07-22)

### L54 — `catch (e) { String(e) }` 對 supabase-js 錯誤會產生 "[object Object]";錯誤序列化壞掉 = 沉默 drift 的幫兇
**問題**:`fetch_log` 盤點發現 `etf_metadata_sync` 的 error 欄位是字面的 `[object Object]`,完全看不到真因。根因:`if (error) throw error` 拋的是 supabase-js 的 **PostgrestError plain object(不是 Error 實例)**,下游 `catch (e) { e instanceof Error ? e.message : String(e) }` 就落到 `String(e)` = `"[object Object]"`。機械 grep 發現**全系統 22 處 `throw error` + 19 檔同款序列化** = 系統性日誌盲區。
**做法**:
1. 寫入日誌/回報錯誤時,**序列化必須能吃 plain object**:先 `Error.message`,再取物件的 `message`/`code`/`details`/`hint`,最後才 `JSON.stringify` → `String`。單純 `String(e)` 只對 Error 與原始型別安全
2. 拋錯時**主動包成 Error 並帶上下文**:`throw new Error(\`etf_metadata upsert: ${errMsg(error)}\`)`,別直接 `throw error` 把 library 的 plain object 丟出去
3. 這類 helper 應抽到 `_shared/`,避免 N 份重複再 drift(同 [[L42]] 做法 3 單一事實來源)
4. **稽核角度**:排查資料管線時,若看到 `[object Object]`、`undefined`、`null`、空字串這種「非訊息的訊息」,先懷疑序列化壞掉,不要當成「沒有錯誤資訊可得」
**為什麼**:[[L42]]/[[L46]] 的沉默 drift 之所以難發現,不只因為沒人看 log,**還因為 log 本身是瞎的**。監控鏈上任何一環把錯誤吞成無資訊字串,等於整條觀測鏈斷掉 —— 你以為有 `fetch_log` 就有觀測性,實際上關鍵那一格是 `[object Object]`。**可觀測性要驗證「錯誤路徑」而不只是「成功路徑」**:寫完 EF 要問「這個 catch 真的觸發時,寫進 log 的字串長什麼樣?」

### L55 — 手動 quota 分配會餓死排在後面的 cron;先到先得不是分配策略
**問題**:11 個 EF 共用 FinMind 主 token 的 600 daily quota,純先到先得。主 token 7/19-21 連 3 天 600/600 用滿,而備援 `finmind_2` 只用 150-309/600 → **排在 cron 後段的 `finmind_margin`(09:05)連 5 天 quota_exhausted**,`stock_margin` 靜靜 stale 2 天,籌碼因子吃過期資料。系統「看起來在跑」(EF 有執行、有寫 fetch_log),只是每次都 skip。
**做法**:
1. **共用配額的排程群組要看「總量 vs 分配」兩層**:總量夠(1200)不代表不會餓死,先到先得會讓後段任務系統性挨餓
2. 短期解:把後段任務手動指到閒置的配額池(本次沿用 lending 既有的 `token_key` body 參數 pattern,零新機制)
3. 長期解:**自動 failover** —— `pick_finmind_quota()` RPC 回傳「目前還有餘額的 token」,EF 不再硬編碼配額來源。手動分配會隨新增 EF 再次失衡
4. **`quota_exhausted` 這種 skip 要當失敗看待並告警**,不能因為「EF 正常回應」就視為健康 —— 它是資料停止流入的沉默形式
**為什麼**:配額耗盡不會噴錯、不會讓 EF 崩潰,只會讓資料悄悄不再更新 —— 這正是 [[L42]]/[[L46]]/[[L54]] 同一家族的沉默失敗。institutional-grade 的標準是:**任何導致「資料不再更新」的狀態都必須可見**,不論它在技術上是不是 error。

---

## 檢驗動能要選對窗口(2026-07-22)

### L56 — 用長窗口報酬檢驗「動能」會把「漲完在崩」偽裝成強勢股;檢驗前先確認窗口與待答問題一致
**問題**:Andy 反映「漲幅很大卻排不前面」,我第一次用 **60 日報酬**排序檢驗,看到 2492 華新科 +132% 卻 rank 88、動能分只有 1/5,差點下結論「動能因子壞了」。查細項才發現它 **20 日 −47.7%、RSI 8.1、距 60 日高點 −51%、股價 300 vs MA20 459** —— 那是**漲完崩掉一半**,動能因子給 1/5 完全正確。60 日 +132% 只是因為起算點在兩個月前的低位。換 **20 日**重驗才浮現真問題(正在漲的股票被 fund 40% 權重壓在 100 名外)。
**做法**:
1. **檢驗「現在的動能」用近端窗口(5/20 日),不要用 60 日以上** —— 長窗口報酬 = 「這段期間的累積」,對「現在還在不在漲」幾乎沒有辨識力。要看現況就選近端,要看趨勢才配長端
2. **一律並列多個窗口 + 距高點**:`ret_20d` 與 `ret_60d` 方向組合可分辨四種型態(續漲/剛轉強/漲完回檔/弱勢),`off_high_60d` 補上「離頂點多遠」。單一數字必然誤導
3. **對使用者的直覺回報要先驗證再認同**:Andy 的觀察最終成立,但「機制」跟他(和我)的第一直覺都不同 —— 不是動能因子失靈,是權重結構錯配。**照單全收使用者的歸因會修錯地方**(這次差點去動動能因子,實際該處理的是「並列一個純價格視角」)
4. 同理適用於任何「為什麼 X 沒被選中」的排查:先把 X 的**分項數據攤開**(哪一維扣分、扣在哪個因子),再談要不要改規則([[L34]] 查完整 code path 的數據版)
**為什麼**:「漲幅大」是個含糊詞,60 日與 20 日可以指向完全相反的狀態。用錯窗口檢驗會得到相反結論,然後去修一個沒壞的東西 —— 比不修更糟(對照 [[L48]]:誤報 P0 照單全收會為不存在的 bug 加複雜度)。同時這也是 [[L41]] Gate 0 的變形:**動手前先確認「你量的東西真的是你要問的東西」**。
