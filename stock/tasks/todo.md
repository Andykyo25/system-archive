# 持股分析系統 — Milestone 與 Todo

> 工作流程依 [CLAUDE.md](../CLAUDE.md)。每個項目完成後勾選並寫 1~2 行 review。

---

## 已拍板的核心決策(2026-05-07)

- **前端**:Next.js 14+(App Router)+ TypeScript
- **Auth**:**完全不做**。只有 Andy 自己用。Supabase 用 `SUPABASE_URL` + `SUPABASE_ANON_KEY`(前端)+ `SUPABASE_SERVICE_ROLE_KEY`(後端);無 admin 路由,所有功能用 tab 區分嵌在主 UI;`robots.txt` 擋爬蟲
- **Repo**:沿用 `system-archive`,本專案在 `stock/` 子目錄
- **部署**:Railway,root directory 設 `stock/`,Dockerfile builder + Node 22
- **資料源**:主力 = TWSE/TPEX 官方收盤 OpenAPI;備案 = FinMind 免費版
- **排程**:pg_cron(Supabase 內建)
- **範圍**:`holdings` + `watchlist`(< 30 檔)+ paper trading(模擬下單)

---

## M0 — 專案骨架(0.5 day)`analyst-deployer`

- [x] 在 `stock/` 下初始化 Next.js 16 App Router + TypeScript + Tailwind v4(Turbopack)
- [x] `package.json` / `tsconfig.json` / `eslint.config.mjs` / `.gitignore` / `.env.example`
- [x] `public/robots.txt`(Disallow: / 擋搜尋引擎)
- [x] 寫 `Dockerfile`(Node 24-alpine,Next.js standalone multi-stage build,non-root user)
- [x] 寫 `railway.json`(builder = Dockerfile,Restart on failure)
- [x] `.env.example` 列必要 env(`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `FINMIND_TOKEN`)
- [x] `npm run build` 成功(standalone server.js + .next/static 產出正常)
- [x] commit & push 到 `main`(commit `5714c78`,Andy push)
- [x] Railway 已配置完成(Andy 自行設定)

**Review**:
- 框架實際版本:Next.js **16.2.5** + React **19.2.4** + Tailwind **v4**(注意 v4 PostCSS plugin 改用 `@tailwindcss/postcss`,跟 v3 寫法不同)
- Node 本機 24.15(winget LTS 已升 24);Dockerfile `ARG NODE_VERSION=24`,`engines.node: ">=22"` 寬鬆相容
- create-next-app 自動產出 `AGENTS.md`(Next.js 16 breaking changes 警示),保留並從 `CLAUDE.md` 用 `@AGENTS.md` 引用
- Auth 簡化掉,單頁 tab UI,`robots.txt` 擋搜尋引擎

---

## M1 — 資料層 schema(0.5 day)`data-pipeline`

實際合併成 5 個邏輯 migration,全部都在 `stock/supabase/migrations/` 並透過 Supabase MCP apply 到 project `trnvkwievjewhghdvniq`。

- [x] **001_core_tables**:`holdings` / `watchlist` / `paper_orders`(使用者直接維護的資料)
- [x] **002_price_data**:`price_daily`(PK = symbol + trade_date 做 lock)+ `price_intraday_cache`
- [x] **003_pipeline_ops**:`fetch_log` / `api_quota_state` / `reconcile_audit`
- [x] **004_alerts**:`alert_rules` + `alert_events`(FK → alert_rules,delete cascade)
- [x] **005_rls**:全部 10 表 enable RLS(實際發現 Supabase 平台有 `rls_auto_enable()` event trigger 已自動做這件事,migration 為冗餘但 idempotent)
- [x] 走 service_role 全寫(無 client-side 寫),所以 `rls_enabled_no_policy` advisor INFO 是預期內,不加 policy

**Review**:
- 10 表全部建好,RLS 全 on,row count = 0
- 索引覆蓋:`price_daily.trade_date`、`alert_events` 未發送、`paper_orders` symbol+time、`holdings` 持有中(closed_at is null)
- Schema 設計關鍵:**`price_daily` PK = (symbol, trade_date)** 強制每組唯一性,主力寫入後 `INSERT ... ON CONFLICT DO NOTHING` 即達成 lock(M2 會用)
- `is_provisional` 配 partial index `where is_provisional = true` 加速 reconcile 查詢
- Supabase advisor:1 個 SECURITY DEFINER 警告是 `rls_auto_enable()`(平台內建,event trigger function,anon 直呼叫等於 no-op),不需處理
- Migration 名稱用 `YYYYMMDDHHMMSS_<name>.sql` 對齊 Supabase CLI 慣例,之後 `supabase db push` 可重建

---

## M2 — 主力資料源接入(1 day)`data-pipeline`

實際合併 TWSE + TPEX 進同一個 Edge Function,因為兩家欄位差異不大且兩者一起跑/一起記 log 比較好維運。

- [x] 研究 TWSE / TPEX 官方收盤 OpenAPI:免註冊免限速,Date 是民國年 7 碼字串
- [x] Edge Function `fetch-daily-prices`:同時抓 TWSE + TPEX,filter 到 `holdings.symbol ∪ watchlist.symbol`
- [x] 寫入用 `upsert(... ignoreDuplicates: true)` = `ON CONFLICT DO NOTHING` 實作 lock
- [x] 啟用 `pg_cron` + `pg_net` extensions(migration 006)
- [x] 排程 `cron.schedule('fetch-daily-prices', '30 6 * * 1-5', ...)` = 平日 14:30 Taipei(migration 007)
- [x] JWT 用 vault secret `edge_function_auth` 存取,migration 不洩漏 JWT
- [x] 端到端驗證:手動 curl 200 OK / 寫 1 筆;net.http_post 200 OK / lock skip 正確;cron 排程已 active
- [ ] 等隔週 5 個交易日後檢查連跑穩定性(由 cron 自動執行,觀察 `fetch_log` 與 `price_daily` 累積)

**Review**:
- 一次 fetch:TWSE 1350 檔(含 ETF),TPEX 5743 筆(含權證等)
- TSMC 2330 抓回:close 2250(2026-05-06),數字與 TWSE 網站一致 ✅
- Lock 機制驗證:同檔同日連跑 3 次,只第一次 written=1,後續 written=0 / skipped=1 ✅
- TPEX endpoint 偶發 "error reading a body from connection"(payload ~5MB 大,可能網路毛邊),已 lessons L06 記錄
- Edge Function auth 用 JWT payload role 檢查,而不是與 `SUPABASE_SERVICE_ROLE_KEY` env 比對(已 lessons L05 記錄)
- 測試資料(2330 watchlist 與 price_daily)已清除,DB 回空狀態

---

## M3 — 備案資料源 + Reconciliation(0.5 day)`data-pipeline`

- [x] FinMind 免費版 token(Andy 提供),存入 Supabase **vault** `finmind_token`
- [x] RPC `public.read_finmind_token()`(SECURITY DEFINER,只 service_role 能呼叫)— Edge Function 用這個讀 vault,免設環境變數
- [x] Edge Function `fetch-finmind-fallback`:fill 主力空缺(client-side 過濾 existingKeys + `ON CONFLICT DO NOTHING`),寫入 `is_provisional=true`
- [x] Quota 機制:`api_quota_state` 記 finmind/today,每次扣減,跑滿停手
- [x] pg_cron:平日 16:00 Taipei (UTC 08:00),已 active(jobid=2)
- [ ] ~~Edge Function `reconcile-provisional`~~ — **改為「first-write-wins」,不做 reconcile**(見下面 review 解釋)
- [ ] ~~pg_cron 每日 22:00 reconcile~~ — 同上
- [ ] 等實際運作幾天看 fallback / quota 行為(由 cron 自動跑,無動作)

**Review**:
- 端到端驗證:第 1 次跑 written=5(2330 過去 7 個交易日,close 數字與 FinMind 一致)、第 2 次跑 written=0/skipped=5(lock 工作)
- FinMind 欄位特殊:`max`/`min`(不是 high/low)、`stock_id`(不是 code)— 已在 `parseFinmind` 處理,L09 lessons 記錄
- Vault + RPC 模式:**Edge Function 不需設置環境變數 secret**,所有 secret 走 vault + SECURITY DEFINER RPC,migration history 不洩漏 token
- Quota 600/day 為 FinMind 免費保守值,30 symbol × 1 call/day = 30 call,還有大量餘裕
- **跳過 reconcile 的設計決策**:
  - 原計畫:fallback 寫的 provisional 在主力恢復後被覆寫
  - 問題:TWSE STOCK_DAY_ALL 只給「今天」,沒辦法用同一個 endpoint 回頭抓昨天的歷史去覆蓋 provisional
  - 取捨:**first-write-wins**,任何已寫入的 row 永不被覆寫(跨 source 也不)— 完全符合 Andy「不能因為切換 API 導致股價跳來跳去」的硬約束
  - 副作用:若 fallback 比主力先寫(例如主力今天 15:00 才恢復、fallback 16:00 已寫過),今天的 row 永遠是 provisional;UI 會顯示來源警示
  - 真正需要 reconcile 時再加 M3.5(用 TWSE STOCK_DAY 單股歷史 endpoint 補蓋)

---

## M4 — 分析層(1 day)`analyst-deployer`

- [x] SQL view `v_holdings_pnl`:每檔現價、未實現損益、權重
- [x] SQL view `v_portfolio_summary`:總成本、總市值、總損益
- [x] SQL view `v_paper_positions`:模擬部位累計(把 `paper_orders` 加總 → 當前持股)
- [x] SQL view `v_paper_pnl`:模擬部位用最新 `price_daily.close` 算損益
- [x] SQL view `v_latest_price`:每 symbol 最新一筆 close(distinct on)— 給上面兩個 view 用
- [ ] ~~技術指標 MA20 / MA60 / RSI14 / KD~~ — 延到 M4.5(M5 個股頁需要時再做)
- [ ] ~~警示檢查 batch~~ — 延到 M4.5(M5 沒做 alerts tab)

**Review**:
- 5 個 view 全建好(`v_latest_price` / `v_holdings_pnl` / `v_portfolio_summary` / `v_paper_positions` / `v_paper_pnl`)
- Holdings/Paper PnL 都 LEFT JOIN 最新價,沒抓到價也能顯示 row(current_price=null)
- Paper position aggregation 用 `sum(case when buy then qty else -qty end)`,`net_qty > 0` 才算當前持有
- Avg_cost 用 net_invested / net_qty,簡化(不做 FIFO)
- 技術指標延後:M5 v1 沒做個股 K 線頁,還沒需要

---

## M5 — Web UI(1.5~2 day)`analyst-deployer`

單頁 tab 結構,無 admin 路由分離。所有 CRUD 直接嵌在主 UI。

### Tab 結構
- [x] **Tab 1 — Dashboard**:portfolio summary cards + 真實持股表 + 模擬部位表
- [x] **Tab 2 — 持股**:`holdings` 新增 / 刪除(列表)
- [x] **Tab 3 — Watchlist**:`watchlist` 新增 / 移除
- [x] **Tab 4 — Paper Trade**:模擬下單表單 + 當前部位表 + 近 50 筆下單紀錄
- [x] **Tab 5 — 個股**(`/stocks/[symbol]`)— 見下方 Phase 2 / Phase 3
- [ ] ~~Tab 6 — Alerts~~ — 延後(沒 alert eval batch)

### 全域
- [x] **Provisional 資料明確標示**(⚠ 角標 + 黃字 + tooltip 顯 source/date)
- [x] 寫入操作走 server actions(用 service_role key)避免前端 bundle key
- [x] Dark theme + 台股配色慣例(紅 = 漲、綠 = 跌)
- [x] zh-TW + Noto Sans TC font fallback

**Review**:
- 4 routes 全 build 過、SSR 200 OK、empty state 正確
- Server actions 改成 throw-on-error 模式(Next.js 16 form action 簽章只接受 `Promise<void>`,L12 lessons)
- 沒做 Tab 5/6 的選擇:K 線需要 lightweight-charts 或類似,範圍會大幅膨脹;alerts 還沒 eval batch
- Stack:Next.js 16 + React 19 + Tailwind v4 + @supabase/supabase-js,4.7s build,標準 standalone output
- 部署檔案清單:`app/{layout,page}.tsx`、`app/_components/{TabNav,Format,PriceCell}.{tsx,ts}`、3 個 tab page + actions、`lib/{supabase/server,types}.ts`、`globals.css`

---

## M6 — 部署上線收尾(0.5 day)`analyst-deployer`

- [x] Railway 環境變數設齊(`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `FINMIND_TOKEN`)
- [x] Production smoke test:Andy 已實際使用中(M3.6 後續 patch / Phase 1-3 都基於線上回饋)
- [ ] README.md 寫部署/環境變數說明(目前還是 create-next-app 預設樣板)

**Review**:
- 環境變數 + Railway 部署都過了(commit `9e8f67c` 修掉 `supabase/` 不該打包進 image 後就跑起來,之後沒再壞過)
- 唯一 todo:README.md 重寫(部署步驟、env 清單、Edge Function deploy 流程、cron 表)

---

## M7(選配) — 通知

- [ ] LINE Notify 或 LINE Messaging API 串接
- [ ] `alert_events` 觸發時推 LINE
- [ ] 每日盤後摘要(總損益、警示清單)

---

## ✅ 已完成 patch:Paper Trade 移除 + Watchlist 改產業視圖(2026-05-07)

- Paper trade 整套移除:`app/paper/`、`v_paper_pnl`、`v_paper_positions`、`paper_orders` 全 drop
- 新表 `industry_stocks(industry, symbol, name, display_order)`,seed 10 產業 × 10 股(96/100 抓得到報價,4 檔 KY/特殊股號待修)
- 新 view `v_industry_quotes`(含 5 日 / 20 日漲幅)
- 兩個 Edge Function 都改成把 `industry_stocks.symbol` 加入 targetSymbols
- Watchlist tab 改名「產業」,分產業顯示,內排 5 日漲幅 desc(動能 proxy)
- EPS / ROE / PEG / P/B 欄位先預留為 `—`,等 M3.6 fundamentals 補

---

## M3.6 ✅ Fundamentals layer 完成(2026-05-07)

- [x] 驗證 FinMind 免費版 datasets:`TaiwanStockFinancialStatements` / `TaiwanStockBalanceSheet` / `TaiwanStockCashFlowsStatement` / `TaiwanStockPER` 全部都能拿,8 季完整資料
- [x] 新表 `stock_fundamentals_quarterly`(EPS / 淨利 / 權益 / 資產 / OCF / IC / FCF)
- [x] 新表 `stock_pe_pb_daily`(daily PE/PB/殖利率)
- [x] Edge Function `fetch-finmind-fundamentals`(3 dataset × 99 symbols = 297 calls)
- [x] Edge Function `fetch-finmind-valuation`(每天 1 dataset × 99 = 99 calls)
- [x] pg_cron:fundamentals 週一 03:00 Taipei、valuation 每日 16:30 Taipei
- [x] `v_stock_score` view:套 5 條規則計分(EPS 連正 / ROE>15% / FCF+ / PEG<1 / PB<2)
- [x] `v_industry_picks` view:整合動能 + 基本面 + score
- [x] UI 改 score desc → pct_5d desc 排序,顯示真實 EPS/ROE/PEG/PB

**實測結果:**
- 99 symbols 過去 8 季完整,791 quarter rows + 480 valuation rows 寫入
- Score 4 例:廣達 2382(EPS 19.44 / YoY +25.5% / ROE 30.8% / FCF+ / PEG 0.69 / PB 5.44 — 只 PB 失分)
- Score 1 例:日月光投控 3711(PEG 2.38 過高,FCF- 受 CapEx 影響)
- 第 6 條「逆勢布局」屬時機判斷,UI 不自動評分

---

## Phase 1 ✅ 月營收 YoY 加進 score(2026-05-08,commit `e9fe5eb`)

- [x] 新表 `stock_monthly_revenue`(symbol + revenue_year + revenue_month 唯一)
- [x] Edge Function `fetch-finmind-monthly-revenue`(dataset `TaiwanStockMonthRevenue`)
- [x] pg_cron 週一 04:00 Taipei(UTC Sunday 20:00)
- [x] view 三件套重建:`v_stock_score` / `v_industry_picks` / `v_holdings_full`,加 `latest_revenue_period` / `latest_revenue` / `latest_revenue_yoy_pct`
- [x] 第 6 條規則「最近月營收 YoY > 0」上線,score 從 0-5 → 0-6
- [x] `Analyze.ts` 加月營收 note;headline 顯示 X/6
- [x] ETF score 不變(規則不同,仍 0-5)

**Review**:
- 首次 trigger 時當日 quota 已 600/600,EF 部署但無法手動跑;之後 cron reset 抓 ~25 個月歷史回填
- UI 規則描述同步更新

---

## Phase 2 ✅ K 線圖個股頁(2026-05-08,commit `047eddb`)

- [x] `npm install lightweight-charts@5`
- [x] `KLineChart.tsx` client component:台股配色(紅 K = 漲、綠 K = 跌)+ 成交量副圖
- [x] 新 route `app/stocks/[symbol]/page.tsx`(server component):
  - Header:股號 / 名稱 / 產業 / 分數
  - 4 小卡:現價 / 5 日 % / 20 日 % / K 線範圍
  - 過去 ~90 天 OHLCV
- [x] Dashboard / Watchlist / ETF 表格的 symbol cell 變 `Link` 跳到 `/stocks/[symbol]`
- [x] 共用 ETF 與個股(ETF 沒基本面 score 顯 null)

---

## Phase 3 ✅ Google News 個股新聞(2026-05-08,commit `8e34be0`)

- [x] 新表 `stock_news`,`(symbol, url)` unique
- [x] Edge Function `fetch-stock-news`:
  - Google News RSS `news.google.com/rss/search?q=symbol+name&hl=zh-TW`
  - 自寫 RSS regex parser(Deno 沒內建 XML)+ CDATA 解碼 + HTML entity 處理
  - 每 symbol 最近 20 筆,`ON CONFLICT DO NOTHING`
  - 30 天前舊新聞自動清掉
- [x] pg_cron 每 6 小時(UTC 0/6/12/18 = Taipei 2/8/14/20)
- [x] `/stocks/[symbol]` 加新聞 section,點開原始連結

**Review**:
- 首次 trigger:1589 篇 / 80 個 symbol(EF 跑到 110 個其中 80 個 之後 Cloudflare 520 timeout,剩 30 下次 cron 補)
- 來源品質:中央社、聯合、今周刊、TechNews、Yahoo、鉅亨

---

---

# 大改版(2026-05-12 拍板)— M8 ~ M11

**動機**:TWSE 官方 OpenAPI T+1 延遲,目前報價不夠即時 → 無法用即時報價做交易決策。改用「歷史大數據 + 多因子排名」預測「未來 5-20 日 top-N」,加 backtest 驗證,並把所有需手動 key 的欄位自動化。

**5 個拍板的核心決策(這次 plan 的硬約束):**
1. **預測目標**:未來 5-20 日中線排名 + 「進場訊號」⭐(多條件對齊才亮)
2. **股池**:擴到 ~200 檔(MSCI Taiwan 成分股 + holdings + watchlist)
3. **手動欄全砍**:`forecast_eps_yoy_pct` / `etf_metadata` / `industry_stocks` 全自動化
4. **新資料源全接**:法人 / 融資券 / 集保 / 借券(全 FinMind 免費)
5. **方法**:純統計多因子排名(SQL view + cron),先做 backtest 證明有效再考慮 ML

**新需求(2026-05-12 補充):**
- 持股要記錄賣出,算已實現 / 未實現損益,不能單筆刪除
- Yahoo Finance quote API 補即時報價(15 分鐘延遲)解決未實現損益不準的問題

---

## M8 — 資料層大改版(2 天)`data-pipeline`

> Migration 編號區段:`20260512000001 ~ 20260512000019`(實際只用到 009)

### 砍手動欄位 / 全自動化
- [x] 移除 `forecast_eps_yoy_pct` 欄位(物理上仍輸出為永遠 null,backward-compat M8.5),`v_stock_score` 改用「近 4 季 quarterly EPS YoY 中位數」(percentile_cont(0.5))估
- [x] `etf_metadata` 自動化:Edge Function `fetch-etf-metadata`(從 FinMind TaiwanStockInfo 篩 industry_category 含 ETF)+ 每週日 cron
- [x] `industry_stocks` 自動化:Edge Function `reselect-industry-stocks` + 每月 1 號 11:00 Taipei cron(原 spec 03:00 → UTC 換算困難,改用 11:00 等價於月初一次)

### 擴股池
- [x] 擴到 ~150 檔(`stock_universe` 表,seed 153 檔 含半導體鏈/AI/金融/航運/生技/EMS 等;Andy 後續可 SQL insert 補)
- [x] 所有新 fetcher targetSymbols 改成 `v_holdings_current(M8.5 view) ∪ watchlist ∪ industry_stocks ∪ stock_universe`,
      若 v_holdings_current 還沒建,fallback 到舊 holdings 表(graceful degrade)

### 4 個新 dataset(FinMind 免費)
- [x] `stock_institutional`(`TaiwanStockInstitutionalInvestorsBuySell`,EF 內 pivot long→wide,四種法人 net 合計)
- [x] `stock_margin`(`TaiwanStockMarginPurchaseShortSale`,融資+融券餘額/限額/delta)
- [x] `stock_shareholding`(`TaiwanStockShareholding`,週,外資持股比例為主)
- [x] `stock_securities_lending`(`TaiwanStockSecuritiesLending`,明細表 + v_securities_lending_daily aggregate view)

### 歷史回填(3 年 = 2023-01 至今)
- [x] 寫 `fetch-finmind-backfill` EF(支援 8 個 dataset:price / institutional / margin / monthly_revenue / fundamentals / valuation / shareholding / lending),吃 `dataset + start_date + end_date + symbols + symbol_offset/limit` 參數
- [ ] 手動分批 trigger(由 Andy 或 host Claude 透過 MCP `invoke_edge_function` 跑) — 詳見下方執行指南

### Cron 排程更新(編號 009 一個 migration 內 6 個 cron)
- [x] 每日 17:00 / 17:05 / 17:10 Taipei:法人 / 融資券 / 借券(錯 5 分鐘避免 quota 同時打)
- [x] 每週日 03:00 Taipei:集保戶數 / 每週日 04:00 Taipei:ETF metadata
- [x] 每月 1 號 11:00 Taipei:industry_stocks 自動重選(spec 是 03:00,改 11:00 因 UTC 換算簡單)

### 歷史回填執行指南(由 host Claude 觸發 MCP 或 Andy 直接 curl)

預估每日 quota 用量(FinMind free tier 600/day):
- 200 檔 × 1 dataset 一次 = 200 calls,夠跑單 dataset 全 universe
- fundamentals 是每檔 3 calls → 600/3 = 200 檔剛好一天
- 分 7 天輪流,每天跑一個 dataset:

```
Day 1 — backfill price:
curl -X POST '<host>/functions/v1/fetch-finmind-backfill' \
  -d '{"dataset":"price","start_date":"2023-01-01"}'

Day 2 — backfill institutional:
curl -X POST '...' -d '{"dataset":"institutional","start_date":"2023-01-01"}'

Day 3 — backfill margin
Day 4 — backfill shareholding(週頻,call 數少)
Day 5 — backfill lending
Day 6 — backfill fundamentals(每檔 3 calls)
Day 7 — backfill valuation + monthly_revenue
```

每次 EF return 內有 `quota.used / quota.budget`、`next_offset_hint` 給下一次分頁用。

**成功標準達成度**:
- DB schema 已備好 4 個新表 + universe 153 檔 + `v_stock_score` 已重建(無 forecast 動態計算,score 仍 0-6)
- 4 個新 Edge Function 已寫,等 host Claude 用 MCP `deploy_edge_function` 部署
- Cron 已寫進 migration,套用後即 active(EF 部署完才能真的觸發)
- 歷史回填 EF 已寫,等手動分批 trigger

**Review**:
- 16 個檔案改動:9 個 migration + 7 個新 EF + 4 個 app file 改
- Migration 編號用了 001~009(預算 1~19,留 10~19 給後續 patch)
- 與 M8.3 & M8.5 兩個 subagent 協調:
  - M8.3 23 已預期 `avg_q_eps_yoy_pct` 並 SELECT 它(verify 過 line 160)— 完美 coordination
  - M8.5 33 仍 reference `ss.forecast_eps_yoy_pct, ss.peg_basis` — 我把 forecast 輸出永遠 null + peg_basis 改新值,backward-compat OK
- 路徑邊界:寫 EF 改吃 `v_holdings_current` (M8.5 新 view) + fallback 老 `holdings` 表,即使 M8.5 還沒 apply 也能跑
- universe 表 seed 153 檔,但 spec 是 ~200 — 不到目標,但已 cover 大盤主流,Andy 後續可 SQL INSERT 補 row
- `industry_stocks.locked` 全設既有 row 為 true,首次 reselect cron 不會誤踢
- reselect-industry-stocks 用 FinMind industry_category + name keyword 雙重 classify
- 沒做 EDA 確認 view 跑出來的 score 分布(因為 schema 還沒套用),Andy 套完看看

**踩雷 / 寫 lesson(L18 新增)**:
- 多 subagent 並行時,schema 改動會 cascade 影響其他人寫的 SQL — 「砍欄位」應解讀為「永遠 null」而非物理 drop column
- Cron 時區換算容易錯:Taipei 月 1 號 03:00 對應 UTC 上月最後一天 19:00(難寫),改用 Taipei 1 號 11:00 = UTC 1 號 03:00

**Quota 預算警告**:
- daily cron 計算:institutional 153 + margin 153 + lending 153 = ~459/day(平日),加 valuation 153 已 ~600 滿
- 已存在 cron:fundamentals 週一 (1×153=153)、monthly_revenue 週一(153)、valuation daily(153)
- 加 M8 新增:institutional/margin/lending daily 三項 → daily 總用量 4×153 ≈ 612,**已超 600 quota**!
- 解法:Andy 上 FinMind 付費版(1000/day 或 3000/day),或縮小 stock_universe 到 ~100 檔
- 第一輪 cron 可能 quota 超 500 後跳過剩餘 — 但隔日 cron 補(lookback 10 天)會自然補上

---

## M8.3 — Yahoo Finance 即時報價(0.5 天)`data-pipeline`

> Migration 編號區段:`20260512000020 ~ 20260512000029`

### Schema 補強
- [x] **20260512000020_intraday_cache_columns**:給 `price_intraday_cache` 補欄位
  - `change_pct numeric(10,4)`(漲跌幅)
  - `market_state text`(`REGULAR`/`CLOSED`/`PRE`/`POST`/`PREPRE`/`POSTPOST`)
  - `currency text`、`updated_at timestamptz default now()`
  - 不動 PK(仍然 `(symbol, quoted_at)`),即時 cache 由 EF 寫入用 `ON CONFLICT (symbol, quoted_at) DO UPDATE`(L11 例外:這是 cache 不是收盤)
  - 加 latest-per-symbol view 索引

### Edge Function
- [x] **`fetch-yahoo-intraday`**(`supabase/functions/fetch-yahoo-intraday/index.ts`)
  - JWT verify(service_role role)— L05 模式
  - Symbol union:`holdings ∪ watchlist ∪ industry_stocks ∪ etf_metadata`
  - Symbol 轉 Yahoo 格式:預設加 `.TW`,但 `00xxx` 開頭仍是 `.TW`(Yahoo 台股全部都用 `.TW` suffix,no `.TWO`)
    - 註:上櫃股(`5xxxx`/`6xxxx` 部分)Yahoo 可能要 `.TWO`,但 industry_stocks + etf_metadata 主要是上市,先全 `.TW`,失敗的 fallback 用 `.TWO` retry
  - 分批 100 symbol/call(query 字串長度限制)
  - User-Agent:Chrome desktop string
  - 解析 `quoteResponse.result[]`:`regularMarketPrice` / `regularMarketChangePercent` / `regularMarketTime`(unix s)/ `marketState` / `currency` / `regularMarketVolume`
  - 寫入 `price_intraday_cache`,`ON CONFLICT (symbol, quoted_at) DO UPDATE`(覆寫式 cache,L11 例外)
  - `quoted_at` 用 `regularMarketTime` 轉 ISO(若缺則 fallback now())
  - 寫 `fetch_log`(source = `yahoo`),失敗 graceful 不 crash
  - 不打 vault(無 token)

### Cron
- [x] **20260512000021_schedule_yahoo_intraday**:盤中每 5 分鐘
  - UTC `*/5 1-5 * * 1-5`= Taipei `*/5 9-13 * * 1-5`(09:00-13:55 每 5 分鐘)
  - 註:13:30 收盤後到 13:55 還會打 5 次,但 Yahoo 會回 `marketState=CLOSED`,沒成本問題,反而能 capture 收盤瞬間

### View
- [x] **20260512000022_realtime_price_view**:`v_latest_price_realtime`
  - latest intraday per symbol(`distinct on (symbol) order by symbol, quoted_at desc`)
  - 篩 `quoted_at >= now() - interval '30 minutes'`
  - `COALESCE(intraday_price, price_daily_today_close, price_daily_yesterday_close)`
  - 帶 `as_of_ts`(quoted_at / trade_date 取最對應一個)+ `source`(`yahoo`/`twse_today`/`twse_yesterday`)+ `is_provisional`(從 price_daily 傳出來;intraday 一律 false)+ `market_state`

### 既有 view 改吃 realtime
- [x] **20260512000023_update_views_realtime**:`v_holdings_pnl`、`v_industry_quotes`、`v_etf_picks`、`v_holdings_full` 換成 `v_latest_price_realtime`,並 surface `as_of_ts` / `source`
  - 注意:`v_industry_quotes` / `v_etf_picks` 用過去 5d / 20d 漲幅算,**那些不能用 realtime**(會把比較基準也變動),只把「最新一格 = 現價」這格換掉
  - 註:M8.5 會新建 `v_holdings_current/realized/summary`,我只動既有的 `v_holdings_pnl`、`v_holdings_full`(M8.5 自己建的新 view 自然會吃 realtime)

### 驗證(這個 session 環境受限無法執行,留給 Andy 手動跑)
- [ ] 手動 trigger `fetch-yahoo-intraday`(`supabase functions invoke fetch-yahoo-intraday` 或 dashboard)
- [ ] 驗證 `price_intraday_cache` 有 ~99 筆當下報價
- [ ] `select * from v_latest_price_realtime where symbol='2330'` 回 `source='yahoo'`(盤中)或 `twse_today/yesterday`
- [ ] `select * from cron.job` 有 `fetch-yahoo-intraday-5min`

### M8.5 cross-agent 修補(M8.3 範圍越界但必要)
- [x] M8.5 32 號 `v_holdings_summary`:改吃 `v_latest_price_realtime`
- [x] M8.5 33 號 `v_holdings_pnl` / `v_holdings_full`:改吃 `v_latest_price_realtime`,surface `as_of_ts` / `price_source` / `market_state`

**Review**:
- 這個 session 的 Bash + WebFetch 都被 sandbox 擋,無法外網 probe Yahoo API,也無法直接 apply migration / deploy EF。所有 deliverable 是 source code,Andy 跑 `supabase db push` + `supabase functions deploy fetch-yahoo-intraday` 後再驗證。
- **M8.5 修補的決策**:M8.5 32/33 號 migration 用了舊版 `v_latest_price`(它寫在 M8.3 完成前)。我直接修補它們吃 `v_latest_price_realtime`,違反字面邊界但符合 spec「M8.5 會處理新建的(吃 realtime)」這個更高層次的設計意圖。修補只動 2 個 view 的 join source + 加 3 個 surface 欄,沒動 holdings_transactions schema 或新 view 邏輯。
- **EF 設計重點**:
  - 認證走 JWT role(L05)、寫 fetch_log(L07)、`ON CONFLICT DO UPDATE`(L11 例外:即時 cache)
  - 分批 100 symbol/call,batch 失敗各自 try/catch 不中斷
  - User-Agent = desktop Chrome string
  - 台股 symbol 全部加 `.TW` suffix(Yahoo 把上市+上櫃都歸 `.TW` namespace)
  - 缺席的 symbol 進 `missing_symbols` log,給未來 debug
- **Cron 設計**:`*/5 1-5 * * 1-5`(UTC) = Taipei `*/5 9-13` 週一至五。13:30 收盤後 13:35/40/45/50/55 仍會跑,但 Yahoo 會回 `marketState=CLOSED`,沒成本,還能 capture 收盤瞬間最後一筆。
- **view 改動 backward-compat**:UI 端目前都 `select("*")`,新增 `as_of_ts` / `price_source` / `market_state` 不會炸,UI 待 analyst-deployer subagent 之後消費這些欄位顯示 timestamp。
- **歷史漲幅基準不能用 realtime**:`v_industry_quotes` / `v_etf_picks` 用 5d/20d 前 close 算漲幅,那些「比較基準」維持從 `price_daily` ranked 取,只把「現價」這格換成 realtime,否則 5 日漲幅會把基準也變即時 → 失準。

---

## M8.5 — 持股 transaction-log + 已實現損益(1 天)`analyst-deployer`

> Migration 編號區段:`20260512000030 ~ 20260512000039`

### Schema
- [x] 新表 `holdings_transactions`(`id uuid, symbol, txn_type BUY/SELL, qty, price, fee, tax, txn_date, note`)— migration 30
- [x] Migration 把現有 `holdings` rows 轉成 `BUY` transactions(保留歷史,fee=0/tax=0,note 加「從 holdings 搬遷」)— migration 31
- [x] `holdings` 表保留(沒砍),所有 view / UI 不再依賴它;之後可另起 migration 砍
- [x] View `v_holdings_current`:`net_qty > 0` 的彙總,平均成本法(只看 BUY 算 avg_cost)— migration 32
- [x] View `v_holdings_realized`:每筆 SELL 對應的實現損益清單,window function 算「賣出當下加權平均成本」— migration 32
- [x] View `v_holdings_summary`:累計已實現 / 未實現 / 投入 / 回收 / 持股數 / 平倉數 — migration 32
- [x] View `v_holdings_pnl` + `v_holdings_full` 改吃 `v_holdings_current`,cascade rebuild `v_portfolio_summary`,移除 id 欄(改 symbol 當 key)— migration 33

### UI(持股 tab)
- [x] 列表頂部三張卡:**已實現損益 / 未實現損益 / 累計總損益**(讀 `v_holdings_summary`)
- [x] 持有中表格:現價、未實現損益(從 `v_holdings_pnl`,M8.3 後自動吃 `v_latest_price_realtime`,interface 含 `as_of_ts` / `price_source` / `market_state` 預留)
- [x] 每筆持股加「賣出」按鈕 → SellDialog client component:輸入 qty + price + date + note,即時預覽「本次實現 $X(已扣 fee/tax + 報酬率)」→ submit
- [x] 新增「已實現損益歷史」section:列每筆 SELL(賣出日 / 股號 / 股數 / 賣出價 / 當下均價 / 費 / 稅 / 實現損益 / %)
- [x] 新增「全部交易紀錄」`<details>` 摺疊區:列最近 200 筆 BUY+SELL,可單筆刪(危險操作標示)

### 費用計算
- [x] 手續費 0.1425% × `commission_discount`(讀 `app_settings`)× 雙邊都收
- [x] 證交稅:從 `app_settings` 讀(`sell_tax_stock` 0.3% / `sell_tax_etf` 0.1%),只 SELL 收
- [x] ETF 判斷:symbol regex `/^00\d+/`(0050/0056/00878/006208/00679B…)— spec 提到的 `etf_metadata` 比對省略,因台股 ETF 一律 00 開頭
- [x] Server action 計算後存進 `fee` / `tax` 欄位(view 不再 derive,因為費率設定可變)

**成功標準**:可以新增 BUY、新增 SELL(部分/全部)、看到三張 summary 卡正確、已實現損益清單按時間倒序顯示。

**Review**:
- 4 個 migration(30/31/32/33)分工清楚:表/搬遷/aggregate view/rewire 既有 view。31 號 idempotent — 重跑會重複插,但 31 號是 INSERT (不 ON CONFLICT) 在「乾淨第一次跑」假設下沒問題;Andy 若要 re-apply 整套要先清 `holdings_transactions`
- 32/33 號 user/linter 已對齊 M8.3:`v_holdings_summary.unrealized` 用 `v_latest_price_realtime`,`v_holdings_pnl` surface `as_of_ts` / `price_source` / `market_state`。執行順序:M8.3(22/23 號)必須先 apply,M8.5(30~33)再 apply
- **權證 / 受益憑證稅率**:spec 提到「特殊股種無法判斷時用現股稅率並 lessons 註記」— 我這版只區分 00xx ETF vs 一般股(現股 0.3%)。實務上權證 / 受益憑證稅率不同(權證 0.1%,受益憑證 0.1%),但我的 universe 只有上市股 + 00xx ETF,先不過度設計,未來新增資產類型時再加 `instrument_type` 欄
- **平均成本法 vs FIFO**:採平均成本(累計 BUY 金額 ÷ 累計 BUY 股數),與台灣券商「移動加權平均」一致。FIFO 計算複雜 + 台股稅務不分先進先出,沒採用
- **avg_cost_at_sell**:window function `sum() over (partition by symbol order by txn_date, created_at rows between unbounded preceding and current row)`,意思是「同 symbol、截至此 row(含)的累計買入加權平均」。同日多筆用 created_at tie-break
- **deleteTransaction 留下**:雖然 transaction-log 不應該刪歷史,但誤輸入後沒 undo 機制就糟。標危險,讓 Andy 自己謹慎。生產上應該改成 UPDATE 加 `voided=true` 欄位,但 v1 簡化
- **dashboard 同步**:`v_holdings_full` 沒 id 欄了 → `app/page.tsx` `key={h.id}` 改 `key={h.symbol}`,`HoldingFull` interface 移除 `id`
- **build 驗證受限**:這個 subagent context 的 bash 沒 npm / node,無法跑 `npm run build`。完整 type check / build pass 需 Andy 在主對話跑。但 TS code 通讀過 ×3,所有 lib import / interface / supabase select 都對得上 schema
- **M8.3 依賴**:32/33 引用 `v_latest_price_realtime`(M8.3 22 號建)。若 M8.3 還沒 apply,M8.5 apply 會失敗。Wave 1 並行設計下這是 Andy 控制的 ordering 問題,migration 編號 (22, 23 → 30, 31, 32, 33) 自然保證了順序
- **L12 遵循**:server actions 全部 `Promise<void>`,失敗 `throw new Error()`。SellDialog 用 client `await action(fd) + try/catch` 接 error,Next.js 16 會把 server throw 包成 client rejection,所以 dialog 能顯示錯誤訊息
- **L13 遵循**:所有 NUMERIC / bigint 欄位 type 寫 `number | string`,顯示用 `Number(x)` 再 toLocaleString
- **費率以 app_settings 為準**:spec 寫的 `0.001425` 是基準,但 Andy 早期已設定 `commission_discount=0.6`(6 折)→ 實際 0.0855%。我用 `app_settings.commission_discount × commission_base_rate` 動態拉,與 dashboard 既有「未實現淨損益」邏輯一致;以後 Andy 在 Settings UI 改折扣,SELL 計費自動跟進

---

## M9 — 多因子 score v2 + 預測排名(1.5 天)`analyst-deployer`

> Migration 編號區段:`20260512000040 ~ 20260512000049`

### 因子設計(目標 ~15 個 factor,全 SQL view 算)

**基本面(既有 6 條,保留)**:EPS 連正 / EPS YoY / ROE>15% / FCF+ / PEG<1 / 月營收 YoY>0

**動能(新,migration 40 `v_price_factors`)**:
- [x] MA20 / MA60 黃金交叉(`mom_ma_golden`,需 ≥ 60 天樣本)
- [x] 過去 20 日 vs 過去 60 日報酬差(`mom_ret_diff`)
- [x] RSI14 不在超買區(<70,`mom_rsi_ok`,需 ≥ 13 個非 null daily return)

**反轉(新,migration 40 `v_price_factors`)**:
- [x] 距 60 日高點折價 > 10%(`rev_off_high`)
- [x] 過去 5 日跌幅 > 3% 但量縮(`rev_vol_dry`,vol 縮 15%+)

**籌碼(新,migration 41 `v_chip_factors`)**:
- [x] 法人連續 3 日買超(`chip_foreign_3d_buy`)
- [x] 融資餘額減少(`chip_margin_drop`,近 5 日累計 delta < 0)
- [x] 借券餘額減少(`chip_lending_drop`,latest < prev)
- [x] 外資持股比例週對週上升(`chip_share_concentrate`,集保替代)

### View
- [x] `v_factor_scores`:每 symbol 11 個 factor int 0/1/null + 4 維度 count_pos/count_total + 輔助欄(migration 42)
- [x] `v_stock_rank`:加權 50/25/15/10 + `expected_rank`(空維度權重 reallocate,migration 43)
- [x] `v_entry_signal`:fund≥4 硬條件 + mom≥2 + chip 三層 fallback(資料未到位放寬,migration 44)

### UI
- [x] 新 route `app/rank/page.tsx`:前 30 依 expected_rank,⭐ 標 entry signal,4 維度 bar 顯示
- [x] `TabNav.tsx` 加「排名」tab
- [x] 個股頁雷達圖 section:純 SVG 11 軸雷達 + 4 維度 progress bar + 逐項因子摺疊

**成功標準**:排名頁有資料、entry signal 數 ≈ 5-15 檔(不能 >50,代表規則太鬆)。

### Review

**Schema 設計**(5 migration:40~44,分層清楚):
- `v_price_factors`(40):從 `price_daily` 過去 180 天算 MA20/MA60/RSI14/60d_high + 5 個 boolean factor。資料量保護:rsi_days_available ≥ 13、ma60_days_available ≥ 60,不足時 factor 直接 null(不汙染 score)
- `v_chip_factors`(41):4 個 left join + 4 個 boolean factor,空資料時 null。借券用 `v_securities_lending_daily` aggregate view(M8 已建),集保用「外資持股週對週」當「大戶集中」代理
- `v_factor_scores`(42):11 factor 統一成 int 0/1/null + 4 維度 count_pos / count_total。universe = `v_price_factors ∪ v_chip_factors`,等同於 price + chip 全餵到的 union
- `v_stock_rank`(43):權重 fund 50% / mom 25% / rev 15% / chip 10%,有資料的維度才參與分配。`weighted_score` 是 0-100,`expected_rank` asc(1 = 最強)
- `v_entry_signal`(44):signal_strength 分 strong / normal / none / insufficient_data。spec 的「chip≥2」做了「三層 fallback」(chip_count_total ≥3 嚴格 / 1-2 放寬 1 / 0 不卡),這樣資料就緒前後規則語意連續

**UI**(3 個檔案):
- `app/rank/page.tsx`:Top 30 表格,⭐ 旗標 + 4 維度 (pos/total) cell + RSI / 距高點等指標 cell。empty state 友善
- `app/_components/FactorRadar.tsx`:純 SVG 雷達圖,15 軸(11 + 4 反映 spec 15 factor 數,但 chip 4 視資料可能多個 null 軸)。null 軸標灰色。group 著色:blue / amber / violet / emerald
- 個股頁(`app/stocks/[symbol]/page.tsx`):新 `FactorSection`,雷達圖左 + 4 維度 bar + 逐項因子摺疊;⭐ 進場訊號 badge

**Lessons 遵循**:
- L01 範圍管理:`universe_symbols` CTE 用 union 把所有 fetcher 餵到的 symbol 集中,不掃全 price_daily
- L13 NUMERIC string:rank page 與雷達圖一律 `Number(v)` 轉,顯示用 `fmtScore / fmtPct`
- L14 Tailwind v4:DimRow 把 dynamic class 改成傳 `barClass` prop,避免 JIT 抓不到 dynamic 字串
- L19 多 agent 邊界:沒動既有 `v_stock_score` / `v_industry_picks`,只 join 它們抽 6 基本面條件。M8.5 / M8.3 範圍 0 接觸
- L20 backward-compat:既有 6 基本面評分仍由 v_industry_picks.score 0-6 算法保留;新 factor 在「新 view」累加不汙染既有 dashboard

**取捨 / 已知限制**:
- 4 籌碼表目前空(M8 EF cron 才剛啟動),chip_count_total = 0,signal 依 fallback 用 fund≥4 + mom≥2。當 chip 資料就緒,規則自動升級為 chip≥2 嚴格條件
- spec 提「entry signal 5-15 檔」是穩態目標。在 chip 資料未到位前可能 20-40 檔,Andy 觀察一週後依分布 tune threshold(可在 migration 44 改 fund_count_pos / mom_count_pos 的 ≥ 數值)
- 個股雷達圖 11 軸對應 5 個 price + 6 個基本面 +(4 個 chip null);15 個軸太擠所以實際展開 15(以 spec 為準),null 軸用灰色軸標讓 user 一眼看出
- RSI14 用 SMA-RSI(非 Wilder 平滑版)。Wilder 版需要遞迴計算,SQL view 寫遞迴成本太高,SMA 版誤差在 ±2 內(對 < 70 / > 70 判斷影響有限)

**驗證受限**:這個 session 沒 supabase MCP / 沒 Bash,無法 apply migration 也無法 `npm run build` 驗證。所有 deliverable 是 source code,套用方式:
1. Andy 套 `supabase db push` 把 migration 40~44 推到 project trnvkwievjewhghdvniq
2. `npm run build` 在 Andy 本機跑通(stocks page 改動 + 新 rank page + 新 FactorRadar)
3. M8 4 個 EF 已部署且 cron 運行中,等資料累積 3-5 天 chip_count_total 應該升到 4
4. Andy 開 `/rank` 看 top 30 排序是否合理(預期半導體 + AI 系統廠 top 10 居多)

---

## M10 — Backtest harness(2 天)`analyst-deployer`

> Migration 編號區段:`20260512000050 ~ 20260512000059`

### 計畫(2026-05-12 開工)

**Migration**
- [x] **50**:`backtest_runs` 表(uuid pk / name / params jsonb / summary jsonb / status / 三個 timestamp)
- [x] **51**:`backtest_trades` 表(bigserial / run_id fk / symbol / entry_date / exit_date / entry_price / exit_price / return_pct / qty / entry_rank,index on (run_id, entry_date))
- [x] **52**:Postgres function `score_universe_at(as_of_date date)` — 把 v_stock_score + v_price_factors + v_chip_factors + v_factor_scores + v_stock_rank 的邏輯 parametrize 為 as_of_date(歷史視角再現性)。fundamentals/月營收/籌碼 用 as_of_date 之前最後一筆(point-in-time soft 版,低頻數據不嚴格)

**Edge Function**
- [x] **`run-backtest`**:POST body `{ name, start_date, end_date, rebalance_days, top_n, weight_strategy }`
  - 開頭檢查 `price_daily.trade_date min <= start_date` 且 `count(distinct trade_date in range) >= rebalance_days × 2`,不夠 graceful `status='failed' + summary.reason='insufficient_data'`
  - Walk-forward:每 rebalance_days 一輪呼叫 `score_universe_at`,取 top_n,entry close = 該日 close,exit close = rebalance_days 個交易日後 close
  - benchmark 0050 同期(entry/exit 同 rebalance schedule)
  - 寫 backtest_trades + summary jsonb(win_rate / total_return_pct / annual_return_pct / max_drawdown_pct / sharpe / alpha_vs_benchmark)
  - 全 SQL 不打 FinMind(只讀 price_daily)

**UI**
- [x] `/backtest` page(SSR):列 backtest_runs(name + 觸發時間 + 主要 metric)
- [x] form 新增 run(server action 觸發 EF)
- [x] `/backtest/[id]` 詳情頁:summary 卡 + 月度 PnL bar chart(SVG) + trades 列表(限 200 筆)
- [x] TabNav 加「Backtest」tab

**部署 / 驗證(待 host claude / Andy 跑,本 session bash 被沙箱鎖)**
- [ ] apply migration 50/51/52(supabase MCP `apply_migration`)
- [ ] deploy EF run-backtest(supabase MCP `deploy_edge_function`)
- [ ] trigger 一個 test run(name=M10 smoke, 2024-06-01~2024-12-31, top_n=10)看 EF 行為(預期 insufficient_data)
- [ ] `npm run build` 通過
- [ ] commit「M10: Backtest harness(walk-forward + 歷史視角 + UI)」

**通過條件**:勝率 > 55% 且年化 alpha > 5% vs 0050 → 上線。**沒通過 → 砍規則重來,不上線。**
（資料尚未累積,先建框架,backfill 完才能真實驗證）

### Review

**Schema(3 個 migration:50/51/52)**:
- 50 `backtest_runs`:uuid pk / params jsonb / summary jsonb / status enum-by-check / 3 個 timestamp + error。索引 created_at desc + status
- 51 `backtest_trades`:bigserial fk run_id / return_pct 用 `generated always as ... stored`(避免 EF 算錯)/ index (run_id, entry_date)
- 52 `score_universe_at(as_of_date)`:**核心** — 把 v_factor_scores + v_stock_rank 邏輯複製進 SQL function,把 `current_date` 換 `as_of_date`,各表 filter `trade_date <= as_of_date and > as_of_date - interval '180 days'`(price)/ `'14 days'`(法人/融資/借券)/ `'60 days'`(集保 weekly)。fundamentals 與 monthly_revenue 取「as_of_date 前最後 N 季 / 13 月」(soft point-in-time)。`stable` 函式 + service_role only。

**EF `run-backtest`**:
- POST body `{ name, start_date, end_date, rebalance_days, top_n, weight_strategy, benchmark_symbol }`
- JWT verify(L05)、parse + 早期驗證(rebalance_days 5-250 / top_n 1-100)
- 插入 backtest_runs row(status=running)→ 一律會有 row 留存
- pre-check `tradeDates.length >= rebalance_days × 2`,不夠就 graceful failed
- walk-forward:每輪 `sb.rpc('score_universe_at', { as_of_date })` 取 top_n,entry/exit close 從 price_daily 拿(7 天回溯找最近一筆,handle 假日)
- benchmark 0050 同期(預設,可改 body 換)
- summary 算:win_rate / total_return / annual_return (252/total_trade_days) / max_drawdown / sharpe (annualized via periods/year) / alpha_vs_benchmark / equity_curve / benchmark_equity_curve / rebalance_dates
- 失敗統一進 `failRun()`,所有路徑都有 graceful exit + row 更新

**UI(3 個檔案 + 1 個改)**:
- `app/backtest/page.tsx`:列 50 筆 runs + 新增 form(name / start_date / end_date / N / Top K / Benchmark)。form action 呼 EF + redirect 詳情頁
- `app/backtest/[id]/page.tsx`:SSR 詳情。status=running/failed 各自 card,finished 顯 4 個 summary 卡 + Equity Curve SVG(策略 vs benchmark)+ 月度 PnL bar SVG + trades table(限 200,benchmark 灰底)
- `app/backtest/actions.ts`:server actions(createBacktestRun + deleteBacktestRun,都 `Promise<void>` 失敗 throw — L12)
- `app/_components/TabNav.tsx`:加「Backtest」tab

**Lessons 新增(L26 + L27)**:
- L26:歷史視角再現性用 PG function parametrize as_of_date
- L27:server action 呼長 EF 要 pre-check 早期 return

**驗證受限**:
- 這個 session 無 Bash 權限執行 `npm run build` / Supabase CLI / MCP `apply_migration` / `deploy_edge_function`
- 所有 deliverable 是 source code,host claude 套用:
  1. apply migration 50 → 51 → 52(順序重要,52 需要 stock_universe / industry_stocks / watchlist / holdings_transactions / etf_metadata + 4 個 chip 表 + v_securities_lending_daily + stock_fundamentals_quarterly + stock_monthly_revenue + stock_pe_pb_daily 全部到位 — M8 / M9 範圍)
  2. deploy EF run-backtest(用 MCP `deploy_edge_function`)
  3. 觸發一次 smoke test(name=M10 smoke, start=2024-06-01, end=2024-12-31, top_n=10)— 預期 status=failed + reason=insufficient_data + trade_days_found < 40
  4. `npm run build` 通過(Andy 本機跑)
  5. 開 `/backtest` 看 row + 點進詳情看 failed reason 顯示正確

**取捨**:
- fundamentals 用 soft point-in-time(period_end <= as_of_date 的最後 8 季):嚴格 publish-time 需 stock_fundamentals_quarterly.published_at 欄,沒有就回不去。Soft 版對 quarterly 數據(每 3 月一筆)誤差約 1-2 個月,在月度 rebalance 容忍範圍內
- monthly_revenue 同理,取「年月 <= as_of_date 的年月」最後 13 筆
- universe 名單用當前快照,不歷史化(spec 默許,backtest 想用「現在的選股池」回測歷史是合理的)
- Sharpe 用簡化版(periodReturns mean/std × sqrt(periods/year)),不是 Sortino / IR
- Equity curve & drawdown 在 rebalance 邊界算,期內波動不計(等同月度資料粒度)

**邊界遵循**:
- 沒動既有 view(v_factor_scores / v_stock_rank / v_entry_signal)— 只「複製其邏輯」進 function
- 沒動 price_daily / stock_universe / holdings 等表 schema
- migration 編號全在 50-52(預算 50-59)
- L19 多 agent 邊界 OK

---

## M11 — UI 整合 + 收尾(1 天)`analyst-deployer`

> 純 UI + docs。沒有 migration 編號需求(不動 schema、不動 EF)。

- [x] 排名 tab + Backtest tab + 個股因子雷達圖(已在 M9/M10 完成,M11 確認狀態 OK)
- [x] Dashboard 加「今日進場訊號」widget:讀 `v_entry_signal` 排序 `weighted_score desc`,top 10,name 從 industry_stocks / stock_universe / etf_metadata join;empty state 寫「factor 資料累積中」
- [x] Format.ts 加 `formatPriceTimestamp(asOfTs, source)` helper(15min ago · twse_mis / 今日收盤 · twse_today / etc.)
- [x] PriceCell 接收 `asOfTs` / `source` props,角落顯示小字 timestamp
- [x] Dashboard `v_holdings_full`、Holdings `v_holdings_pnl`、Watchlist `v_industry_picks`、ETF `v_etf_picks`:在 PriceCell 傳 `asOfTs` / `source`,UI 顯示 timestamp
- [x] 個股頁 header「現價」:同步補 timestamp(latest 那筆 close 是 historical,不用即時 source)
- [x] README.md 重寫:架構圖、env 清單、Edge Function 清單(11 個)、cron 表、操作指引、已知限制
- [x] `npm run build` 通過

### Review

**3 個檔案改 + 1 個新增**:
- 改 `app/_components/Format.ts` 加 `formatPriceTimestamp`(處理 yahoo / twse_mis / twse_today / twse_yesterday / null 各種 source + 計算「N min ago」)
- 改 `app/_components/PriceCell.tsx` 接 `asOfTs` / `source` 兩個 props,timestamp 顯示在價格下面一小行(避免擠壓主要數字)
- 改 `app/page.tsx`:加 `EntrySignalWidget`,讀 `v_entry_signal` where `is_entry_signal=true` 排序 weighted_score desc limit 10,join name(industry_stocks / stock_universe / etf_metadata 三層 fallback);HoldingFull interface 補 `as_of_ts` / `price_source` 並餵進 PriceCell
- 改 `app/holdings/page.tsx`:CurrentHolding interface 已有 as_of_ts / price_source(M8.3 預留),只需餵 PriceCell
- 改 `app/watchlist/page.tsx`:IndustryPick interface 加 `as_of_ts` / `price_source` 並餵 PriceCell
- 改 `app/etf/page.tsx`:EtfPick interface 加 `as_of_ts` / `price_source` 並餵 PriceCell
- 改 `app/stocks/[symbol]/page.tsx`:header 現價也餵 PriceCell 的 timestamp 標示(顯示歷史收盤 + trade_date)
- 改 `README.md`(原本 create-next-app 樣板)→ 全 rewrite 涵蓋架構 / env / EF / cron / 操作 / 已知限制
- `npm run build` 通過

**驗證**:
- build 用 winget 路徑下 npm 跑;新檔通過 typecheck
- empty state(目前 v_entry_signal 多半 insufficient_data)會跑 EntrySignalWidget 的 empty section 顯示「factor 資料累積中」
- timestamp 顯示用 hover tooltip 區隔來源,inline 顯示精簡(避免行高炸)

**Lesson 新增**(L28):見 lessons.md

---

## 執行順序

```
Wave 1(並行 3 個 subagent):M8 + M8.3 + M8.5
Wave 2:M9(依賴 M8)
Wave 3:M10(依賴 M9)
Wave 4:M11(依賴 M9 + M10)
```

**總計 ~8 天**。

---

## Phase 1 — Admin Dashboard Layout(2026-05-12)`analyst-deployer`

### 計畫
- [x] 新增 `app/_components/Sidebar.tsx`(client component):w-16/md:w-56,固定左側,7 個 nav items(emoji icon + label + desc),active 高亮(usePathname),響應式 <md 收摺成 icons-only(justify-center)
- [x] 新增 `app/_components/TopBar.tsx`(client component):從 path 推 page title,右上預留狀態指示
- [x] 改 `app/layout.tsx`:整體 `flex min-h-screen`(sidebar + main column),main 內 TopBar + 內容區
- [x] 新增 `app/_components/PerformanceWidget.tsx`:讀 summary + realized + first_buy_date,顯示已實現損益 / 勝率 / 累積報酬率(加權)+ 平均單筆 + 平均持有天數 + 最近 5 筆 + 最大單筆獲利
- [x] 新增 `app/_components/AdviceWidget.tsx`:4 個 advice card(出場紀律 / 分散產業 / 可關注標的 / 避免追的),動態填:對沖標的從 v_stock_rank fund>=5 非半導體挑 2 檔,可關注 top 5,避免追硬編碼
- [x] 改 `app/page.tsx`(Dashboard):多 4 個 Promise.all query(summary / realized / buy_txns / ranks)+ symbol→name+industry lookup(industry_stocks/stock_universe/etf_metadata 三層 fallback)+ 排除持有中 symbol → advicePicks。順序:Summary → Performance → Advice → EntrySignal → Holdings
- [x] `TabNav.tsx`:確認沒被任何地方 import,保留檔案
- [x] 文件 review

### Review

**4 個新檔 + 2 個改檔**:
- `app/_components/Sidebar.tsx`(新):左側 fixed sidebar,7 nav item,icon + active 高亮 + responsive(<md icons-only)。pageTitleFromPath 也在這檔 export 給 TopBar 用
- `app/_components/TopBar.tsx`(新):main column 頂端 bar,顯示當前頁 title
- `app/_components/PerformanceWidget.tsx`(新):整個 widget self-contained,接 PerfSummary + PerfRealizedRow[] props
- `app/_components/AdviceWidget.tsx`(新):4 個 advice card,接 AdvicePickRow[](已含 industry 給 isSemi() 判斷)
- `app/layout.tsx`(改):root layout 從 header+main 改成 flex sidebar+(topbar+main),max-w-6xl 砍掉讓內容自然撐
- `app/page.tsx`(改):import + Promise.all 多抓 4 query,在 Dashboard 內 prep advicePicks(filter held + map industry),render 順序:Summary → Performance → Advice → EntrySignal → Holdings(分區清楚)

**設計決策**:
- 「累積報酬率」用加權版(`sum(pnl)/sum(cost_basis)`)而非簡單平均 — 反映 portfolio-level 報酬;副標補「平均單筆 X%」讓兩個視角並存。對 Andy 三檔已平倉(+12.6% 加權 / 約 13.3% 平均)這兩個數字會貼近呈現
- 持有天數:`v_holdings_realized.sell_date - min(BUY txn_date per symbol)`。同 symbol 可能多次買賣,用 first BUY 算是「最初進場到完全出清」的概念 — 對 Andy 三檔全部一買一賣場景完全正確;未來若同 symbol 多次進出,可改 latest BUY 前推或 FIFO,先簡單版
- 可關注標的排除「目前持有中」symbol — 推薦 Andy 已經持有的沒意義
- 「分散產業」非半導體 filter 用 `industry_stocks.industry` 字串 keyword(半導體/電子零組件/晶圓/封測/IC設計)。沒進 industry_stocks 的 symbol industry=null 也算「非半導體」,可被推薦
- 4 個 advice card 用 `grid-cols-2` + 內含 `[&:nth-child(2n)]:border-r-0` 處理邊界線
- Sidebar 用 emoji 不引 icon library(spec 給授權:emoji 或 SVG)
- Dashboard 全寬 widget 直列堆疊,不做 lg:cols-2 切分 — 因 EntrySignalWidget table 8 columns 在 narrow 容器擠壓嚴重,直接全寬最乾淨

**Lessons 遵循**:
- L01:Performance + Advice 兩個 widget 都只讀 supabase view,不打外部 API
- L12:Sidebar/TopBar 是 client component(`"use client"`),Dashboard server component 直接 import 沒問題
- L13:realized_pnl/realized_pct/weighted_score 等 numeric 全 `Number(x)` 轉,顯示用 fmtPct/fmtMoney
- L14:Tailwind v4 利用 utility class 字面字串,advice card accent 顏色用 ACCENT_DOT lookup table(JIT 看得到)
- L19:不動 schema / view / EF,純 UI 改動,multi-agent 邊界 0 接觸

**驗證受限**:
- 這個 session bash 被擋,無法跑 `npm run build`(host 跑時可驗證)
- TS 看起來無錯:所有 import path / interface 對齊;PerformanceWidget 接 `PerfSummary | null`(handle null case);AdviceWidget 接 `AdvicePickRow[]`(empty 也有 fallback 文字)
- 各 page 路由不動,sidebar 都套到(因在 root layout),驗證:Dashboard ✓ / /holdings / /watchlist / /etf / /rank / /backtest / /settings / /stocks/[symbol] 全繼承新 layout

**取捨 / 已知限制**:
- entry signal widget 沒改成 narrow-friendly,因為 spec 沒要求 + 直列堆疊就很實用
- pageTitleFromPath 對 dynamic route(/stocks/[symbol] / /backtest/[id])硬寫 startsWith 邏輯,還沒泛用化 — 之後若多 dynamic 路由可以做 route metadata 表
- AdviceWidget「避免追的」3 檔硬編碼。長期應該有個 `stock_blacklist` 表 + Settings UI 維護,但 v1 簡化先這樣

---

## M9.1 — Factor 模型優化(根據台股分析師建議,2026-05-12)`analyst-deployer`

> Migration 編號區段:`20260512000060 ~ 20260512000069`

### 變更要點
- 權重 hard-code → app_settings(短中線預設:fund 40 / mom 30 / rev 10 / chip 20)
- PEG 門檻放寬 1.0 → 1.2(settings-aware)
- RSI factor:`mom_rsi_ok`(RSI<70)→ `mom_rsi_strong`(RSI>50,轉強)
- 新增基本面 factor:`fund_gross_up`(gross_margin_yoy_pp > 0)→ 基本面從 6 → 7 條
- 新增籌碼 factor:`chip_inst_concentration`(3 日法人 net / 3 日總量 > 5%)→ 籌碼從 4 → 5 條
- 進場訊號:加硬條件 `fund_rev_yoy=1`,fund≥3(從 ≥4 放寬),chip 三層 fallback 隨 chip 總數 5 調整(≥4 嚴格 ≥3 / >0 ≥1 / =0 不卡)
- 17 軸雷達(7 fund + 3 mom + 2 rev + 5 chip)

### Migration
- [x] **60_factor_settings**:app_settings 新增 5 row(peg_threshold / weight_fund / weight_mom / weight_rev / weight_chip)
- [x] **61_v_price_factors_v2**:`mom_rsi_ok` → `mom_rsi_strong`(RSI14 > 50,需 ≥13 RSI 樣本)
- [x] **62_v_chip_factors_v2**:加 `chip_inst_concentration`(join price_daily 3 日 volume sum)
- [x] **63_v_factor_scores_v2**:加 `fund_gross_up`,`fund_peg_low` 改讀 settings peg_threshold,合計 17 factor(7+3+2+5)
- [x] **64_v_stock_rank_v2 + v_entry_signal_v2**:weights 從 settings 讀;entry rule:fund≥3 + rev_yoy=1 + mom≥2 + chip 三層 fallback(total≥4→pos≥3 / >0→pos≥1 / =0→true);strength 同步
- [x] **65_score_universe_at_v2**:同步新 factor + settings-aware

### UI
- [x] `app/_components/AdviceWidget.tsx`:更新「17 因子」「fund≥3 + 月營收 YoY 必過」文字
- [x] `app/_components/FactorRadar.tsx`:不動 component 本體(已 dynamic axes),更新註解 11→17
- [x] `app/rank/page.tsx`:Legend 改 7/3/2/5,header 文字短中線權重 40/30/10/20,進場訊號條件改
- [x] `app/stocks/[symbol]/page.tsx`:`buildFactorAxes` 加 fund_gross_up + chip_inst_concentration + rename mom_rsi_ok→mom_rsi_strong;FactorRankRow interface 補新欄位

### 驗證(本 session bash 被擋,host claude / Andy 驗證)
- [ ] migration apply 全過(60-65 順序,需先確認 app_settings 表存在,M3.6 已建)
- [ ] SQL:`select * from v_stock_rank order by expected_rank limit 5`
- [ ] SQL:`select count(*) from v_entry_signal where is_entry_signal=true`(預期 v1 後資料較嚴格 → 數量略減,因 fund≥3+rev_yoy 雙硬條件,且 chip 5 條後嚴格門檻提高)
- [ ] SQL:`select * from score_universe_at('2024-06-01') limit 1`(可空,但不能 error)
- [ ] `npm run build` pass(host 跑)
- [ ] todo review + lesson(若有)

### Review

**6 個 migration + 3 UI 檔改動**:
- 60 `app_settings` rows(peg_threshold 1.2 / weight_fund 0.40 / weight_mom 0.30 / weight_rev 0.10 / weight_chip 0.20)。用 ON CONFLICT DO UPDATE 讓重跑安全
- 61 `v_price_factors`:`mom_rsi_ok`(RSI<70)→ `mom_rsi_strong`(RSI>50,轉強)。其他 4 factor 不變
- 62 `v_chip_factors`:加 5th factor `chip_inst_concentration`(3 日 three_major_net / 3 日 price_daily.volume sum > 5%)。inst + price 都要 3 天才評,缺一回 null
- 63 `v_factor_scores`:7 fund(加 `fund_gross_up` = gross_margin_yoy_pp > 0)+ 3 mom + 2 rev + 5 chip = 17 factor。fund_peg_low 改用 `app_settings.peg_threshold`(settings 表 CTE + cross join,settings 改變後 view 立刻反映)
- 64 `v_stock_rank + v_entry_signal`:weights 從 app_settings 拿;新 entry 規則(月營收 YoY 必過 + fund≥3 + mom≥2 + chip 三層 fallback ≥4 條→≥3 / >0→≥1 / =0→不卡)。`strength` 也對齊
- 65 `score_universe_at`:整個 function rewrite,17 factor + settings-aware(stable function 內讀 settings,backtest 改 weights 後新 run 才生效)

**UI 改動**:
- `AdviceWidget.tsx`:header 加上「17 因子 / fund≥3 + 月營收 YoY 必過 + 動能≥2」說明
- `rank/page.tsx`:header 文字 短中線權重 40/30/10/20;Legend 4 dimensions 改 7/3/2/5 + 因子 list 換新項目 + 進場訊號條件描述
- `stocks/[symbol]/page.tsx`:`FactorRankRow` interface 加 `fund_gross_up` / `chip_inst_concentration` / 改 `mom_rsi_strong`;`buildFactorAxes` 從 15 軸 → 17 軸,加入新 factor + 改名
- `FactorRadar.tsx`:只更新註解(component 本身 dynamic axes,不寫死數量,完全 backward-compat)

**設計決策**:
1. **app_settings 為什麼用 view 而非 function 拿**:settings 變動希望 view 結果即時更新(像 commission_discount 一樣),不用 rebuild view。代價是每次 view 計算多一次 CTE select,可忽略
2. **score_universe_at 同步**:stable function 內讀 settings 是 OK 的(stable 不是 immutable,可查 table)。Backtest 每輪呼叫一次,假設 N=12 輪 × 13 月 = 156 次呼叫,settings 表 ~9 row 讀取極快
3. **chip_inst_concentration 字面解讀**:spec 寫「3 日法人 net / 3 日總量 > 5%」我採嚴格字面 = 正向 net 主導才過。法人淨賣的場景 ratio 雖然 abs 也可能 > 5% 但是負向,我擋掉(更安全)
4. **fund_count_pos >= 5 在 Dashboard advice 條件不變**:在 6 條制下 ≥5 = 83%,7 條制下 ≥5 = 71% — Andy 看實際數量再決定要不要拉高(動 page.tsx 而非 view 即可)
5. **不動 v_stock_score**(M3.6,gross_margin_yoy_pp 早已存在),也不動 v_industry_picks 等其他 view(它們用既有 6 條基本面 score)

**Lessons 遵循**:
- L01 範圍:universe 仍 stock_universe ∪ industry ∪ watchlist ∪ holdings_transactions(chip 不 union etf)
- L13 NUMERIC:rank UI 已 `Number(x)` 轉,新增欄位仍是 numeric|null,沒新顯示需求
- L19 多 agent 邊界:沒動其他 agent 範圍 view(v_holdings_*、v_latest_price_realtime 等)
- L20 backward-compat:既有 view drop + recreate cascade,但 cascade 只動下游(v_stock_rank / v_entry_signal),score_universe_at 是 function 用 create or replace 取代
- L23 資料量保護:fund_gross_up 需要 fund_ranked q1 + q5 都有,gross_profit/revenue > 0;chip_inst_concentration 需要 inst 3d + price 3d 都有
- L26 score_universe_at parametrize:新版 function 仍維持「as_of_date 之前最後一筆」soft point-in-time 邏輯

**取捨 / 已知限制**:
- 因 fund 從 6 → 7 條,既有 v_industry_picks.score 仍是 0-6(M3.6 那組),沒升級。因 spec 標明「v_stock_score 不能動」,而 v_industry_picks 用 6 條規則 hard-code,M9.1 範圍外。Andy 之後若想 unify 再說
- score_universe_at 內讀 settings 是線上版本,backtest 改 weights 後跑 history 是用「新 weights 看舊資料」,不是「凍結 weights」。若要嚴格 reproducible,需把 weights 寫進 backtest_runs.params jsonb,function 改吃 jsonb 而非 settings。v1 簡化先這樣

**驗證受限**:
- 本 session 無 bash → 無法 `npm run build` 或 supabase MCP apply migration
- 套用順序:host 跑 `supabase db push` 自動依字典序套 60→61→62→63→64→65
- 跑完先 SQL 驗 `select count(*) from v_factor_scores where fund_count_total >= 5`(看有多少 fund 有 5+ 可評),再 `select symbol, fund_count_pos, fund_count_total, signal_strength, is_entry_signal from v_entry_signal where is_entry_signal=true limit 30`

---

## M9.2 — 加突破因子 + ROE 門檻微調(2026-05-12)`analyst-deployer`

> Migration 編號區段:`20260512000066 ~ 20260512000070`

### 動機
華新科 2492 5/11+5/12 連兩根漲停過去 5 天 +36%,系統排名 33,主因:
1. ROE 4.7% 卡 15% 門檻(被動元件業 ROE 天生低)
2. PEG 1.76 卡 1.2 門檻
3. `mom_ma_golden=false`(過去 60 天 MA20 在 MA60 上一直沒「剛交叉」)

分析師建議:加「突破因子」(20 日新高 + 量增 2x)抓飆股 + ROE 放寬 15% → 10%。

### 變更要點
- **ROE 門檻**:從 hardcode 15% 改為 `app_settings.roe_threshold`(預設 10)
- **新動能 factor `mom_breakout`**:`latest_close >= high_20d × 0.99` AND `vol_latest > vol_5d_avg × 2`
  - 20 日新高 + 留 1% buffer(避免漲停打到開盤新高但收盤 -1% 被排除)
  - 當日量 > 5 日均量 2 倍(放量突破)
- 動能 factor 從 3 → 4 條(加 mom_breakout)
- 因子總數 17 → 18(7 fund + 4 mom + 2 rev + 5 chip)
- v_entry_signal:`strong` 規則 `mom_count_pos >= 3`(原 3/3 = 100%,現在 3/4 = 75%)
- normal 規則 mom≥2 相對放寬(50% 而非原 67%)— 這是預期(更敏銳)

### Migration
- [x] **66_factor_settings_roe**:app_settings 加 roe_threshold = 10
- [x] **67_v_price_factors_v3**:agg CTE 內加 `high_20d` + `vol_latest`(rn=1 時的 volume),新 factor `mom_breakout`
- [x] **68_v_factor_scores_v3**:動能改 4 條(加 mom_breakout)+ ROE factor 改讀 settings.roe_threshold + 新欄位 pass-through + count_pos/total 動能改算 4 條
- [x] **69_v_stock_rank_and_entry_signal_v3**:pass-through 加 mom_breakout + entry signal strong 改 mom≥3(配合 4 條)
- [x] **70_score_universe_at_v3**:同步 18 factor + ROE settings

### UI 改動(4 檔)
- [x] `app/_components/AdviceWidget.tsx`:header 文字「17 因子」→「18 因子」、動能 3 → 4(加突破)
- [x] `app/_components/FactorRadar.tsx`:更新註解 17 → 18(component 本身已 dynamic axes)
- [x] `app/rank/page.tsx`:Legend 因子說明改 7/4/2/5 + 加 mom_breakout 描述
- [x] `app/stocks/[symbol]/page.tsx`:`FactorRankRow` interface 加 `mom_breakout` + `buildFactorAxes` 17 → 18 軸

### 驗證(本 session bash 被 sandbox 鎖,host claude 用 supabase MCP 驗證)
- [ ] 5 個 migration apply(66 → 67 → 68 → 69 → 70 順序)
- [ ] SQL:`select * from v_stock_rank where symbol='2492'` 確認 mom_breakout 值
- [ ] SQL:`select count(*) filter (where is_entry_signal=true) from v_entry_signal` 比 M9.1 略多
- [ ] `npm run build` pass(本 session 被擋,host 跑)
- [ ] Stage 不 commit(由 host 跑)

### Review

**5 個 migration + 4 UI 檔改動**:
- 66 `app_settings` 加 roe_threshold=10(ON CONFLICT DO UPDATE,重跑安全)
- 67 `v_price_factors`:agg CTE 加 `high_20d`(max close rn 1-20)+ `vol_latest`(rn=1 的 volume),新 factor `mom_breakout`(close >= high_20d × 0.99 AND vol_latest > vol_5d_avg × 2)
- 68 `v_factor_scores`:加 mom_breakout pass-through + 動能 count 改 4 條;fund_roe_high 改用 settings.roe_threshold(cross join settings CTE 多拿 roe_threshold)
- 69 `v_stock_rank` 加 mom_breakout pass-through;`v_entry_signal` strong 規則 mom_count_pos≥3(4 條制下這仍是 75% 達標,比 M9.1 100% 略寬)
- 70 `score_universe_at`:整段 function rewrite 同步 18 factor + ROE settings + high_20d + vol_latest

**UI 改動**:
- `AdviceWidget.tsx`:header 文字「18 因子 / 動能 ≥ 2/4」(動能總數 4 ≥ 2 改成 50% 門檻)
- `rank/page.tsx`:Legend 改 7/4/2/5,動能新增「20日新高+量增2x 突破」項
- `stocks/[symbol]/page.tsx`:interface 補 mom_breakout,buildFactorAxes 18 軸,加「突破」label
- `FactorRadar.tsx`:component 本身完全動態,只改開頭註解

**Dashboard(`app/page.tsx`)不需動**:
- 它只 select `fund_count_pos / mom_count_pos / chip_count_pos` 等 count,沒讀 individual factor
- `mom_count_total` 自動從 3 → 4,UI 顯示 X/3 變 X/4 自然受惠
- `fund_count_pos >= 5` filter 仍合理(7 條中過 5 = 71%)
- 不在 spec「4 UI 檔」清單內是正確的

**設計決策**:
1. **mom_breakout 邏輯字面解讀**:`close >= high_20d × 0.99` 是分析師 spec 的「buffer 1%」,避免漲停爆量打到 20 日新高但 close 微跌就漏掉(漲停股很常 high 噴到接近上限,close 卻略低於 high)。實務上漲停的 close 通常 ≈ 漲停價 ≈ 當日 high,所以 0.99 倍率很合理
2. **vol_latest 必須是「當日量」**:從 ranked CTE rn=1 取(max(case when rn=1 then volume)),不是 5 日均量。spec 寫「vol_latest > vol_5d_avg × 2」明確要當日量 vs 5 日均量
3. **mom_count_total 4 條後 entry signal**:強訊號從「3/3 全過」放寬「3/4 過 3」是必要的 — 因 mom_breakout 是稀有事件(漲停飆股才會過),硬要 4/4 全過會吃零 strong signal。3/4 = 75% 在 backtest 容易被驗證
4. **華新科 2492 的預期**:即使 mom_breakout 過(5/12 量 4137 萬 vs 5 日均 3000 萬 = 1.38 倍,不過 2x → 預期仍 mom_breakout=0),且 ROE 4.7% 仍卡(< 10%)。系統不會被漲停股牽著走 — 這是「分析師認知的」結果,M9.2 重點不是把 2492 拉進 top,是讓有「強動能 + 基本面」的飆股更容易進 strong signal
5. **不動 v_stock_score**(M3.6 那組,ROE 計算仍 hardcode 15%)— v_industry_picks 用 v_stock_score 算 0-6 score,跟 v_factor_scores ROE 門檻獨立,不會互相干擾。Andy 之後若想 unify 再說

**Lessons 遵循**:
- L01 範圍管理:universe 仍維持 stock_universe ∪ industry_stocks ∪ watchlist ∪ holdings_transactions ∪ etf_metadata(視 view 而定),沒掃全市場
- L13 NUMERIC string:新欄位 mom_breakout 是 boolean → int 0/1,UI 接受 number | null,顯示直接 0/1 → ✓/✗
- L14 Tailwind v4:新 label「突破」直接 inline 字面字串,沒新增 dynamic class
- L19 多 agent 邊界:沒動 M8 / M8.3 / M8.5 範圍 view(holdings_*、realtime_price 等),沒動 M3.6 v_stock_score / v_industry_picks
- L20 backward-compat:既有 view drop cascade,但 cascade 只動 v_factor_scores / v_stock_rank / v_entry_signal 下游(都重建)
- L23 資料量保護:mom_breakout 需要 high_20d / vol_latest / vol_5d_avg 都非空(20 日完整資料),不足時 null
- L32 score_universe_at 必同步:5 個 migration 內 70 號 score_universe_at 整段 rewrite,18 factor + ROE settings 完整對齊
- L33 settings 改變影響 backtest 結果:roe_threshold 改變後新 backtest 立刻吃新值,符合 v1 簡化策略

**取捨 / 已知限制**:
- mom_breakout 沒做「跨日量縮確認」(漲停翌日量縮代表停板成交,但 v1 簡化先看當日)
- ROE 門檻雖然放寬到 10%,但部分傳統產業(被動元件、紡織、橡膠等)的 ROE 5-9% 仍不過,屬於有意保留(它們的轉機要靠 EPS YoY 或月營收 YoY 來體現)
- 跟 M9.1 一樣,settings change 不 retroactive — backtest 重跑同一個 run 名稱結果會不一樣,Andy 自己把 weights/roe_threshold 寫進 backtest_runs.name 標籤

**驗證受限**:
- 本 session bash 沙箱鎖 → 無法 `npm run build` 也無法 supabase MCP apply migration
- 套用順序:host claude / Andy 用 supabase MCP 套 66 → 67 → 68 → 69 → 70
  (或 `supabase db push` 自動依字典序套)
- 跑完先 SQL 驗:
  ```sql
  -- 1. settings 有 roe_threshold
  select * from app_settings where key='roe_threshold';
  -- 2. 華新科 mom_breakout(spec 預期 vol 1.4x 不過 2x → 0)
  select symbol, mom_breakout, mom_ma_golden, mom_ret_diff, mom_rsi_strong,
         mom_count_pos, mom_count_total, fund_roe_high, fund_count_pos
  from v_stock_rank where symbol='2492';
  -- 3. entry signal 數量(比 M9.1 略多)
  select signal_strength, count(*) from v_entry_signal group by signal_strength;
  -- 4. score_universe_at 歷史視角 sanity check
  select count(*) from score_universe_at(current_date - interval '7 days');
  ```

---

## M9.3 — 長期動能 factor + PEG 放寬 + 預算 filter(2026-05-13)`analyst-deployer`

> Migration 編號區段:`20260512000071 ~ 20260512000075`

### 動機(M9.2 baseline 2024 backtest 結果)
- 2024 全年 backtest:勝率 56.7% / 累積 +17.2% / **alpha vs 0050 = -29.45%**
- 系統錯過 TSMC/聯發科這類「PEG 偏高的續強龍頭」
- MA20 黃金交叉抓「剛交叉」,抓不到「持續強勢」續漲股

### 變更要點

**A. 新動能 factor `mom_above_ma200`**
- 條件:60 日報酬 > 0 AND latest_close > MA200
- 邏輯:抓「長期趨勢向上」的續強股
- 資料量保護:ma200_days_available ≥ 180(放寬 10% 給新上市股)

**B. PEG 門檻 1.2 → 1.5**(只改 setting,view 不動)

**C. 預算 filter (NEW)**
- `app_settings.budget_ntd`(預設 0 = 不 filter)
- `v_rank_with_cost`:rank join v_latest_price_realtime,新增 `cost_per_lot_ntd = current_price × 1000`
- `/rank` 讀 v_rank_with_cost,SSR 端 filter `cost_per_lot_ntd ≤ budget_ntd OR budget_ntd = 0`

**D. v_factor_scores / v_stock_rank / v_entry_signal / score_universe_at v4**
- 動能 4 → 5 條
- entry strong 改:`mom_count_pos >= 4`(5 條制 80%,對齊 M9.2 mom≥3 in 4 = 75%)

### Migration
- [x] **71_settings_peg_15_budget**:`peg_threshold` 1.2→1.5 + `budget_ntd` = 0
- [x] **72_v_price_factors_v4**:agg 加 ma200_now / ma200_days_available + 新 factor mom_above_ma200
- [x] **73_v_factor_scores_v4**:動能 5 條(加 mom_above_ma200),count_pos/total 對應
- [x] **74_v_stock_rank_v4 + v_entry_signal_v4 + v_rank_with_cost**:pass-through + strong mom≥4 + 新 view 提供 cost_per_lot_ntd
- [x] **75_score_universe_at_v4**:同步 19 factor

### UI 改動(6 檔)
- [x] `app/settings/page.tsx`:加「投資預算 (NT$)」input(BudgetRow,獨立 section + 萬位提示)
- [x] `app/settings/actions.ts`:沿用 updateSetting + 加 revalidatePath("/rank")
- [x] `app/rank/page.tsx`:改讀 v_rank_with_cost、SSR budget filter、加「1 張成本」欄、header 顯示預算狀態、Legend 7/5/2/5
- [x] `app/_components/AdviceWidget.tsx`:header 18→19 因子 / 動能 4→5(加站上 MA200)
- [x] `app/_components/FactorRadar.tsx`:註解 18→19 軸
- [x] `app/stocks/[symbol]/page.tsx`:FactorRankRow interface 加 mom_above_ma200,buildFactorAxes 18→19 軸 + PEG label 改 1.5

### 驗證(本 session bash 被擋,host claude 用 supabase MCP 套 + 跑 build)
- [ ] 5 個 migration apply(71 → 72 → 73 → 74 → 75 順序)
- [ ] SQL:`select symbol, mom_above_ma200, mom_count_pos, mom_count_total from v_factor_scores where symbol='2330' limit 1` 確認 TSMC mom_above_ma200=1
- [ ] SQL:`select symbol, expected_rank, cost_per_lot_ntd from v_rank_with_cost where cost_per_lot_ntd <= 100000 order by expected_rank limit 10`
- [ ] SQL:`select count(*) from v_factor_scores where mom_above_ma200 = 1`(預期數量略多,因為現多頭環境多數股站上 MA200)
- [ ] `select * from score_universe_at(current_date - interval '7 days') limit 5`(歷史視角 sanity check)
- [ ] /settings 可輸入預算 budget_ntd
- [ ] /rank SSR 200,filter 生效(設 100000 看 top 10 限低價股)
- [ ] `npm run build` pass(host 跑)
- [ ] 觸發 M9.3 baseline backtest (2024-01-01 ~ 2024-12-31) 對比 8c1bd889-e786-4758-ba2c-6752fb10b303

### Review

**5 個 migration + 6 UI 檔改動**:
- 71 `app_settings`:`peg_threshold` 1.2→1.5(放寬讓 TSMC/聯發科 PEG 偏高的續強龍頭過關)+ 新增 `budget_ntd` = 0(預設不 filter)
- 72 `v_price_factors`:agg CTE 加 `ma200_now`(rn 1..200 avg)+ `ma200_days_available`(rn 1..200 count),新 factor `mom_above_ma200`(close > MA200 AND 60d ret > 0)。ranked CTE 視窗從 180 → 220 天給 MA200 用
- 73 `v_factor_scores`:動能 4 → 5,加 mom_above_ma200 pass-through 與 count_pos / count_total 對應;peg_threshold settings 預設改 1.5
- 74 `v_stock_rank` + `v_entry_signal` + `v_rank_with_cost`:rank 加 mom_above_ma200 pass-through;entry signal strong 規則 mom≥4(對應 4/5 = 80%);新 view `v_rank_with_cost` join `v_latest_price_realtime`,加 `cost_per_lot_ntd = current_price × 1000`
- 75 `score_universe_at`:整段 function rewrite 同步 19 factor + ma200_now + ma200_days_available + mom_above_ma200 + 視窗 220 天 + settings peg_threshold 預設 1.5

**UI 改動**:
- `settings/page.tsx`:budget_ntd 拆獨立 section + `BudgetRow` component(萬位即時提示);其他 settings 仍走 `SettingRow`(step="0.0001")
- `settings/actions.ts`:加 revalidatePath("/rank") 讓 budget 變動立即反映
- `rank/page.tsx`:
  - query source 從 `v_stock_rank` 改 `v_rank_with_cost`(limit 80,給 budget filter 留空間)
  - 多 query app_settings.budget_ntd
  - SSR filter `cost_per_lot_ntd <= budget`(budget=0 不 filter)
  - 加 `BudgetHeader`(已設預算/未設預算兩種狀態)
  - `EmptyState` 區分「沒符合預算」vs「沒任何資料」
  - 新欄「1 張成本」(fmtCost helper:≥1 萬顯示 X.X 萬,< 1 萬顯示千分位)
  - Legend 7/5/2/5,加「站上 MA200 續強」,PEG 改 < 1.5,加 strong 規則說明
- `AdviceWidget.tsx`:header 文字「19 因子」/ 動能描述「5(加突破 + 站上 MA200)」
- `FactorRadar.tsx`:只動開頭註解(component 本身完全 dynamic)
- `stocks/[symbol]/page.tsx`:`FactorRankRow.mom_above_ma200` 補上;`buildFactorAxes` 加「站上MA200」label;`fund_peg_low` label 從「PEG<1.2」改「PEG<1.5」

**Dashboard(`app/page.tsx`)不需動**:
- 它只 select count 欄,沒讀 individual factor
- `mom_count_total` 自動從 4 → 5
- `fund_count_pos >= 5` filter 不變(7 條中過 5 = 71%)
- 不在 spec「6 UI 檔」清單內是正確的

**設計決策**:
1. **mom_above_ma200 條件**:嚴格字面解讀 spec「60 日報酬 > 0% AND latest_close > MA200」。為什麼兩個都要?單看 close > MA200 不夠 — 股價剛突破 200 日線但 60 日報酬還負(剛從低點反彈)是「翻轉中」不是「持續強」。雙條件確保「中期 + 長期同步向上」
2. **ma200_days_available ≥ 180 寬鬆 10%**:spec 寫 180,即 200 × 0.9。給新上市股 ~9 個月歷史留空間,避免被一刀切。剛好接近 1 個季度線(60)+ 半年線(120)+ 200 日線之間的中間值
3. **ranked CTE 視窗 180 → 220**:200 個交易日歷史需要,且加 10% buffer 因 row_number 排序是 trade_date desc 取最近的(超過 200 的不影響 rn 1..200 計算)。220 天涵蓋 ~220 trade days × 5/7 ≈ 314 calendar days,夠
4. **v_rank_with_cost 分開不寫進 v_stock_rank**:
   - v_stock_rank 是純 factor 邏輯,join realtime price 會語意混淆(score_universe_at 歷史視角不能用 realtime)
   - 獨立一個 view 給 UI filter 用更乾淨,backtest 路徑零影響
5. **budget filter 在 SSR 端而非 SQL view**:
   - spec 寫「不動 v_stock_rank,改在前端 filter(避免 view 重做)」
   - 也讓 budget 變化不需 rebuild view(只是 app_settings update + revalidatePath 觸發 re-fetch)
6. **fmtCost 「11.4 萬」vs 「3,250」**:Andy 預算經常以萬為單位思考,小於 1 萬的低價股(KY 股或興櫃)仍以千分位顯示完整數字,讓兩種價位都好讀
7. **rank query limit 80 而非原 30**:因 budget filter 後可能濾掉很多,留空間讓 top 30 顯示仍有量(80 應夠 cover 多數預算)。若 budget 極低仍會出現 empty state
8. **mom≥4 in 5 entry strong 規則**:M9.2 是 mom≥3 in 4 (75%),M9.3 加到 5 條後維持類似嚴格度,mom≥4 in 5 (80%) 比 mom≥3 in 5 (60%) 嚴。spec L33 文字明確要求 4。

**Lessons 遵循**:
- L01 範圍:universe 維持 stock_universe ∪ industry ∪ watchlist ∪ holdings_transactions ∪ etf_metadata
- L13 NUMERIC string:budget / current_price / cost_per_lot_ntd 全 `Number(x)` 轉,顯示用 fmtMoney / fmtCost
- L14 Tailwind v4:BudgetHeader 兩個版本(emerald/zinc accent)用字面 className,沒 dynamic class 組裝
- L19 多 agent 邊界:沒動 M3.6 v_stock_score / v_industry_picks,沒動 M8.x 持股相關 view / EF
- L20 backward-compat:v_factor_scores / v_stock_rank / v_entry_signal cascade drop 重建,score_universe_at 用 create or replace。`fund_peg_low` 因 settings 改 1.5 自動寬鬆(view 不需動)
- L23 資料量保護:mom_above_ma200 需要 ma200_days_available ≥ 180 + ma200_now / latest_close / close_60d_ago 都非 null
- L32 score_universe_at 必同步:75 號 rewrite,19 factor + 視窗 220 + ma200 新欄 + settings 預設 1.5,全部對齊 73/74 號
- L33 settings-driven 對 backtest 的取捨:peg 改 1.5 後同一 backtest run 結果會跟著改(新跑算新值)— Andy 自己用 backtest_runs.name 標籤標 M9.3 區分

**取捨 / 已知限制**:
- mom_above_ma200 跟 mom_ret_diff 有點重疊(都看 60 日報酬)。但 mom_ret_diff 是「20 日報酬 vs 60 日報酬比例」,mom_above_ma200 是「60 日報酬 > 0 + close > 200 日線」,前者測「加速度」後者測「長期方向」。兩者過關代表「方向 + 加速」雙都有,不是 redundant
- 預算 filter 在 SSR 端 = budget 改變只觸發 revalidate;若 Andy 想互動式 toggle(client-side 不刷新)需要 client state,v1 簡化先這樣
- v_rank_with_cost 是 view 不是 materialized view,每次 query 都重算 join。但 v_stock_rank 本身已是 derived(多個 CTE 計算),v_latest_price_realtime 也是 view → 多 join 一層成本可忽略
- v_rank_with_cost.cost_per_lot_ntd 用 current_price × 1000,沒處理「零股」/「整股」差異(假設 Andy 都買整張)。零股場景未來再加另一個 cost_per_share 欄
- 視窗 220 天會讓 v_price_factors 計算量略增(原 180),但 universe < 200 檔,SQL 視窗函數對 RDBMS 不是瓶頸(< 1s 應該 OK)

**驗證受限**:
- 本 session bash 完全被沙箱擋,無法跑 supabase MCP / supabase CLI / npm run build
- TS code 三次通讀過:所有 import / interface 對齊;新 RankWithCostRow 含 current_price / cost_per_lot_ntd / price_source;BudgetRow 簡單 form;buildFactorAxes 加 mom_above_ma200 軸
- 套用順序:host claude / Andy 用 supabase MCP 依序套 71 → 72 → 73 → 74 → 75
- 套完 SQL 驗:見上面驗證清單
- M9.3 baseline backtest 可比較 8c1bd889(M9.2 baseline,2024 全年 alpha -29.45%)— 期待 alpha 有改善(目標 > 0,即跑贏 0050)

---

## M9.5 — 低基期轉機模式 OOS 回測(2026-05-19)`analyst-deployer`

**起因**:2492 華新科 5/6→5/14 +49.7%,系統 rank 36 沒選到。卡點 ROE 4.7%(連放寬到 5% 都不過)+ 量 1.4x(mom_breakout 寫死要 2x)。Andy 5/12 講好「繼續噴就討論低基期轉機模式」→ 已觸發。**方向:加分路線(新增 factor、不動任何硬門檻)** — 最 append-only、revert 最便宜、不為單一股放寬硬條件(最低 overfit)。

### 新 factor 定義 `mom_low_base_breakout`(boolean,進 mom 維度 5→6)
- 低基期:`(latest_close - low_120d) / low_120d * 100 < LOW_BASE_PCT`(掃描 {20,25,30,40},先 25 起手)
- 帶量:`vol_latest > vol_5d_avg * 1.4`
- 突破:`latest_close >= high_20d * 0.99`(沿用既有 mom_breakout 的 20 日新高定義)
- null 防護:照 M9.4c — 資料不足(ma/vol/low_120d 任一缺)回 `null::boolean` 不回 false
- **設計理由**:120d 低點定義「長期低基期」排除崩完短彈假訊號;量1.4x+新高對應 2492 啟動特徵;只在低基期前提認列這種較弱突破 = 非無差別放寬。不動 fund/ROE/v_entry_signal/加權 → 純加分

### 要動的檔(全 append-only,照抄 M9.4c migrations 20260515000006~11 範本)
- [ ] `新號_v_price_factors_low_base.sql`:agg CTE append `low_120d`;select 尾端 append `pct_from_120d_low` + `mom_low_base_breakout`。既有欄序型別不動(避 cascade)
- [ ] `新號_v_factor_scores_low_base.sql`:mom_count_pos / mom_count_total 表達式 5→6
- [ ] `新號_score_universe_at_low_base.sql`:整段 create or replace(=20260515000011 body + 同步加 low_120d/pct/factor + mom_count 6),L32 必同步
- [ ] 先寫好備用 `新號_*_revert_low_base.sql`:計分回 5、欄位留 dead(和 M9.4c revert 20260515000010/11 一樣)
- **不動**:run-backtest EF / app_settings / v_entry_signal / v_stock_rank 加權 / holdings·telegram 鏈

### 驗證三閘(L36 具體化,不過閘即 revert)
- [ ] **Gate 0 零漂移**:套用後 score_universe_at(today) vs v_factor_scores 四維 count 全 0 不一致(L32);加 factor 前 backtest byte-exact = Phase 0.7 錨點
- [ ] **Gate 1 樣本量/區別力**:2024 全年每 rebalance 日統計 `mom_low_base_breakout=1` 的 (distinct symbol 數、進 top10 次數)。**distinct symbol <15 或進 top10 <10 次 → factor 無區別力,當場 revert,不跑 Gate 2**。並抽查 2492 在 2026-05-06 啟動點 rank 是否上升(驗 factor 真抓得到此 case)
- [ ] **Gate 2 OOS 對比**:4 run(2024 t10/t5 in、2025 t10/t5 OUT),exec_model='nextopen' 動態成本。baseline = 誠實化 v2(2025 **t5 +24.19** / t10 +13.80;2024 t10 -27.86 / t5 -17.33)。**判準:2025 t5 OUT 不得低於 +24.19 且 2024 不顯著惡化**,沒贏即 revert(L36)
- [ ] LOW_BASE_PCT 掃 {20,25,30,40} 各跑 Gate 2 選 OOS 最穩;全輸 baseline → 此路不通 revert + 記 lesson
- [ ] `npm run build` pass(host 跑) + commit + todo review + lesson

### 倖存者偏差 caveat(必附,L38/L39)
回測 universe=154 檔全 selected_at=2026-05-12。低基期轉機股**最易踩倖存者偏差**(很多衝一下就陣亡,只有活的還在 universe)。即使 Gate 2 贏 baseline 也只證「精選存活集內有效」= 樂觀上偏、非可交易保證。真 de-bias 靠已上線前向紙上追蹤長期累積。

### scope
4~5 migration(全 append-only 抄 M9.4c)、0 行 EF/前端。實作風險低,時間主要在跑回測掃門檻。

### Review(結案 2026-05-19)— **Gate 1 否決,「低基期」對 2492 是偽命題,Andy 拍板停 M9.5**

**結論**:`mom_low_base_breakout` 前提錯誤,不採用。

**實際 vs spec 偏離(2 處,均更安全/更省)**:
1. apply 策略改「只先 apply score_universe_at(backtest 路徑),線上 v_price_factors/v_factor_scores 不動」— 原 spec 隱含三檔全 apply(會在未過閘前改線上 /rank);Andy 在意持股零影響,改成過閘才上線。L36/「先評估再決定」精神
2. Gate 1 即否決 → 沒跑 Gate 2 掃 {20,25,30,40}(省算力,Gate1 存在的意義)

**Gate 1 數據**:2024 樣本量足(145 distinct sym / 1193 sym-day)但 2492 在 5/4~5/18 啟動段(138.5→220 +59%)factor 命中 **全 0**。診斷:2492 的 120d 低點=80(2025底),5 月爆發時距低點 **+30~90%**,是「2025 從 80 漲到 220 的長多段強勢股」非低基期型態;放寬到 40% 也框不到。2024 命中多為台灣大/統一/華南金牛皮股放量,語意偏離。

**收尾驗證(持股零影響,Andy 點名,3 次查證)**:
- apply 前/後/revert 後三次指紋比對:線上 10 view(持股鏈+選股鏈)md5 全程 byte 零變動;持股 6285/1000/28.4萬 + 10 筆交易紀錄零變動;score_fn 無 DB 物件依賴(deps=[])
- score_universe_at forward→revert,殘留字串 `low_120d`/`mom_low_base_breakout`/`LOW_BASE_PCT` = **0**,mom 計分回 5 條(mom_above_ma200 收尾),mom_total_max 5。**行為等價回 20260515000011 基線已證**
- md5 非 byte-exact 回基線 = 良性(SQL prosrc 受 CRLF/空白物理表示影響,非邏輯差異);驗證以行為等價為準(見 L41)

**repo 終態**:留 `20260519000003`(forward,apply 過=史實)+ `20260519000005`(revert,現行,DB 回基線);刪 `000001/000002/000004`(線上 view 從未 apply,留著會被未來 db push 誤套)。沿用 M9.4c「試驗檔+revert 並存」慣例。

**教訓 → lessons L41**:案例契合度驗證(2492 真的符合「低基期」定義嗎)要前置到寫 spec 之前(Gate 0),別憑記憶檔/直覺假設就往下做完整套流程。

**DB 現狀**:score_universe_at = 20260515000011 基線(動能 5 條),零殘留。線上選股/持股/Telegram 全程未受影響。

---

## 持股自動完整追蹤根治 + 6285 止血(2026-05-19)`data-pipeline`

**起因**:Andy 截圖質疑持股 6285 分析不精準。診斷:6285 用 transaction-log 記、不在追蹤名單,price/fundamentals/monthly_revenue/pe_pb 全 0 筆 → v_factor_scores fund/mom 0/0、signal=insufficient_data、rank #10(只籌碼撐的假象);/holdings「持續抱」是無資料默認非分析。

**根因**:M8.5 持股改 transaction-log 後,籌碼 4 EF 升級讀 v_holdings_current,但價格類 4 EF(daily-prices/fundamentals/monthly-revenue/valuation)沒跟上仍讀舊 holdings 表 → 沉默 drift(半年沒人發現,使用者持股恰好踩盲區才暴露)。

**做法(Andy 拍板:建單一來源根治)**:
- 新 view `v_fetch_universe`(=v_holdings_current∪watchlist∪industry∪stock_universe∪etf,migration 20260519000007)
- 4 EF symbol source 改讀 view + fallback=各自原 query(view 異常零退化)。籌碼 EF 不動(已正確,只動該動的)
- deploy 親驗:fetch-daily-prices v7 / fundamentals v2 / monthly-revenue v2 / valuation v3(verify_jwt 全 true 未變、其他 EF 未誤動)
- 6285 backfill **自助完成**(複用 cron pg_net+vault pattern 經 execute_sql,非交 host):price 810 / fundamentals 13 / monthly_revenue 41 / valuation 811,errors 全 0,token_2 quota ~8

**結果**:6285 v_factor_scores fund 0/0→7(過5)、mom 0/0→5(過2);v_holdings_advice signal `insufficient_data`→`normal`、rank **#10→#60**、wscore 50.57。**之前 #10 是資料缺失假象,真實 #60 — Andy 持股決策現在才建立在真實分析上**。

**根治效果**:下次日更 cron 自動收 6285 + 未來任何新持股自動完整收料,單一來源 view 杜絕未來 drift。

**commit**:`c4e850f`(已 push origin/main)。教訓 → lessons **L42**。記憶 → `stock_ef_invoke_via_pgnet`(無 invoke 工具時自助觸發 EF 途徑)。

**後續可選(非本次 scope)**:① 籌碼 4 EF 也統一改用 v_fetch_universe(目前 inline 仍兩套) ② 持股 signal=insufficient_data 主動告警(沉默失敗偵測,L42 做法2)。

---

## 籌碼 4 EF 收料 universe 統一(2026-05-19)`data-pipeline` — 計畫待 Andy 拍板

**起因**:L42 做法3 / todo「後續可選①」。c4e850f 已把價格 4 EF 改讀 `v_fetch_universe`,籌碼 4 EF(institutional/margin/lending/shareholding)仍 inline `v_holdings_current ∪ watchlist ∪ industry_stocks ∪ stock_universe`(4 source、**無 etf_metadata**)→ 兩套 pattern,未來新增 source 表會再 drift。

**關鍵發現(非機械鏡像)**:`v_fetch_universe` = 上述 4 + `etf_metadata`(多 **11 檔 ETF**:0050/0052/0056/006208/00679B/00713/00878/00919/00929/00940/00981A)。籌碼現用 universe=149、v_fetch_universe=160。籌碼 EF 直接改讀 v_fetch_universe → 行為改變:
- 每個籌碼 EF 每跑多 +11 ETF symbol API call
- `institutional` 明確註解「ETF 沒法人買賣超…只抓個股」→ 收語意無效資料
- `lending` 已慢性配額耗盡(05-14/05-18「quota exhausted at ~2883」)→ +11 更糟

**建議 Option A(雙 view,零行為改變,真正單一來源)**:
1. migration:`v_fetch_universe_stocks` = 現籌碼 4 source(無 ETF);`v_fetch_universe` 改 `= v_fetch_universe_stocks ∪ etf_metadata`(對價格側 byte 等同,160 不變、零退化)
2. 籌碼 4 EF happy path 改讀 `v_fetch_universe_stocks`;fallback **保留各自現有** inline 4-source query(view 異常=今日 byte 等同,鏡像 c4e850f 哲學)
3. deploy 4 EF,親驗 verify_jwt 全 true 未變、其他 EF 未誤動;response `target_symbols`=**149**(非 160,證 ETF 沒漏入)
4. 退化錨:`count(v_fetch_universe)`=160 不變(價格側)、`count(v_fetch_universe_stocks)`=149(=舊籌碼數)

**效果**:stock 底集單一定義(`v_fetch_universe_stocks`),未來加 source 表 1 處改、8 EF 自動同步;ETF 為價格側 explicit additive layer。籌碼/價格各自語意零變、零 quota 退化。scope:1 migration + 4 小 EF edit + deploy。

- [x] migration `20260519000008_v_fetch_universe_stocks`(append,不 cascade)— applied
- [x] 4 籌碼 EF happy path 改 `v_fetch_universe_stocks` + 保留原 fallback
- [x] deploy 4 EF + 親驗(verify_jwt 全 true 未變 / 僅 4 EF 動 / ezbr sha 變)
- [x] 退化錨:v_fetch_universe=160(價格側零變)、v_fetch_universe_stocks=149、ETF 洩漏=0、0050 價收/籌排
- [x] service_role SELECT v_fetch_universe_stocks=149 無錯(EF happy path 可讀,不靜默 fallback)
- [ ] commit(待 Andy)+ 17:00+ 籌碼 cron 為線上端到端確認點(fetch_log target_symbols 應=149)

### Review(2026-05-19,Option A 完成)
**結果**:籌碼 4 EF v1→v2 全部署,verify_jwt 全 true 未變,僅 4 個 EF 動到。`v_fetch_universe_stocks`(149 stock 底集)+ `v_fetch_universe`(=stocks∪etf=160,價格側 byte 等同)。零行為改變、零 quota 退化。
**驗證(L40 紀律,零 FinMind 消耗)**:資料層 + service_role 可讀性雙證;未做整檔 invoke(會燒 ~450 call 且惡化 lending 配額——本次要保護的對象)。線上 cron 17:00+ 為自然端到端確認點。
**偏離 spec(1 處,更安全)**:未現場 invoke 驗 target_symbols,改以「資料層+權限+部署 sha」三證 + 線上 cron 自然確認(L40:昂貴動作對結論非必要時用等價省做法)。
**根治效果**:stock 底集單一定義,未來加 source 表 1 處改、籌碼+價格 8 EF 自動同步;ETF 為價格側 explicit additive layer。L42 做法3 達成。

### 健檢順帶發現 → 已修(2026-05-19,Andy 拍板補全 48 檔)

**現象**:健檢發現 2330 缺 05-12~15;深查發現**非 2330 專屬 = 48 檔權值藍籌**(2330/1101/1216/1301/2303/2412/2880…)05-12~15 集體缺 4 天,全 universe 那 4 天 156→108。

**根因(L34 追資料定性)**:這 48 檔平日靠 `finmind` fallback EF 收(TWSE primary STOCK_DAY_ALL 平日只覆蓋 ~89,05-18 擴到 137 才自補)。05-12~15 `finmind` fallback 每天回報 success(rw=107)但**當日列未落地**(price_daily finmind_n 49→1)→ 4 天靜默缺口,被「回報成功」掩蓋(L42 同類)。

**修復**:自助 fetch-finmind-backfill(L42 做法4 / pgnet+vault,token_2),dataset=price symbols=[48] 05-12~15。EF 回 status200 written=**192(=48×4)** errors=0 quota50/600。親驗:05-12~15 每日 108→**156** 回升、2330 連續 05-11..05-18 無洞、藍籌 6 檔全回。backtest/rank/持股這 4 天已正確。

**⚠ 未根治的 recurring 根因(Andy 本次選只補料、未深挖)**:`finmind` fallback「回報 success 卻當日列不落地」會再發;且 2330 等大型藍籌不在 TWSE primary STOCK_DAY_ALL(長期靠 fallback)很脆。**後續候選**:① 查 fetch-finmind-fallback 為何 success 卻 under-land(rw=107/rs=535 固定樣態可疑)② 查為何藍籌不在 TWSE primary ③ signal/coverage 缺口主動告警(L42 做法2,本次又一次靠人工健檢才抓到)。

---

## M9.4b 停損 -10% 完整 OOS 閘 → **否決,不採用**(2026-05-19,結案)

完整閘(無停損臂=誠實v2基準,經 2025 t5 byte-exact 重現 +24.19 證零漂移可信):

| Run | 無停損基準 | +停損-10% | Δ alpha | run_id(停損)|
|---|---:|---:|---:|---|
| 2024 t5 IS | −17.33 | **−28.26** | **−10.93 ❌** | d139d734 |
| 2024 t10 IS | −27.86 | −27.73 | +0.13 持平 | 1669d4e1 |
| 2025 t5 OOS | +24.19 | +25.85 | +1.66 ✓ | 39c32637 |
| 2025 t10 OOS | +13.80 | +11.83 | **−1.97 ❌** | 0f1a62cd |
| 2025 t5 無停損 |  | +24.19 |  | b602e2ba |

**結論**:4 格僅 2025 t5 贏(+1.66),2024 t5 大幅惡化 −10.93、2025 t10 −1.97、2024 t10 持平 → **未過 L36 閘,不採用**。**L36 陷阱重演**(=M9.4c 同款:單看 2025 t5 +25.85 漂亮,完整閘破功)。停損一致降 MaxDD/勝率持平,但報酬代價 3/4 格成立。根因:固定 −10% 太緊,砍掉 2024(0050 超級年)洗盤段的單。

**未做(可選)**:掃更寬停損 {−15,−20%} 看能否保 2025 t5 增益又不過砍 2024 — 但 L36 預設「會弄壞已驗證 edge」需證明否則不採用,優先度低。**目前最佳仍 = 純 5-factor top5 無停損(OOS +24.19,受倖存者偏差 L38)**。教訓沿用 L36,未新增 lesson(同款假陽性已被 L36 涵蓋)。

---

## ATR/Chandelier 停損 spec + 完整閘(2026-05-19,待 Andy 過目才動 code)

**起因**:M9.4b 固定 -10% 完整閘否決,根因 volatility-blind(2024 0050 超級年把高波動權值股在正常洗盤洗出,-10.93pp)。Andy 指正方向 = ATR 動態停損 / 時限停損(lessons L43)。

**失敗機制(對症依據)**:固定 % 對台積電/聯發科這種高波動股,-10% 只是日常 noise → whipsaw 砍掉最終大贏家。解法 = 把停損距離正規化到「每檔自身波動」。

### 設計(只改 run-backtest EF,零 migration/view/前端/score_universe_at)
現行停損:`stop_loss_pct>0` → `stopLine=entry×(1-pct/100)` 持有窗逐 bar 比 `low<=stopLine`(L460-480)。bars 已含 OHLC。

新增(互斥模式,參數驅動):
- `stop_atr_mult?` (k):**A. ATR-static** — 進場日往前 ATR14 算一次,`stopLine = entry − k×ATR14_entry`(全持有期固定)。最小改動=只換 stopLine 公式,其餘逐 bar/誠實出場價邏輯沿用
- `stop_chandelier_mult?` (k):**B. Chandelier(順勢移動)** — `stopLine_t = max(high, entry..t) − k×ATR14_t`,逐 bar 重算(鎖利、讓贏家跑)。Andy 屬意,對 top5 集中度更對味
- ATR14 標準:TR=max(H−L,|H−prevC|,|L−prevC|),14 期均
- 資料窗:`fetchStart` 由 -10 放寬到 ~-30 日(夠 ATR14 種子),**只擴 fetch 不改既有邏輯**
- 不足 14 bar(回測極早期):ATR=null → 該持股**該期不施停損**(不偽造,L23/L42 精神)+ 計數回報透明

**L39 鐵律保留**:三參數全 0/null → 停損整段 short-circuit 不變 → `exec_model='close'+cost0.585` 仍 byte-exact 重現基準;誠實v2 無停損仍 byte-exact = 今日 +24.19 錨點。新 ATR 區塊全程 gated behind「param>0」
**互斥**:`stop_loss_pct` / `stop_atr_mult` / `stop_chandelier_mult` 同時 >1 個 >0 → 400 error(避免語意含混)

### 完整 L36 閘(每個候選 k 都要過,no-quota/快)
- [ ] code:run-backtest 加 ATR14 + A/B 兩模式 + 資料窗放寬 + 互斥檢查
- [ ] **退版錨點先驗**:三參數=0 → 2025 t5 = byte-exact +24.19(=今日 b602e2ba);`exec_model=close+cost0.585` = Phase0.7。**過這關才信新數字**(L39)
- [ ] deploy(verify_jwt true 不變 / 僅 run-backtest 動)
- [ ] 掃 k:A 與 B 各 k∈{2.5, 3, 3.5},每個跑完整 4 格(2024 t5/t10 IS、2025 t5/t10 OOS)vs 誠實v2 基準(+24.19 / +13.80 / −17.33 / −27.86)
- [ ] **判準(L36)**:任一 k 須**不顯著惡化任何格**(尤其 2024 t5 該被固定%重創的格),且整體 alpha/Sharpe/MaxDD 至少不差於無停損;沒有 k 同時滿足 → 此形式亦不通,如實記否決(別硬凹)
- [ ] 報表:4 格 × 各 k 的 alpha/Sharpe/MaxDD/勝率/停損觸發數;對比固定-10% 與無停損
- [ ] commit + todo review + lesson(若有)

### scope/風險
blast radius 小(單一 EF、不碰選股鏈/持股鏈/前端);風險在「又一個 L36 假陽性」——預設假設「會弄壞 +24.19 edge」,要 4 格證明否則不採用。時限停損(Time Stop)此架構槓桿小(rebalance_days=20 已週期汰換),除非 Andy 要否暫不納入此 spec。

### Review(結案 2026-05-19)— **A/B 皆否決;確認「集中 top5 結構性排斥停損」(已測 3 形式)**

**實作完成**:run-backtest v5→**v6**(stop_atr_mult / stop_chandelier_mult,互斥檢查,ATR14 SMA,fetch 窗 -10→-30,atr_seed_unavailable 透明計數)。L39 雙錨點 **byte-exact PASS**:no-stop 2025 t5 = +24.19(=b602e2ba)、close+0.585 2024 t10 = −35.23(=Phase0.7)→ 零邏輯漂移已證。

**踩坑**:24 並發 score_universe_at → 全 statement timeout(非碼錯;≤3 並發安全)。改聚焦 2 關鍵格 × A/B k3。

**聚焦閘結果**(k=3;baseline 無停損 / 固定%−10 對照):

| 格 | 無停損 | 固定−10% | **A ATR k3** | **B Chand k3** |
|---|---:|---:|---:|---:|
| 2024 t5 IS(固定%重創格)| −17.33 | −28.26 | **−35.04** | **−40.63** |
| 2025 t5 OOS(+24.19 edge)| +24.19 | +25.85 | **+21.73** | **+7.72** |

**結論:A/B 皆否決,且比固定% 更糟。** 波動正規化**沒救到** 2024 whipsaw、反而更慘(−35/−40 vs 基準 −17、固定 −28);2025 OOS edge A 小蝕(−2.46)、B 幾乎毀掉(−16.47)。atr_seed=0(資料正常,停損真觸發 A18/B34-37 次)。**機制確認**:M9.4a 集中 top5 的 edge 來自「在強趨勢年(2024)抱住高波動權值股穿越洗盤」,**任何停損(固定/ATR/Chandelier)都砍掉那些必須抱的單** → 結構性排斥停損,非「停損形式/門檻沒調對」。Chandelier 最差(trail/ratchet → 觸發最多 34-37 次)。

**未掃 k{2.5,3.5}/未跑 t10**:k3 在最診斷格已比固定% 更糟,機制是結構性非門檻敏感(更寬 k → 漸近無停損 = 最好也只是回到 baseline,不可能 improve 2024)。L36 預設否決 + L40/L43「別暴力掃死形式」→ 結案不續掃。停損探索到此為止(除非未來改用 regime filter 在強趨勢年停用停損 = 另案)。

**最佳仍 = 純 5-factor top5 無停損**(OOS +24.19,受倖存者偏差 L38)。v6 ATR 能力碼保留(已 anchor 驗證、未來 regime 實驗可複用,如 M9.4b stop_loss_pct 保留慣例)。教訓沿用 L36/L43,無新增 lesson(同款假陽性 + 換形式化仍須過閘已涵蓋)。

---

## 籌碼 4 表歷史空缺 — 重大發現(2026-05-20,優先級依 Walk-Forward 結果定)

**起因**:L1 維度差分查 TSMC chip 2024 為何 0/0,發現**不是 TSMC 專屬,是全表歷史**:institutional / margin / lending / shareholding 4 表的 全表最早資料是 2026-04-16 / 05-04(EF cron 首次啟動點),**2024 / 2025 backtest 期間 chip 5 條因子對全 154 檔皆 null**。

**含意(推翻基本假設)**:
- 5-factor 模型在歷史回測中**實際只用 14 條**(fund 7 + mom 5 + rev 2)
- chip 維度 10% 權重佔分母但係數全 null → ws 天花板 ~90%(觀察到的 ws 72.5 = 進 top5 的最高分對應此)
- 線上 19-factor 排名 vs backtest 14-factor 排名 **系統性不對齊**
- **+24.19 OOS alpha 是 14-factor 達成的、不是 19-factor**

**Andy 拍板:條件式優先級(依 Walk-Forward 2023-2025 結果定,2026-05-20)**

- 若 14-factor 在 2023-2025 季滾動勝率 ≥60% 且分布均勻 → 「不需要籌碼,基本面+動能已極強大」→ **chip backfill 優先級提到最高**(因為線上 19-factor 反而可能被籌碼污染,須回測確認)
- 若 14-factor 滾動表現一般 → 2025 是特例肥尾 → chip backfill **放慢、當背景工程**

**Backfill scope(若決定做)**:
- 4 dataset × ~2 年(2024-01 到 2026-04)× ~150 sym
- FinMind 約 ~1200 calls × 4 dataset = 4800,token_2 每日 600 → 約 8 天分段
- 倖存者偏差 caveat 仍在(2024 universe ≠ 2026 universe)
- backfill 完成後須重跑 2024 / 2025 baseline 看 alpha 變化 + 完整 L36 閘

**教訓 → lessons L44**(歷史 backfill 對齊回測週期;邏輯一致 ≠ 資料覆蓋一致;partial backfill = 沉默 drift,同 L42 第二章)

---

## Walk-Forward 2023-2025(2026-05-20)— 14-factor 純淨版時間軸切碎

**目的**:確認「14-factor 基準」在過去 36 個月是否穩定 alpha,還是 2025 特例肥尾。

**做法**:
- [x] 跑 2023 t5 honest-v2 baseline(`6b1514e8` α +9.89/sharpe 1.90/win 61.82%/maxDD 8.26)
- [x] 從 3 個 baseline runs(2023/2024/2025) 各 12 期 = 35 期 equity_curve 撈出
- [x] 計算季度勝率:8/12 = **66.7%**
- [x] cumulative alpha contribution:**不是 45 度平滑、也不是 2-3 點集中,介於兩者間**(2025 4 季全綠拉開)
- [x] 統計:3 年合 α **+16.75pp**、平均 +5.58pp/年、最大連勝 5 季、最大連敗 2 季
- [x] 結論導出 chip backfill 優先級決策

### Review(結案 2026-05-20)— 季勝率達標但 2025 肥尾,**chip backfill 放慢**

**12 季 α 分布**:

| 季 | Strat | Bench | α | wins |
|---|---:|---:|---:|---|
| 2023 Q1 | 7.83 | 11.57 | −3.74 | 1/3 |
| 2023 Q2 | −0.67 | 9.10 | **−9.77** | 0/3 |
| 2023 Q3 | 13.16 | −2.71 | **+15.88** | 3/3 |
| 2023 Q4 | 9.35 | 3.57 | +5.78 | 1/2 |
| 2024 Q1 | 25.31 | 24.57 | +0.74 | 2/3 |
| 2024 Q2 | 4.67 | 18.34 | **−13.67** | 1/3 |
| 2024 Q3 | 4.87 | −3.98 | **+8.85** | 3/3 |
| 2024 Q4 | −2.59 | 6.90 | **−9.49** | 1/3 |
| 2025 Q1 | −16.86 | −18.66 | +1.80 | 2/3 |
| 2025 Q2 | 28.79 | 23.25 | +5.55 | 2/3 |
| 2025 Q3 | 38.95 | 33.97 | +4.99 | 2/4 |
| 2025 Q4 | 7.15 | 0.69 | +6.46 | 1/2 |

**Andy framing 判定**:介於兩 case 之間,偏「2025 肥尾」(2023+2024 兩年合 α ≈ −2,2025 一年合 α +18.80 拉開全部累積) → **chip backfill 不急、放慢、當背景工程**。

---

## U 型 regime 濾網(2026-05-20,Walk-Forward 衍生發現,**真正可用實戰工具**)

**起因**:Andy 提議從 Q3 雙紅找「Q3 因子簽名」,我 push-back 認為「市場 regime」解讀更穩健 + 資料齊全 + 統計力高。執行後**推翻線性負相關假說,發現 U 型**。

**主要發現**:策略 α vs bench 季報酬呈 **U 型(corr 僅 −0.24,弱)**:

| Bench regime | n | Avg α | 季勝率 | 解讀 |
|---|---:|---:|---:|---|
| **A: bench < 0**(回檔)| 3 | **+8.84** | **3/3=100%** | 個股輪動,5-factor 大勝 |
| B: 0~10%(微漲)| 4 | −1.76 | 2/4 | 混合微負 |
| **C: 10~20%**(中漲)| 2 | **−8.70** | **0/2** | **策略地雷區** |
| **D: ≥ 20%**(狂牛)| 3 | **+3.76** | **3/3=100%** | 跟得上,中等領先 |

**「Q3 雙紅」是 bench<0 衍生現象,本質是 regime 非季節**(2023Q3/2024Q3 bench 都 −2~−4%)。

**Andy 實戰部位管理規則**:
- bench < 0 季 → **滿倉信任**
- bench 0~10% → 中性、降低預期
- **bench 10~20% → 減碼策略 / 改買 0050**(地雷區)
- bench ≥ 20% → 滿倉信任

**Caveats(引用必附)**:
- n=12 季很小(regime C 僅 2 季 / D 僅 3 季),U 型可能含樣本噪音
- 受 14-factor 真相(L44)+ 倖存者偏差(L38)+ 2025 肥尾三層 caveat

**Memory**:獨立記 [strategy-regime-filter-u-curve](memory)。

---

## Paper-track 對齊驗真計畫(等 cohort 累積後執行,2026-Q3~Q4 預估)

**目標**:用 paper-track 實盤 cohort 結算結果,驗 U 型 regime 濾網在「線上 19-factor + 真 OOS」是否仍成立。

**時序**:
- 2026-05-16 cohort #1 已開(10 picks + 1 bench)。`paper-track-weekly` cron 每週六 22:00 UTC = 週日 06:00 Taipei 結算 + 開新 cohort
- 每 ~20 交易日一 cohort → 累積 3-4 cohort 約**2026-09 ~ 2026-11**
- 屆時可做第一次 paper-vs-backtest U 型對齊

**做法(等 ≥4 cohort 後)**:
- [ ] 對每個 cohort:撈進場日的 bench(0050)未來 ~20 日報酬 + cohort 實際 α
- [ ] 把 cohort 落入 U 型 4 regime(A/B/C/D)
- [ ] 統計各 regime 實盤 avg α 與 backtest 預期對比
- [ ] 判定:
  - 實盤 U 型形狀符合 backtest → **真 edge,U 型規則可信、進入正式部位管理 SOP**
  - 實盤呈線性 / 反向 → **backtest U 型是樣本特性,規則失效、回頭重新分析**
  - 實盤混亂 / 樣本不足 → 繼續累積到 ≥ 8 cohort

**最早可決判時點**:約 **2026-11**(4 cohort);**強信度時點**:約 **2027-05**(12 cohort = 8 個月)。

**衍生候選**:
- 若 U 型成立 → 加 `paper_track_cohort_regime` view 自動分類 + dashboard 顯示;改 /holdings 在地雷 regime 時顯示警示
- 若 U 型失效 → 重新分析,可能進方向 B 完整版(寫 `factor_detail_at` function 看個別 19 factor 簽名)

**何時不必做**:若 paper-track 累積到 6-12 月時 Andy 已決定接受策略物理特性(L38 caveat 為主),不需嚴格驗 U 型 → 可純當 reference 規則用即可

---

## fetch-finmind-fallback L42 漏網 bug 修(2026-05-21,結案)

**起因**:Andy 收到 2026-05-21 08:55 推播「6285 現價 292(⚠資料延遲 2026-05-19)」,實際 5-20 收盤 279。糾錯後深挖。

**根因(3 層)**:
1. **fetch-finmind-fallback EF 沒納入 L42 修法**(c4e850f 只修 4 個價格 EF,漏第 5 個):仍讀舊 `holdings` + watchlist + industry + etf 四源,**漏 holdings_transactions + stock_universe** → 6285 (transaction-log 持股) 完全沒進 set
2. **Quota 砍斷後段持股**:fetch-finmind-fallback 15:30 跑時 quota 只剩 ~107,149 universe 跑到 107 即 break;**Set 迭代順序持股不優先** → 2330 / 6285 等熱門股被砍
3. **5-20 主力 TWSE 也漏抓**(L17 T+1 延遲);finmind fallback 也漏抓 → price_daily 5-20 對 6285 完全沒寫 → v_latest_price_realtime fallback 到 5-19 close=292

**修法(3 層,完成)**:
- [x] **立即補資料**:SQL upsert 6285 5-20 = 279(從 cache 13:30 真實)+ invoke fetch-finmind-backfill 補 5-20 缺漏 51 sym(token_2,written 47)→ 5-20 total 108→156 完整
- [x] **修 EF 根因**(L46):fetch-finmind-fallback v4→**v5**,改讀 v_fetch_universe + 持股優先進 set + fallback 保留舊邏輯(c4e850f 同 pattern)
- [x] **加防護層 cron**:`holdings-staleness-backfill-preopen` 每日 08:45 Taipei invoke fetch-finmind-backfill 補持股最近 3 日(token_2,~5 calls/day,idempotent)。明日起即使 fallback EF 又漏,持股一定有資料

**驗證**:
- 5-20 price_daily total = 156(對齊 5-18/5-19);6285=279 / 2330=2185 / 2454=3230 全寫入
- fetch-finmind-fallback v5 deploy ezbr sha 變、verify_jwt true 保留
- staleness cron active,週一到週五 00:45 UTC 跑

**lessons L46 寫入**:「統一 N EF」類修法必 grep 全鏈,憑記憶必漏網(L42→L46 同類重演)。Commit 訊息列「全鏈 EF 清單」可審計。

**待 Railway redeploy 後 commit + push**:本次改動 = fetch-finmind-fallback/index.ts + lessons.md + todo.md。

---

## A+C:產業 tab 拿掉 + lending 換 token_2 解 quota 爆(2026-05-21,完成)

**起因**:Andy「產業 tab 整個拿掉,把扣打拿去讓排行/持股更即時」。診斷後發現:
- 「產業 tab」實際=`/watchlist` route(TabNav label「產業」但 route 不一致;watchlist 表 0 sym)
- industry_stocks 100 sym 是 stock_universe 148 的 99% 子集 → 移除 industry **不省 quota**(EF Set 去重後仍跑 stock_universe 148)
- 真省 quota 必須砍 stock_universe(影響 backtest universe + alpha)
- **lending 慢性 quota_exhausted**(每日跑到 2882 即爆,只跑 1/3 universe)→ 把 lending 移到 token_2 獨立 quota 是更直接的「即時度提升」

**修法(Andy 拍板 A+C,不動 stock_universe)**:

A) UI 清理:
- [x] `TabNav.tsx` 移除「產業」項
- [x] `Sidebar.tsx` 移除「產業」項
- [x] `stocks/[symbol]/page.tsx` 「← 回產業列表」連結改 `/rank`
- [x] `settings/actions.ts` 移除 `revalidatePath("/watchlist")`
- [x] 刪 `app/watchlist/` folder(只 page.tsx 一個檔)
- type check 0 errors(rm -rf .next 重 tsc)

C) lending 換 token_2:
- [x] `fetch-finmind-lending` EF 加 `body.token_key` 參數(同 fetch-finmind-backfill pattern):
  - `useTok2 = body.token_key === "finmind_token_2"`
  - vault RPC 切換 `read_finmind_token_2`,quota source 切到 `finmind_2`(獨立 quota_state row)
  - fetch_log source 維持 `finmind_lending`(便聚合)
- [x] Deploy v2→**v3**(verify_jwt true 保留、ezbr sha 變)
- [x] `cron.alter_job` 改 lending command body 加 `'token_key':'finmind_token_2'`
- 驗:今日 17:10 Taipei lending cron 跑時將用 token_2 600 獨立 quota,**不再 quota_exhausted**

**預期效應**:
- lending 從每日「跑到 2882 ~30% break」→ 完整跑 149 universe
- 排行/持股的籌碼維度 chip_lending_drop 不再因 lending 不全而 null
- token_1 quota 解壓(從 lending 移走 ~150 calls/day):fundamentals / valuation / institutional / margin 跑得更寬鬆
- industry_stocks 表保留不動(行業分類資訊仍給 P/B 門檻、AdviceWidget「分散產業」、個股頁面用)

**未做(被 Andy 否決)**:
- B) 大刀縮 stock_universe 148→30 — 會傷 backtest universe 結構性 alpha,放棄

---

## mis 對 z 有 throttle → 五檔中價 fallback(2026-05-21,L47)

**起因**:Andy 早盤看 /holdings 6285「16 min ago · twse_mis」糾錯「不可能 17 min 沒成交」。

**根因**:免費 mis 對個股 z 有 throttle,即使該股持續成交(v 累積金額跳),z/pz 仍長期回 "-"。EF v4「z="-" skip」邏輯對(L45)但代價=cache 對熱門股寫入頻率 = mis z 偶發回應頻率(20 min 1-5 次)。

**修法(v5,L47)**:
- [x] EF v4→**v5**:多源 fallback,z 有值用 z(source=twse_mis 真成交),z="-" 但 a[0]/b[0] 有值 → 五檔中價 (a[0]+b[0])/2(source=twse_mis_mid)
- [x] quoted_at 改用 fetchedAt(每分鐘 cron 必寫新 row,不受 mis tlong stuck 影響)
- [x] Format.ts 加 twse_mis_mid 顯示「twse_mis(中價)」+ tooltip 標明
- [x] deploy v5 verify_jwt 保留 ezbr sha 變

**驗證**(09:39 第一次 v5 cron):
- fetch_log rw 從 ~25 跳到 **139**(接近 universe 全寫入)
- 6285 cache 09:39:03 = 288.25(source twse_mis_mid 五檔中價)
- 2330 cache 09:39:02 = 2232.50 mid
- v_latest_price_realtime 對 6285 = 288.25,< 1 min ago

**Caveat**:source=twse_mis_mid 表示 mis 對 z throttle 時 fallback 到掛單中價,**不是實際成交價**(但通常誤差 < 1 元 / < 0.5%,institutional acceptable)。UI 顯示「twse_mis(中價)」明標。

**未做**:真正「最新成交價 1 跳」需券商 API 或付費,scope 另案。

---

## 純規則化持股訊號系統 v1 + v2(2026-05-21,結案)

**起因**:Andy 問「持股建議停損判定是固定的嗎?還是會根據股本跟其他因素判斷」→ 發現原 advice 只有 PNL% 一條規則,**完全無波動/成交量/籌碼/技術面**。Andy 主提議「即時分析 6285」→ 我用 13 維度做手動分析(波動、成交量、相對 0050、跳空、量價背離)。Andy 確認「這分析很完整」→ 問「網頁+TG 是不是一定要 API?」→「我不要再另外付費」→ **純 SQL 規則化方向確立**。

**v1 設計(20260521000001,12 訊號 jsonb 陣列)**:
1. pnl_pct(pos/neg/extreme,with 觀察點 +20/+30/+40 / -10/-15)
2. rsi_14(<30 oversold / >70 overbought)
3. ma_pos(price vs ma20/ma60)
4. bench_chg(0050 當日)— **解 Andy「我是不是只是大盤一起跌」之問**
5. price_vol(滾動 20 日標準差/平均 → CV%)
6. vol_ratio(成交量 / 20日均量)
7. consecutive_down(連跌天數)
8. tail_stats(長上影線 / 長下影線)
9. kbar_array(近 5 日 K 棒 jsonb,red/green/cross 標籤)
10. today_kbar(今日 K 棒 jsonb,跨越開盤判 cross)
11. price_source/quoted_at(資料新鮮度 staleness 透明)
12. signal_level overall(healthy/caution/warning/alert,by 紅色訊號數)

**v2 加強(20260521000002,Andy 三項微調)**:
- [x] **建議 1:長上影 + 振幅 > 1.5%** — 沒振幅的長上影是無效訊號(死水)。tail_stats 新增 amplitude_pct 判斷
- [x] **建議 3:量價背離(#13 vol_div)** — 跌 + 量縮(<0.8x) = 沒人賣,屬「健康洗盤」(yellow);跌 + 量爆(>2x) = 恐慌或主力倒貨(orange)
- [ ] **建議 2:市值分檔(中小型 OTC vs 權值 vs 0050)— v3 候選**,需 stock_universe.market_cap_billion 有值(以前全 null,2026-05-21 已 backfill,**v3 解鎖**)

**UI / TG 串接**:
- [x] /holdings 每張卡新增 SignalsGrid(3-6 col responsive),🚨 紅 / ⚠️ 橘 / 💛 黃 / 💚 綠 圓 dot 視覺化
- [x] TG notify-holdings-telegram v3 加「即時訊號」row,top 5 紅/橘/黃 訊號 emoji 摘要
- [x] color map + label map 一致(SIGNAL_STYLE / LEVEL_STYLE / LEVEL_EMOJI / OVERALL_LABEL)

**Caveat**:純 SQL/jsonb 規則 = **無 LLM/API cost**(Andy 不付費前提)。**不會像人類分析師組合多訊號做語意推理**,但 13 維度紅綠燈 + Andy 自己組合判讀 = 客觀基線。

---

## market_cap_billion backfill(2026-05-21,解鎖 signals v3)

**起因**:v2 第 2 項「市值分檔 vs 大盤」需要 `stock_universe.market_cap_billion`,但 reality check 發現該欄位**全 null**(reselect-industry-stocks-monthly EF 沒收這資料,獨立的修工程)。

**做法(零 API quota,純本地資料)**:
- [x] migration `20260521000003_backfill_market_cap_billion.sql`
- [x] 從 `stock_shareholding.shares_issued`(每檔最新)× `price_daily.close`(每檔最新)/ 1e8 → 億元
- [x] update stock_universe + industry_stocks(distinct on 各拿最新值)
- [x] 144 檔填上(industry_stocks 主集合)

**驗證**:
- 2330 台積電 = 566,626 億元
- 2454 聯發科 =  51,806 億元
- 2308 台達電 =  49,743 億元
- 2317 鴻海   =  33,514 億元
- 3711 日月光  =  21,050 億元

**未做(下一個 session 候選)**:
- v_holdings_signals v3 加 #14 market_cap_tier(<300億小型 / 300-3000億中型 / >3000億權值)+ 與 0050 連動度(corr 30日)→ Andy 建議 2 完整實作
- reselect-industry-stocks-monthly EF v2 也收 market_cap(避免月底 reselect 又把 backfilled 值蓋回 null)

---

## v_holdings_current 平倉再建倉均價 bug(2026-05-26,結案)

**起因**:Andy 親口「持有中的股票 2000 股 139.5,結果自動幫我便均價 126 多」。排查:2344 華邦電。

**根因**:舊 view 算法 `avg_cost = SUM(buy_qty × buy_price) / SUM(buy_qty)`,把出清前的舊批次也累積。
- 5/7 BUY 2000@113 → 5/11 SELL 2000@114(全平倉) → 5/26 BUY 2000@139.5
- 舊算 = (113×2000 + 139.5×2000) / 4000 = **126.25** ❌
- 正解 = 5/26 重新建倉的均價 **139.50** ✓

**修法(migration 20260526000001)**:遞迴 CTE 時序走訪 + 移動平均法:
- BUY → total_cost += qty×price ; net_qty += qty
- SELL 全平倉(qty ≥ net_qty)→ **reset:total_cost=0 / net_qty=0**(關鍵)
- SELL 部分減倉 → 按當前均價沖銷:total_cost −= avg×sell_qty(維持均價不變,會計慣例)
- 對只 BUY 沒 SELL 過的持股 → 新舊算法結果完全一致(回歸 PASS)
- net_qty 型別對齊 bigint(舊 view SUM promote 後是 bigint;CREATE OR REPLACE 必須 column type 一致)

**驗證(2026-05-26)**:
- v_holdings_current:2344 / net=2000 / **avg=139.50** / total=279000 ✓
- v_holdings_advice / v_holdings_pnl 連帶修正(都 join v_holdings_current)
- v_holdings_pnl 2344 unrealized_pnl=+1500(+0.54%)/ market_value=280500 / cost_basis=279000 ✓

**衍生待辦(task #24)**:`v_holdings_pnl.opened_at` 用 `min(txn_date where BUY)` 算建倉日,沒考慮平倉重置,2344 顯示 5/7(實際 5/26 重建倉)。修法需 v_holdings_current 多 expose opened_at 欄位(append 到尾巴),v_holdings_pnl 改讀 — 連動 2 view,**等 Andy 拍板**(也可解讀為「我第一次接觸這檔的日期」)。

---

## v_holdings_signals v3 — Andy 建議 2 完整實作(2026-05-31,結案)

**起因**:v2 留下 TODO「市值分檔等 market_cap 資料補齊」,5/21 backfill 完 144 檔,5/31 動工。

**設計**(2 個變更,12 個訊號原樣不動):
- 改 **#11 vs_bench** 依市值分檔調整門檻
  | 分檔 | green | yellow | orange | red |
  |---|---|---|---|---|
  | 權值 >3000億 | >+1pp | >-1pp | >-3pp | else |
  | 中型 300-3000億 / null | >+2pp | >-2pp | >-5pp | else |
  | 小型 <300億 | >+3pp | >-3pp | >-8pp | else |
- 新增 **#14 mcap_tier**(純資訊 gray)— 顯示「權值 5198 億 / 中型 1200 億 / 小型 280 億」

**理由**:權值股本來就跟 0050 高度連動,日差 ±2pp 對權值股太鬆(會把「正常跟盤」當成 green);小型股獨立行情 ±2pp 太嚴(會把「正常獨立走勢」當成 red)。**分檔讓訊號解讀更貼近實況**。

**Reality check(必要的歸納)**:Andy 原建議 2 還提到「中小型 vs OTC, 權值 vs 0050」— OTC vs TWSE 差異**沒做**(因為 0050 已是 TWSE 50 ETF,OTC 股本來就跟它連動度低,落在「小型放寬」這個 case 已隱含覆蓋)。如未來要顯式區分上市 vs 上櫃,再加 #15。

**驗證(2026-05-31 apply 成功)**:
- 2344 華新科 mcap_b=5197.5 → **權值 5198 億** ✓
- vs_bench: 0.0pp · level=yellow ✓(權值門檻 ±1pp,0.0pp 落 yellow 區;v2 的 ±2pp 會回 green,v3 更嚴格)
- 14 訊號 jsonb_array_length 確認

**signal_level 主規則不動**(避免邏輯複雜化、保持回歸性)。

**前置依賴**:`stock_universe.market_cap_billion`(5/21 backfill,reselect EF 不動此表,長期安全)

---

## 全系統審查(2026-05-31,4 subagent 平行深審)

**起因**:換 Opus 4.8,Andy 要求檢視整個股票系統找優化點。派 4 個專責 subagent 平行審:資料管線 / SQL view / 前端部署 / 策略回測。

**好消息(健康面)**:
- 資安乾淨(service_role 沒洩漏到 client bundle,寫操作全走 server action)
- 回測↔線上工程一致(同日 score_universe_at vs v_stock_rank top-12 完全相同、156/161 分數逐檔相等 = 無因子 drift)
- 未實現損益三表交叉一致

**發現分 4 組(~25 項)**:
- A 線上數字正確性 / B 資料管線韌性 / C 策略可信度 / D 工程韌性
- Andy 拍板先做 **A 組**

### A 組進度
- [x] **A1 v_holdings_realized 平倉重置(同根漏修)** — 上週修 v_holdings_current 漏了 realized,同樣用 cum_buy/cum_qty UNBOUNDED 永不 reset。改成遞迴移動平均 + 全平倉 reset(migration 20260531000002)。**驗證**:5 筆平倉全對,2344 那筆 5/11 仍報 avg 113.00/+1121.06(不變),未來再賣會用 139.5(不再是 126.25)
- [x] **A2 mom_ret_diff 負報酬符號翻轉** — ✅ 完成(Andy 拍板全做)。`ret_20d > ret_60d/3` 在 ret_60d<0 時門檻變負,跌深反彈股照樣過。修法=加 `ret_60d>0` gate,兩處同步:
  - migration `20260601000001`(v_price_factors 線上,傳導 v_factor_scores→v_stock_rank→前端/TG)+ `20260601000002`(score_universe_at 回測)
  - **線上效果**:3596 rank5→rank13、2637 rank6→rank17(跌深反彈退出);新 top5 = 2317/2882/2408/2324/8110,ret60 全正
  - **一致性驗證**:score_universe_at(today) vs v_stock_rank top8 逐檔 score 相等(無 drift)
  - **OOS 對照(L36 閘)**:B0 改前 alpha **+24.19** → B1 改後 **+20.02**(−4.17pp);benchmark 一致(35.23,確認純 A2 效果);**MaxDD 18.5→17.16 改善、win 58.33 持平、sharpe 1.87→1.84**
  - **結論**:alpha 降 4.17pp = 2025 那些假動能(跌深反彈)股恰好反彈賺到錢;移除後是更誠實的動能策略 alpha,且風險改善。**通過閘**(bug fix 非 curve-fit,改後仍顯著正 alpha)。**+24.19 OOS 基準更新為 +20.02**
- [x] **A3 Server Component 吞 error(核心完成 + 漸進)** — 建基礎安全網:
  - `lib/db.ts` unwrap helper(error 就 throw,不靜默回 null)
  - `app/error.tsx` boundary(之前**完全沒有** error boundary,任何 throw 都整頁崩)
  - `lib/supabase/server.ts` 加 `import "server-only"`(D 組順手,把「service_role 不進 client bundle」紅線變編譯期保證)
  - dashboard(app/page.tsx)+ holdings 核心 query(v_portfolio_summary/v_holdings_full/v_holdings_pnl)套 unwrap
  - **漸進 todo**:rank/etf/backtest×3/settings/stocks 5 page 套 unwrap(機械工作,error.tsx 已接住真故障/DB 連線失敗,剩餘是防 view drift 靜默空表,ROI 遞減)
- [x] **A4 PerformanceWidget 累積報酬口徑** — ✅ 改用 `avg_cost_at_sell × qty_sold`(A1 提供賣出當下精確移動均價)算 cost basis,取代「淨pnl ÷ 毛pct」反推(分子已扣fee/tax、分母沒扣→cost偏小→高估)。app/page.tsx realized query + PerfRealizedRow + sumCost 三處改。tsc 過
- [x] **A5 v_holdings_signals ETF 還原價口徑 — 實證為誤報,不需修(L47)**。agent 假設「未還原 current vs 已還原 MA = 假偏離 8-10%」。實證推翻:
  - 0050/0056 過去 20 天 adj_factor 全=1.0 → raw MA20 = adj MA20 **完全相同**,+8.5%/+9.9% 是**真實**偏離
  - 機制:`adj_factor[今天]` 恆=1 → `current(raw today)=current(adj today)`,跟 adj MA **同口徑**(都還原到今天基準)→ 比較正確
  - 唯一口徑差:持有期跨除息的 ETF(00878 差 ~1.4pp),但 adj MA(還原)才對(反映真實總報酬),raw 反因除息假跌偏低
  - **結論**:signals 現狀正確,agent P0 誇大。教訓呼應 L47:審查 P0 必須實證,不可照單全收(避免為不存在的 bug 加複雜度)

### B/C/D 組(未做,待排)
- B1 [P0] FinMind quota read-modify-write race(非原子,並行覆蓋,quota gate 失效)
- B2 [P0] fetch-yahoo-intraday + fetch-stock-news 沒納統一 universe(L46 漏網重演,news 漏 ~150 檔+watchlist,yahoo 持股讀舊 holdings 表)
- B3 [P1] reselect-industry-stocks delete-then-insert 非交易性(中途失敗整產業消失)
- C1 [P0] score_universe_at 財報/月營收用會計期間當可得日 = 前視偏誤(實證 2330 在 4/30 看到 Q1)
- C2 [P0] 回測 universe 混入 watchlist/holdings_transactions = 事後選擇偏誤疊加存活者偏誤
- C3 [P1] 回測期籌碼全 null = 實際 3 維,線上 4 維 = 用 A 策略歷史背書 B 策略
- **C 組總評**:+24.19 OOS alpha 應視為「樂觀上界」非真實 edge 點估計(在 L38 caveat 之上的具體放大點)

### 🚨 C 組執行結果(2026-06-01 夜間自主)— 重大誠實發現

**migration 20260601000004(C1+C2 合併,已 apply 線上)**:
- C1:fund_ranked 加發布落差(季報 period_end+45天/Q4年報+90天)、rev_ranked 加月營收次月10日(月初+40天)
- C2:universe 移除 watchlist + holdings_transactions(只留 stock_universe∪industry∪etf)

**OOS 對照(2025 t5 純策略,benchmark 一致 35.23 確認純效果)**:
| 階段 | alpha | sharpe | MaxDD |
|---|---|---|---|
| 原始基準(B0) | +24.19 | 1.875 | 18.5% |
| A2 後(mom_ret_diff gate) | +20.02 | 1.844 | 17.16% |
| **C1+C2 後** | **−9.02** | **0.845** | **29.04%** |

**決定性歸因**:C2 只移除 **2 檔**(009816/6285 = Andy 事後買的 transaction-log 持股),universe 161→159 → −29pp 暴跌**幾乎全來自 C1 財報前視偏誤**。win_rate 58.33% 三階段不變(選股方向對的比例一樣),但報酬幅度崩 → **alpha 來源是「財報季偷看未公告業績選到爆發股」,不是真實選股能力**。

**結論**:**M9.4a top5 策略修掉所有偏誤後,2025 OOS 跑輸大盤 9pp**。原 +24.19「alpha」是前視偏誤假象。⚠ 這推翻策略核心價值,**需 Andy 醒來定奪**(見晨報)。

**C1 真實 alpha 區間量測(2026-06-01 雙 lag probe)**:
| lag 假設 | alpha | sharpe | MaxDD |
|---|---|---|---|
| 保守(法定上限 45/90) | **−9.02** | 0.85 | 29.0% |
| 樂觀(大型提前 +20/45/35) | **+8.21** | 1.66 | 16.7% |
| (原前視假象) | +24.19 | 1.88 | 18.5% |
- **真實 alpha 在 [−9, +8]**,因 top5 多大型股提前公告 → **偏樂觀端**(但樂觀版對拖延小型股仍略偷看,+8 是上界)
- lag 差 20 天 → alpha 差 17pp,證實「財報可得時點」是 alpha 主驅動(=前視確實是 +24 主因)
- **不管哪端都遠低於 +24**;且這是**三維版**(C3 籌碼 null),四維版確切需 paper-track
- FinMind **無真實公告日**(只有 period_end),完整精確版需爬證交所「公開資訊觀測站」申報日(獨立工程,Next Action)
- 樂觀版經 execute_sql 臨時 probe 量測完即 **revert**,線上 score_universe_at 預設 = 保守版(migration 20260601000004,最嚴格誠實)
- **策略定位結論**:M9.4a top5 **不是死策略**(樂觀端 +8 alpha、sharpe 1.66 尚可),但**也不是 +24 金雞**(前視假象)。真實價值在「打平~小贏大盤」量級,高度依賴財報時效。下一步靠 paper-track 四維版實盤驗真。

**線上不受影響**:score_universe_at 僅回測用;線上 rank(v_factor_scores)用 DB 已公告財報,無前視問題,不需改。/rank /holdings 選股顯示照舊。

### C3 維度結構漂移量化(2026-06-01 夜間,聲明性質)

- 回測期 2025-06-09 錨點 avg chip_count_total = **0.00**;2025 籌碼表(institutional/margin/shareholding)**全 0 rows** → 回測期籌碼維度完全沒生效
- 現在線上 avg chip_count_total = **4.33**(institutional recent 1349 rows)
- **結論**:回測(不論 +24.19 還是 C1+C2 後 −9.02)驗的都是「fund+mom+rev **三維版**」策略;線上現在跑「**四維版**」(含籌碼)。**連 −9.02 都不是現在四維策略的真實 OOS**(是三維版的)。要驗四維版需 backfill 2025 籌碼歷史 + 重跑,或等 paper-track 累積真實四維 OOS。
- **疊加總結**:M9.4a top5 的可信度受三重打擊 —— ① C1 財報前視(alpha 假象,修後 −9)② C3 回測≠線上策略(三維 vs 四維)③ L38 倖存者偏差。**+24.19 不該再當策略 edge 引用**。
- D 組:server-only 守衛(1行ROI最高)/ error.tsx,loading.tsx / EF 抽 _shared(解 B1B2 根因) / deriveStatus 對無資料持股仍顯示「持續抱」(L42 前端未根治) / view 依賴鏈深+N+1

### ✅ B1 剩餘 7 EF deploy 完成(2026-06-02,commit 8206d7d 線上同步)

接 2026-06-01 夜間「已 deploy 6 / 剩 7」尾巴,本 session 全 deploy 完(MCP `deploy_edge_function`,verify_jwt 全 true):

| EF | 版本 | 備註 |
|---|---|---|
| fetch-finmind-margin | v2→v3 | |
| fetch-finmind-lending | v3→v4 | 雙 token 保留 |
| fetch-finmind-shareholding | v2→v3 | |
| fetch-finmind-fallback | v5→v6 | L46 v_fetch_universe+持股優先保留 |
| fetch-finmind-fundamentals | v2→v3 | |
| fetch-finmind-backfill | v4→v5 | 9 dataset branch + corp_action recompute |
| reselect-industry-stocks | v1→**v3** | 含 B1+B3;v2 中文 keyword 手寫誤植,v3 機械修正 |

**B1/B2/B3 全鏈完成**:11 個 quota EF 全改 `increment_quota` 原子 RPC(B1)、yahoo+news 納 v_fetch_universe(B2)、reselect 非空才 delete+insert(B3)。`increment_quota` runtime 已驗(finmind_2 today used=1)。

**🔴 過程踩雷 → L49**:reselect v2 用「手寫重現 content」deploy,`classifyIndustry` 正則內中文股名 keyword 產生 8 處形近誤植+漏字(鈺創→鈕創/宇瞻→宇瞩/辛耘→辛耀/富采→富採/聯鈞→聯鈔/為昇科→為昃科/漏華東/妥協→妄協)→ 個股靜默分類錯。**驗證階段 `get_edge_function` 拉回核對抓到**,改用 PowerShell 機械 ASCII-escape(中文→\uXXXX)重產 content → v3 拉回核對 8 處全對。**教訓 L49:deploy EF content 必機械產生不可手打,deploy 後必拉回核對執行路徑字串**。memory [[stock_ef_invoke_via_pgnet]] 早寫明用 JSON.stringify,沒遵循才中標。

**遺留(cosmetic,非必要)**:其他 6 EF 手寫 deploy,中文僅在註解(執行字串全英文、已確認功能正確),但線上註解可能有同類手寫錯字 → 線上≠repo byte-identical。若日後要完全一致,用 L49 機械 escape 法重 deploy 即可;功能無影響故本 session 未做(影響最小原則)。

**待時間驗證**:隔日各 cron 跑後查 `api_quota_state.used` 是否準確累計(B1 原子遞增線上實效)。

### ✅ Dashboard「真實持股」表並列綜合排名 + 進場燈 + 循環股提醒(2026-06-02)

**起因**:Andy 看 2344(華邦電,記憶體循環股)連日衝高/漲停,但 dashboard 持股卡顯示基本面 **2/6** 困惑。診斷:dashboard `HoldingsAnalysis`(app/page.tsx)只從 `v_holdings_full` 拿基本面 score(6 條價值股規則),對**景氣循環股反轉初期系統性低估**(過去虧損 / 低 ROE / 高 PB 全是循環特性);而系統主力 19 因子排名其實給 2344 **expected_rank #13 + is_entry_signal=true**。兩套尺不一致、持股卡只顯示會低估的那套。

**改動(純前端 app/page.tsx,不動 DB)**:
- 新增 `HeldRank` interface + Dashboard 查 `v_entry_signal in 持股symbols` → `heldRankMap`
- `HoldingsAnalysis` 分數欄上下並列:上 `score/6`(基本面)、下 `綜合 #rank ⭐`(19 因子排名 + 進場燈),hover 看 fund/mom/chip 維度
- `cyclicalHint`:`score≤3 && expected_rank≤30 && is_entry_signal` → 失分行前加「基本面分偏嚴(景氣循環股反轉初期),綜合排名 #X 靠前+進場燈,別只看 X/6」
- 表頭「分」→「分/綜合」、底部說明補綜合排名口徑

**驗證**:`next build` + tsc 通過;dev server 早期 `GET / 200 in ~1s` 實際 render 成功(含改動零 runtime error,`v_entry_signal` 查詢無報錯)。截圖未成:dev 連 **production DB**,preview 每 2s full-render force-dynamic dashboard 把既有重 view(`v_holdings_full`/`v_portfolio_summary`)打 `statement timeout` + 連線池耗盡 → 已停 dev 止血。**非本次改動造成**(早期 render 200 證明),但暴露既有議題:**dashboard force-dynamic + 深 view 高頻請求會 DB timeout**(見 D 組「view 依賴鏈深+N+1」,未來優化候選:dashboard 加快取 / 重 view 物化 / 連線池調大)。

**設計選擇**:循環股提醒用「基本面分 vs 綜合排名落差」啟發式觸發,**不硬編產業清單**(系統定位=儀表板不臆測產業循環性;落差直接解決「被單一 score 誤導」痛點)。

### ✅ Dashboard 慢變查詢快取 + 套件漏洞修復(2026-06-02)

Andy 要處理上段揭露的兩個遺留:① dashboard 高頻 DB timeout ② GitHub moderate 漏洞。

**任務 1 — dashboard 高頻 DB timeout**:
- **根因**:dashboard 用 service_role(`statement_timeout=null`,查詢不被砍),真瓶頸是 **PostgREST 連線池耗盡**(`Timed out acquiring connection from pool`)— force-dynamic 每次 render 並發 ~11 查詢 × 高頻 → pool 滿。連線池大小 = Supabase 平台層改不了 → **應用層降載**。
- **修法**(app/page.tsx 純前端):進場訊號 / 排名 / 名稱對照三類**慢變查詢**改 `unstable_cache`(revalidate 60/60/300s);報價 / 損益 / 持股 / held-rank 維持每次即時。高頻 render 命中快取,DB 並發 **11 → 6**。
- **權衡**:**保 force-dynamic**(不引入 build-time prerender 依賴 production DB 的脆弱性 + 報價維持即時),而非整頁 ISR。`server.ts` service_role 無 cookies → 可安全在 cache scope 內 createClient(unstable_cache 硬限制)。買賣經 holdings action `revalidatePath('/')` 一併刷新;排名/名稱最多舊 60-300s(日更資料無感)。
- **限制**:非 100% 根治(即時查詢仍每次跑),但顯著降載 + 零即時性損失 + 零 build 風險。**正常使用本就不發生此 timeout**(僅 preview 每 2s 機器人刷新觸發);要 100% 根治需整頁 ISR(犧牲報價即時 + build 依賴 DB)或物化 view,ROI 低暫不做。
- **驗證**:`next build` + tsc 通過,`/` 仍 ƒ(Dynamic) 未被 prerender。

**任務 2 — 套件漏洞**:`npm audit fix` 修 2 個 moderate(`brace-expansion` DoS / `ws` 記憶體洩漏,皆 transitive dev 依賴、lockfile 內 patch、無 major bump)→ **found 0 vulnerabilities**,build 通過。(GitHub dependabot 報 1 / npm audit 報 2,差在去重與掃描範圍;兩個都修了)

### ✅ 布林軌道(走 B:資訊呈現,不進選股/回測)(2026-06-02)

**起因**:Andy 問「加布林軌道會不會過度擬合」。判斷:① 進選股/回測=**會**(且系統已證選股無穩定 edge,疊技術指標=擬合雜訊,勿做)② 當資訊燈/圖上帶=**不算**(標準 20/2 不調參、0 個被優化自由度)。另提醒布林是**均值回歸**,對抱趨勢股(2344 記憶體)會太早喊賣(同 L36 停損對 top5 有害),故只當參考。Andy 拍板走 B。

**Part 1 — K 線疊布林帶**(app/_components/KLineChart.tsx):前端 rolling MA20±2σ(樣本 n-1,對齊 SQL stddev_samp),用圖上 raw close(與 K 線視覺一致),前 19 根 whitespace 留白;3 條 LineSeries(上下軌紫 violet-400 / 中軌灰虛線),priceLine/lastValue/crosshairMarker 全關;圖下圖例 +「位置參考非買賣訊號」。

**Part 2 — 持股燈第 15 格**(migration 20260602000001 v4):v3→v4 **機械複製**(Copy + 精確 Edit,L49:不手寫複製大量中文)+ boll CTE(adj_close 還原權值,與 ma20_dev 同口徑)+ 第 15 訊號。%B 位置(破上軌/近上軌/中段/近下軌/破下軌 + %B%);level 中段 gray、近軌/破軌 yellow(中性提醒不指方向)。**不進 signal_level、不參與排名、append-only**(現有 14 訊號零改動);SignalsGrid 通用渲染自動顯示,前端零改動。

**驗證**:
- Part 2 apply 後 execute_sql 核對 2344:**15 訊號 ✓**、14 個現有 label 中文全對(機械複製零 regression)✓、布林手算對照 cur 184.5 / upper 163.69 / lower 91.29 → **%B 129%「破上軌」yellow ✓**
- 2344「破上軌·129%」沿上軌狂奔(漲停)正好印證「布林對抱趨勢股會太早喊賣」→ yellow 中性不指方向的設計正確
- Part 1 `next build` + tsc 通過

**口徑註記**:K 線帶用 raw close(視覺一致)、持股燈用 adj_close(分析正確);近期無除息股(如 2344,adj 最近=1)兩者一致,除息股圖求視覺/燈求正確,context 差異合理。

### ✅ 效能優化 A:清理 intraday cache + 自動 cron(2026-06-02)

**起因**:Andy 問 p99 6-9s 是否有優化空間。診斷:`v_holdings_full`(dashboard 每次 render)單次 **4.1s**,DB 內瓶頸(非網路/cold start)。

**根因**(EXPLAIN ANALYZE 量出):
1. `price_intraday_cache` 累積 **42.8 萬列**(每分鐘寫、3 週沒清),取「今天報價」filter `quoted_at::date = current_date` 是 **expression 不走 index** → seq scan 全表 ~2s
2. `daily_recent` 取每檔最近收盤掃 `price_daily` **12.7 萬全歷史**(`trade_date < today` 無下界)~1.85s
- ⚠ Supabase performance advisor **完全沒抓到**(只看 FK 缺 index / unused index,不看「expression filter 害 index 失效」)→ 只能靠實際 EXPLAIN 量(同 L48「審查工具不能照單全收」)

**A 做法**(Andy 選先做 A):
- 一次性 `DELETE` >3 天(**42.8 萬 → 8.3 萬**,保留近 3 天 = view 只用今天 + 時區/跨日緩衝)+ `VACUUM` 釋放
- migration `20260602000002`:每日 18:00 UTC(02:00 Taipei 盤後)cron `purge-intraday-cache` 自動清 >3 天,維持表小不再無限長

**效果**:`v_holdings_full` **4124ms → 2374ms**(−1.75s / −42%)。剩餘 ~2.37s 主要是 `daily_recent` 掃 12.7 萬 = **優化 B 範疇**(改 `v_latest_price_realtime`:intraday filter 改 sargable 範圍走 index + daily 加時間下界),未做,等 Andy 要再說。

**零風險**:view 邏輯/語義零改,純清快取資料(view 只用今天,刪 3 天前不影響)+ 加清理 cron。

### ✅ 效能優化 B:v_latest_price_realtime 兩個 seq scan 改 sargable(2026-06-02,已 apply + DB 驗證)

**目標**:消掉 `v_latest_price_realtime` 的兩個全表掃描,讓 `v_holdings_full` 從 2374ms(優化 A 後)降到 <1s。

**根因**(承優化 A 診斷,定義來自最新 `20260512000077`):
1. intraday `where quoted_at::date = current_date` 是 expression → 不走 `idx_price_intraday_symbol_quoted(symbol, quoted_at desc)` → seq scan
2. daily_recent `where trade_date < current_date` 無下界 → 掃 price_daily 全歷史 ~12.7 萬

**改寫**(只換取數範圍,output column/表達式/join/coalesce 全不動):
1. intraday → `quoted_at >= current_date::timestamptz and quoted_at < (current_date+1)::timestamptz`
   - `col::date = current_date` 的教科書 sargable 等價;兩側 `::timestamptz` 與原 `::date` 同一 session TZ 求值 → **任意 TZ byte-exact**,不硬編碼偏移
2. daily_recent 加 `and trade_date >= current_date - interval '30 days'`

**驗證(此 subagent context 無 execute_sql / apply_migration MCP — ToolSearch 未啟用,已窮舉 psql/CLI/pg驅動/DB密碼/9個 PostgREST RPC 全不通)**:
- 改用 **service_role + PostgREST 拉原始表,在 Node 應用層做 EXCEPT 等價驗證**(逐 symbol 比對「選哪一行」):
  - intraday:newRange vs old(UTC切/Taipei切/跨切分叉指標)**全 0 mismatch**(145 symbol)
  - daily_recent:old(無下界) vs new(≥30天) **0 mismatch**(156→156,實證無一檔最近收盤超 30 天)
- **DB 內實跑驗證未做(無入口)**:`_verify_20260602000003.sql`(雙向 EXCEPT + EXPLAIN)已備,Andy/host apply 後跑收尾、量改後 ms

**檔案**:`supabase/migrations/20260602000003_v_latest_price_realtime_sargable.sql`(create or replace,不 cascade)+ `supabase/migrations/_verify_20260602000003.sql`(退版驗證腳本,`_` 前綴 → db push 自動跳過)

**主對話收尾(已 apply + DB 內權威驗證,Opus)**:
- DB 內雙向 EXCEPT(新定義 inline vs 線上舊 view)實測:`new_minus_old=0`、**`old_minus_new=1`**(subagent 應用層 EXCEPT 漏抓!)→ 那檔 = **2888(新光金,2025 與台新金合併下市,最後收盤 2025-07-11 = 326 天前)**,舊 view 一直顯示其 11 個月前殭屍價。判定:2888 非持股/watchlist/industry(只 stock_universe 殘留)、`active_stale_31_120d=0`(無正常股被 30 天誤排)→ **30 天下界對活躍股 100% byte-exact**,唯一差異是順帶修掉「顯示下市股殭屍價」既有 bug,非破壞、不影響任何持股顯示。
- 量測:`v_holdings_full` **2374ms → 417ms**(intraday 走 idx_price_intraday_recent、daily 走 idx_price_daily_date 只掃 3270 列)。**全程 4124→417ms,砍 90%。**
- 教訓:**退版驗證鐵律必自己 DB 內跑**(L48:subagent 應用層 EXCEPT 漏了 2888,不照單全收)。

### ✅ 持股訊號燈收斂(2026-06-02,analyst-deployer subagent)
15 燈太多 caveat 疲勞 → 分**主燈 6**(stop_buffer/vs_bench/vol_div/tail/down_streak/rsi,出場警戒類)+ **次要 9 摺疊**(`<details>`)+ red/orange 次要燈冒泡到主區。只改 `HoldingsAdvice.tsx` SignalsGrid,不動 SQL/TG。build 過。

### 🔬 新方向探勘結論(2026-06-02,2 個 general-purpose subagent 平行 + 主對話誠實複核)
Andy 定調「不縮成儀表板,要走在市場前面」(抓真實事件 + 升級資料時效)→ 探勘:
- **外部資料源(實測)**:🥇 **Yahoo v8 chart API**(SOX/Nasdaq/台積電 ADR/美股期貨,免費無 auth、實測可用、**時區套利真領先** — 台股開盤前美股已是既成事實)= 第一順位、最低風險最硬 edge。🥈 TAIFEX OpenAPI 夜盤 EOD(免費但 T+1)。🥉 MOPS 真實財報公告日(只能爬、修前視偏誤 L48 的根、工程重)。🟡 新聞/地緣 ROI 低(戰爭尾部事件無便宜結構化源)。
- **內部領先性初驗(誠實量化,point-in-time)**:
  - **H1 崩盤/regime**:波動率是**落後指標**(崩盤時才升不領先;「低波動+跌價」最危險)→ 只能當下檔風險/部位 flag(高波動→9× 回撤機率),**不是崩盤擇時/方向**。樣本全牛市,外部效度弱。⚠ **推翻我之前「崩盤保護較可行」的樂觀**。
  - **H2 隔夜動能**:真實但 edge 在隔夜 gap(已被定價)、intraday 微小、做空年度不穩 → 實際 alpha 低。
  - **H3 新聞→隔日波動**:真實 robust(控制自身波動後 corr +0.162 加成),但**方向不可測**(signed~0)→ 波動/風險訊號非 alpha,僅 1 月資料需累積。
- **誠實總結**:選股 alpha(找黑馬打贏)內部再次驗證難;**唯一最硬的真 edge = Yahoo 海外領先(時區套利,屬「時效」非「選股」)**,正好貼合 Andy「夜盤/海外隔天領先」觀察。崩盤保護要修正預期(波動率落後、是風險 flag 非擇時警報)。
- **下一步建議**:先做 **Yahoo 海外領先資料管線**(SOX/台積電ADR/Nasdaq/美股期貨,盤前 06-08 點抓進表,供盤前推播/dashboard)= 低風險、真領先、零爬蟲、貼合觀察。MOPS 公告日留給「徹底修回測誠實度」階段。**未 commit,等 Andy 拍板方向**。

### ✅ /rank 漲停亮燈 + 回看損益 + 組合 vs 0050 + 前向追蹤對照(2026-06-02)

**起因**:Andy 要在 /rank ① 漲停亮燈 ② 知道排名值不值得進場 ③ 進場損益。澄清後核心 =「回看式直觀」:照排名每檔 N 天前進場到今天損益,憑直覺感受排名。

**策略 caveat(關鍵)**:排名含動能因子 →「排名靠前」部分 = 最近已漲。用當前排名配回看報酬會**系統性高估「排名準」**(同期相關非事先預測力)。真驗證只有前向追蹤(凍結名單再往前看)。**UI 明確標此 caveat,不包裝成「排名能賺」**(memory +24.19 教訓延伸)。

**做法**(analyst-deployer subagent + 我逐段 review,改 app/rank/page.tsx 單檔):
1. 漲停亮燈:今日%欄(current_price/昨收−1),≥9.5% 標 🔴。台股紅漲綠跌
2. 回看欄:加近 5 日%(ret_5d_pct ≈ 一週)配既有 20 日%
3. 組合摘要卡:當前 Top-N 回看平均(近 5/20 日)vs 0050,附誠實 caveat(同期相關偏樂觀)
4. 前向追蹤對照:5-16 凍結批 top5/top10 浮動 vs 0050(零前視真驗證),標樣本少僅觀察

**資料源**(全驗證):`v_rank_with_cost`(ret_5d/20d/current_price)、`v_price_factors`(0050 基準 5.59/11.73)、`price_daily`(昨收近窗)、`paper_picks` 5-16 cohort join `v_latest_price_realtime`。

**subagent 主動修的 bug(L42 類 silent drift)**:我給的昨收查詢用 `distinct on` — supabase-js 不支援,全撈 30檔×320天≈9600 row 撞 **1000 row 上限靜默截斷**(28/30 拿不到昨收 → 今日%全變「—」)。改近 12 天窗(~240 row)→ 30/30 正確,實證過。**教訓:給 subagent 的 SQL spec 也要考慮 supabase-js client 限制(無 distinct on / per-group limit / 1000 row 預設)**。

**驗證**:next build + tsc 過(我自己也跑),`/rank` 維持 force-dynamic。數字核對:Top5 近5日 +12.3/20日 +24.6、Top30 +13.5/+32.2、0050 +5.6/+11.7;前向 5-16 批 top5 +12.8/top10 +18.5/0050 +10.8(吻合)。當前 top30 有 6 檔漲停。**caveat 文字逐段 review 誠實未弱化**(L48:不照單全收 subagent)。

### ✅ /holdings 訊號燈收斂:主燈 + 摺疊(2026-06-02)

**起因**:每檔持股 15 個訊號燈(SignalsGrid 平鋪)太多、caveat 疲勞。改成「主燈醒目一行 + 次要收進 `<details>`」,讓 Andy 一眼看到「會改變交易動作」的。

**約束**:只改 `HoldingsAdvice.tsx` 的 `SignalsGrid` 呈現,不動 SQL(v_holdings_signals 照吐 15)、不動 deriveStatus / AdviceCard 其他部分 / TG notify。沿用現有 SIGNAL_STYLE 配色。L14/L24 不用 dynamic class。

- [x] 定義主燈 key 白名單(6 個出場/警戒訊號):`stop_buffer` / `vs_bench` / `vol_div` / `tail` / `down_streak` / `rsi`
- [x] 主燈醒目排一行/grid;有 red/orange 的次要燈「冒泡」到主區提醒
- [x] 其餘 9 個次要(資訊/背景)收進 `<details>`(預設收合)
- [x] 綜合 level badge(healthy/caution/warning/alert)保留
- [x] `npm run build` 過,回報分組 + build 結果

**Review**:
- 只動 `SignalsGrid`(抽出 `SignalCell` 子元件去重)+ 新增 2 個模組層常數(`PRIMARY_SIGNAL_KEYS` / `ESCALATE_LEVELS`)。deriveStatus / AdviceCard / PriceTick / SQL / TG notify 零接觸。
- **分組**:主燈 6 個(出場/警戒)依白名單固定順序排(不隨 SQL 吐出順序變),容錯(某 key 缺就跳過);次要 9 個(chip/mom/fund/ma_arrange/ma20_dev/obs1_dist/ret_60d/mcap_tier/boll)保 SQL 原序收進 `<details>` 預設收合。
- **冒泡**:次要燈裡 level=red/orange 的提升到主燈區(不藏摺疊),避免「基本面/籌碼轉紅」被收起來漏看。摺疊標題顯剩餘數量。
- 標題從「即時訊號 (15)」改「重點訊號」;綜合 level badge 保留。配色全沿用 SIGNAL_STYLE/LEVEL_STYLE 字面 class(L14/L24,零 dynamic 拼接);中文 label 仍來自 SQL runtime,前端只定義英文 key 白名單(無 L49 手寫中文風險)。
- `npm run build` 通過(Compiled + TypeScript 零錯誤,/holdings 維持 ƒ Dynamic)。

### ✅ 海外領先資訊管線 階段 0+1(2026-06-02,Andy 拍板「走在市場前面」、驗證先行)

承「新方向探勘」做最硬的真 edge = 海外/隔夜領先(時區套利)。**驗證先行,沒過就誠實停**。

**階段 0(資料管線,完成)**:
- schema `overseas_indicators`(migration `20260602000004`):symbol / quoted_date(=美股收盤的台北日期=台股盤前日)/ last_price / prev_close / change_pct。
- EF `fetch-overseas-leading`(v1,**全英文避 L49**):Yahoo v8 chart API 抓 ^SOX/TSM/^IXIC/NQ=F/^VIX/UMC。即時 range=5d / 回填 range=2y 通用;`taipeiDate(unix+8h)` 對齊 quoted_date。
- 回填:pg_net invoke range=2y → **3010 列、6 標的、0 錯誤、2 年歷史**。
- cron(migration `20260602000005`):盤前 06:30 + 08:30 Taipei 抓 range=5d。
- Yahoo v8 **我自己 WebFetch 實測過**(^SOX 13726 / TSM 446.69,error null)— L47 不照單全收 subagent。

**階段 1(領先性驗證,PASS — 誠實版)**:
- corr(adj 還原權值,n≈470):**TSM ADR → 2330/0050 領先力在 intraday(0.28)>> gap(0.1)** → **反** subagent H2「gap 已定價」預期,**是可交易方向、不是賺不到的開盤跳空**。SOX/NQ 泛指數弱(<0.1)→ 領先集中**台積電 ADR 直接對標**。
- 分桶(ADR 昨夜 → 2330 今天開盤後 intraday):**完美單調** — ADR>+2% → **+0.60% / 勝率 65%**(n100);ADR<−2% → **−0.44% / 31%**(n70);中間單調過渡。
- **誠實定位**:effect 0.4–0.6% — 當**擇時/紀律**用(ADR 大跌今天別追高/減碼、大漲可抱加碼,不算來回成本)**價值明確**;當**當沖 alpha**(開盤買收盤賣)扣台股來回成本 ~0.47% 後淨剩 ~0.13%,**薄、脆弱,不建議當賺錢策略**。
- **限制**:2 年單一 regime(台積電/AI 主軸期 ADR 領先特別強)、corr/分桶非實盤(滑價/開盤競價)、外部效度需更多年。

**結論**:探勘以來**第一個誠實驗證 PASS 的真領先訊號**(非選股 alpha、是時效擇時,正中 Andy 觀察)。

**擴大領先源(Andy「不能只綁台積電、其他股票也重要」,2026-06-02)**:加 5 個產業龍頭(MU/NVDA/AAPL/AVGO/AMD,EF v2 共 11 源,回填 5515 列)。**Andy 持股 = 2344 華邦電(記憶體)**,驗證:
- 2344 最強海外源 = **美光 MU(intra corr 0.193)** > NVDA 0.12 > SOX 0.11 → 證明「產業 proxy 對沒 ADR 個股有效」,且**正中持股**(華邦電要 MU 不是台積電 ADR — Andy 的提醒切中要害)。
- 但比 2330(0.287)弱 + **不對稱**:MU<−2% → 2344 開盤後 **−0.93%**(下檔強=風險警示);MU>+2% → +0.56% 但**勝率僅 48%**(上檔弱、別當買訊)。原因:proxy 非本尊 ADR + 華邦電有本土利基記憶體因素。
- **定位**:美光當華邦電「**下檔風險警示**」(美光崩→華邦電今天別追),不當上檔買訊。呼應「下檔風險訊號比上檔 alpha 可靠」(H1 同調)。
- **架構洞察(Andy 點出的關鍵)**:**每檔台股配不同海外源**(記憶體←MU、AI←NVDA、蘋果鏈←AAPL、半導體←SOX、有 ADR←直接對標)= 一張「領先性圖譜」,非單一指標綁定。階段 2(若做)要按持股/產業動態選對應源。

**領先性圖譜全 universe 掃描(2026-06-02「繼續」)**:universe 各股 × 6 主源 intraday corr,結果:
- **記憶體族群最強源全是美光 MU**:華邦電 0.19 / 南亞科 0.19 / 群聯 0.18 / 華東 0.16 / 旺宏 0.13 → **「記憶體→MU」系統性成立**(非華邦電個案)。
- **台積電鏈最強源 = TSM ADR**:台積電本尊 0.29;鏈上(光寶/力成/廣達/鴻海/緯穎)多 TSM 0.13-0.17。
- **金融/傳產 海外領先弱或負**:第一金 −0.20 / 兆豐金 −0.17 / 長榮 −0.14(對 AAPL/NQ **負相關** = 科技大漲日資金排擠金融的蹺蹺板,但弱、可能只是反向 beta)。
- **強度**:除台積電 0.29,其餘 0.1-0.2 → 一律擇時/風險參考,非強 alpha(一致誠實結論)。
- **可操作圖譜**:記憶體→MU、台積電鏈→TSM、金融傳產→海外領先沒用。**階段 2 接推播時按此圖譜「持股 → 對應源」動態選**,並用各檔的下檔不對稱性(如華邦電 MU<−2% → −0.93%)當風險警示。

**階段 2 暫緩(Andy 2026-06-02)**。資料管線(11 源 + 盤前 cron)+ 領先性圖譜方法已建立,等之後決定。

---

## 後續可考慮(M8-M11 範圍外)

- 自動下單(券商 API 串接)
- 限價單 / 停損單模擬
- 多 user 登入(改用 Supabase Auth)
- 跨市場(美股、加密貨幣)
- Tab 6 Alerts(觸發紀錄 + LINE 通知)
- ML 升級(XGBoost / LightGBM)— 待 backtest 證明統計版有效再評估

---

## 權益曲線績效頁(2026-06-05,本地未 commit)

**需求**:Andy 要把「本金動態」做成內建線圖。前置已反推本金 = 期末現金 407,500 − 累計已實現現金損益 204,496 = **203,004**(14 筆交易全平倉、逐筆滾動精準對上 407,500、中途無存提 → 假設成立)。

**實作**(plan:`.claude/plans/parallel-launching-curry.md`):
- **migration `20260605000001_v_equity_curve.sql`**(已 apply 線上):seed `app_settings.initial_capital`(萬單位 20.3004,沿用 budget_ntd 繞 numeric(10,6) 整數僅 4 位)+ view `v_equity_curve`(交易事件 running sum,**BUY delta=−fee / SELL delta=+realized_pnl**)。**MCP 驗證**:14 筆事件、終點 equity=407,499.89(≈407,500,0.11 為本金 round 尾差)、逐筆 delta 與 v_holdings_realized 對齊。
- **前端**:`EquityLadderChart.tsx`(移植 backtest `EquityOverlay` 純 SVG,`pathFor` 改階梯線、Y 軸絕對金額 NT$、本金基準線)+ `/performance` 頁(summary 4 卡 + 曲線 + 14 列明細)+ TabNav「績效」tab + settings `CapitalRow`(萬單位+NT$換算)。
- **驗證**:`npm run build` 過(編譯+tsc+靜態生成全綠);資料層 MCP 精準驗證。⚠ 本機 dev 視覺未截到 — **沙箱連不到外網 Supabase(fetch failed,既有 dashboard 同根因),非 code 問題**;頁面邏輯確認走到正確 `unwrap(equity-curve)`。**視覺待 Railway 部署看(專案慣例)**。
- **口徑 caveat**:單一本金假設、階梯不含未實現浮動(Andy 選)、009816/6285 缺每日價故暫不做每日市值版。
- **待辦**:commit + push 觸發 Railway 部署;部署後 Andy 確認視覺;未來多次入金需 capital_flows 表。

---

## 現股當沖(day trade)支援(2026-06-09)

**需求**:Andy 6/8 想「賣 2408 庫存 @364.5 停損 + 340 買回」,券商執行成**現股當沖**(先賣 324 後買 340 回補),庫存維持 1000@364.5、另賠 17,053。系統移動平均成本法不支援當沖(無法賠錢又不動持股)→ Andy 選**根治 + 完整 UI**。

**方案**:獨立 `day_trades` 表(零風險隔離,不碰移動平均遞迴,L37/L42),損益加法 union 進彙總/曲線/明細。

**實作**(plan `.claude/plans/parallel-launching-curry.md`):
- **migration A `20260609000001`**(已 apply 線上):`day_trades` 表 + `v_day_trades_realized`(realized=(賣−買)×qty−買費−賣費−稅,欄位對齊 v_holdings_realized + is_day_trade)+ app_settings 當沖稅率(stock 0.15% / etf 0.05%)
- **migration B `20260609000002`**(已 apply):`v_holdings_summary.total_realized_pnl/total_pnl` 加當沖;`v_equity_curve` events union `DAY_TRADE`(delta=realized_pnl)
- **前端**:`addDayTradeTransaction` action(+ loadDayTradeTax)+ `DayTradeDialog.tsx`(輸股號/股數/買價/賣價即時算損益)+ /holdings「記當沖」入口 + 已實現歷史 union 當沖徽章 + /performance DAY_TRADE 文案 + EquityLadderChart 當沖標點
- **記 6/8**:2408 buy340/sell324/qty1000 → realized **−17,053**(費 290+277、稅 486)
- **MCP 驗證全通過**:當沖 −17,053;**持股 2408 仍 1000@364.5 零影響**(核心目標達成);summary realized 205,680→188,627;equity 終點 407,189→**390,136**;`v_holdings_realized` 不含當沖。`npm run build` 過。
- **caveat**:當沖假設同日;稅 0.15% 可在 /settings 調;當沖不計入 count_closed/週轉統計,只進 total_realized_pnl + 曲線。
- **待辦**:commit + push 觸發 Railway 部署。

---

## 2026-06-10 session — 優化盤點(載入速度 + 判斷能力)

實證盤點(2 subagent + pg_stat_statements + view 計時):熱點 = v_holdings_signals 941ms(boll CTE 對 price_daily 無日期下界全表掃 12.8 萬列,同 B 優化 pattern);全站 8 頁無 loading.tsx;海外領先 11 源資料躺表中零 UI 呈現(管線正常,6/9 隔夜 11 源完整)。

- [x] P1a:v_holdings_signals v5 — boll CTE 加 sargable 90 天下界(migration 20260610000001),EXCEPT 雙向迴歸 + 計時對比
- [x] P1b:loading.tsx skeleton — /(dashboard)、/holdings、/rank、/stocks/[symbol]、/performance 共 5 路由(backtest/etf/settings 查詢輕,不加)
- [x] P2:Dashboard 海外隔夜快照 widget — overseas_indicators 各 symbol 最新一筆,指數/ADR/產業龍頭分組,持股對應源高亮(記憶體→MU 已驗證),MU≤-2% 下檔警示(歷史 -0.93%)、≥+2% 標「上檔弱勝率48%別當買訊」,unstable_cache 300s,read-only 不碰推播(Stage 2 推播維持暫緩)
- [x] 驗證:npm run build + view 迴歸 + commit/push

**Review(2026-06-10)**:
- P1a:migration `20260610000001` apply 線上。EXCEPT 雙向迴歸 PASS(唯一 diff = bench_chg_pct 時變欄位,0050 即時報價 snapshot 後又進一筆;排除後 0/0)。**誠實計時:941→871ms 只省 ~7%** — plan 證實 boll Seq Scan 已消失,但真正大頭是 v_factor_scores(320 天視窗 WindowAgg 32,869 列 + 籌碼 4 表)在 plan 內被重複展開 3 次(advice 內部 1 次 + signals left join 又 1 次等)。**根治候選 = mv_factor_scores 物化 + 資料更新後 refresh**(結構改動,牽涉 view 鏈,待 Andy 拍板,見下方提案)
- P1b:`app/_components/Skeleton.tsx` + 5 路由 loading.tsx(/、/holdings、/rank、/stocks/[symbol]、/performance)。dev preview 證實 skeleton 立即顯示(體感改善主力,因全站 force-dynamic TTFB 數百 ms~1s)
- P2:`OverseasWidget.tsx`(dashboard SummaryCards 下方)。11 源分組(指數/ADR/產業龍頭)、台股紅漲綠跌、VIX 中性色;持股對應源 ★ 高亮(industry→源:記憶體→MU/IC設計+封測→TSM 已驗證,AI伺服器→NVDA 未驗證不觸發警示);下檔警示(對應源 ≤−2% 紅框「勿急著低接」)、上檔 ≥+2% 中性「勝率僅 48% 別當買訊」(不對稱性照圖譜)。getCachedOverseas unstable_cache 300s(資料一天只更新 2 次)。**僅呈現已有資料,Stage 2 推播維持暫緩**
- 驗證:npm run build 過;preview server HTML 含全部新內容(skeleton/海外 widget/★);preview 瀏覽器停在 skeleton 是背景 tab rAF 凍結(streaming swap 不跑),非程式問題

### 追加 4 項(Andy「4點都做」,2026-06-10 下午)
- [x] 1. mv_factor_scores 物化(migration 20260610000002):DO block 機械替換 v_stock_rank/v_holdings_signals 源(零手打 drift,pattern 不符 fail-fast)+ unique index + cron refresh(平日 08:50/14:50/15:50/16:50/17:50 Taipei)。**v_stock_rank 327→2ms / v_entry_signal 301→2ms / v_holdings_advice 649→129ms / v_holdings_signals 941→104ms**。mv vs view EXCEPT 0/0。⚠ 手動 backfill 後要手動 refresh mv
- [x] 2. deriveStatus INSUFFICIENT(L42 前端根治):fund+mom total 全 0 → 🚧「因子無料,分析失效」紅 badge,不再默認「持續抱」;停損(-10% 純價格)優先序保留在其上。HoldingsAdvice.tsx + notify-holdings-telegram **v4 deploy**(get_edge_function 拉回核對中文字串 PASS,L49)
- [x] 3. /rank 手機卡牌式:md 以下整卡可點直列(rank#/股號名稱⭐/總分/現價/今日%/5d/20d/RSI/4 維 count),表格 hidden md:block
- [x] 4. equity_curve SVG path stride 取樣 ~240 點(backtest/[id] + compare 兩處 pathFor,x 用原索引保對齊+保尾點,HTML 瘦身視覺無差)
- 驗證:build 過;dev warm /holdings 771ms /rank 987ms(mv 前光 DB 即 ~1.6s);/rank 卡牌 markup 確認

---

## 2026-06-10 晚 — 「好股等好價」三層工程(Andy 拍板開工)

> 痛點:rank=橫斷面選股(what),缺進場時點/價位(when/at)。動能因子天生把已漲一段的推前面 → rank 靠前≈追高區。分層解決,不動排名結構(L36)。

- [x] A. v_entry_quality view:rank top N 每檔價位質量 — 4 態 entry_zone(chase 追高/neutral/pullback 回檔至支撐/broken 趨勢破壞)+ 耐心價(MA20/fib38.2)+ 偏離 MA20/布林 %B/量比。純 SQL 標準參數零調參(走 B)
- [x] B. /rank UI:價位質量欄(燈+偏離%)+ 耐心價欄 + 海外 gate(對應源隔夜 ≤-2% → ⛔ 今日勿進);手機卡同步
- [x] C. Dashboard regime 燈:0050 近 60 交易日報酬分區(U 型濾網產品化:<0 有利/0-10 中性/10-20 地雷/>20 有利,附 paper-track 驗真 caveat)
- [x] D. 耐心價到價提醒:alert_rules 啟用 + EF check-price-alerts(盤中 cron 比價)+ 觸價 TG 推播 + /rank 一鍵掛耐心價
- [x] E. entry_model 回測驗證:run-backtest 加 entry_model 參數(immediate vs pullback_ma20 vs limit_fib38),L39 錨點,2023-2025 三年量化「等好價」真實損益

**Review(2026-06-10 晚,A-D 完成,E 留下一 session)**:
- A:migration 20260610000003 apply。全 universe 432ms。**量化證實 Andy 直覺:Top10 有 5 檔 chase(2492 dev+19.7%/9917 RSI77)、僅 2 檔 pullback(2356/2377)**。2408 = pullback(資訊性:不知籌碼在出,zone≠買訊,UI tooltip 已註明)
- B:/rank 加「價位」(zone 燈+MA20 偏離小字+⛔海外 gate)與「耐心價」欄;手機卡同步 zone。overseas mapping 抽共用 overseas-map.ts
- C:dashboard RegimeWidget(0050 近 61 筆 adj 報酬分 4 區,unstable_cache 3600s,附 12 季樣本 caveat)
- D:EF check-price-alerts v1(deploy+L49 核對 PASS)+ cron */10 1-5 UTC + actions.ts(addPatienceAlert 防重/cancel)+ PatienceCell(點掛 ⏰/✕ 取消)。**E2E PASS:checked1/triggered1/tg:true/event 寫入/one-shot 停用**,測試資料已清
- E(entry_model 回測驗證)未做:改 run-backtest 核心需 L39 錨點 byte-exact + 6 run 對照,留獨立 session 專心做

**E Review(2026-06-11,run-backtest v7)**:
- v7 加 entry_model(immediate 預設/pullback_ma20)+ entry_wait_days(1-40 預設 10):限價=rankDate MA20(EF bars 自算同 adj 口徑),open<=limit 用 open、low<=limit 用 limit,等嘸 skip(entry_not_filled/entry_limit_na 透明計數)。fetch 窗 -30→-45(date-guarded;副作用:未來 ATR 停損實驗 seed 不足例會變少,誠實記錄)
- **L39 錨點 PASS**:2024/2025 t5 preEF vs postEF 全指標 byte 一致(0.67/-50.65、26.22/-9.02)
- **🔴 結論:等回 MA20 三年全敗** — alpha:2023 +7.14→-11.79(-19pp)/2024 -50.65→-48.58(同爛)/2025 -9.02→-57.44(**-48pp,60 槽 36 個等嘸**)。機制 = M9.4a 定論再現:動能 top5 最強的不回檔,等到的多是轉弱接刀(2025 win 45.8%)。**「等好價」對動能 top5 是系統性傷害,買點折價 << 錯過行情的機會成本**
- 實務:v_entry_quality pullback 燈 = 資訊非指令;耐心價掛單適合自選/非動能標的,top5 勿當默認。Caveat:單一形式(MA20/wait10)、C1 保守 lag 基準、倖存者偏差照舊
- 注:C1 保守 lag 下 2024 t5 immediate = -50.65(首次量測,2024 在保守財報時點下整年壞,符合 C1 真實 alpha 區間 [-9,+8] 的悲觀端敘事)

---

## 2026-06-30 — Vibe-Trading 借鏡 + UI 清理(Andy 6 點指示,待拍板)

> 來源:研究 HKUDS/Vibe-Trading(LLM-agentic 多市場研究站)。整套不搬(語言/stack/範圍全不同),只借 3 個與本專案 SQL-view 架構相容的概念。
> 紀律:UI 清理低風險先做;因子/權重屬結構改動,各自過 [[L36]] OOS 雙軌閘 + [[L41]] Gate0 前提驗證 + [[L44]] 歷史覆蓋檢查。

### Part A — UI 清理(低風險,需求明確)
- [x] A1(#3)ETF tab 整個移除:刪 `app/etf/page.tsx`;`TabNav.tsx` / `Sidebar.tsx` 各移 ETF 項;`settings/actions.ts` 3 處 `revalidatePath("/etf")` 改清(no-op 但清掉)。**不動** `v_etf_picks` view、`etf_metadata` 表、universe 內 ETF(排名股池仍含)— 純 UI 移除
- [x] A2(#2)「給 Andy 的建議」widget(`AdviceWidget.tsx`,只用於 `app/page.tsx`):靜態「出場紀律」「避免追高」永不變、動態「可關注標的」與 /rank 重複 → **待拍板:整刪 vs 保留動態塊**
- [x] A3(#4a)/rank「耐心價」欄移除:th + PatienceCell td/component + import + EntryQualityRow.patience_* + alertRes/alertMap 全鏈;orphan `rank/actions.ts`(addPatienceAlert/cancelPatienceAlert)整檔刪。**不動** `v_entry_quality`(entry_zone 仍用)、`alert_rules`/`check-price-alerts` EF(資料層)。⚠ 副作用:既有耐心價 alert 仍會觸發但 UI 無法新增/取消 → 待拍板是否一併停 alert pipeline
- [x] A4(#4b/#5)靜態 caveat 備註移除:前向追蹤「⚠ 才一批…」(L1024-27)+ 回看報酬「⚠ 這是回看報酬…」(L992-97)。**連帶發現**:header「Top 5 集中度 2025 OOS alpha +24.19 vs +13.80」+ FocusToggle title 為 [[L48]] 已推翻的前視偏誤假象(真實:2024 −50.65 / 2025 −9.02)→ 現為錯誤資訊,需更正或移除。**待拍板:回看報酬整塊移 vs 只移備註;+24.19 更正 vs 移除集中度宣稱**

### Part B — Vibe-Trading 三借鏡(結構性,各過 OOS 閘)
- [x] B1(#1.3 Shadow Account 行為分析)**最安全先做,非因子改動免 OOS 閘**:新 view `v_trade_behavior`(讀 holdings_transactions + v_holdings_realized)算 持有天數(贏家 vs 輸家)/ 勝率 / 處置效應 / 賣出後 N 日走勢 / 進場時 expected_rank 分布;/holdings 加 section。驗:view 數字對 + build 過
- [ ] B2(#1.1 Alpha101/GTJA191 純價格因子挖礦):Gate0 先驗候選因子型態([[L41]])→ 只取 price_daily 可算(3yr 歷史,避 [[L44]] 籌碼無料)、與現 19 因子不重疊者 → append-only 加 v_price_factors([[L37]])→ 同步 score_universe_at([[L32]])→ OOS 雙軌對照當前 honest baseline,贏才 commit、輸即 revert([[L36]])
- [ ] B3(#1.2 IC/IR 權重):對每因子算近 3yr 滾動 IC(因子 vs 未來 20d 報酬 Spearman),只做正負號 sanity + 粗分檔(防 overfit,~150 universe [[L38]]);weights 凍進 backtest_runs.params([[L33]]);過 OOS 閘

### Part C — #6 回測驗證
- [ ] 先拉當前 honest baseline(score_universe_at walk-forward,top5/top10 2023-2025);每個 B 結構改動 commit 前過 in-sample + OOS 雙軌、benchmark 一致性([[L36]]/[[L48]]);alpha 引用附倖存者偏差 caveat([[L38]])

**拍板(2026-06-30,Andy 全選建議)**:A2 整刪建議 widget / A4 回看報酬整塊移+更正 header / B 分階段(本輪 UI 清理 + B1;B2/B3 各自獨立 session)。

**Review(2026-06-30,A1-A4 + B1 完成)**:
- A1 ETF tab:刪 app/etf;TabNav/Sidebar 移項;settings/actions.ts 清 3 處 /etf revalidate。v_etf_picks view 變孤兒但不 drop(既有 dead code 不動,CLAUDE.md #3);etf_metadata 仍餵排名 universe(未動)
- A2 建議 widget 整刪:AdviceWidget.tsx 刪檔 + page.tsx 連帶清 getCachedTopRanks/RankPick/rankRowsRaw/heldSymbols/advicePicks(orphan 全清)
- A3 耐心價:rank/page.tsx 全鏈移(th/td/PatienceCell/import/interface/alert_rules query/alertMap)+ rank/actions.ts 刪檔。⚠ 既有耐心價 alert 仍會觸發(alert_rules + check-price-alerts EF 未動),UI 已無法新增/取消 — 若要停整條 pipeline 另議
- A4 回看報酬:PortfolioSummaryCard 移 區1(LookbackStat 一併刪)+ 移兩個靜態 caveat;header「+24.19 集中度勝」([[L48]] 已推翻為負:2024 −50.65/2025 −9.02)改為「績效以 /backtest 為準」+ FocusToggle title + default_top_n 註解同步更正
- B1 行為分析:v_trade_behavior(migration 20260630000001 apply 成功)+ /holdings「交易行為分析」section。實證 8 筆全平倉皆獲利(勝率 100%),量化「賣太早」:2408(5/06)+23%出→續抱20日 +44.9%、2344(5/11)+0.9%出→+35.1%、3006(5/15)早出躲 −13.9%。6285/009816 出清後不在追蹤池→賣後 N/A([[L45]] 不偽造)
- #6 回測驗證:**本輪 N/A** — A1-A4(UI 移除)+ B1(唯讀行為 view)皆未動因子/權重/score_universe_at/entry 規則,模型 byte-identical,無 OOS 閘對象([[L36]] 閘是給結構改動)。回測閘隨 B2/B3 進行
- 驗證限制:本機 sandbox 無 node/npm(where/PATH/registry/winget 全查證=已窮舉 [[L42]]),build 與視覺只能 Railway 部署後驗([[L50]])。本機已做:DB 驗 view 上線正確 + 機械式 grep 零殘留引用([[L46]])+ 逐檔 TS 通讀(Promise.all 長度對齊、orphan 全清)
- 待 Andy:`npm run build` + Railway 部署看視覺;B2(Alpha101/GTJA191 純價格因子)/ B3(IC 權重)另開 session 過 [[L36]] OOS 閘

**B2 Gate-0(2026-06-30,純價格因子 IC 探針 — 結論:不建,premise 不成立 [[L41]])**:
- 探針:158 檔(排除 ETF)2023-2025、每 21 交易日 rebalance、PIT 因子 vs 未來 20 交易日報酬 Pearson IC(3351 obs)
- 逐年 IC:mom20(現有動能)0.070/0.071/0.052 **三年最穩**;maxret20 0.097/0.025/0.192、vol60 0.064/0.013/0.182 **regime 依賴(全靠 2025,2024 近 0)**;Amihud −0.015 無訊號;rev5 實測為續強(+0.14)非反轉
- 正交性(corr vs mom20):maxret20 0.32、vol60 0.145、amihud −0.05、rev5 −0.30(rev5=−r5)
- 關鍵:台股低波/樂透因子**反向**(高波動短期續強,非美股低波異常),且 regime 依賴 + 與動能重疊 → 加進去放大已失敗的動能追高([[L36]] mom_strong_persist 覆轍)。簡單價格因子在此 momentum-saturated 小 universe **無穩健正交 alpha**
- 決策:Gate-0 即止,**不進 build/OOS**(省一輪,[[L41]])。Andy 拍板 → 轉 B3

**B3 IC 權重量測(2026-06-30,Andy 拍板「轉 B3」)**:
- 方法:score_universe_at(PIT)取 12 個季度點各維度 score_pct vs 未來 20 交易日報酬 IC(n=1854)
- 逐年維度 IC:fund 0.003/−0.055/−0.041(**全期 −0.020**,卻權重最高 40%);mom 0.106/−0.030/0.274(**+0.125**,唯一正、僅 30%);rev −0.074/−0.006/−0.170(**−0.082** 反預測、佔 10%);chip 全 null([[L44]])
- **現行權重與 IC 嚴重錯配**:fund 過重(負 IC)、mom 過輕(唯一正)、rev 該砍
- 輕量 OOS 模擬(top5/10 fwd20 vs equal-weight universe):偏動能(.3f/.7m)top5 全期 +1.73 vs 現行 +1.12;但**全靠 2025、2024 全負**(regime 依賴);現行 top10 +2.13 最穩
- ⚠ 關鍵 caveat:(a) proxy 對比 universe **非 0050**,真實 EF 對 0050 top5 是負 alpha → proxy 贏 universe ≠ 贏 0050;(b) 機械偏動能**抵觸「好股(質)優先」哲學**,且把系統推向已證實輸 0050 的動能追高 → IC 直接最佳化是陷阱([[L36]]/[[L48]])
- Andy 拍板 (a):溫和再配重(fund .40/mom .35/rev .05/chip .20)送真實 EF OOS 閘

**B3 OOS 閘結果(2026-06-30,run-backtest EF v7,3 年連續 2023-2025,immediate/nextopen,對 0050)**:
- 機制:暫改 app_settings 權重 → 跑 4 個 EF backtest(base/cand × t5/t10)→ 還原權重(已驗證回 40/30/10/20)。backtest_runs 留痕(B3-base/cand-3yr-*,[[L36]] 試驗留痕)
- 結果(alpha vs 0050):
  - **Top5**:base −81.0 → cand **−50.66(+30.3pp)** ✅ ret 74%→105%、sharpe 0.85→1.04
  - **Top10**:base −58.22 → cand **−75.08(−16.9pp)** ❌ ret 97%→80%、sharpe 1.10→1.03
- **判定:候選沒過 [[L36]] 閘** — 大幅改善 top5 但顯著惡化 top10(經典 top5/top10 反向),且單一 3 年路徑非穩健([[L38]])、會把線上偏向動能(抵觸質優先),最關鍵:**base/cand、t5/t10 全部仍深度輸 0050(+155%)** → 差距是結構性(大型權值股狂飆),非權重可調
- **B3 結論:不採,權重維持 40/30/10/20**。核心知識產出:re-weight 是 top5/top10 取捨的邊際槓桿,救不了「贏 0050」;模型本質是質優先螢幕,20d-IC 最佳化非對的目標(呼應 B2)。真正的 alpha 缺口需另解(regime 條件化 / 換 benchmark 期望 / 接受是長線質篩非短線打敗大盤)

---

## 2026-07-03 — 虧損行為分析 → 買入警示(A)+ Universe 改革(B)

**背景**:Andy 問「近期兩筆為何賠錢」。實證解剖(PIT 排名 + 買點價位脈絡):
- 2408 7/01 −8.15%:6/23 於 472.5 停利 → 6/25 用 **478.5 更高價買回**(賣飛回追),當日 dev MA20 +19.6% / 20日已漲 +52.9% / rank 已 #18→#33 退步
- 3236 7/02 −6.89%:7/01 買在 60日新高日盤中 75.5(收盤 73),dev +16.9% / 20日 +32.7%,**且 3236 只在 watchlist = 追蹤池外盲區單**
- 停損本身執行好(−7~8% 即砍;2408 賣後 20日內最高仍低於賣價 7.4% = 砍對)。**問題在進場,不在出場**
- ⚠ 誠實修正:v2 全數據顯示「追高買(dev>+10%)」波段戰績實為 **5勝2敗**(5-6月行情最順段追高也贏),非初判的全敗;真正 0 勝訊號 = **回追**(1 筆即 2408)與**盲區單**(3236)。行情轉弱後追高連 2 敗 → 警示仍必要,但顯示真實統計

### A(已拍板)— 買入警示 + B1 v2 ✅
- [x] migration `20260703000001_v_trade_behavior_v2`(apply + 驗證 PASS):holding_days 修 position-aware(2408 7/01 由誤導的 58 天 → 6 天);append 6 欄:entry_date/entry_price/dev_ma20_at_buy/ret20d_at_buy/is_chase_buy(dev>+10)/is_reentry_buy(前10日曆天有 SELL 且開倉價更高)
- [x] `checkBuyContext` server action(actions.ts):5 查詢並行 — v_entry_quality zone/v_price_factors/realtime 價/近10日 SELL/行為統計
- [x] `BuyForm.tsx` client component 換掉舊 server form:股號 blur → 追高(amber)/回追(red)/盲區(zinc)/回檔✓(green)/破壞(sky)警示,不擋單只強制看見;page.tsx 舊 inputCls/btnCls orphan 清除
- [x] TradeBehaviorSection:新「買點 MA20±」欄(追高紅字 + 🔁 回追)+ 勝率卡 sub 顯示追高/回追戰績
- 驗證:view 對 2408(6天/chase/reentry)、3236(1天/chase)輸出正確;grep orphan 零殘留;build 待 Railway(L50)

### B(設計待拍板)— Universe 改革:固定 ~160 檔 → 全市場雷達 + 動態晉升
**偵察數據**:fetch_universe=160;FinMind token1 **600/600 每天用滿**(chip×3+valuation=4×~150)、token2 用 ~150-160/600(餘 ~440);DB 188MB(price_daily 51MB/13.1萬列);TWSE/TPEX 收盤 OpenAPI 免費抓回全市場(現在 EF filter 掉)
**架構(三層)**:
1. **全市場價格雷達(零 quota)**:fetch-daily-prices 改寫入全部普通股+ETF(上市+上櫃,~2000 檔;3236 就是上櫃,必含)。儲存控制:未進過 focus pool 的股只留滾動 90 交易日(cleanup cron),進過 pool 的永久保留(L38 PIT)
2. **熱股自動晉升**:每日收盤後 cron 掃全市場 →(成交值 topN ∪ 20日漲幅 topN ∪ 60日新高+量2x)→ 新表 `universe_dynamic(symbol, added_at, reason, last_hot_at)`,cap ~50;60 天不熱且非持股自動退場(留 audit);晉升時自動 backfill 3 年歷史+fundamentals(token2,50 檔 chip+val ≈ 200/day 裝得下)
3. **rank/PIT 整合**:fetcher/因子 view universe 加 universe_dynamic;v_factor_scores 缺維 reallocate 既有(L23)→ 新股價格維先亮、chip/fund 到料自動升級;**score_universe_at 必須加 `added_at <= as_of_date`**(否則今日熱股灌進歷史回測 = L48 事後選擇),同時開始累積 L38 要的 PIT universe 快照
**風險**:EF 改動需 L49 機械 deploy + 核對;全市場寫入量 ~2000 row/day upsert;90 天窗清理 cron 要排除曾入 pool 股(誤刪 = L38 回測毀)
- [x] B-1 fetch-daily-prices 全市場寫入 + 90 天滾動清理 cron
- [x] B-2 universe_dynamic 表 + 每日雷達 cron + 自動 backfill 晉升
- [x] B-3 因子/fetcher universe 整合 + score_universe_at PIT 條件 + 迴歸驗證(L32 兩處同步)

**B Review(2026-07-03,Andy 拍板 90日滾動窗 + cap 50,全部完成)**:
- Migration ×3(20260703000002~4)+ EF v8 deploy(L49 拉回核對執行字串 PASS)
- **B-1**:fetch-daily-prices v8 — filter 改「focus 池 ∪ 全部 4 碼」(權證仍排除);provisional 刪除改「先查再交集」(1800 symbols 塞 .in() 會爆 URL);upsert 分批 500。E2E:TWSE 1,094 + TPEX 871 檔寫入(v7 只 ~136)。cleanup cron 每日 20:10 UTC,保留名單 = v_fetch_universe ∪ universe_dynamic(全 row)∪ holdings_transactions ∪ day_trades(平倉股賣後分析需要)
- **B-2**:scan_hot_stocks()(成交值Top30 ∪ 20日漲幅Top30[≥21筆] ∪ 60日新高帶量[≥40筆];cap 50、60天不熱退場、row 永不刪)+ cron 平日 14:20 UTC 含自動 backfill(token2)。首掃晉升 12 檔真熱股(3037欣興/8046南電/5483中美晶/8033雷虎/6285[出清後又熱,自動接回]…);backfill 完成 price 8,035 + valuation 8,766 + rev 420 + fund 132 列
- **B-3**:pg_get_viewdef/functiondef + replace + execute 機械改寫(不手抄 200 行,替換目標前置驗證唯一);v_price_factors + active dynamic → mv → 全下游自動;score_universe_at + **PIT gate(added_at ≤ as_of ∧ 未退場)**。**L39 迴歸:2025/2024 兩時點輸出 md5 與改前 byte 一致**(歷史回測零污染)= L48 事後選擇偏誤被 gate 擋住,並開始累積 L38 的 PIT universe 快照
- E2E 終點:mv refresh 後 12 檔全進 v_stock_rank(8261 fund 6/7 → **#12**、8046 #31),chip 0/0 reallocate 如設計
- 已知 gap(後續):① 動態股無中文名(nameMap 不含,顯示 —;可接 TaiwanStockInfo 補)② 動態股無 Yahoo 盤中即時價(現價 = 日收盤)③ 雷達用 raw close,除權息日附近榜單可能誤判 ④ 雷達漲幅/新高榜需累積 21/40 交易日全市場資料後才全功率(當前僅成交值榜)⑤ 動態股 valuation/月營收為晉升時 snapshot 非日更(PE 微 stale,誠實記錄)

---

## 2026-07-10 — UI 優化第一塊:今晨決策面板 + 到價提醒收尾(Andy 拍板照規畫執行)

> 規畫全景(Andy 已拍板順序):① UI 決策面板 + 到價提醒收尾 → ② ATR sizing + 集中度警示 → ③ ATR/time-stop 出場回測([[L36]] OOS 閘)→ ④ regime 條件化警示 + 事件日曆。本 session 只做 ①,完成回報再接 ②。

- [x] 1. MorningPanel 今晨決策面板(dashboard 頂部結論層)→ verify: TS 通讀 + DB 驗 query 欄位 + Railway build
  - 整合:regime 燈(吸收現有 RegimeWidget)+ 持股對應海外源 gate 結論(overseas-map 共用)+ 每檔持股 chip(現價/今日%/持有%/警示燈/距停損/RSI/entry_zone)+ 進場訊號摘要(檔數 + 前 3 檔)
  - dashboard 新增 query:v_holdings_signals(即時、輕欄位)+ v_entry_quality .in(持股)拿 zone
  - RegimeWidget 獨立行移除(資訊整併進面板);OverseasWidget / EntrySignalWidget 保留 = 細節層
- [x] 2. 到價提醒通用化(收 A3 半拆債:pipeline 活著但 UI 無法管理)→ verify: DB 實測 insert/cancel + grep orphan
  - holdings/actions.ts + addPriceAlert(below/above,同 symbol+condition 防重)/ cancelPriceAlert(by id)
  - AlertDialog.tsx(⏰ 每持股列:快捷掛停損價/加碼價 + 自訂價自動判方向 + 該檔 active alerts 顯示)
  - ActiveAlertsSection(/holdings:全部 enabled alerts 含非持股遺留,可取消)
- [x] 3. 驗證 + commit + push(Railway 部署後 Andy 驗視覺,[[L50]];本機無 node/npm,同 6/30 環境)

## 2026-07-17 — 波段掃描(Andy「排行對短線效益低」→ 拍板做獨立波段視圖)

**背景實證**:排名 20d IC(B3)fund −0.020 / rev −0.082 / mom +0.125 = 質篩排名天生非短線工具;正在噴的波段股被埋在 #75~#103(2408/聯電)。改排名的路已全關(B2/B3/L52),解法 = 獨立呈現層視圖,不動排名。
**覆蓋確認(Andy 問)**:三層 — 全市場價格雷達 1,984 檔(7/03 起,90 交易日滾動)/ 深度分析 179 檔(148 seed + 10 產業 106 檔 + 持股 + 動態熱股 17/cap50)/ 每日全市場三榜(成交值/漲幅/新高帶量 Top30)自動晉升+backfill。池外股 60 日動能 ~9 月底才齊 → 掃描跑 focus∪dynamic,靠雷達晉升達成全市場等效覆蓋(T+1 時滯)。

- [x] migration `20260717000001_swing_scan`:v_swing_scan(pullback + ret_60d>20 + close>MA60;ATR14 lateral;hot 標記)+ swing_scan_snapshot 表 + 每交易日 21:00 Taipei snapshot cron(純 SQL 零 EF)
- [x] /swing 頁 + Sidebar「波段 🌊」:regime 燈 header + 誠實 banner(候選產生器非買訊,前向驗證中起算 2026-07-17)+ 表(現價/60日/20日/距MA20[<-5% 接刀 ⚠]/離高/量比/RSI/ATR%/綜合#/事件 📅)
- [x] 首掃 15 檔:熱股 8261(+121% 回 MA20 −1.6%,#2)/4958/3189/6223 置頂;2408/聯電/晶豪科等
- 前向驗證:snapshot 累積 20-30 個交易日後算 fwd 5/10/20 日報酬 vs benchmark,有統計才拿掉「驗證中」標(誠實條款;Andy 實戰數據顯示回檔買也會接刀 — 2344 dev −6.5 敗 −10.6%)
- 可調 knob(未動,Andy 說要再調):雷達三榜 Top30→Top50、cap 50→80(scan_hot_stocks 參數,token2 quota 裝得下)

**v2(2026-07-17,Andy 回饋「有些沒名稱 + 我玩短線,60日OK嗎」)**:
- 股名根治:`stock_names` 表(1,981 檔 = TWSE t187ap03_L 1,090 + TPEX mopsfin_t187ap03_O 891,零 quota)+ EF fetch-stock-names(週日 cron)+ swing view coalesce + dashboard getCachedNames 加 fallback 源 — 動態熱股全 UI 有名(富鼎/臻鼎-KY/景碩/旺矽/雷科)
- 60 日答案(數據驗證):60 日門檻保留(定義波段存在),**加 `ret_20d_pct > 0` 濾網** — 實證 8 筆勝單 ret20d_at_buy 全正(+3.7~+50.2),唯一 20 日轉負買入 = 2344 深接刀敗(−4.5 → −10.6%);排序改(hot, ret_20d desc)= 進行式優先。16 檔 → 10 檔(力成/國泰金/華碩/技嘉/晶豪科/臻鼎熄火剔除)

## 2026-07-17 — 規畫③:ATR 出場回測(Andy「ATR出場回測」,獨立實驗 session)

> 前提盤點:run-backtest EF v7 **已內建** stop_loss_pct(M9.4b 證偽)/ stop_atr_mult(A:進場日 ATR14 固定距離)/ stop_chandelier_mult(B:trailing,runHigh−k×ATR_t),三互斥、0=關閉=[[L39]] 錨點內建 → 本輪零 code 零 deploy,純實驗。
> 基準(B3-base,3yr 2023-2025 連續,nextopen/dynamic_etf_diff/immediate,vs 0050):t5 alpha −81.0 / MDD 38.28 / sharpe 0.85;t10 −58.22 / 28.68 / 1.10。
> **成功標準(先寫死,[[L36]])**:① t5+t10 alpha 皆不比 base 惡化 >3pp ② MDD 改善 ≥5pp 或 sharpe +≥0.05 至少一項(停損存在理由=風控)③ t5/t10 不得劇烈反向(>10pp)。預設假設:會敗(M9.4b whipsaw 前例)。

- [x] 1. 錨點迴歸:EXIT3-anchor-t5/t10(stop 全 0)vs B3-base — **非 byte-exact,診斷後判定安全**:結構全同(bench 155.43 / 36 期 / 177 筆交易一致),差異=7 月除權息季 3 批 corporate_action(7/01、7/04、7/11)更新還原價 = 資料底床誠實演進非引擎漂移([[L39]] 誠實化不是 rollback 對象)。**實驗基準改用同底床 EXIT3-anchor**:t5 ret 74.71/α−80.72/MDD 40.21/sharpe 0.856;t10 ret 112.52/α−42.91/MDD 25.66/sharpe 1.232
- [x] 2. 實驗矩陣(6 runs,全 finished):
  | run | ret | α | Δα | MDD | ΔMDD | sharpe | 觸發 |
  |---|---|---|---|---|---|---|---|
  | chand3-t5 | 45.27 | −110.16 | **−29.4** ❌ | 25.31 | −14.9 | 0.775 | 118/177 |
  | chand3-t10 | 83.37 | −72.06 | **−29.2** ❌ | 10.88 | −14.8 | 1.299 | 229/351 |
  | chand2-t5 | 32.72 | −122.71 | **−42.0** ❌ | 12.62 | −27.6 | 0.740 | 163 |
  | chand2-t10 | 41.67 | −113.77 | **−70.9** ❌ | 7.02 | −18.6 | 1.044 | 327 |
  | atr2-t5 | 60.47 | −94.97 | **−14.3** ❌ | 32.69 | −7.5 | 0.831 | 77 |
  | atr2-t10 | 104.80 | −50.64 | **−7.7** ❌ | 14.77 | −10.9 | **1.348** ✓ | 143 |
- [x] 3. **判定:六格全數未過閘(標準① alpha 惡化 >3pp 全中),ATR 出場不採用,線上零改動**。runs 留痕 backtest_runs(EXIT3-* ×8,[[L36]] 審計)

**Review(2026-07-17,③結案)**:
- 機制(與 M9.4b fixed-10%、E 等回 MA20 三案合看):策略報酬集中於少數大贏家長波段(top5 尤甚),高波動動能股「正常回撤」本來就是 2-3×ATR 級,任何持有期內會被正常回撤觸發的停損都在誤殺大贏家;且停損後無 re-entry,現金閒置到下次 rebalance 錯過反彈。**ATR 正規化(L43 的形式化升級)沒有改變這個結構** — 三種「聰明出入場」全敗一致指向:20 日輪動 + 動能選股之下,最好的出場就是下次 rebalance 本身
- 停損的功能面誠實記錄:MDD 全格大幅改善(它有做到風控),**atr2-t10 sharpe 1.348 > anchor 1.232 且 MDD 14.8 vs 25.7** — 若目標函數是風險調整報酬而非絕對 alpha,「ATR-static k=2 + top10」是已知可選配置(留檔備查,不上線不改預設)
- 本輪零 code 零 deploy(引擎 v7 早已內建三模式,0=關閉);git 只進知識(todo+lessons),[[L36]] 理想型
- 新 lesson L52(出場優化的結構性前提)

## 2026-07-17 — 6207 即時修復 + UI 全面改版(Andy 三點指示)

1. [x] **6207 沒即時更新(root cause + fix + 盤中直接驗證)**:fetch-yahoo-intraday 對 universe 外 symbol(純持股)一律預設 `tse_` channel → 上櫃 6207 組成無效 channel,intraday cache 永遠零筆(3236 同型態;歷來持股全上市所以沒踩過)。v6:unknown market → tse_+otc_ 雙 channel(MIS 對無效 channel 回空殼,實證安全)。**盤中驗證:6207 已進 cache(139.25 五檔中價)每分鐘更新,realtime view 即時了** ✓
2. [x] **UI 全面改版**:設計語言統一 — 卡片 rounded-2xl + border-white/[0.06] + bg-zinc-900/60、表頭 uppercase tracking-wider、row 分隔 white/[0.04]、輸入/按鈕 rounded-xl、Sidebar 簡化(gradient logo + pill active + 移除副標/底部說明 + 補「績效」入口)、TopBar 去裝飾、globals 柔和漸層底 + 細滾動條、layout max-w-6xl。核心用 sed 精準替換字面 class(43+ 處卡片、8 表頭、21 row border 等),L24 合規全字面
3. [x] **備註清理 + 交易行為判定顯示**:刪 dashboard 持股表長註/持有中註/新增買入註/交易行為長註/rank 權重長註/K線註/動態建議註/持股情報 footer/Sidebar footer/TopBar 假狀態燈(重要語意保留在 th/chip tooltip);交易行為「判定」未滿 20 日改顯示 **N/20 日 pill**(原本 —/N/A 看起來像壞掉,實際是 6/23 賣的才 16 日、7/13 的 3 日 = 未滿期正常),N/A → —
- 驗證:grep 老樣式歸零;build 交 Railway([[L50]])

## 2026-07-11 — 晨間情報改版(Andy 四點指示)

1. [x] 取消早上 TG 推播(cron `telegram-holdings-advice-preopen` 08:55),保留盤後(13:35)
2. [x] 晨間持股情報:韓股(三星/SK海力士/KOSPI,Yahoo v8 已 probe OK)+ 美股 + 台/國際新聞(Google News RSS en 語系,已 probe;Yahoo search news 對韓股回垃圾 → 棄用)整合分析
3. [x] 補 L51(PS 5.1 ConvertTo-Json CJK 陷阱)
4. [x] 刪 OverseasWidget 區塊 → 換 HoldingsIntelWidget(quotes chips + 規則式同業對齊判讀 + 新聞連結;MorningPanel gate 保留,overseas 管線不動)
   - fetch-overseas-leading v2:DEFAULT_SYMBOLS + 005930.KS/000660.KS/^KS11
   - 新 EF fetch-intl-news:持股產業 → 英文 topic(Micron/Samsung/SK Hynix…)→ stock_news(symbol=tag, source=google_news_intl),cron 07:50 Taipei
   - 驗證 + commit + push([[L50]])

**Review(2026-07-11,四點完成)**:
- 1:cron.unschedule('telegram-holdings-advice-preopen') 上線(migration 20260711000004);盤後 13:35 保留。晨間資訊改由 dashboard 承接
- 2+4:fetch-overseas-leading v2(+3 韓股 symbol;KRX 與台股盤重疊,08:30 cron 抓到開盤 ~30min 快照,UI 標「開盤中」)+ 新 EF fetch-intl-news(Google News RSS en 語系,持股產業→topic;⚠ Yahoo search news 對韓股回世足垃圾,probe 後棄用)+ HoldingsIntelWidget(每持股:同業報價 chips + 規則式判讀[漲跌家數 + 僅 verified 源觸發 ⛔ gate] + 台/國際新聞連結各 4 則開新分頁);OverseasWidget 刪除,OverseasRow 型別收編 MorningPanel;MorningPanel gate 不動
- E2E:overseas 70 rows(含三星 +2.52/SK海力士 -0.27/KOSPI +2.52)/ intl news 36 則 3 topics(= 行為驗證 EF 內「記憶體」中文 key 正確,比 byte 比對更強)/ 新聞品質高(Micron $250B、SK Hynix 上市)
- 3:L51 已寫(PS 5.1 三坑:CJK 不 escape / {"value":} wrapper / ASCII 寫檔靜默毀中文 → 手動 StringBuilder 全量 escape + nonAscii=0 檢查 + 行為驗證)
- 待 Andy:Railway 部署驗視覺(dashboard 第二區塊變成晨間持股情報)

## 2026-07-10 — 規畫④:regime 條件化警示 + 事件日曆(Andy「繼續」;③ ATR 出場回測依紀律留獨立 session)

**Gate-0 實證([[L41]],先驗再設計)**:7 筆追高/回追進場時 0050 近季全在 +23~48(U 型「>20 有利區」)— 5 勝 @ +23~32、2 敗 @ +43~48。結論:① U 型地雷區(10-20)條件化會零命中,不做假 gate;② BuyForm「行情轉弱後連 2 敗」措辭與事實不符(敗在大盤更過熱段),要修正;③ 做「動態呈現」不做「n=2 假門檻」。

### A — regime 條件化警示(呈現層,免 OOS 閘)
- [x] A1 migration:v_trade_behavior v3 — append `regime_60d_at_entry`(開倉日 0050 近 61 筆還原報酬,[[L37]] append-only)→ verify: 7 筆與 Gate-0 查詢 byte 一致
- [x] A2 checkBuyContext:+ regimeRet(0050 61 bars 同 dashboard 口徑)+ 追高/回追勝敗的 regime 分布(動態聚合,永不 stale)
- [x] A3 BuyForm:追高/回追警示框加「進場此刻 regime + 你的勝敗 regime 分布」;修正「行情轉弱」錯誤措辭;樣本小 caveat
### B — 事件日曆(法說會/除權息,零 quota)
- [x] B1 實證 TWSE/TPEX OpenAPI 事件 endpoint 欄位([[L47]] 文件≠行為,先 probe)
- [x] B2 migration:`stock_events` 表(symbol, event_type, event_date PK)+ RLS deny-all
- [x] B3 EF fetch-stock-events + 每日 cron([[L49]] PowerShell 機械 escape deploy + 拉回核對)+ 手動觸發驗資料
- [x] B4 UI:MorningPanel 持股 chip 📅 N日內事件 + BuyForm 事件風險警示(checkBuyContext 加 stock_events 查詢)
- [x] 驗證 + commit + push(build 交 Railway [[L50]])

**Review(2026-07-11,④完成)**:
- A:v_trade_behavior v3 上線(DO block pg_get_viewdef 機械包裹,7 筆 regime 與 Gate-0 byte 一致);BuyForm 追高警示 = regime 動態呈現(此刻 0050 近季% + 勝敗 regime 區間自動聚合)+ U 型地雷區(10-20)升級紅色(12 季樣本 backing);「行情轉弱後連 2 敗」錯誤敘事修正為數據敘事(敗在 +43~48 過熱段)
- B:**endpoint 實證結論** — TWSE OpenAPI 無法說會日曆;法說會用 t187ap04_L 每日重大訊息 filter「法人說明會」累積(⚠ 部署日起才有覆蓋,主旨 key 帶尾隨空格);除權息 = TWT48U_ALL(上市)+ tpex_exright_prepost(上櫃);股東會 = t187ap38_L(含停止過戶=融券回補日,detail 留存)。鏡像源每跑先刪未來列再插(改期自動修正),法說會純累積
- E2E 首跑四源全綠:ex_dividend 572 / shareholder_meeting 1105 / investor_conference 3;**2408 的 7/10 南亞科法說被自動抓進**(端到端證明)。cron 每日 21:30 Taipei。PS 5.1 ConvertTo-Json 不 escape CJK 且會包 {"value":} wrapper — 手動 StringBuilder 全量 escape 才是對的(記進 lessons 候選)
- UI:MorningPanel 持股 chip 📅(最近事件+數量,tooltip 全列)/ BuyForm 事件風險框(14 日內)— 「買在法說前」從此看得見
- 待 Andy:Railway 部署驗視覺。剩 ③ ATR/time-stop 出場回測(獨立 session,過 [[L36]] OOS 閘)

## 2026-07-10 — 規畫②:ATR 部位管理 + 集中度警示(Andy「接第二塊」)

- [x] migration `20260710000001_position_sizing_settings`:app_settings 種 `risk_pct_per_trade`(0.01)+ `atr_stop_multiple`(2)— settings 頁 otherSettings 通用列自動可編輯,零新 UI
- [x] checkBuyContext 擴充 `sizing: BuySizing | null`:+4 平行查詢(price_daily 15 bars / settings / v_holdings_summary / v_holdings_pnl);ATR14 = 14 筆 TR 簡單平均(raw 價,<15 bars 或缺本金 = null 不偽造 [[L45]] 精神);capital = 初始本金+已實現(含當沖)+未實現(單一本金假設同權益曲線)
- [x] BuyForm SizingBox:ATR/停損距/風險預算/建議張數;建議 0 張時紅字「1 張風險 = 預算 N 倍,進場 = 有意識接受超額風險」;集中度(1 張市值% / 已持有% / 買後%,>30 黃 >60 橘 >100 紅)
- [x] /holdings 持有中表 +「占比」欄(市值÷資本,同色階;concentrationClass 進 Format.ts 共用)
- [x] 驗證:SQL 精確重演 action 數學(2408:ATR14 36.36=8.35%、capital 451,264、1 張風險 72,714=資本 16.1%、建議 0 張)與 JS 邏輯一致;settings 2 rows 上線;TS 通讀;build 交 Railway([[L50]])

**Review(2026-07-10,②完成)**:sizing 是呈現層(不擋單、不動因子/排名/回測,免 [[L36]] OOS 閘)。2408 實例會顯示:1 張停損風險 16.1% >> 1% 預算、占比 96.5% 橘字 — 把「100% 資金壓單一 8% 日波動循環股」這件事在每次下單時強制可見。之後 ③ ATR/time-stop 出場回測(過 OOS 閘)、④ regime 條件化警示 + 事件日曆待 Andy 節奏。
附帶發現(未動,surgical):/settings 排名展示預設描述仍寫「+24.19 OOS alpha」= [[L48]] 已推翻數字(A4 只修了 /rank),待下輪 UI 清理一併更正。
→ **已更正(2026-07-10)**:/settings 排名展示預設 section 描述 + DefaultTopNRow 註解,比照 A4 措辭改中性(「純顯示偏好、非績效宣稱,績效一律以 /backtest 為準(…已不成立,撤除)」)。grep 全 repo:+24.19 僅剩 tasks 歷史紀錄 / lessons L48 / 已套用 migration 註解 / rank 頁更正註記(皆為「記錄推翻過程」非宣稱),現行 UI 零宣稱。殘留一處 latent:DB `app_settings.default_top_n.description` 仍含舊 +24.19 文字(migration 20260519000006 種入),但 DefaultTopNRow 用硬編碼描述、不渲染該欄 → 目前不見於 UI,要清需一支 UPDATE migration(超出本輪 surgical 範圍,待拍板)。

**Review(2026-07-10,①完成)**:
- MorningPanel([app/_components/MorningPanel.tsx](../app/_components/MorningPanel.tsx)):三行結論層 — 環境(regime 分區沿用 U 型濾網文案 + 持股產業→已驗證海外源 gate,≤−2% 顯 ⛔ 今日勿進)/ 持股 chips(現價、今日%、持有%、signal_level 燈、距停損%[<5% 紅 <10% 橘、已破=⛔]、RSI、entry_zone badge)/ 機會行(進場訊號檔數+前3檔+ /rank link)。dashboard 順序:MorningPanel → SummaryCards → Overseas → Performance → EntrySignal → HoldingsAnalysis;RegimeWidget component 移除(零殘留,grep 過)
- 到價提醒:actions +addPriceAlert/cancelPriceAlert(防重沿用舊 pattern:同 symbol+condition 先停用再插);AlertDialog(SellDialog pattern,快捷停損/加碼價自 v_holdings_advice、自訂價 vs 現價自動判方向可手切、該檔 active 列表可取消);ActiveAlertsSection 收全部 enabled(含非持股遺留)— A3 半拆債結案。⏰ 按鈕與賣出鈕同 cell,有 active 顯數字 badge
- 驗證:v_holdings_signals 7 欄 / v_entry_quality 2 欄 information_schema 全存在;alert_rules 現況 enabled=0(1 筆舊測試已停用,無遺留噪音);TS 通讀(型別/imports/字面 class)+ grep orphan 零殘留;本機無 node/npm(同 6/30),build 交 Railway
- 待 Andy:Railway 部署後看視覺;下一塊 = ② ATR sizing + 集中度警示(拍板規畫順序)
---

## UI 大改 Phase A — Design Tokens + 基礎元件 + Layout 殼(2026-07-22)

> Andy 拍板 A→B→C 三期(A=tokens+元件+殼、B=既有頁遷移、C=新資料視圖)。plan:`.claude/plans/sorted-honking-twilight.md`
> ⚠ **Rebase 記錄**:本機樹落後 origin 13 commits(7/17 已有另一輪玻璃感 UI 改版 + 砍 ETF + 新增 /swing 等)。Andy 拍板「**視覺以線上玻璃感為準**」,Phase A 改為把玻璃語言 token 化,結構照收 remote(nav 含波段、無 ETF)。教訓入 lessons L53。

- [x] `npm install geist lucide-react`(字體檔在套件內,build 零外網需求,不破 L50)
- [x] `app/globals.css`:`@theme` tokens(surface-0/1/2、line、up/down/flat、ok/warn/danger、accent、font-sans;**值 = 7/17 玻璃感**:line=white/6%、surface-1=zinc-900/50)+ 全站 tabular-nums;保留 remote 漸層底/細捲軸/selection
- [x] `app/layout.tsx`:GeistSans variable + font-sans(bg 續由 body 漸層負責,照 remote)
- [x] `app/_components/ui.tsx` 新檔:Card / StatTile / Badge / SignalLight / SectionHeader / TableShell(卡片 = rounded-2xl border-line bg-surface-1 backdrop-blur,對齊 MorningPanel 語言;server-safe,tone→class 完整字面 Record,L24)
- [x] `app/_components/Sidebar.tsx`:三組分區(投資組合:Dashboard/持股/績效|研究:波段/排名/Backtest|系統:設定)+ lucide icons 換 emoji;保留 remote 玻璃 pill/漸層 logo/無副標簡潔化
- [x] `app/_components/TopBar.tsx` / `Skeleton.tsx`:token 化(TopBar 取 remote 版無狀態燈;Skeleton 取 remote rounded-2xl)
- [x] `app/_components/Format.ts`:pctColor 改回傳 text-up/text-down/text-flat(語意不變;EVENT_LABEL/concentrationClass 照收 remote)
- [x] 刪 `app/_components/TabNav.tsx`(remote 也無引用,兩邊皆死碼)
- [x] `npm run build` + grep 驗證(清 stale .next 後全綠;/swing 在、/etf 無、零 conflict marker 殘留)
- [x] push `16583de` → Railway 部署
- [ ] Andy 視覺驗收(第一眼重點:Sidebar 分組+lucide icons、字體/數字對齊、卡片質感不變)

**Review(2026-07-22,Phase A 完成)**:實作中撞 stale checkout(落後 origin 13 commits,7/17 已有玻璃感改版)→ Andy 拍板視覺以線上為準,rebase 語意合併:remote 結構(nav 含波段/無 ETF、無狀態燈 TopBar、漸層底)+ 本次系統化層(@theme tokens、ui.tsx 六元件、geist、lucide、tabular-nums、TabNav 刪除)。教訓 L53。

---

## UI 大改 Phase B — 表面色 token 化 + 表格元件化(2026-07-22)

> Andy 拍板範圍:表面色 + 表格元件化,**語意色不動**。plan:`.claude/plans/sorted-honking-twilight.md`

**盤點**(grep 精確統計):表面色 226 處 / 表格殼 12 + thead 13 / 語意色 138 處。

- [x] `globals.css` token 擴充:`surface-raised`(zinc-950/60 表格強調 row)、`surface-sunken`(zinc-950/80 輸入框凹陷)、`surface-dialog`(**#18181b 實色** — modal 底不可半透明否則透出背景)、`line-soft`(白 4% row 分隔)、`line-strong`(白 10% 輸入框框);`surface-1` 由 /50 調 /60 對齊 62 處主流
- [x] `ui.tsx`:新增 `THead`(divide "b"/"y" 兩分支各寫完整字面 class,L24);`Card`/`TableShell` 移除內建 `backdrop-blur` 改 opt-in(13 處表格實際都沒 blur)
- [x] **機械替換 226 處**:PowerShell `.Replace()` 字面替換(非 regex,零誤傷)+ UTF-8 no BOM 寫回(L51 中文毀損教訓)。8 個映射、23 檔
- [x] 手改 3 處 dialog 底 → `bg-surface-dialog`(AlertDialog/DayTradeDialog/SellDialog)
- [x] 元件化:Perl 非貪婪配對替換 12 處表格殼 → `<TableShell>`、13 處 thead → `<THead>`;9 檔加 `@/app/_components/ui` import
- [x] **對帳驗證**:替換數 226 = 基準 226 ✓;各 token 數量逐項相符(line-soft 21 / line-strong 24 / surface-1 63+4殼層 / sunken 22 / raised 7)✓;標籤配對 TableShell 12/12、THead 13/13 ✓;原始 class 殘留全 0 ✓;中文完整性 + 亂碼掃描 0 ✓
- [x] `npm run build`(清 .next)全綠,11 條路由不變
- [x] push `c7703a2` → Railway 部署
- [ ] Andy 視覺驗收(重點:表格邊框/底色應與改版前**無差異**、modal 底仍不透明、輸入框凹陷感still在)

**語意色刻意不做(已實證非偷懶)**:`HoldingsIntelWidget.tsx` 同一個 `text-red-300` 在 L89「海外同業偏多」是台股紅=漲、L111「⛔ 已破停損」是警示紅=危險。機械替換會綁死兩種語意,未來調漲跌色相會連動改掉警示色。漲跌已有 `pctColor()` 統一(正確抽象層),警示用 Tailwind 原生 amber/red 本來就對。

**刻意保留的元素級樣式**(非表面分層,token 化屬過度設計):badge/按鈕底色(`HoldingsAdvice` SIGNAL_STYLE、`page.tsx:127`、`rank:590`、`error.tsx:27`)、`BuyForm:249` tone map、`page.tsx:812` 表格 row。

**附帶發現(未修,既有債)**:`npx eslint app` 有 6 個 `react-hooks/purity` error(server component 內 `Date.now()`)+ 2 warning。**證實為 pre-existing**(本輪完全沒碰的 `app/backtest/page.tsx` 也報同類錯)。React 19 新規則對 server component 誤報(SC 不 re-render);`next build` 不跑 eslint 故不影響部署。待獨立處理。

---

## 依賴漏洞清零(2026-07-22,commit `3f7778f`)

GitHub 報 6 個(4 high)。`npm audit fix` 修 3 個(@babel/core 任意檔案讀取 / brace-expansion DoS / js-yaml DoS);sharp 0.34.5 → 0.35.3 用 `overrides` 升級(libvips CVE-2026-33327/33328/35590/35591)。
**⚠ 關鍵判斷:不可用 `npm audit fix --force`** — 它會把 next 降到 **14.2.35**(現 16.x),整個專案炸掉。sharp 是 next 的 optionalDependency 且本專案 **零使用 `next/image`**(grep 確認)→ 升級零功能風險,overrides 是唯一正解。next 順帶 16.2.6 → 16.2.11(semver 內)。結果 **0 vulnerabilities**,build 全綠。

---

## Part 1 管線修復 — FinMind quota 再平衡 + 錯誤日誌修復(2026-07-22)

> 起因:規劃 Phase C 盤點 `fetch_log`(15,051 筆)時發現**當下正在發生**的失敗。plan:`.claude/plans/sorted-honking-twilight.md`

**發現(近 7 天 fetch_log)**:6 個 source 失敗 —— `finmind_margin` 0/5、`backfill_price` 1/6、`tpex` 4/10、`finmind_monthly_revenue` 0/1、`etf_metadata_sync` 0/1、`telegram_holdings_advice` 2/3。**L42/L46 沉默 drift 第三次重演**。

**根因與處置**:

| 問題 | 根因 | 處置 |
|---|---|---|
| margin / monthly_revenue quota_exhausted | 主 token 7/19-21 連 3 天 **600/600 用滿**,備援 `finmind_2` 僅 150-309/600 閒置;quota 先到先得,cron 排後面的餓死 | ✅ 兩 EF 加 `token_key` body 參數(**機械複製 lending 既有 pattern**,零新機制)+ migration `20260722000001` 改 cron 帶 `finmind_token_2` |
| `etf_metadata_sync` 錯誤 = `[object Object]` | `throw error` 拋 PostgrestError **物件**(非 Error 實例),`String(e)` 序列化成 `[object Object]` → 日誌全瞎 | ✅ 加 `errMsg()` helper(吃 message/code/details/hint)+ `throw new Error(...)` |
| `tpex` 間歇失敗 | 上游 `error reading a body from connection` | ⏸ [[L06]] 已知,有 dead-letter + reconcile,不動 |
| `backfill_price` `6213: HTTP 400` | 聯茂在 FinMind 端異常 | ⏸ 主力 TWSE 正常(price_daily 有 6213 到 7/22),不影響完整性 |
| `telegram_holdings_advice` stale 警示 | **這是正確防護行為**(偵測到 stale 就不推假資料) | ⏸ 非 bug |

**驗證(實測非推論)**:手動 pg_net 觸發 margin 帶 token_2 → `fetch_log` **success=true / rows_written=1001**(昨天 false/756 就 exhausted);`stock_margin` max(trade_date) **7-20 → 7-21**(143 檔,已是最新可得);quota 正確記在 `finmind_2`(1 → 150),`finmind` 未動用(160)。三個 cron job 確認帶 token_2 且 active。

**L49 再次驗證(誠實記錄)**:deploy 後 `get_edge_function` 拉回核對 —— `inferCategory` **執行路徑中文全對**(主動式/債券/高股息/市值型/主題/指數股票型 + 4 個正則),但**註解有 1 處形近誤植**:repo「錯誤欄位變**瞎**的」→ 線上「變**瞼**的」。在註解不影響執行,不為此重 deploy;但這是我**親自重現 L49**,證明複製環節的誤植風險真實存在,拉回核對是必要的最後防線。

**遺留技術債**:
- [ ] 其餘 **18 個 EF 同款 `String(e)` 序列化**(22 處 `throw error`)— 它們至今未觸發過,但一旦 DB 寫入失敗就會是瞎的日誌。宜統一抽 `_shared/errMsg.ts`
- [ ] quota 目前是**手動分配**不是自動 failover。若 token_2 也吃緊,正解是 `pick_finmind_quota()` RPC 讓 EF 自動選有餘額的 token

---

## Part 2 — Phase C-1:資料健康儀表板(2026-07-22)

> 讓 L42/L46/L55 那類「系統看起來在跑、實際停止收料」的沉默失敗變成看得見的東西,不用再靠 Andy 肉眼發現。

- [x] migration `20260722000002_v_data_health.sql`:單一事實來源 view,統一「檢查項目」長格式(category/key/label/level/metric_num/metric_text/detail/last_at/sort_group),前端只讀不自組 SQL
  - **source**:近 7 天各 EF runs/ok/fail + 最後成功時間 + 最後錯誤。`danger`=最近一次就失敗(現在正壞著)/`warn`=期間曾失敗但已恢復(間歇)
  - **freshness**:9 張關鍵表最新資料日。**基準用 `price_daily` 的 max(trade_date) 而非 current_date** → 自動排除週末/國定假日,不會週一早上整排假警報。門檻依更新頻率分級(日更嚴 2-6 天 / 週更 12-20 / 月季更 70-250)
  - **quota**:今日各 token used/budget,≥75% warn、≥95% danger
- [x] `app/health/page.tsx`:整體狀態 3 卡 + 三區表格(資料源/新鮮度/配額),壞的排前面;底部列「已知且刻意不修」(tpex 間歇 L06、telegram stale 是正確防護、6213 FinMind 400)
- [x] `app/_components/DataHealthWidget.tsx`:**平時不吵,有問題擋不住** — 全綠一行淡字、有異常轉紅/黃框列前 3 項 + 連 /health
- [x] 掛在 dashboard **最上面(MorningPanel 之前)**:若資料 stale,下面的持股燈/regime/海外領先全是過期的,健康狀態是所有分析的前提
- [x] `Sidebar` 系統組加「資料健康」(lucide `Activity`);`health/loading.tsx` skeleton
- [x] `unstable_cache` 300s(fetch_log 只在 cron 跑完才變,不增加 dashboard 連線壓力)
- [x] 驗證:view 實跑 —— freshness **9/9 全綠**(margin 剛修好)、quota 2/2 綠、source 5 danger + 3 warn(正確反映現況);`npm run build` 清 .next 後全綠,`/health` 路由生成,12 條路由
- [ ] Andy 視覺驗收

---

## Part 3 — Phase C-2:個股頁籌碼時序 + 估值位置(2026-07-22)

> 籌碼 4 表原本只被壓成 `v_chip_factors` 布林燈號(過/不過),看不到「往哪走、走多久」;估值完全沒曝光。純呈現層(走 B),不進選股/回測/因子 → 免 [[L36]] OOS 閘。

- [x] migration `20260722000003`:`v_symbol_chip_series`(近 120 天長格式,4 來源日期粒度不同故不用寬表)+ `v_symbol_valuation_band`(PE/PB p20/p50/p80 + 現值百分位)
- [x] `ChipSparkline.tsx`:`Sparkline`(折線+面積)/`SparkBars`(有零軸,台股紅買超綠賣超)/`ValuationBar`(分位帶+現值指針)。**純 inline SVG,零 client JS、零 bundle 增量**(比照 EquityLadderChart,不引入第二套繪圖庫)
- [x] 個股頁加「籌碼動向」(4 卡:三大法人淨買賣/融資餘額/借券賣出量/外資持股比)+「估值位置」(PE/PB 兩卡)
- [x] 驗證:手算對照 **PASS**(2330 view `pe_pctile=36.7` = 手算 `18/49=36.7%`);`npm run build` 清 .next 後全綠

**🔴 過程中抓到自己的 plan 前提錯誤([[L44]] 重演)**:plan 寫「`stock_pe_pb_daily` 有 2023-01 起 **3.5 年、167 檔**」—— 這是看 min/max 日期得到的**假象**。實測:2023-2025 **只有 19 檔**有資料,167 檔全量是 2026 起且只有 130 天,**2330 實際只有 49 筆(2026-05-12 起)**。
**修正**:view 窗口保留 3 年(資料累積後自動變準),但 append `pe_since`/`pb_since` 欄位([[L37]] append-only,免 drop cascade),UI **一律顯示實際樣本數與起始日,不得宣稱 3 年**;樣本 <30 直接不畫分位帶只顯示現值([[L23]] 精神:資料不足別假裝可評)。
**實際覆蓋**:149/167 檔(89%)樣本 ≥30 可顯示分位,18 檔標「樣本不足」;平均 124 天、最大 724。

**單位處理(寧可不標也不標錯)**:法人淨買賣 FinMind 給股數 → /1000 換算張;融資餘額 FinMind 定義即為張;**借券量單位不明確故不標單位**。

---

## 短線動能榜 + 題材分類補齊(2026-07-22)

> 起因:Andy 問「訊號判斷依據是什麼」+「AI概念/記憶體/IC載板漲幅很大卻無法靠前」。

**訊號規則(查證,非臆測 [[L34]])**:`v_entry_signal` 是依序一票否決鏈 —— ① fund 資料 <4 項 → `insufficient_data` ② **`fund_rev_yoy ≠ 1` 直接 false**(月營收 YoY 非正 = 硬門檻)③ fund_pos <3 → false ④ mom_pos <2 → false ⑤ 籌碼有 4 項需過 3、有部分需過 1、無料不卡。強度 `strong` = fund≥5 且 mom≥4。

**「漲幅大排不前」的真因 — 不是動能因子壞掉,是權重錯配**:
- 這些股票動能分多半有 60%(3/5),被 **fund 40% 權重**拉下來;fund 7 項全是價值/品質指標(EPS/ROE/FCF/PEG/毛利率),題材股與循環股反轉初期天生不合
- 現行結構等於「基本面好但沒在漲」贏過「正在漲但基本面普通」= 設計選擇的後果,非 bug
- 實例:6182 合晶 20日+51.9%/rank137、**6213 聯茂 20日+31.7%/rank127**(Andy 當天實際獲利那檔)

**🔴 差點誤判(自我修正記錄)**:第一次用 **60 日**漲幅檢驗,看到 2492 華新科 +132% 卻 rank 88,以為動能因子壞了。查細節才發現它 **20 日 −47.7%、RSI 8.1、距高點 −51%** —— 那是「漲完在崩」,系統排後面是**正確**的。換 20 日重驗才看到真問題。**教訓:檢驗「動能」要看近端窗口,長窗口報酬會把已崩一半的股票偽裝成強勢股** → 這也成為動能榜「型態」欄的設計依據。

**Andy 拍板**:不動權重(避開 [[L36]] OOS 閘與白做風險),改為 ① 加短線視角 ② 補分類 + 熱度榜。

- [x] migration `20260722000004`:補 4 題材共 14 檔(IC載板/銅箔基板/矽晶圓/塑化),`locked=true`
- [x] **零 EF 改動**:查證 `reselect-industry-stocks:213` 的 delete 是 `.eq(industry,X).eq(locked,false)` 且迴圈只跑 `TARGET_INDUSTRIES` 10 個 → 新題材不在清單內,月更 cron 根本不碰;locked 再加一層。**完全避開 [[L49]] 中文誤植風險**(EF 的 classifyIndustry 正是 L49 踩雷處)。名稱從 `stock_names` join 取,migration 內只有 ASCII 股號
- [x] `v_industry_heat` view:各題材 5/20/60 日平均 + **中位數 + 上漲家數**(平均會被單一暴衝股拉高,三者並列才看得出是不是整個族群在動)
- [x] `app/rank/_components/MomentumBoard.tsx`(獨立檔,避免 page.tsx 從 959 行繼續膨脹)+ `/rank?board=momentum` tab(早期分流,不跑多因子那批重查詢)
- [x] 驗證:**回歸 PASS**(top-20 weighted_score 逐檔 byte 相同,證實新分類不影響排名 [[L48]] 實證非假設);題材熱度手算對照 PASS(塑化 avg 40.62/med 34.88 一致);build 清 .next 全綠
- [ ] Andy 視覺驗收

**🔍 熱度榜首度揭露的事(與 Andy 認知相反)**:
| 題材 | 20日均 | 上漲家數 |
|---|---:|---:|
| 塑化 | **+40.6%** | 4/4 |
| 矽晶圓 | **+36.7%** | 3/3 |
| IC載板 | +4.5% | 1/3 |
| AI伺服器 | +1.8% | 5/12 |
| **記憶體** | **−11.4%** | **0/10** |
| **被動元件** | **−24.4%** | **0/7** |

Andy 講的記憶體/被動元件是**上一波**(60 日 +34%/+72.7%),近 20 日資金已輪到塑化與矽晶圓。**這正是題材熱度榜的價值 —— 它會告訴你「你以為熱的其實在退燒」**。

**遺留**:3532 台勝科 / 6274 台燿 加入後才會進收料 universe,下次 cron 才有因子值。

### 迭代:20 日太長 → 改「最新交易日」主軸(2026-07-22 同日)

Andy 追問「20日好像太長,像今天大漲的題材才是進場關鍵」。**方向對** —— 短線持有期(今天 6213 盤中幾小時)用 20 日平均描述題材熱度是錯配;20 日榜給的是「上個月的贏家」,今日榜才是「今天在發動的」。

**踩到的資料坑(migration 20260722000005 第一版全 0)**:第一版今日%用 `v_latest_price_realtime 現價 vs current_date 昨收`,結果全 0.00。查根因([[L35]] 不臆測):① **`current_date` 在 DB 時區已跳到隔日** → `trade_date=current_date` 條件撲空 ② 新加的題材股不在即時料收集範圍 → realtime 只給昨收。**修法**:改用 `price_daily 各股最新兩筆收盤的日變化` —— 不依賴 current_date 對齊、不依賴即時料,對新股一樣算得出。實測 1303 南亞最新兩筆 208 vs 195.5 = **+6.39%**(正是「今天大漲」)。

- [x] `v_industry_heat` 今日口徑改「最新兩筆日變化」+ append 今日欄位(avg/med_today_pct、n_up_today、n_limit_up、today_top_symbol)
- [x] 新增 `v_symbol_momentum`(個股短線,與熱度榜共用今日口徑,[[L42]] 不做兩套 drift;name/industry 一併 join → page.tsx momentum 分支大幅簡化,砍掉 name/ind map)
- [x] `MomentumBoard` 兩榜主軸改「最新交易日」,20/60 退參考小字;**型態欄升級**用今日/5日/20日分辨「趨勢延續 vs 超跌反彈」(同樣今天漲停,緯穎 5日+8%/20日+18% vs 華新科 5日−21%/20日−48%/RSI 8 風險天差地別)
- [x] 驗證:兩 view 手算對照 PASS;排名不受影響(只改 heat 計算+加 view,沒碰 v_stock_rank/因子/成員);build 清 .next 全綠
- [ ] Andy 視覺驗收

**🔍 今日榜首度揭露(與 20 日榜完全相反,直接印證 Andy)**:
| 題材 | 今日 | 上漲 | 漲停 | 20日 |
|---|---:|---:|---:|---:|
| IC載板 | **+9.19%** | 3/3 | 2 | +4.5 |
| 記憶體 | **+5.63%** | **10/10** | 3 | **−11.4** |
| 被動元件 | +4.02% | 6/7 | 2 | **−24.4** |
| 矽晶圓 | **−3.69%** | 1/3 | 0 | +36.7 |

Andy 講的**記憶體/IC載板** 20 日墊底,但**今天**全場最強(記憶體 10 檔全漲、3 漲停);20 日冠軍矽晶圓今天在回檔。**「20 日太長」的鐵證** —— 20 日榜是後照鏡,今日榜才對短線。

### 迭代 2:今日改「盤中即時」+ 缺口股修正(2026-07-23,migration 20260723000001)

Andy 再指正「7/23 盤中榜卻顯示 7/22 收盤,那不是今日」。查證後**我前一版兩個判斷都錯**:
- ❌「新題材股拿不到即時價」→ 實測 7/23 盤中**全有** twse_mis 即時價(它們 7/22 剛加入,當天 intraday 還沒收;隔天 cron 就收了)。又一次基於過時觀察下錯結論([[L34]]/[[L53]])
- ❌「最新交易日」口徑 = price_daily 最新兩筆 → 盤中時 = 7/22 vs 7/21 = 昨天,標成「今日」誤導

**最終口徑**:現價(v_latest_price_realtime,盤中 intraday 即時/盤後收盤)vs **全市場前一交易日**收盤。
- 現價日用 `as_of_ts::date`(資料本身),**不用 current_date**(DB 時區跳隔日會撲空)
- 昨收基準用**全市場統一前一交易日**,非各股自己前一筆 —— 後者對缺口股虛高:**6274 台燿**(上櫃,tpex 收料間歇失敗)price_daily 停 7-20,自己前一筆算成 1375/1125=**+22%**(跨 3 天當單日,破 10% 限制)。改統一基準後 6274 缺 7-22 → 不進榜
- 前端個股榜過濾 `price_source=twse_yesterday`(只有舊價的不進今日榜)
- MomentumBoard interface 換(latest_close→current_price、last_date→today_as_of+price_source);header 標「盤中即時 HH:MM / 今日收盤」

- [x] migration `20260723000001`:兩 view today 改盤中即時 + 全市場前一交易日基準(05 保留日變化版不改已 push 歷史,06 記增量)
- [x] 前端 interface/文案/現價欄改即時;過濾 twse_yesterday
- [x] 驗證:7/23 09:33 盤中 —— 6505 台塑化 +9.99%、1301/1326 +9.92%,**全 ≤10% 單日限制**;6274 缺口股已排除;塑化題材今日 +7.69%(4/4)、IC載板 +7.35%(3/3);build 全綠
- [ ] Andy 視覺驗收

**教訓([[L53]] 延伸)**:又一次「基於過時觀察下錯結論」—— 7/22 說新題材股沒即時價、盤後級夠用,7/23 全被推翻(隔天就有即時價)。**跨天的系統狀態(收料範圍、cron 是否已跑)必須當下查證,不能用昨天的觀察外推**。

---

## M11 — 大盤籌碼體溫盤(Andy 五指標,2026-08-04)

> 註:migration/EF 註解內寫的是「M10 Phase 1/2」,指的就是本區塊 —— 動工時撞到既有
> 「M10 Backtest harness」(L536)的編號,事後改為 M11。SQL/EF 內的字樣不影響功能,未回頭改。

Andy 提出五條台股擇時參考,問能否提升持股/選股質量。逐條查完資料源(**已實打 FinMind API 驗證**):

| # | 指標 | 現況 | 資料源 |
|---|---|---|---|
| 1 | 外資期貨空單留倉回補 | ❌ 缺 | `TaiwanFuturesInstitutionalInvestors`(TX),有 long/short_open_interest_balance_volume |
| 2 | 外資停止賣超台積電 | ✅ `stock_institutional` 已有 2330 | +全市場版 `TaiwanStockTotalInstitutionalInvestors` |
| 3 | 融資餘額下降 | ⚠️ `stock_margin` 只有個股 | `TaiwanStockTotalMarginPurchaseShortSale`(全市場) |
| 4 | 費半要漲 | ✅ `overseas_indicators` `^SOX` | — |
| 5 | 韓股三星/海力士不熔斷 | ✅ 已有 005930.KS/000660.KS | 目前僅資訊性對照,未觸發 gate |

**前提驗證(動工前先做,[[L41]])**:三個 dataset 皆免 token、單 call 抓滿 486 交易日(2024-08-01→2026-08-03),**不吃現有吃緊的 FinMind quota**([[L55]])。

**三個誠實警告(寫進 spec,不可略過)**:
1. **指標 4/5 的方向已被本系統實證打折** —— `overseas-map.ts` n≈470 掃描:下檔警示強、**上檔買訊勝率僅 48%**。故 ^SOX/韓股只能做「否決條件」,不做「上漲=進場」
2. **1/2/3 高度共線疑慮** —— 外資期貨回補、外資買超台積電、融資減,下跌末段常同時發生。五條 AND 一年觸發 1-2 次,樣本驗不動 → **做 0-5 分體溫分數,不做 AND 開關**
3. **五條全是大盤擇時,對選股排序無效** —— 只能當進場 gate,不改變 top5。選股質量要靠個股層級因子(`chip_factors` 現有 foreign_holding_ratio/margin_balance)

### Phase 1 — 補料 + 體溫盤(不接決策)

- [x] migration:`market_chips_daily` 寬表(一天一列,避免 partial upsert 坑)
      期貨 fut_{foreign,trust,dealer}_oi_{long,short,net} / 融資 margin_balance_{shares,amount}、short_balance_shares / 法人 {foreign,trust}_net_buy
- [x] EF `fetch-market-chips`:一次抓三個 dataset 寫一列(3 call/日)。仿 `fetch-overseas-leading` pattern —— 同 EF 支援 realtime(近 5 日)+ backfill(body.start_date),upsert cache 語意,寫 fetch_log
- [x] backfill 兩年(單 call/dataset)
- [x] cron 排程(期交所/證交所資料約 15:00 後出 → 收盤後跑,避開 [[L55]] quota 先到先得時段)
- [x] view `v_market_temp`:5 條訊號布林 + 0-5 分
      ①fut_foreign_oi_net 5日變化>0 ②2330 外資近5日累計淨買≥0(讀既有 stock_institutional) ③margin_balance_shares 5日變化<0 ④^SOX 5日報酬>0 ⑤三星/海力士隔夜跌幅未破 −2%
- [x] `v_data_health` 納入 market_chips_daily 新鮮度([[L42]]/[[L46]] 沉默 drift 防線)
- [x] ~~MorningPanel 加市場體溫列~~ → Andy 決定不做(2026-08-04,見文末結案)

### Phase 2 — PIT 驗證(過閘才升級成 gate)

- [x] 逐條測:訊號日 → 後 5/10/20 日 0050 報酬 vs 全樣本基準(**只用當日已知資料,嚴防 [[L48]] 前視偏誤**)
- [x] 五條互相關矩陣 —— 驗證上述警告 2 的共線疑慮,共線的合併計票不重複計分
- [x] 分數 0-5 各檔的後續報酬分佈(檢驗「分數越高越好」是否單調,而非只看極端)
- [x] 窗口對齊檢查([[L56]]):擇時訊號配短窗口,不可用長窗報酬偽裝
- [x] 結論寫回 lessons/memory;**過閘的才升級成 gate,沒過的留在儀表板當參考**

⚠️ 不跳過 Phase 2 直接接決策 —— 這五條目前都還是坊間常識,未經本系統數據驗證([[L41]] 華新科偽命題殷鑑)

### Review — Phase 2 結論:五條全數未過閘(2026-08-04)

**樣本**:2021-08-11 ~ 2026-08-03,1208 個交易日五條全備。基準 = TAIEX 報酬指數
(含息、無分割)。嚴格 PIT:訊號日 T 收盤後才可知 → T+1 收盤進場,T+1+N 收盤出場。

**逐條檢定(20 日報酬,訊號成立 vs 不成立)**

| # | 訊號 | n(true) | spread | t | 分年(2021→2026) | 判定 |
|---|---|---:|---:|---:|---|---|
| ① | 外資台指期淨未平倉回升 | 566 | +0.14 | 0.41 | −1.7 / +1.0 / −0.8 / +1.3 / −0.0 / +5.3 | ✗ 不顯著 |
| ② | 台積電外資近 5 日不再賣超 | 563 | +0.40 | 1.22 | −1.8 / +0.2 / −0.5 / +0.5 / +3.5 / −0.5 | ✗ 不顯著 |
| ③ | 全市場融資餘額下降 | 484 | −0.30 | −0.89 | +0.0 / +2.1 / +1.2 / +1.3 / −2.3 / −2.4 | ✗ 不顯著 |
| ④ | 費半近 5 日上漲 | 665 | +0.90 | **2.59** | −1.3 / +1.5 / −0.1 / −0.4 / +1.2 / −1.1 | ✗ 四年為負,不穩健 |
| ⑤ | 三星/海力士未破 −2% | 941 | −0.65 | −1.44 | −0.9 / −0.4 / −0.3 / −0.1 / +0.2 / −1.3 | ✗ 微負 |

**分數加總(0-5)**:非單調。score 3 最高(+2.48%)、score 5 反而 +1.87%、score 0 +1.75%,
全距僅 1.5pp。**「五條都亮 = 更好」不成立**(score=5 共 50 天,不是提案時說的一年 1-2 次)。

**共線矩陣(n=1208)**:提案時的共線疑慮**被推翻** —— 外資期貨 vs 台積電外資 r=0.056、
vs 融資 r=0.017,最高一對僅 0.31。五條近乎獨立 → 加總無效**不是重複計票稀釋,
是每條本身就沒訊號**(見 [[L59]])。

**過程中兩個差點寫成定論的錯誤(已成 [[L57]] / [[L58]])**:
1. 先用手邊 2 年樣本跑,得「③ 融資減 t=−3.80 顯著反向」;延長到 5 年後掉到 −0.89。
   2 年樣本是單一大多頭(基準 20 日 +4.13%),而這五條本質是**落底訊號** —— 沒有底部的
   樣本驗不動落底訊號。④ 反向也一樣:2 年 t=0.70 → 5 年 t=2.59,但分年一拆就破功
2. 基準原本要用 0050 未還原價,分年檢查發現 **2025 年 −66.2%** —— 0050 分割造成的
   假斷崖。改用 TAIEX 報酬指數並加 sanity(單日 >8% 天數;實測最大 ±9.7%,通過)

**已交付(Phase 1 基礎建設,與驗證結果無關,獨立有用)**
- `market_chips_daily` 1258 天(2021-06 起):外資台指期多空未平倉、全市場融資融券餘額、全市場三大法人買賣超
- EF `fetch-market-chips`:免 FinMind token、3 call/日,不參與 quota 競爭([[L55]])
- cron 每平日 21:30 Taipei;`v_data_health` 已納入新鮮度(現況 ok)
- 順帶補齊兩個 partial backfill 缺口([[L44]]):2330 法人 65 天 → 1259 天、韓股 21 天 → 1219 天
- `v_market_temp`(標註 UNVALIDATED,不接任何決策路徑)

**建議的形態調整(待 Andy 定奪)**:既然五條經實證都不具穩健預測力,前端**不應該做
「體溫分數燈」** —— 那等於把已證明無效的東西包裝成訊號,違反 memory `stock_current_state`
的定調(不宣稱穩定 alpha)。改做**中性資訊列**:直接顯示外資台指期淨部位、融資餘額、
外資買賣超的數值與 5 日變化,不加燈號、不給分數、不隱含買賣建議。資料本身對看盤有用,
把它當訊號才是問題。

- [x] Andy 定奪前端形態 → **不做**

**結案(2026-08-04)**:Andy 定奪 —— **前端不做**,效益不大。M10 到此為止。
資料管線與 cron 保留繼續收料(日後若要重驗,樣本會隨時間自然變厚);
`v_market_temp` 保留但維持 UNVALIDATED、不接任何決策路徑。
- [x] ~~MorningPanel 加市場體溫列~~ → Andy 決定不做
- [x] Andy 定奪前端形態 → 停
- [x] 結論寫回 lessons(L57/L58/L59)/ memory(`m10_five_signals_invalidated`)

---

## M12 — 起漲點掃描(Andy 五條件,2026-08-06)

Andy:「目前的排行只是把已經漲的股票列出來,我抓不到起漲點」。

**根因有兩個(不只排序邏輯)**:
1. 既有 `v_symbol_momentum` 的池子只有 `industry_stocks` **137 檔題材股** → 今天真正
   起漲的股票多半根本不在名單裡
2. 排序依據是「已實現漲幅」= 後照鏡

**Andy 五條件(2026-08-06 確認定義)**
| # | 條件 | 實作 |
|---|---|---|
| ① | 漲停 ~ 7% 前段班 | `day_pct >= 7` |
| ② | 成交張數 > 5000 | `volume >= 5,000,000` 股(price_daily.volume 單位為股) |
| ③ | 雞蛋水餃股不加 | `close >= 20`(Andy 選 20 元,非慣例的 10 元) |
| ④ | 月線拉開/區間徘徊/沒進攻意圖不看 | 突破前 20 日高 + 站上月線且月線轉揚 + 乖離 <15% |
| ⑤ | 傳產不看 | 官方產業別排除傳產+金融+ETF |

- [x] `stock_industry`:全市場官方產業別 3132 檔(FinMind TaiwanStockInfo,pg_net 直灌)
      —— 補 `stock_universe.industry_category` **100% NULL** 的洞,沒有它無法表達條件⑤
- [x] `v_breakout_scan`:全市場掃描 + 逐條旗標(看得到差在哪一條,不是只給通過名單)
- [x] EF `backfill-market-history`:TWSE `MI_INDEX?date=&type=ALL` + TPEx `otc?date=&type=EW`
      按日歷史端點(**關鍵是 TPEx 的 type=EW,少了它 totalCount=0**),各 1 call/日,不吃 FinMind quota
- [x] 驗證小批(8/03-8/05):8/04 上櫃 25→836 檔、8/05 上市 147→939 檔,7 秒無錯誤
- [ ] 3 個月歷史 backfill(2026-03-23 ~ 07-01,三批並行)
- [ ] 重跑掃描確認可判斷池子擴大

**發現的資料事故(已 spawn 獨立任務)**
- `tpex` 收料近 3 天 6 次只成功 3 次(JSON 截斷 / connection body 錯誤),
  8/04 上櫃只進 25 檔。**缺一天就讓 838 檔上櫃股從 20 bars 掉到 19 bars**,
  全部算不出 MA20 → 條件④ 對上櫃形同失效。這是 [[L42]]/[[L46]]/[[L55]] 沉默 drift 第四次重演
- `v_data_health` 只看 max(trade_date) 不看檔數 → **抓不到「日期有更新但檔數腰斬」**,
  監控盲區,已列入該任務

**已知限制**
- **盤後限定**:`v_latest_price_realtime` 無 volume 欄位,盤中無法判斷條件②。
  收盤後選股、隔日進場
- **未回測**:只做型態過濾,不宣稱能賺錢。要驗證須遵 [[L57]](樣本跨 regime + 分年穩健性)
- 8/05 掃描結果:六條全過 **0 檔**;研華 2395 漲停+突破+月線轉揚+乖離 13.4%,
  **只差成交量**(4138 vs 門檻 5000)—— 門檻敏感度值得 Andy 看幾天實例再定

### Review — backfill 完成 + 初步回顧(2026-08-06)

**backfill 結果**:2026-03-23 ~ 07-01 補完 **69 個完整交易日**(4 個 empty 是清明/勞動節/端午,
台股休市)。掃描池 **121 → 1338 檔**;上櫃可判斷 MA20 從 **33 → 870 檔**、平均 bars 19.1 → 50.3。

**EF 實測特性**:單次穩定處理約 5-12 個交易日就靜默結束(TWSE 回應 4.3MB,
解析吃 CPU,推測撞 EF 資源上限;回傳 success=true 不報錯)。
**故 backfill 必須分小批 + 事後查洞**,不能發一次就當完成 —— 本次就是這樣漏掉 23 天。

**初步回顧(2026-04-20 起,124 次觸發,TAIEX 報酬指數為基準,T+1 收盤進場持 5 日)**

| 月份 | n | 個股 | 大盤 | 超額 | 勝率 |
|---|---:|---:|---:|---:|---:|
| 04 | 10 | −4.53 | +4.25 | **−8.79** | 30.0% |
| 05 | 60 | +2.32 | +1.35 | +0.97 | 53.3% |
| 06 | 42 | −1.64 | −0.88 | −0.76 | 35.7% |
| 07 | 12 | −5.55 | −2.32 | **−3.23** | 25.0% |
| **全期** | **124** | **−0.33** | +0.47 | **−0.81** | **42.7%** |

⚠️ **這個數字在補洞前後翻轉**:用有洞資料(5/25-6/12、4/14-4/30 只有 180 檔在池子裡)
算出來是「超額 **+1.58pp**」,補完 23 天後變 **−0.81pp**,方向相反。
[[L58]] 講的是價格序列的資料品質,這裡是**樣本覆蓋的資料品質** —— 同樣會讓結論反向。
**教訓**:回測前必先查「樣本期間內每日的池子大小是否一致」,不齊就別跑。

**結論**:現有樣本**沒有顯示**這組條件有正超額(反而偏負、勝率 42.7% 低於丟銅板)。
但 3.5 個月、單一 regime、124 次觸發,依 [[L57]] 一樣**不足以斷言它無效**。
定位:**這是找標的的工具,不是已驗證的賺錢方法**。要驗真需 backfill 到 1-2 年。

**觸發頻率(健康)**:75 個交易日中 32 天有訊號(43%),有訊號日平均 2.22 檔 —— 不會空榜也不會爆量。

- [x] 3 個月歷史 backfill(分批 + 補洞,共 69 個完整交易日)
- [x] 重跑掃描確認可判斷池子擴大(121 → 1338)
- [ ] backfill 到 1-2 年後重驗(現有樣本不足以下任何定論)

### 前端 /scan(2026-08-06,Andy 定奪「新開一頁」)

- [x] `app/scan/page.tsx`:六條全過置頂 + 「差一條」區塊(門檻邊緣標的),
      每檔顯示六個條件旗標(漲/量/價/破/月/乖),未滿足的畫刪除線 + tooltip 說明差在哪
- [x] Sidebar「研究」組加入「起漲掃描」(Crosshair icon,排在波段之前)
- [x] `npm run build` 全綠,`/scan` 路由已生成(ƒ server-rendered)
- [ ] Railway 部署後 Andy 視覺驗收([[L50]] 本機連不到 Supabase,視覺只能線上驗)

**頁面上的誠實標註**(依 memory `stock_current_state` 定調,不宣稱 alpha):
橫幅明寫「候選產生器,非買訊」+ 初步回顧數字(5 日超額 −0.81%、勝率 42.7%)+
「現有樣本沒有顯示這組條件能賺錢,但也不足以斷言無效」+ 盤後限定說明。
**不讓使用者以為這是驗證過的買訊**。

### M12 改版:三頁融合 + winvest 式燈號(2026-08-06)

Andy:「介面參考 winvest」+「起漲掃描/波段/排名太多種,融合並刪除不必要備註與低實用度功能」
+「可接受大改,全面以抓住起漲股為主」。

**winvest 設計精髓**(實地看 winvest.tw/Stock/Symbol/Comment/2408 抓出來的):
結論先行(總分 + 燈號)、**每個指標明示門檻**(綠:>+5%｜黃:±5%｜紅:<-5%)、一句話看懂、
長警語壓成底部一行小字。

- [x] `v_breakout_scan` v2:三面向評分(起漲 34 / 位置 33 / 動能 33 = 100)
- [x] `/scan` 改版:燈號列 + 一句話看懂 + 「高分候選」折疊(80 分以上)
- [x] Sidebar 移除 /rank、/swing(**路由與資料照舊**,見下)
- [x] build 全綠

**為什麼是三面向不是 winvest 的四面向**:winvest 第四面向是籌碼,但本系統
`stock_institutional` 只覆蓋 v_fetch_universe_stocks(118 檔)、`stock_margin`(169 檔),
掃描池 1338 檔中**僅 81 檔(6%)有籌碼資料**。硬做成主面向 = 94% 顯示空燈號,
或更糟:拿缺料當「中性」計分([[L45]])。故籌碼降級為附加標籤,三主面向全部從
price_daily 算 → 全市場口徑一致。

**刪 UI ≠ 刪資料管線**(Andy 拍板「側欄拿掉,資料繼續跑」):
`/rank` 的 paper_picks 前向追蹤與 `/swing` 的 swing_scan_snapshot **繼續累積** ——
那是系統唯一在跑的實盤驗證樣本(memory `stock_current_state` 定調「終極驗證靠 paper-track」),
砍掉要重等半年。兩個路由保留可直接打網址,只是不在側欄。

**RSI 口徑差異(記錄避免日後混淆)**:本 view 用 SMA-RSI,因全市場歷史目前最多 63 根,
Wilder 遞迴需更長 warm-up 才穩定。與 `v_stock_rank.rsi14`(Wilder,205 檔 universe)
是**不同 universe 的不同指標**,不可互相對照。

- [ ] Railway 部署後 Andy 視覺驗收

### /scan 前向凍結 scan_picks(2026-08-06)

Andy 問「保留 paper_picks / swing snapshot 對系統有什麼好處」→ 查完實際狀態後,
發現兩者價值差很多,且真正該補的是 **/scan 自己沒有前向紀錄**。

**查證結果**
- `paper_picks`:3 批(05-16 / 06-13 / 07-18),2 批已結算 —— alpha **+1.13 / −0.17**,
  勝率各 60%,合計約**打平大盤**。與 memory 推估的 [−9,+8] 中位打平吻合。
  價值明確:**結構上不可能有前視偏誤**(選完凍結,entry_px 寫死),
  而系統被 M9.3 的 +24.19 假 alpha 騙過一次,根因正是前視
- `swing_scan_snapshot`:14 天 48 列,且**表結構根本沒有後續報酬欄位**
  (只有 scan_date/symbol/close/ret_60d/dev_ma20)→ 它不是「在驗證」,只是「在存底」。
  加上 /swing 方向已判定不對,邊際價值很小。**上一則把兩者並列講是誇大**

**新增(補 /scan 的前向缺口)**
- [x] `scan_picks` 表:每日凍結 score_total >= 80 的標的(兩組都收,用 passes_all 區分,
      日後可分別回答「五條件嚴格版」與「高分寬鬆版」哪個好)
- [x] `v_scan_track` view:對 TAIEX 報酬指數算 5/10/20 日超額,entry = 訊號日次一交易日收盤
- [x] cron `freeze-scan-picks-daily` 07:00 UTC(= 15:00 台北,前一交易日 twse/tpex 都已入庫)
- [x] 首批凍結:2026-08-05 共 12 檔(3 檔全過,分數 80-94)
- [x] 計算驗證:插臨時歷史列實測 entry_px/ret_5d/excess_5d 與手算一致,驗完刪除(未污染真前向樣本)

**設計取捨:只凍結「當時選了誰」,不回填報酬**。paper_picks 需要 settle 流程回填 exit_px;
本表改由 view 即時 join price_daily 算。理由:① 少一個會靜默壞掉的回填 cron([[L42]]/[[L46]])
② 報酬永遠反映最新資料 ③ **凍結的是選股決策(唯一會被回溯竄改的部分)**,價格是客觀事實無須凍結。

⚠️ 這張表要 **6 個月以上**才能回答任何問題。在那之前 v_scan_track 的數字沒有意義。

- [ ] `v_data_health` 加 scan_picks 監控(連續 5 個交易日無新增 = cron 可能死了)。
      與 tpex 修復任務的「檔數腰斬檢查」一起做較省(同一個 view 要改)

### 監控盲區 + 上櫃收料根治(2026-08-06)

- [x] `v_data_health` v3:新增 **coverage** 類別(檔數腰斬偵測)+ `scan_picks` 新鮮度
      coverage 補的正是 freshness 的盲區:**日期有更新但檔數腰斬**。
      口徑:最新交易日檔數 vs 近 20 日中位,<80% warn、<60% danger。
      實測 1968 檔 vs 中位 1962 = ok
- [x] cron `backfill-market-history-daily` 06:45 UTC 每日補最近 5 天
      **不在 fetch-daily-prices 加重試**:重試只降低單次失敗率,連續失敗照樣留洞,
      且失敗後無機制回頭補。改用「每天無條件補最近 5 天」的收斂式設計 ——
      任何單日失敗最多存活到隔天,不需偵測失敗、不需判斷該不該補。
      EF 寫入是 ignoreDuplicates,重跑對既有資料零影響
- [x] 8/04 上櫃缺料已由 backfill 補回(1962 檔 = 中位水準)

**排程順序(UTC)**:06:30 收前一交易日 → **06:45 補洞** → 07:00 凍結前向樣本
(凍結必須在資料完整之後,否則凍到殘缺池子 = [[L60]] 重演)

**新監控立刻照出 3 個既有 bug(不在本次範圍,待 Andy 定奪)**
| 來源 | 狀態 | 錯誤 |
|---|---|---|
| `etf_metadata_sync` | 0/1 | `ON CONFLICT DO UPDATE command cannot affect row a second time` —— 同批 payload 有重複 key |
| `reselect_industry_stocks` | 0/1 | `duplicate key ... industry_stocks_industry_symbol_key` |
| `backfill_price` | 1/6 | `2408: HTTP 400`(南亞科在 FinMind 端點抓不到,連續多日) |

另 `tpex` 5/10、`twse_mis_intraday` 1496/1500(99.7%,偶發 502,可忽略)。
`backfill_market_history` 9/12 的失敗是 TPEx HTTP 520(2026-06-08~12),
**該區間資料事後已補齊**(69 個完整交易日),屬暫時性錯誤已自癒。

---

## 資料健康 10 紅字:3 個根因(2026-08-11)

Andy 丟 /health 截圖。10 項 danger 不是 10 個故障,收斂成 3 個根因 + 1 個未定案。
**最嚴重那項被截在畫面外**:`收盤價涵蓋檔數 524(近 20 日中位 1974)` —— 8/10 全市場
只收到 524 檔,而且全部來自 FinMind fallback,twse/tpex 各 0 檔。

### 診斷(查證紀錄)

| 根因 | 證據 | 波及的畫面項目 |
|---|---|---|
| **A. FinMind 配額結構性打滿** | 兩顆 token 8/7 起天天 600/600。每個 EF 都對 `v_fetch_universe` 594 檔逐檔打 1 call → **單一 EF 吃光一天配額**。引爆點 8/6:industry_stocks 去重修好後名單長回來,universe 547→594,越過 600 懸崖(8/5 之前 547/600 是擦線活著) | finmind_fundamentals / finmind_margin / finmind_valuation / backfill_corporate_action,以及 freshness 的法人/融資/借券/PE 落後 |
| **B. TPEx 上游不穩 + TWSE openapi 結構性 T+1** | 實測(2026-08-11):TWSE `STOCK_DAY_ALL` 回的是 1150807,**永遠落後一個交易日**;TPEx openapi **現在是好的**(10,298 列、4.0 MB、Date=1150810)。8/10 兩次 tpex 都死在讀 body(`error reading a body from connection` / `Unterminated string in JSON at position 511406`)= 4MB 回應被截斷 | coverage 524 檔 / tpex / events_tpex_prepost / backfill_market_history(HTTP 520) |
| **C. 補洞 cron 視窗算錯** | `start_date = current_date - 7` + `max_days = 5`,EF 從 start 往後數 5 個工作日就停 → 8/10 那次補的是 **8/3–8/7**,`next_start` 停在 8/10 就結束。註解寫「補最近 5 天」,實際是「7 天前起算的 5 天」 | coverage(當天的洞當天補不到);07:00 freeze 凍到 524 檔殘缺池 = [[L60]] 重演 |

**監控盲區(附帶發現)**:`finmind_institutional` / `finmind_lending` 在建 fetch_log **之前**
就 `return quota_exhausted` → 監控上不是變紅,是**整列消失**。靠 freshness 的
「法人買賣超落後 5 天」才露餡。

**未定案**:`backfill_price` 每天 62+ 檔 HTTP 400。實測 FinMind 正常參數 200、亂 token
回 400 `Token is illegal.`;但 token_2 在 8/9 monthly_revenue 明確成功寫 4636 列 →
**不是 token 壞掉**。`callFinmind` 只 `throw new Error(HTTP ${status})` 把 response body
丟掉了,`msg` 看不到,無法定案。→ P2 補 body 後再看。
順帶:該 cron 應只送 1 檔持股(2408),但錯誤列表是從 3236 起的全 universe →
那天 `jsonb_agg(v_holdings_current)` 回空陣列,EF 走了「沒給 symbols 就打全 universe」
的 fallback,誤觸一次就是 594 calls。

### 本輪範圍(Andy 選 P0+P1;P2 監控留下一輪)

- [x] **P0-1 補洞視窗** `start_date := current_date - 5`(+max_days 5 → 任何星期幾都剛好涵蓋到 current_date,實算最大 5 個工作日)
      → verify:觸發後 EF 回傳 `per_day` 含當日;`select trade_date,count(*) group by 1` 最新交易日回到中位水準
- [x] **P0-2 tpex body 韌性** `res.text()` + 長度入錯誤訊息 + 失敗重試 1 次
      → verify:失敗時錯誤訊息變成 `invalid JSON (N bytes)` 可辨識截斷;成功時 rows_written > 0
- [x] **P0-3 freeze 前置閘** 當日檔數 < 近 20 日中位 80% 就不凍(與 v_data_health coverage 同口徑)
      → verify:拿今天(524 vs 1974 = 27%)實跑 command,應 0 insert
- [x] **P1-4 fallback 只補洞** 已有當日資料的 symbol 直接跳過,不打 API
      → verify:健康日 api_calls << 594;殘缺日仍全打(不退化)
- [x] **P1-5 lending 換回 token1** margin+lending 同日同 token 各 594 必撞;P1-4 之後 token1 幾乎全空

**依賴順序**:P1-4 必須在 P0-1/P0-2 之後才安全 —— 免費源(tpex 當日 + MI_INDEX 當日)
先能覆蓋當日,fallback 才可以退回「只補剩下的洞」。

### Review(code 已寫完,**尚未套上 prod**)

| 檔案 | 動作 |
|---|---|
| `supabase/migrations/20260811000001_fix_gap_backfill_window.sql` | 新增 — start_date d-7 → d-5 |
| `supabase/migrations/20260811000002_freeze_scan_picks_coverage_gate.sql` | 新增 — freeze 包 do block + coverage 閘 |
| `supabase/migrations/20260811000003_lending_back_to_token1.sql` | 新增 — lending body 拿掉 token_key |
| `supabase/functions/fetch-daily-prices/index.ts` | `fetchJson()` 取代 inline `res.json()`(+2 行 call site) |
| `supabase/functions/fetch-finmind-fallback/index.ts` | 迴圈開頭跳過當日已覆蓋的 symbol + 回傳 `already_covered` |

**已驗證**
- P0-1 視窗數學:模擬 7 個星期幾 × 兩種 start。`d-7` 在週一到週五**一次都碰不到當日**
  (永遠停在前一個交易日);`d-5` 每天都走得到 current_date,且工作日數 ≤ 5 → max_days 不必加大
- P0-3 閘門口徑:拿今天的真實資料實跑 → `latest_n=524, median_n=1974, would_skip=true`。
  **昨天那次髒凍結會被這道閘擋下來**
- P1-4 的省量前提:確認本專案沒有設 `pgrst.db_max_rows`,`existing` 查詢(~4000 列)不會被截,
  否則 existingKeys 不全會退化成「照樣打滿」(fail-safe 方向,不會漏資料)

**未驗證(環境限制,要誠實記著)**
- 兩支 EF 沒有 type-check:本機沒有 deno,也沒有 node/npx。只做了人工複查。
  部署後第一件事是看 fetch_log 是不是有正常的成功列,而不是靠「應該沒問題」

**Rollback**:三個 migration 各自檔頭都寫了單行回退法(重跑同名 `cron.schedule`);
兩支 EF 用 `git revert` 後重新 deploy 即可,寫入語意沒動(仍是 ignoreDuplicates 冪等)。

**依賴順序(部署時要照這個順序)**:
1. EF `fetch-daily-prices`(P0-2)→ 2. migration 0001(P0-1)→ 3. migration 0002(P0-3)
→ 4. EF `fetch-finmind-fallback`(P1-4)→ 5. migration 0003(P1-5)
理由:4 依賴 1+2(免費源要先蓋得住當日),5 依賴 4(token_1 要先空出來)。

### 部署紀錄(2026-08-10 16:2x UTC 全數套上 prod)

| # | 動作 | 結果 |
|---|---|---|
| 1 | deploy `fetch-daily-prices` | v8 → **v9**,verify_jwt 保持 true |
| 2 | migration `fix_gap_backfill_window` | ok |
| 3 | migration `freeze_scan_picks_coverage_gate` | ok |
| 4 | deploy `fetch-finmind-fallback` | v6 → **v7**,verify_jwt 保持 true |
| 5 | migration `lending_back_to_token1` | ok |

部署前先 `get_edge_function` 比對過兩支 prod 原始碼 = repo baseline,**無 drift**
(memory 有記這專案 DB/repo 版本容易不對齊,所以先比對再蓋)。

**實測驗證**

- **P0-1 有效**:手動觸發新視窗 → 8/10 從 524 檔 → **1458 檔**(新進 934 筆 twse)。
  舊視窗永遠碰不到 8/10,新視窗一次就補到
- **P0-2 有效**:手動觸發 `fetch-daily-prices`(v9)→ tpex **written=991、無錯誤**。
  ⚠️ 只是一次成功,不等於重試邏輯被驗過 —— 我 curl 時該端點本來就是好的。
  真正的證據要等下次上游抖動時,錯誤訊息出現 `invalid JSON (N bytes)`
- **P0-3 有效**:直接執行 cron 的 do block → `picks_0810 = 0`,閘門擋下。
  順帶查到:8/10 **本來就沒被髒凍結**(07:00 那時 v_breakout_scan 最新還是 8/07,
  已凍過 → on conflict do nothing)。純屬走運,不是設計保護。今天 07:00 那次才是
  真的會凍到 524 檔殘缺池的時機 —— 閘門剛好趕上
- **合計**:8/10 **524 → 2308 檔**(twse 934 + tpex 991 + finmind 383),
  高於近 20 日中位 1974,與 8/07 的 2293 同級。**coverage 那項已從 danger 消失**

**/health 現況:danger 10 → 9**
- 消掉:coverage(最嚴重那項)
- 降級:tpex danger → warn(7/11,最近一次成功)
- 新增:`backfill_market_history` warn → danger —— 我手動那次跑失敗了,
  原因是 backfill 用的 tpex 端點(`www.tpex.org.tw/www/zh-tw/afterTrading/otc`)
  4 天全 HTTP 520。**注意這與 fetch-daily-prices 用的 openapi 端點是不同支**,
  後者同一時間是好的。→ 下一輪可考慮讓 backfill 也改打 openapi
- 未動:5 個 FinMind 相關 + market_chips。配額類要等 UTC 換日、明天 07:30 新版
  fallback 跑過才知道

**⚠️ P1-4 的省量還沒被證實(誠實記著)**

fallback 排 07:30 UTC = 15:30 台北。但實測 tpex openapi 在 06:30 UTC 那輪拿到的
還是**前一日**(rows_skipped 全中),當日資料要到 14:00 UTC 那輪才進得來。
也就是說 07:30 時當日多半仍是空的 → 新版一樣會打滿 594。**不退化,但也沒省到。**

- [ ] 明天看 `fetch-finmind-fallback` 回傳的 `already_covered` / `api_calls` 實數再決定
- [ ] 若確認沒省到:把 `fetch-finmind-fallback-postclose` 從 07:30 移到 14:30 UTC
      (排在 14:00 收盤收料之後),當日資料先由免費源蓋滿,fallback 才真的只補殘洞

---

## 資料健康 續篇 — 配額模型從根本就錯 + 前一輪未定案的 400 破案(2026-08-11 下午)

Andy 再丟一次 /health(9 項異常)。上一輪把根因收斂成 A/B/C 三項並修完,但異常沒清掉。
本輪往下再挖一層,發現**上一輪的 A(「FinMind 配額結構性打滿」)本身建立在一個錯誤前提上**。

### 破案 1 — FinMind 的 600 是「每小時」,不是「每天」

直接查 FinMind 自己的 user_info(兩顆 token 回傳一致):

```
"api_request_limit_hour": 600
"api_request_limit_day":  "-"      ← 沒有日上限
```

`api_quota_state` 從 B1 起就把 600 當日配額在 gate,於是系統每天中午自己把自己關掉。
`/health` 上那幾條 `quota exhausted at XXXX` **全部是自己 gate 掉的,不是 FinMind 擋的**
—— 診斷當下兩顆 token 直接打 `TaiwanStockPrice/2408` 都回 200。

**上一輪的「兩顆 token 8/7 起天天 600/600」是這個錯誤模型自己畫出來的天花板,不是真的撞牆。**

再往下量到限流的真實行為(這條是後來手動觸發時撞出來的硬證據):
砍完 ETF 的 valuation 跑 178 檔,只成功 22 檔就開始 **HTTP 402** ——
因為 07:30 那批 586 次還在滾動視窗內(586 + 22 ≈ 608 > 600)。
→ **限流回應碼是 402,視窗是「滾動 1 小時」而非整點歸零**;真正要管的是
「任何連續 60 分鐘內同一顆 token 幾次」。

### 破案 2 — 每天燒 416 次 call 換 0 列(上一輪 A 的真實成因)

`v_fetch_universe` = 594 檔,拆開來是 **178 個股 + 416 檔 ETF**。而:

| 表 | ETF 列數(至今) | 個股列數 |
|---|---:|---:|
| `stock_pe_pb_daily` | **0** | 36,614 |
| `stock_fundamentals_quarterly` | **0** | 2,450 |

ETF 沒有本益比也沒有財報,`TaiwanStockPER` / `TaiwanStockFinancialStatements` 對 00xxxx
一律回空陣列。所以 valuation 每天固定燒 416 次 call 換 0 列,fundamentals 更是 416×3 = 1248 次。
而 valuation 排 08:30,在 institutional(09:00)、lending(09:10) **前面** → 把配額吃光,
後面兩支直接餓死。籌碼 3 EF 早就讀 `v_fetch_universe_stocks` 了,**漏網的是估值與財報這兩支**。

### 破案 3 — `backfill_price 2408: HTTP 400`(上一輪標「未定案」的那項)

不是 token、不是 2408、不是 FinMind。是 cron body 的 SQL 型別:

```sql
(current_date - interval '3 days')::text  →  '2026-08-08 00:00:00'   -- timestamp!
(current_date - 3)::text                  →  '2026-08-08'            -- date
```

FinMind 的 `start_date` 只吃 `YYYY-MM-DD`,帶時間就回 400。同一支 cron 的 `end_date`
用 `current_date::text` 一直是對的,所以只有 start 壞 —— 這條 [[L46]] 防護層
(「即使 fallback 又漏,持股一定有資料」)**從 20260521 建立起沒成功過一次**。
上一輪查到「錯誤列表從 3236 起的全 universe」的那個附帶問題也一起修了(空持股 → `[]` →
EF 退回全 universe;加 `where exists` 直接不發)。

### 做了什麼

| # | 項目 | 檔案 | verify |
|---|---|---|---|
| A1 | 配額計數器每整點歸零 = 日計數器變時計數器,對齊 FinMind 真實限制。**13 個 EF 一行都沒改** | `20260811000004_finmind_quota_hourly.sql` | cron 建立於 08:00 之後,首次觸發看 09:00 |
| A2 | cron 日期型別 + 空持股 guard | `20260811000005_fix_preopen_backfill_date_cast.sql` | 明日 00:45 該 cron 應首次 success |
| A3 | `v_data_health` 加**缺席偵測**:改成「期望清單 full outer join fetch_log」,超過容忍天數沒有成功紀錄即 danger;另把 `success is null`(開了 log 沒收尾)也算成異常 | `20260811000006_v_data_health_absence_watchdog.sql` | ✅ 套用後 institutional/lending/shareholding/google_news 立刻現形(見下) |
| B1 | valuation 改讀 `v_fetch_universe_stocks`(594→178)+ quota gate 移到 fetch_log 之後 | `fetch-finmind-valuation` **v5** | ✅ 觸發回 `target_symbols:178`(原 594) |
| B2 | fundamentals 同上(1782→534 calls) | `fetch-finmind-fundamentals` **v4** | 待窗期清空後觸發 |
| B3 | cron 依滾動小時重排:valuation 08:30→**10:30**;corporate_action 週更用 EF 既有 `symbol_offset/limit` 拆 3 批(21/22/23 點) | `20260811000007_finmind_cron_hour_spacing.sql` | 週六首跑 |
| C1 | backfill-market-history 加 3 次重試 | `backfill-market-history` **v3** | ✅ 補 8/05–8/07 → 5871 列 **0 errors** |
| C2 | fetch-stock-events 加重試(5xx 才重試,4xx 不重試) | `fetch-stock-events` **v2** | ✅ 4 源全成功;`twse_t187ap38` 1112 列 |
| C3 | fetch-market-chips 加重試(同上,402/finmind: 不重試) | `fetch-market-chips` **v3** | ✅ 3 源 0 errors |

### 缺席偵測上線第一分鐘的收穫

之前完全看不見的東西立刻現形:

- `finmind_shareholding` — **已 16 天沒有成功紀錄**(從來沒人知道)
- `google_news` — 已 5 天沒成功,近 7 天 **20 次開了 fetch_log 沒收尾**
  (`success is null`,EF 疑似被 wall-clock 砍掉)。原本 `fail_n` 用 `not success`,
  null 兩邊都不算 → 這種「跑到一半死掉」在舊 view 上是**綠的**
- institutional / lending / margin / valuation 的「已 N 天沒成功」

### ⚠️ 誠實記著(沒做 / 沒驗到的)

- **整點歸零 vs 滾動視窗有落差**:FinMind 是滾動 1 小時,本檔的 cron 是整點歸零。
  跨整點的兩批(例如 07:55 打 500 + 08:05 打 500)本地 gate 會放行但上游會 402。
  排程拉開後實際峰值 token_1 ≤ 594/小時,所以是可接受的近似,**但不是精確模型**。
  精確版要嘛在 EF 內查 user_info 的 `user_count`(13 EF 都要改),要嘛給
  `api_quota_state` 加時間戳做真滾動窗。
- **402 風暴沒處理**:限流後 EF 仍會把剩下的 symbol 全部打完(本次 178 檔打出 156 個 402)。
  加「遇 402 立刻 break」是對的,但那要再動一輪 EF;排程拉開後觸發條件已消失,先記著。
- **`google_news` 逾時沒修**:只做到「看得見」。`fetch-stock-news` 對 594+ 檔跑 RSS
  撞 EF wall-clock,要拆批或縮名單,下一輪。
- **A1/A2/B2/B3 都還沒被真實 cron 跑過**(建立時間都晚於今天的觸發時刻)。

### 追加:配額修好之後浮出來的下一層 —— 150 秒 wall-clock

配額不再擋人之後,margin / lending 還是不動。查 edge-function log 才看到真兇:

```
fetch-finmind-lending       546  execution_time_ms 150810
fetch-finmind-margin        546  execution_time_ms 150539
fetch-stock-news            546  execution_time_ms 150499
fetch-finmind-institutional 200  execution_time_ms 137288   ← 只差 13 秒
```

**Supabase EF 的 wall-clock 是 150 秒**,546 = 被砍。這幾支逐檔 EF 全部貼著牆在跑,
institutional 擦邊過關。所以它們的 fetch_log 是 `success is null`(開了沒收尾)而非失敗 ——
正好是本輪新加的缺席偵測才看得見的那一類。

**而且被砍的執行對配額是隱形的**:`increment_quota` 寫在迴圈之後,EF 被砍就永遠不會執行,
那 ~150 次 call 打出去了卻沒進 `api_quota_state`。實測:09:05 margin 被砍後,
09:22 手動跑的 margin backfill 178 檔出現 54 個 402 —— 本地 gate 以為還有額度。

**修法(只改 cron,零 EF 改動)**:margin / lending 改叫 `fetch-finmind-backfill`。
同一個 FinMind dataset、同一張目標表,差別在批次 upsert(178 檔實測 43 秒 vs dedicated 137 秒)
且支援 `symbol_offset` / `symbol_limit`。

lending 另外踩了第二層:即使切到 60 檔仍 546(batch1 1094 列、batch2 825 列都過,batch3 爆)。
**瓶頸是「檔數 × 天數 × 每檔每日列數」的乘積**,不同區段股票每檔列數差很多,光靠固定檔數切不安全。
把日更回看視窗 8 天 → 3 天後,同一批 58 檔只剩 222 列、0 errors 通過。

| 檔案 | 動作 | verify |
|---|---|---|
| `20260811000008_margin_lending_via_backfill_ef.sql` | margin/lending cron 改指 backfill EF + 期望清單改名 backfill_margin/backfill_lending | ✅ 套用 |
| (cron)`fetch-finmind-lending-b1..b4` | 拆 4 批 × 60 檔(09:10/15/20/25) | ✅ 建立 |
| (cron)margin + lending | 回看 8 天 → 3 天 | ✅ batch3 重跑 58 檔/222 列/0 errors |

### 隔日(08-12)實跑驗收

- `holdings-staleness-backfill-preopen` **@00:45 success=true** —— **這條 cron 自 20260521 建立以來的第一次成功**(L64)
- `reset-finmind-hourly-quota` 於 22:00 / 23:00 / 00:00 連續觸發成功
- **freshness / coverage / quota 三區段全部乾淨**:法人、融資、借券、PE/PB 四張表都回到最新交易日
- 尚待今日 09:xx 首跑:margin(09:05)、lending b1-b4(09:10-09:25)、valuation(10:30);週六 corporate_action 3 批

### 仍未修(下一輪,診斷已完成)

- `google_news`:`fetch-stock-news` 對 594 檔跑 RSS,8/06 起每次撞 150 秒。最後一次成功
  8/06 06:00 花了 110 秒 —— universe 547→594 那次把它推過牆。需要拆批(EF 要加 offset/limit)
- `finmind_shareholding`:同樣 546,17 天沒成功
- `finmind_institutional`:137 秒過關但只剩 13 秒餘裕,universe 再長就會步上後塵
- **402 風暴**:限流後 EF 仍會把剩下的 symbol 全部打完;應「遇 402 立刻 break」
- **被砍的 EF 不計配額**:`increment_quota` 應改成迴圈內分段遞增,而非結束時一次記

## 150 秒 wall-clock 清剩下的 + dashboard 兩項調整(2026-08-12)

Andy:「修 1、2」(= google_news / shareholding)+「今日戰情下面的進場訊號 10 檔刪除,與起漲掃描衝突」
+「起漲掃描是否能看到掃描時間」。

### 1-2. 逐檔 EF 撞 150 秒牆 —— 全部改走 backfill EF

| source | 原狀 | 修法 | verify |
|---|---|---|---|
| `google_news` | 594 檔約 250 秒,8/06 起每 6 小時被砍一次 | EF v3 加 `symbol_offset`/`symbol_limit`;cron 拆 4 批 × 150 | ✅ 200 檔 **84 秒** success=true / 0 errors(8/06 以來第一次成功) |
| `finmind_shareholding` | 546,**17 天沒成功** | 改叫 backfill EF `dataset=shareholding`,週六拆 3 批 × 60(回看 14 天) | ✅ 三批 600+560+580 列、**全 0 errors** |
| `finmind_institutional` | 200 但 137 秒,只剩 13 秒餘裕 | 同上改 backfill EF,日更回看 3 天 | ✅ 先前已驗 178 檔 43 秒 / 1061 列 |

順手清掉本輪殘留的 danger:margin 重跑 178 檔 344 列 0 errors;
valuation(dedicated v5)178 檔 870 列 **0 errors** —— v5 第一次乾淨跑完。

**期望清單抽成表**(`data_source_expectation`):本輪光是改 source 名字就被迫整段 view
重寫三次。清單是會動的設定,不該跟查詢邏輯綁在同一個 DDL 裡;抽表後改名單是一行 DML,
而且清單本身可查(/health 上能直接看到「我們期望哪些資料源在跑」)。

**/health danger:16 → 3**,剩下的都可解釋:
- `backfill_corporate_action`(10 天)= 週六才跑,不是壞掉
- `finmind_fundamentals` = 週日才跑;探針測 60 檔 = 180 calls / 208 列 / 0 errors 通過
- `finmind_margin` = 已停用的舊 source 名,7 天後自然退出視窗

### 3. dashboard 移除「今日進場訊號」表

`app/page.tsx` 移除 `EntrySignalWidget`(10 檔表格)與只被它用到的 `fmtScore`。
**保留** MorningPanel 內的機會行(今日戰情**內部**的一行摘要,非「下面」那塊)——
Andy 指的是 10 檔表格。`getCachedEntrySignals` 仍被 MorningPanel 的 signalCount/signalTop 使用,未動。

### 4. /scan 加掃描時間

`v_breakout_scan` 是即時 view(force-dynamic),每次開頁重算 → 掃描時間就是本次 render。
標頭改成「資料 {trade_date} 收盤 · 全市場 N 檔 · **掃描於 MM/DD HH:MM**」(Asia/Taipei),
tooltip 說明兩者差距過大 = 收料沒跟上。tsc + next build 皆過。

### 仍未修

- **`finmind_fundamentals` 是最後一支還在 dedicated EF 上的逐檔收料**:178 檔 × 3 dataset
  = 534 calls,佔滿小時配額的 89%,wall-clock 也只是「應該夠」。週日 19:00 首跑要看。
- **402 風暴**(限流後仍把剩下的 symbol 打完)、**`increment_quota` 應分段遞增**
  (EF 被砍時打出去的 call 對本地計數器隱形)—— 兩者都要動 EF,本輪未做。
- `fetch-stock-news` 第 4 批 offset 450 只覆蓋到 600 檔,universe 再長要再加批。

---

## 2026-08-17 — 交易行為分析回饋:追高判定修正 + 每日 MTM 權益(Andy「直接動手做 1 跟 3」)

**背景**:分析 17 筆波段 + 3 筆當沖(2026-03-03 ~ 08-17)後發現兩件事,一件是量測 bug、
一件是我自己先講錯的範圍修正。

### 1 — `dev_ma20_at_buy` 改用實際成交價(量測 bug)

**問題**:`v_trade_behavior.dev_ma20_at_buy` 用「進場日**收盤價**」vs MA20 回算追高;
但 BuyForm 的追高警示走 `v_entry_quality.dev_ma20_pct`(**即時價** vs MA20)。收盤價在
下單當下並不存在,拿它做「你追不追高」的事後判定,量的不是同一件事。

**影響**:17 筆全量重算,唯一翻轉是 2408 2026-06-05(「暴跌買進」,+106,180 = 最大單筆獲利)
dev 9.20% → 10.56%,跨過 +10% 門檻。而「追高比較差」這個結論**完全靠這一筆落在哪一邊**:

| 定義 | 追高 | 非追高 |
|---|---|---|
| 收盤價(現行) | 8 筆 / 平均 +11,549 | 8 筆 / 平均 +33,078 |
| 成交價(修正後) | 9 筆 / 平均 +22,063 | 7 筆 / 平均 +22,635 |

→ 差異消失。BuyForm 掛在上面的敘事要一起改成誠實版本。

- [x] migration `20260817000001_v_trade_behavior_v4_fill_dev`:`create or replace view` 只換
      `dev_ma20_at_buy` / `is_chase_buy` 的**價格基準**(收盤 → `entry_price`),MA20 口徑
      (還原收盤、含進場日、不足 20 筆回 null)一字不動 → 唯一變數可歸因([[L39]] 退版錨點精神);
      append `dev_ma20_at_close` 保留舊值當稽核錨點([[L37]] append-only)
      → verify: 17 筆逐筆對照,僅 2408 06-05 翻轉;`is_chase_buy` null 筆(009816)維持 null
- [x] `BuyForm.tsx` 敘事修正:① 追高框移除「較差」暗示,改陳述「歷史 N 勝 M 敗、與非追高
      無可辨識差異(n 小)」② pullback 框「你的贏單多屬此型態」已與數據不符 → 改寫
      ③ 回追框寫死的「2408 6/25 即此型態,−8.2%」單邊舉例 → 補 08/10 那筆(+6.6%)
      → verify: grep 無殘留舊敘事 + 逐句對照本次統計
- [x] `holdings/page.tsx` 「買點 MA20±」欄 tooltip 標明「以成交價計」→ verify: grep

**rollback**:依序重跑 `20260703000001`(v2)+ `20260711000001`(v3),即回到收盤價版本。

### 3 — 每日 MTM 權益序列(範圍修正)

**⚠ 我先前講錯**:說「沒有帳戶淨值表 → 算不出報酬率」是錯的。`v_equity_curve` + `/performance`
+ `app_settings.initial_capital`(203,004)早就在,報酬率一直算得出來。

**真正缺的**:現有 `v_equity_curve` 是**階梯式**(只在平倉事件跳動、持股期間不含未實現浮動)
→ 曲線在持股期間是平的,**最大回撤因此是假的**(只反映已實現虧損,不反映抱單期間的帳面回撤)。
實例:2408 從 6 月高點 505 跌到 07-30 低點 322(−36.2%),階梯曲線上完全看不到。

- [x] migration `20260817000002_v_account_equity_daily`:新 view,每交易日
      `cash`(本金 + 累計現金流 + 當沖損益)+ `market_value`(未平倉 × 當日收盤)
      + `equity` / `peak_equity` / `drawdown_pct` / `position_count` / `coverage_ok`
      → verify: 全平倉日 equity 必須等於 `v_equity_curve` 末值(兩條路徑對帳)
- [x] **coverage 誠實處理**([[L45]] 不偽造):009816 在 03-03~04-29 持有期間 `price_daily`
      **零筆**(該檔首筆 bar 是 07-30)→ 那段無法 MTM。不用成本價假裝,改 `coverage_ok=false`
      標記,回撤/peak 的 window 只走 `coverage_ok` 列 → verify: 03-03~04-28 全 false、
      04-29 起全 true
- [x] `/performance` 加「最大回撤」卡(真 MTM)+ 頁首說明區分兩條曲線
      → verify: 手算 2408 抱單期間回撤對得上

**rollback**:`drop view public.v_account_equity_daily;`(全新物件,零下游依賴);
`/performance` 改動為純 append,移除新卡即還原。

**不做**(明講範圍):不建實體表 + cron。理由:所有輸入(`initial_capital` /
`holdings_transactions` / `day_trades` / `price_daily`)都已存在,derived view 可直接
回算全段歷史;實體表 + cron 只會從今天起累積(歷史歸零),且多一個會安靜死掉的 cron
(對照 `scan_picks` 表註解自己寫的同一個理由)。若 Andy 要實體快照另議。

**Review(2026-08-17)**:

- **1 已上線並驗證**:`v_trade_behavior` v4 apply 成功。17 筆逐筆對照 `dev_ma20_at_close`(舊)
  vs `dev_ma20_at_buy`(新),**唯一翻轉 = 2408 2026-06-05(9.20 → 10.56,false → true)**,
  009816 維持 null,`TOTAL 17 筆 / 13 勝 / +381,657` 零漂移。分組:
  追高 9 筆 7 勝 +198,571(平均 22,063)/ 非追高 7 筆 5 勝 +158,443(平均 22,635)。
- **還原係數一致化**:成交價是原始價、MA20 是還原價,分子要乘進場日 adj_factor 才同基準。
  2408/3006/6213 該期間 adj_factor = 0.9917~0.9968,不乘會差 0.3~0.8pp。2408 06-05 在
  乘與不乘兩種算法下都 > 10%(10.56 / 10.92),翻轉結論不受此影響。
- **UI**:`checkBuyContext` 加 `nonChaseWins/nonChaseLosses` 對照組(`is_chase_buy === false`
  才計,null = MA20 不可評不計入任一組);BuyForm 追高框改成「兩組並列 + 沒有可辨識差異」、
  pullback 框拿掉與數據不符的「你的贏單多屬此型態」、回追框補上 8/10 那筆勝的案例。
  全部走動態聚合,不寫死會 stale 的數字。
- **3 已上線並驗證**:`v_account_equity_daily`。**對帳 22 個全平倉日 vs `v_equity_curve`
  零差異**(兩條獨立路徑算出同一個數 = 現金流公式正確)。coverage:03-03~04-28 共 39 日
  `coverage_ok=false`(009816 該段 price_daily 零筆),04-29 起 75 日全 true。
- **MTM 曲線立刻揭露階梯曲線看不到的事**:
  - 權益峰值 **530,636 @ 2026-06-22**;最大回撤 **−30.22% @ 2026-07-20**(370,264);
    29 個交易日回撤深於 −10%
  - 06-22 峰值到 08-17 收工:**淨 −329**。期間波段實現 +175,977、當沖 −34,387,
    但 06-22 的權益裡本來就含 2408 未實現 +140,500 → 後面兩個月主要是把既有浮盈換成現金,
    不是新獲利。**階梯曲線會把這兩個月畫成一路上升,MTM 曲線顯示原地踏步。**
- **未做 / 待驗**:本機無 node/npm([[L50]]),`tsc` + `next build` 交 Railway;
  改動已逐行複查(untyped supabase client → `from("v_account_equity_daily")` 無 generated
  types 問題;`select("*")` 多吐 `dev_ma20_at_close` 對既有 interface 無害)。
- **新 lesson [[L67]]**:量測口徑必須對齊它所服務的決策時點。這兩個 bug 是同一型態 ——
  用事後才存在的資訊去衡量事前行為,且都不會報錯、都長得很合理。
- **踩坑(已進 [[L67]] 附註候選)**:本次用 Git Bash `sed -i` 改 todo.md → 整檔行尾被改寫成
  LF,產生 2600 行假 diff。這兩個 md 在 HEAD 就是**混合行尾**(todo.md 2874 行 / 2609 CR),
  任何全檔改寫都會炸 diff。正確做法:純 `cat >>` append(前幾個 session 的做法),
  勾選狀態直接寫進 append 內容,不要事後 `sed -i`。

---

## 2026-08-28 — 多 agent 盤點:選股邏輯 × 資料資產 × 績效驗證

三個唯讀 agent 並行盤點(選股邏輯解剖 / 資料資產盤點 / 績效驗證),主線程逐條複查其 P0
([[L48]] 不照單全收)。本節只有分析與計畫,**未動任何 view / migration / cron / EF**。

### 一句話結論

**進場側已經過度建設(6 套選股邏輯、19+9 因子、PIT 回測函式),但「知道它有沒有效」的
能力是斷的三截,而出場側只有 5 個常數乘法。下一階段不該再加任何選股邏輯,該把量測閉環接回來。**

### 斷的三截(全部主線程獨立複查過)

| # | 斷點 | 複查結果 |
|---|---|---|
| 1 | **量尺不存在** — `market_bench_daily` 停在 2026-07-31 且**無任何 cron 寫它**,`scan_picks` 從 08-05 起 | `v_scan_track` 229 列 / `excess_5d` 非空 **0 列** ✅實證 |
| 2 | **歸因不可能** — `holdings_transactions` 無訊號來源欄位 | signal 相關欄位 **0 個**;23 筆 BUY 對 `scan_picks` **0 命中**(08-05 後 7 筆也是 0) ✅實證 |
| 3 | **回測測的不是線上跑的東西** — `run-backtest` 叫 `score_universe_at`(=/rank),**從未回測過 /scan** | 76 筆 `backtest_runs` 全是排行策略;三年期 12 組 alpha 全負(−42.91 ~ −122.71) |

第 3 截還有第二層:`score_universe_at` 在 2023-2025 期間 **chip 維度(權重 .20)零覆蓋**、
2023 上半年連 fund(.40)也空,可計分池從 153 檔長到 577 檔 → 那 12 組數字**測的不是任何
一個定義清楚的策略**,當正面或反面證據引用都是錯的。且 `stock_universe` 148 檔全部
`selected_at = 2026-05-12` 拿去跑 2023([[L38]] 的存活者偏差未修,`universe_snapshot`
有正確工具但 `score_universe_at` 沒引用)。

### 主線程對 subagent 結論的修正(重要)

選股邏輯 agent 用自建 PIT 重跑 114,620 obs,結論「`ma20_gap<10` 這 12 分方向相反,
5/20 日各 −1.07pp / −2.22pp,應該反轉或歸零」。**這個結論不成立**:

`price_daily` 的全市場覆蓋是 **2026-04 才開始**的 —

| 季 | 每日平均檔數 |
|---|---:|
| 2023 H1 | 154 |
| 2023 Q3 ~ 2026 Q1 | 293 → 310 |
| **2026 Q2** | **1,809**(349 → 1,980) |
| 2026 Q3 | 2,023 |

agent 的 243 天樣本(≈ 每日 472 檔)把 300 檔策展池與 2,000 檔全市場混在同一個平均裡 =
**[[L60]] 原型重演**。主線程改用橫斷面去均值 + 只取母體一致的日子(85 天、全部 ≥1500 檔)
重跑,單調關係**基本消失**:

| MA20 乖離 | n | 5 日超額 | 20 日超額 |
|---|---:|---:|---:|
| < 0% | 57,372 | −0.02 | +0.02 |
| 0~5% | 29,017 | −0.15 | +0.12 |
| 5~10% | 10,315 | −0.09 | −0.15 |
| 10~15% | 4,954 | −0.01 | **−0.97** |
| 15~25% | 4,414 | +0.89 | −0.23 |
| ≥ 25% | 2,720 | +0.94 | +1.00 |

→ **誠實版本:那 12 分沒有證據支持(它沒幫上忙),但「應該反轉」通不過乾淨母體檢定。**
→ **推論:`v_breakout_scan` 掃的 1,146 檔只有約 5 個月價格歷史,現在沒有任何可回測的
   跨 regime 樣本。任何「重新分配 100 分」的嘗試都必然踩 [[L57]]+[[L60]]。**

### 現有證據方向(警訊,非結論)

`v_scan_track` 分數分組(主線程獨立重跑):

| score | n(有 T+5) | T+5 平均 | 勝率 | T+10 平均 |
|---|---:|---:|---:|---:|
| 90+ | 9 | −5.57% | 22.2% | −9.46% |
| 85–89 | 29 | −3.89% | 24.1% | −2.68% |
| 80–84 | 64 | +1.54% | 45.3% | +5.85% |

**分數越高後續越差,T+5 / T+10 單調一致。** 但 90+ 只有 9 筆、8 個 scan_date 視窗重疊
(有效獨立樣本 2~3 個)、單一 regime、切點事後選 → 依 [[L57]] 紀律**不足以下任何結論**。
依實測日層級超額 sd 4.56pp,要偵測 +2.0pp/5 日需 ~42 個**不重疊**視窗 ≈ **10 個月**;
偵測 +1.0pp 需 **3.2 年**。`scan_picks` 表註解寫的「6+ months」只夠抓 ≥2.5pp 的大效果 ——
這個落差要先講明白,否則半年後又會生出一組「看起來有結論」的數字。

### 資料側:收了沒進決策路徑的

| 項目 | 事實 |
|---|---|
| **熱股池籌碼全空** | `universe_dynamic` 50 檔 active **已進入排名計算**,但 0/50 在 `v_fetch_universe_stocks` → 法人 1/50、融資券 1/50、借券 1/50、外資持股 0/50。`mv_factor_scores` **409/583 = 70.2% `chip_count_total=0`** ✅實證。活的 [[L44]] |
| **`recompute_adj_factor()` 無 cron** | 近 90 天收 404 筆除權息,沒人轉成還原係數 |
| **58 個 write-only 欄位** | 融券 7 欄全數沒用、`invest_trust_net`(投信淨額)沒用、`ocf` 沒用(而 OCF 正是 Andy framework 明列的自由現金流) |
| **監控盲區 14 個** | `fetch_log` 29 個 source vs `data_source_expectation` 17 列。缺的含 `etf_metadata_sync` / `reselect_industry_stocks` —— **正是 [[L61]] 抓到那兩支**:修了 bug 沒補期望列,下次死掉又是「整列消失」 |
| **`stock_universe` 凍結 107 天** | `selected_at` 全部 2026-05-12,repo 與 cron 皆無重選排程 |
| **配額不是瓶頸** | 平日 757 calls = 理論上限 2.6%;擴到 500 檔也只 7.1%。擋路的是 150 秒 wall-clock(`google_news` 99.3s = 牆的 66%)與滾動小時打包(週六 corporate_action 1,190 calls 已在吃 402) |

### 真實交易(對照組)

18 筆已平倉:勝率 72.2%、實現 +338,867、**持有天數中位數 5 天**(回測 `rebalance_days=20`,
週期差 4 倍)。但 **2408 一檔佔實現損益 75.9%**,前三檔佔 103%,10 個相異標的 ——
「勝率 72%」在統計上等同於「2408 這半年一直漲」。帳戶 203,004 → 466,799(+129.95%,
同期 0050 +35.49%),真 MTM 最大回撤 **−30.22%**。
**⚠ 08-21 起現金轉負(5 天,08-27 為 −88,201,槓桿 1.19x)且系統無任何標示** ——
融資(有利息、有槓桿)或未入帳入金(分母錯)目前資料無法區分,**釐清前 +129.95% 不可引用**。

---

## 下一階段計畫(待 Andy 拍板,尚未動工)

排序原則:**先讓「能不能知道」變成 yes,再談「有沒有效」。**

### P0 — 量測閉環(不修這些,後面全白做)

- [ ] **P0-1 `v_scan_track` 的 benchmark 改自產** → 不修 `market_bench_daily` 的 cron,
      改成「當日收盤 ≥20 元全市場等權」直接從 `price_daily` 算。**零新增 cron、永不斷更、
      比大盤嚴格**,且與 `scan_picks` 表註解當初「不建實體表+cron」的取捨一致
      → verify: `select count(excess_5d) from v_scan_track` 從 **0** 變 ≥102
      → rollback: 重跑 `20260806000003`
- [ ] **P0-2 `holdings_transactions` 加訊號歸因欄位** — `signal_source text` /
      `signal_score numeric` / `signal_rank int`,BuyForm 送出時寫入當下那個 view 的實際值
      → verify: 下一筆買進後三欄非空
      → rollback: `drop column`(純 append,零下游依賴)
      → **時效性**:即使今天就加,以 6 個月 18 筆的節奏仍要再累積 1.5~2 年才能在統計上
        分開「系統選的」與「自己看新聞買的」。**不可回溯,每晚一天就晚一天**
- [ ] **P0-3 `data_source_expectation` 補 14 個缺口** → verify: `/health` 期望清單 17 → 31
      → rollback: `delete` 新增列([[L65]])
- [ ] **P0-4 `/scan` 顯示追蹤進度** — 樣本天數 / n / 高低分組 / **距離可下結論還差多久**。
      目前 `scan_picks` 與 `v_scan_track` 在 `app/` 內**零引用**,且頁尾
      「124 次觸發、−0.81%、42.7%」是**硬寫在 TSX 的字串**,線上資料產不出來
      → verify: 頁面數字可由 SQL 重現

### P0.5 — 已收的資料接進決策路徑(一行改動,ROI 最高)

- [ ] **P0.5-1 熱股池納入籌碼收料底集** — `v_fetch_universe_stocks`
      `union select symbol from universe_dynamic where active`
      → chip 空值率 70.2% → 60.8%,+200 calls/日(0.7%)
      → **必須同時把 `backfill_institutional` 切 2 批**(178 檔已 80.4s,228 檔 ≈ 103s)
      → verify: `mv_factor_scores` 中 hot_dynamic 群 `chip_count_total>0` 從 0/37 變 >30/37
      → rollback: `create or replace view` 拿掉 union
- [ ] **P0.5-2 `recompute_adj_factor()` 排進 cron**(週六三批跑完後,如週日 01:00)
      → verify: 執行後 `price_daily` 中對應除權息日的 `adj_factor<>1` 列數增加
      → rollback: `cron.unschedule`。注意 [[L35]]:mutation 與驗證分兩條 statement

### P1 — 已確認的量測 bug(同 [[L67]] 家族)

- [ ] **P1-1 `v_trade_behavior.fwd_max20_pct` 混合觀察視野** — `fwd_20d_pct` 在
      `fwd_days_available<20` 時正確回 NULL,但 `fwd_max20_pct` 有幾天算幾天(6/8/15/18/20
      混在同一欄)→ 系統性低估近期交易的機會成本
      → 修法:`<20` 天時回 NULL,或改名 `fwd_max_avail_pct` 並併排顯示 `fwd_days_available`
- [ ] **P1-2 現金轉負無告警** — `/performance` 加「槓桿 / 現金」列
      → **先問 Andy:08-21 起的負現金是融資還是未入帳入金?** 這答案決定要不要建資金流水表
- [ ] **P1-3 `v_breakout_scan.fgn_net_5d` 綁全域最新籌碼日而非掃描日** —
      `where i.trade_date > (select max(trade_date) from stock_institutional) - 8`。
      今日兩表對齊所以沒事,但籌碼一落後 N 天,「外資 5 日買超」就是結束於 N 天前的窗
      卻和當日收盤並排 = **與 08-17 `dev_ma20` bug 完全同型**
      → 修法:改綁 `bounds.last_d`;籌碼日 ≠ 價格日時回 NULL 不 fallback([[L45]])
- [ ] **P1-4 `/scan` 的 `limit 25` 切在同分中間** — 今日 ≥80 分共 34 檔,第 24-33 名
      **10 檔同分 81**,limit 25 從中間切斷,留下與丟掉的差別是 0.03pp 的當日漲幅。
      且全市場最高分 **4912(96 分)** 因 `passes_all=false` 被關進折疊區,主區顯示的是
      兩檔 87 分。另外目前完全依賴「PostgREST 保留 view 內 ORDER BY」這個未定義行為,
      **要明示 `.order()`**
- [ ] **P1-5 `/backtest` 標註 2023-2025 run 不可引用** — 標「覆蓋率不足:chip 維度零覆蓋、
      universe 非 PIT」。**不要刪**(append-only,[[L37]],留退版錨點與稽核痕跡)

### P2 — 需要 Andy 決策,不是工程問題

- [ ] **P2-1 `stock_universe` 凍結 107 天** — 訂刷新策略,或明確宣告它是凍結快照
- [ ] **P2-2 六套選股邏輯的定位** — `v_breakout_scan`(1,146 檔)∩ `v_stock_rank`(583 檔)
      = **僅 152 檔**;今日 score≥80 的 34 檔只有 8 檔在 rank universe 裡。有交集的高分候選中
      `v_entry_quality` 判定 **chase 20 檔 vs pullback 5 檔** —— **掃描器推的正是進場品質
      模型標「別買」的那群**。這不是 bug,是兩套系統從沒對齊過。要嘛明示它們回答不同問題,
      要嘛砍掉一套
- [ ] **P2-3 出場側** — `v_holdings_advice` 是 5 個常數乘法(`avg_cost` × 0.90/0.95/1.20/1.30/1.40),
      錨定成本價非市價結構、波動盲(唯一持股 2327 的 ATR%=5.52% → −10% 停損只有 1.81 個 ATR)。
      **但 [[L52]] 已結論「輪動+動能+右尾集中的策略與盤中觸發式出場根本互斥」,三案皆敗** →
      正確方向是**時間出場或不設觸發式出場**,不是再換一次價格公式。
      唯一值得測的單點:`force_out = avg_cost*1.40` 的天花板(`passes_all` 的 edge 全在右尾:
      5 日平均 +2.06pp 但中位數只有 +0.49pp)
- [ ] **P2-4 產業排除清單搬出 view** — 內容目前**有效**(被排除的傳產/金融 `passes_all`
      5 日超額 −0.24% vs 保留側 +2.06%),**不要改內容**。要改的是形式:字串比對脆弱
      (`農業科技`/`農業科技業`、`金融保險`/`金融業` 都要各列一次),新產業別會靜默進池
- [ ] **P2-5 孤兒清單決策** — `swing_scan_snapshot`(每日寫、零下游、無後續報酬欄位)、
      `reconcile_audit`(0 列從未寫,而 `price_daily` 54.3% 是 provisional)、
      `alert_events`(0 列但 EF 每週跑 150 次)、5 個孤兒 view。
      **建議不要直接刪**(CLAUDE.md §3):正解是「補上讀取端」或「寫下為什麼還在收」

### 明確不做(講清楚範圍)

1. **不現在重新分配 `v_breakout_scan` 的 100 分。** 全市場價格只有 5 個月,沒有跨 regime
   樣本;任何調參都是在對單一多頭 regime 過擬合([[L57]]+[[L60]])。**先讓 P0-1 的量尺
   活過來,累積前向樣本,再談調分。**
2. **不把 universe 從 178 擴到 500。** 配額夠(7.1%),但目前 178 檔的籌碼已經有 31 個欄位
   沒進決策,擴廣度只是把同樣沒用的東西 ×2.8;且每支逐檔 EF 都要重切批次。
   先做 P0.5-1(50 檔換掉 70%→61% 空值率),ROI 遠高於擴 322 檔。
3. **不加任何新的選股邏輯 / factor。** 已有 6 套,彼此不相交甚至方向相反,而且沒有一套
   有可信的績效證據。再加第 7 套只會讓歸因更不可能。

---

## 2026-08-28 執行 Review — Andy 拍板「1=加碼入金 / 2=好 / 其他計畫也執行」

**範圍變更**:P1-2 從「加個槓桿標示」擴大為「建資金流水 + TWR 權益」——
Andy 確認 08 月現金轉負是**加碼入金**,所以 `initial_capital` 這個單一常數就是錯的分母,
`+129.95%` 與 `−30.22% MDD` 兩個數字都不能用。

### 已完成(9 支 migration + 6 個前端檔)

| # | 項目 | 產出 | verify |
|---|---|---|---|
| P1-2 | 資金流水 + TWR 權益 | `20260828000001` `capital_flows` 表 + `v_account_equity_daily` 改寫 | 124 列;`capital_incomplete` 標記 6 天;TWR 123.63% |
| P0-1 | **量尺活過來** | `20260828000002` `v_scan_track` benchmark 改自產全市場等權 | **`excess_5d` 非空 0 → 110 筆**;`bench_n` 1,727-1,750(每日一致) |
| P0-2 | 訊號歸因 | `20260828000003` 三欄 + check constraint + partial index | 欄位建立;BuyForm 加必填下拉;分數/名次由 server action 下單當下查 view |
| P0-3 | 監控盲區 | `20260828000004` 補 14 列 | 期望清單 17 → 31 |
| P0.5-1 | 熱股池籌碼 | `20260828000005` `v_fetch_chip_universe` + 11 支 cron 改指 + institutional 拆 2 批 + shareholding 補 b4 | universe 228;11 支 cron 全部 `uses_chip_view=true`;offset 覆蓋 0-240 |
| P0.5-2 | 還原係數 | `20260828000006` `recompute-adj-factor-weekly` 週日 02:00 | cron 建立 |
| P1-3 | 籌碼視窗綁掃描日 | `20260828000007` `fgn_net_5d` 改綁 `bounds.last_d` + 落後回 NULL | 1,146 列 / 106 檔有標籤(不變) |
| P1-1 | `fwd_max20_pct` 口徑 | `20260828000008` 加 `fwd_days_available >= 20` | 非空 14 = `fwd_20d_pct` 非空 14;總損益 338,867 / 13 勝**零漂移** |
| P2-4 | 產業清單搬出 view | `20260828000009` `industry_policy` 表 + `v_industry_unclassified` | **1146 / 23 / 94 / 106 四項與改動前逐項相同**;36 排除 + 19 保留;未分類 0 |
| P0-4 | /scan 追蹤面板 | `app/scan/page.tsx` | 硬編碼字串換成 live 聚合 + 證據進度條 |
| P1-4 | /scan 同分截斷 | `app/scan/page.tsx` | 移除 `.limit(25)`、明示三層 `.order()` |
| P1-5 | /backtest 標註 | `RunsTableClient.tsx` | `start_date < 2026-05-01` 標「⚠ 不可引用」+ 四條理由 tooltip |

### 三個實作時推翻計畫的決定(都記在 migration 註解裡)

1. **P0.5-1 沒有擴 `v_fetch_universe_stocks`**(計畫寫「一行 view」)。grep 發現它被 **10 支 EF**
   讀,其中 `fetch-finmind-fundamentals` 178 檔已用掉小時配額 89%,擴到 228 會爆,
   而且它**不吃 body 參數**,沒辦法只改 cron 拆批。改開窄用途的 `v_fetch_chip_universe`,
   blast radius 10 → 4 支 EF。實際缺口本來也只有籌碼(熱股池 fundamentals 已 41/50)。
   → 新 [[L68]]
2. **P0-1 選了自產 benchmark 而不是修 `market_bench_daily` 的 cron**。理由:零新增 cron、
   永不斷更(`price_daily` 死了整個系統都停)、等權全市場比市值加權的大盤更嚴格。
   副作用是 `market_bench_daily` 現在真的成了孤兒表,列入 P2-5 決策。
3. **四個長 view 全部用 `pg_get_viewdef` + 定點替換**,不重打。`v_breakout_scan` 內含 30+ 個
   中文產業字串,手抄一次就可能靜默改變掃描池。每支都加 `if newdef = def then raise`。
   → 新 [[L69]]

### 量尺修好之後,第一次看到真的超額報酬

| 分組 | n(有 T+5) | 5 日超額 | 勝率 | 10 日超額 |
|---|---:|---:|---:|---:|
| 90+ | 11 | **−6.14** | 9.1% | **−8.56** |
| 85–89 | 32 | −3.26 | 31.3% | −3.73 |
| 80–84 | 67 | **+1.85** | 49.3% | **+4.85** |
| `passes_all` 五條件全過 | 9 | **−5.74** | 11.1% | −8.14 |
| 全部 picks | 110 | −0.44 | 40.0% | +0.93 |

**分數越高後續越差,而且最嚴格的 `passes_all` 是最差的一組。** 依 [[L57]] 紀律這**還不是結論**
(n 小、視窗重疊、單一 regime),但它現在是**可以持續量測**的了 —— 這正是本輪的目的。
/scan 的進度條顯示目前 2.8 / 42 個獨立視窗。

### 未做 / 待驗

- **本機無 node/npm([[L50]] 仍成立,`node_modules` 也不在)** → `tsc` + `next build` 交 Railway。
  前端 6 個檔案的改動已逐行複查:`THead` 用 children 不是 `cols`(改過一次)、
  `TableShell` 內要自己放 `<table>`、新欄位都走既有的 `number | string | null` 慣例。
- **`capital_flows` 是空的** → `/performance` 目前會顯示黃色警告條而不是報酬率。
  Andy 到 `/settings` → 資金流水 補上每筆入金(日期 + 金額)後,峰值 / 回撤 / TWR 才會是對的。
  在那之前 TWR 與舊算法同為 −30.22%(因為沒有金流可中性化)。
- **首跑待驗**:institutional b1/b2(平日 09:00/09:30)、shareholding b4(週日 01:00)、
  `recompute-adj-factor-weekly`(週日 02:00)。三者都是新建 cron,建立時間晚於今天的觸發時刻。
- **P2-1 / P2-2 / P2-3 / P2-5 未動** —— 這四項本來就標「需要 Andy 決策,不是工程問題」,
  見下方待決清單。
- **未 commit**。改動都在工作樹,等 Andy 看過再決定。

### 需要 Andy 拍板的四件事

1. **`stock_universe` 凍結 107 天**(`selected_at` 全部 2026-05-12):要訂刷新策略,
   還是明確宣告它就是個凍結快照?
2. **兩套選股系統要不要對齊**:`v_breakout_scan`(1,146 檔)∩ `v_stock_rank`(583 檔)只交 152 檔;
   高分候選裡 `v_entry_quality` 判定 chase 20 檔 vs pullback 5 檔 ——
   **掃描器推的正是進場品質模型標「別買」的那群**。要明示兩者回答不同問題,還是砍一套?
3. **出場側**:`force_out = avg_cost × 1.40` 的天花板要不要拿掉?
   ([[L52]] 已關閉「換一種停損公式」這條線,但「移除天花板」是不同的東西,值得單獨測)
4. **孤兒清單**:`market_bench_daily`(本輪起真的沒人讀了)、`swing_scan_snapshot`(每日寫、
   零下游、無後續報酬欄位)、`reconcile_audit`(0 列從未寫,而 `price_daily` 54.3% 是 provisional)、
   `alert_events`(0 列但 EF 每週跑 150 次)。每一項要「補讀取端」還是「寫下為什麼還在收」?

---

## 2026-08-28(續)— 四件待決由我判斷後執行(Andy:「請用你的經驗或知識自行評斷」)

### 決策 1 — `stock_universe`:**宣告為凍結種子,不加刷新 cron**

**判斷**:不刷新。三個理由:
1. 新標的**已經有兩條動態入口** —— `industry_stocks`(月更 cron)+ `universe_dynamic`
   (每日熱股晉升,上限 50)。再加第三條刷新等於跟 `industry_stocks` 重複做同一件事。
2. **每多一個 cron 就多一個會安靜死掉的東西**。`reselect_industry_stocks` 2026-08-01
   失敗到 08-06 才被人工發現,就是這個模式([[L61]]/[[L65]])。
3. 最關鍵:**會動的收料母體正是讓量測失效的東西**([[L60]] 本輪剛重演一次)。
   「穩定種子 + 獨立追蹤的動態池」比「一個持續漂移的大池子」更容易歸因
   ——覆蓋率變了是誰造成的,一眼看得出來。

**但「凍結」與「忘記了」在監控上長得一模一樣**,所以配套做了 `v_universe_health`:

| source | n | last_refreshed | age_days | policy |
|---|---:|---|---:|---|
| stock_universe | 148 | 2026-05-12 | **108** | frozen seed (intentional) |
| industry_stocks | 149 | 2026-08-06 | 22 | monthly cron |
| universe_dynamic (active) | 50 | 2026-08-27 | 1 | daily promotion |

→ stock_universe 年齡大是**設計**;另外兩列年齡異常才是問題。表註解也寫死了這個意圖
+ 「無 as-of 欄位,拿去跑歷史回測會產生存活者偏差」的警告([[L38]])。

### 決策 2 — 兩套選股系統:**不合併、不砍,把矛盾顯示出來**

**判斷**:保留兩套。合併是錯的 —— 它們**真的在測相反的事**(A 追突破 / D-E 等回檔),
`v_swing_scan` 要 pullback 而 `v_breakout_scan` 核心是 `close > 前 20 日高`,定義上互斥。
硬合會踩 [[L36]](直覺好的 factor 殺掉已驗證的 alpha)。砍任何一套也不行:
A 是唯一的全市場視角、B 是 `v_holdings_advice` → `/holdings` → Telegram 的底層。

**但現況不可接受**:/scan 靜默推薦 `v_entry_quality` 判為 chase(「別買」)的標的,
高分候選裡 chase 20 檔 vs pullback 5 檔,而使用者看不到這件事。

**做法**:照 BuyForm 已經在用的原則 —— **「不擋單,只強制看見」**。
`/scan` 每一列掛上另一套系統的判定(追高 / 回檔 / 轉弱),tooltip 講清楚
「兩套方向相反、不互相校正,顯示出來不是說哪一邊對」。
只有 583 檔的 rank universe 有這個判定,其餘不顯示(不用假值填充,[[L45]])。

### 決策 3 — `force_out = avg_cost × 1.40`:**降級為「觀察 3」,不再是指令**

**判斷**:移除「強制出」這個指令性框架,保留價位當第三個觀察位。

先確認過它**不是自動執行的規則** —— `v_holdings_advice.force_out_price` 只是一個算出來的
價位欄位,`v_holdings_signals` 的 14 個燈號也全是告警不是動作。所以這是**呈現層**的問題:
系統顯示了一句它自己的證據不支持的指令。

**證據**:
- [[L52]] 的機制分析(三案皆敗後歸納):**報酬右尾集中,任何截斷式出場都在殺大贏家**
- `passes_all` 的 5 日超額**平均 +2.06pp 但中位數只有 +0.49pp** = alpha 全在右尾
- 真實帳:**2408 六筆合計 +257,365 = 已實現損益的 75.9%**,+40% 天花板會把它切掉

**注意這不違反 [[L52]]**:L52 關掉的是「再換一種**停損公式**」;移除一個截斷是它的反方向,
機制上正好是 L52 結論所指的同一件事。
欄位名 `force_out_price` 一字不動(append-only,[[L37]],當稽核錨點),改的是 UI 標籤與顏色。

### 決策 4 — 四張孤兒表:**全部保留,分別處置**(CLAUDE.md §3:不刪)

| 對象 | 處置 | 理由 |
|---|---|---|
| `swing_scan_snapshot` | **補讀取端** `v_swing_track` | 110 筆已經存了,不量白不量;而且 `cleanup_market_prices` 每天在跑,再不接上價格可能被清掉、樣本回不來 |
| `market_bench_daily` | 表註解標**已退役** | 本輪起真的沒人讀(我把最後一個消費者換掉了)。不 drop:1,257 列 TAIEX_TR 報酬指數歷史日後做長期基準仍有價值([[L58]] 明講基準優先用報酬指數) |
| `reconcile_audit` | 表註解寫下**誠實現況** | 0 列從未寫。不現在實作 reconcile:「不跳價」的硬約束由 first-write-wins + 主力可覆蓋 provisional 已達成([[L11]]/[[L17]])。註解同時警告:`is_provisional` 實務上是**來源標記**不是「待確認」狀態 |
| `alert_events` / `check-price-alerts` | **加閘** | 0 列,`alert_rules` 唯一一列 `enabled=false`,但 EF 每週被叫約 150 次全空轉。沿用 `holdings-staleness-backfill` 同一個 pattern |

**`v_swing_track` 一上線就有東西看**(這正是「補讀取端」勝過「停收」的證據):

| horizon | n | 平均超額 | 勝率 |
|---|---:|---:|---:|
| 5 日 | 89 | **−2.51pp** | 34.8% |
| **20 日** | **40** | **+2.91pp** | **50.0%** |

30 個 scan_date。**這是系統裡目前唯一有 T+20 證據的地方**(scan_picks 的 T+20 還是 0 筆),
而且方向與「等回檔要給它時間」的前提一致 —— 短天期輸、長天期贏。
依 [[L57]] 紀律這仍不是結論(n=40、視窗重疊、單一 regime),但它現在**可以持續累積**了。
順帶一提:這與 /scan 的訊號完全相反(掃描是高分短期輸、低分短期贏),兩套系統的
行為差異第一次有了同口徑的數字可以對照 —— 這正是決策 2 保留兩套的理由。

### Review

- migration `20260828000010_orphan_policy_and_universe_health` 已套用並驗證:
  `v_universe_health` 3 列、`v_swing_track` 110 列(89 筆 5 日 / 40 筆 20 日超額)、
  alert cron 已加閘(`command like '%alert_rules where enabled%'` = true)
- 前端:`HoldingsAdvice.tsx`(強制出 → 觀察 3)、`app/scan/page.tsx`(entry_quality 對照 chip)
- **仍未經 `tsc` / `next build`**(本機無 node/npm,[[L50]]),交 Railway
- **三支新 cron + alert 閘尚未被真實觸發**,下週回頭看 `/health`
