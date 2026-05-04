# 台股戰情室 — Claude Context

> 給 Claude / 未來協作者快速進入狀況用。**動 code 前先讀完整份**。

---

## 1. 專案定位

自用台股看盤 + 量化分析 + 自我學習回饋系統。**不是商用產品**、不是投顧服務，
純粹是 "rule-based scoring + 真實預測追蹤 + 持股管理" 的整合工具。

- **使用者**：個人開發者，跑在 Railway（雲端）+ 本地測試
- **規模**：~10K LOC、單一倉庫、無前端框架（vanilla JS + ES Module）
- **後端**：Node 20+ / Express / Supabase

---

## 2. 高層架構

```
[ 6 個資料 Provider ]
   TWSE OpenAPI / TWSE MIS / FinMind / Yahoo / Stooq / 鉅亨網
        │
        ▼
[ Express Server ]                       [ Supabase Postgres ]
   server/server.js                          predictions
   ├─ providers/*                            portfolio_holdings
   ├─ loadStockDiagnose 共用診斷          ▲
   ├─ marketContext / industryContext      │
   ├─ predictions（self-learning）─────────┤
   └─ portfolio（持股 CRUD）───────────────┘
        │
        ▼ /api/*
[ Frontend（vanilla ESM）]
   index.html + styles.css
   src/
   ├─ main.js（boot + UI 模組 mount）
   ├─ scheduler.js（依交易時段調 polling 頻率）
   ├─ state.js（pub/sub + localStorage 記 currentCode）
   ├─ data/api.js / mock.js
   ├─ ui/*.js
   └─ utils/diagnose.js（核心評分引擎，~1200 行）
```

---

## 3. 核心檔案 — 最重要的 6 個

| 檔案 | 內容 | 注意事項 |
|---|---|---|
| `src/utils/diagnose.js` | 4 維評分 + ensemble + walk-forward + feature engineering + 強勢突破 override | **改之前先看 §6**。TDZ bug 過好幾次 |
| `server/server.js` | 30+ REST endpoints、`loadStockDiagnose` 共用邏輯 | endpoint 順序固定 |
| `server/providers/twseMis.js` | 即時報價（**漲停 / 跌停鎖死的 fallback 邏輯關鍵**） | parseRow 的 price 來源優先序動過要小心 |
| `src/ui/stockPanel.js` | 個股主面板（K 線、AI 顧問卡、診斷渲染） | 700+ 行，避免再加東西 |
| `server/predictions.js` | 自我學習迴路（Memory + Supabase） | dirty queue 2s debounced；不要改成同步 |
| `server/portfolio.js` | 持股 CRUD + 損益含手續費稅計算 | RLS 用 service_role key |

---

## 4. 投資策略（全在 `diagnose.js`）

### 4 維獨立評分（動態權重）
| 面 | 預設權重 | 內含指標 |
|---|---:|---|
| 趨勢 | 30% | MA5/20/60、Bias20、RS vs TAIEX、產業 RS rank |
| 動能 | 25% | KD 黃金/死叉、MACD、RSI(14)、RSI 5d delta |
| 量價 | 20% | 量爆/萎、價量配合、5d 量趨勢、turnover spike、gap、body ratio |
| 籌碼 | 25% | 三大法人 3d、投信佔股本、新聞情緒 |

權重會依 walk-forward per-module 命中率動態調整（命中率 < 40% → ×0.6、≥ 60% → ×1.2）。

### 過擬合對策（六道防線）
1. Ensemble 投票 + 一致性收縮（`shrinkFactor = 0.4 + 0.6 × consistency`）
2. 罰分上限 30
3. winRate clamp [15, 78]（不允許 100% 信心）
4. 多時間框架共振（日週共振 ×1.10、背離 ×0.75）
5. 流動性過濾（低 ×0.7、中 ×0.9）
6. 交易成本可行性（不夠賺 1.17% × 2 → ×0.85）

### 自我學習迴路
- 每次 diagnose 寫入 `predictions` 表（含 features jsonb）
- 5 個交易日後比對實際漲跌算 hit rate
- 連續 3 筆誤差 > 5% → confidence multiplier ×0.7
- 命中率 < 50% → 整體 winRate 收縮

### 強勢突破 override（解保守問題）
漲停 / 大紅帶量 → 加 +12 / +8 / +5。UI 顯示 🚀「強勢突破日」。
playbook 門檻：65→60、55→50、45→42（更積極）。

---

## 5. 資料 Fallback 鏈（極重要）

### K 線（loadStockDiagnose 與 /api/kline 都用此順序）
```
FinMind  →  TWSE STOCK_DAY  →  Stooq CSV  →  Yahoo
（402 quota 死）（穩定但慢）（無 quota）（限流嚴重）
```
**注意**：FinMind 推到第一位是因為它最快（單次取所有資料），但 quota 用完就靠 TWSE 撐。
Yahoo 排最後因為 429 太頻繁，且已加 circuit breaker（連續 429 → 冷卻 10 分鐘）。

### 即時報價（/api/quotes/batch）
```
TWSE MIS（主，無 quota）→ Yahoo（備）→ FinMind cache → lastGoodQuotes
```

### 三大法人
```
FinMind institutional → TWSE T86（/fund/T86，免 quota 官方）
```
T86 一次回全市場，cache 1 小時。

### 大盤指數歷史（marketContext）
```
Stooq ^twi  →  Yahoo ^TWII
```

### 國際指數
```
Stooq（主，免 quota）→ Yahoo
```

---

## 6. 已知雷區（千萬注意）

### A. JavaScript TDZ（Temporal Dead Zone）
`diagnose.js` 變數宣告順序敏感。**已踩過 3 次**：
- `bias20`、`close`、`target1` 在用之前還沒 `const` 宣告 → 整個函式拋 ReferenceError
- 修法：所有指標計算（`closes`/`vols`/`bias20`/`atr14` 等）放函式開頭

### B. 漲停 / 跌停鎖死的價格 fallback（twseMis.js）
**踩過**：2408 漲停日卡在昨收 215.50。MIS 回傳：`z='-'`（無新成交）、`bestAsk=null`（沒人賣）、
`bestBid=漲停價`。舊邏輯 `bestBid && bestAsk` 兩個都要存在 → 退到 `o`（開盤）→ 顯示錯。

修法：parseRow price 優先序：
1. z 即時成交價
2. **漲停鎖死**（bestBid 有 / bestAsk 無）→ bestBid
3. **跌停鎖死**（bestAsk 有 / bestBid 無）→ bestAsk
4. 兩邊都有 → 中間價
5. 五檔都無 → 用 high（盤中最高）
6. 最後 → open

### C. 不要 mock K 線資料
原本 `genMockK()` 在 FinMind 失敗時生成隨機 K 線 → **每次 F5 都不同 → 診斷亂跳**。已拿掉。

### D. 不要對 quote 加 anomaly 攔截
原本擋跳動 > 7%，結果**漲停（+9.97%）被擋住卡住前一日價**。已拿掉，只保留 tick 單位 round。

### E. Supabase RLS
- 用 `service_role` key（後端，跳過 RLS）
- 若用 `anon` key 必須加 policy `FOR ALL USING (true)`
- `predictions` PK 是 `(code, date)`、`portfolio_holdings` PK 是 `id`

### F. 損益計算（含費）
台股實際成本：
- 買進手續費 0.1425%（最低 20 元）
- 賣出手續費 0.1425% + 證交稅 0.3%
- 共用 `computePL()` in server.js，回傳 含費均價、損益兩平價、總費用

### G. 台股跳動單位（roundToTwTick）
Yahoo / Stooq 偶爾回 242.13 這種非法值，必須 round：
```
< 10:    0.01    < 50:   0.05    < 100:  0.1
< 500:   0.5     < 1000: 1       ≥ 1000: 5
```
server `applyQuoteGuard()` 與前端 `format.js fmtTick()` 都有。

### H. 啟動時不要 warm cache
`WARM_CACHE` 預設關。要開：環境變數 `WARM_CACHE=1`。原本啟動就打 6 檔權值股 ×
4 endpoint = 30+ 個失敗 call，FinMind quota 立刻被打爆。

### I. Yahoo Circuit Breaker
連續 429 後冷卻 10 分鐘（providers/yahoo.js）。重啟才會清。

### J. Cache TTL 寫太長 = 改 code 沒效果
- predictions persist 5 分鐘
- diag 30 秒
- kline 60 秒（FinMind）/ 24 小時（TWSE）/ 30 分鐘（Stooq）
- T86 1 小時、industry 24 小時
- TAIEX kline 24 小時

改 diagnose 邏輯後若沒重啟，可能還在用舊 cache。

### K. lastGoodQuotes 鎖死
`lastGoodQuotes` 在 server 記憶體中，重啟才清。如果舊邏輯把錯值寫進去，**重啟才會解**。

### L. state.stocks[code] 多源覆寫衝突
`state.stocks[code].price` 是 header 顯示的 single source of truth，但有多處在寫：
- `scheduler.bootstrapQuotes`（`/api/quotes/batch` → MIS 即時，**正確來源**）
- `scheduler.loadMovers`（`/api/movers` → TWSE STOCK_DAY_ALL **盤後資料**）
- `search.js pick`（建立新 entry）

**踩過**：2408 漲停日，bootstrapQuotes 寫對了 237.0，但 loadMovers 緊接著拿 movers 的
昨日收盤 215.50 覆寫，結果 header 顯示 215.50（diagnose 路徑直接呼叫 MIS 沒被影響）。

**規則**：
- bootstrapQuotes 是唯一可以**覆寫** price 的地方（MIS 是 SSOT）
- loadMovers 只能**建立**新 entry，**不可覆寫**已存在的
- 所有新加的 update path 必須遵守這個 invariant

---

## 7. Supabase Schema

```sql
-- 預測追蹤（自我學習）
CREATE TABLE IF NOT EXISTS predictions (
  code TEXT NOT NULL,
  date DATE NOT NULL,
  close NUMERIC NOT NULL,
  win_rate INTEGER,
  direction TEXT,                 -- long / neutral / short
  target1 NUMERIC, stop NUMERIC,
  expected_return NUMERIC,
  recorded_at BIGINT,
  validated BOOLEAN DEFAULT FALSE,
  actual_close NUMERIC, actual_date DATE,
  actual_return NUMERIC,
  direction_hit BOOLEAN,
  expected_error NUMERIC, abs_error NUMERIC,
  features JSONB,                 -- ML-ready feature vector
  PRIMARY KEY (code, date)
);

-- 持股管理
CREATE TABLE IF NOT EXISTS portfolio_holdings (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL,
  entry_date DATE NOT NULL,
  entry_price NUMERIC NOT NULL,
  lots INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  status TEXT DEFAULT 'active',   -- active / closed
  exit_date DATE, exit_price NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 8. 環境變數（`.env`）

```bash
PORT=5174
FINMIND_TOKEN=<可空，但 quota 緊；402 後自動跑 fallback>
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=<service_role 推薦，anon 要設 RLS>
WARM_CACHE=0                    # 預設關，要開 =1
CACHE_TTL_HISTORICAL_MS=86400000
CACHE_TTL_REALTIME_MS=5000
```

---

## 9. 開發 / 啟動

```bash
npm install
npm start                       # production
npm run dev                     # node --watch
```

正常啟動 log（不應該看到大量 [diag XXX] failed）：
```
▌ 台股戰情室 backend 啟動 → http://localhost:5174
  session=closed  finmind_token=set
  supabase=set
  predictions loaded from Supabase: N 檔
```

健康檢查：
```bash
curl localhost:5174/api/predictions/healthcheck   # Supabase round-trip 自檢
curl localhost:5174/api/diag                      # 6 個 provider 即時狀態
curl localhost:5174/api/predictions/status        # memory + supabase
```

---

## 10. UI 模組現況（main.js mount）

```
topbar → search → drawer → sidebar → indices →
movers → aside → stockPanel → ranking → portfolio →
postPanel → holdings
```

**已拿掉的**（CLAUDE.md 留紀錄避免再加）：
- ❌ heatmap（市場熱力圖）— 拿掉
- ❌ backtest（系統評估）— 拿掉
- ❌ intraday chart（盤中即時走勢）— 拿掉
- ❌ ranking-panel（短線勝率排行榜 UI）— 已併入 AI 智選；ranking.js 仍存做資料 fetcher

關鍵事件（state.js pub/sub）：
- `select` → emit('stock:selected', code)
- `stock:selected` → stockPanel render；自動寫 `localStorage.twr:lastCode`
- `indices:changed` → 大盤卡片更新
- `stocks:changed` → header 即時價格
- `ranking:updated` → AI 智選重配
- `holdings:changed` → AI 智選扣除已持股資金

---

## 11. 不要做的事

| ❌ 不要 | ✅ 改做 |
|---|---|
| 加 mock 假資料 fallback | 顯示 empty state |
| 對 quote 做 anomaly 攔截 | 信任 MIS、只 round to tick |
| 重新做 Backtest 框架 | 之前移除過、結果不可信。要做請另闢資料庫 |
| 加盤中即時走勢圖 | Yahoo intraday 一直 429、不可靠 |
| 加 LSTM / 複雜 ML | 樣本不夠（< 5K），先 backfill predictions |
| 在 diagnose 中發 HTTP 請求 | diagnose 必須純函式 |
| 在前端硬寫加分規則 | 集中在後端 `diagnose.js` |
| 把 service_role key commit 到 git | 只放 .env（已 gitignore） |
| 啟動時連發多支股票診斷 | warm cache 已預設關 |

---

## 12. 該做的後續（依 ROI 排序）

1. **LINE Notify 主動通知**（持股跌停損 / 達停利 / 大盤翻空）
2. **LLM 新聞情緒**（Claude Haiku / GPT-4o-mini，cache 1h）
3. **內部人持股月變動**（公開資訊觀測站，月更）
4. **持股 P&L equity curve**（Chart.js 時間序列）
5. **行動版 UI 優化**

不要做：LSTM、線上學習、規模化商業化（先把上述做完再說）

---

## 13. 開發風格

- **白話文 > 術語**：UI 上對使用者用「建議觀望」而非「winRate < 50%」
- **顯示真實不確定性**：勝率上限 78%、顯示樣本數、命中率
- **Memory-first**：所有 cache 先記憶體，再非同步同步
- **Fail gracefully**：任一 provider 失敗不能拖垮整體
- **節省 token**：edit 時短，不寫贅字註解，刪舊 code 不留註解屍

---

## 14. 求救點

如果遇到莫名其妙的事，按順序檢查：

1. **F5 仍跳奇怪價** → 重啟 server 清 `lastGoodQuotes`
2. **某檔顯示昨收價（不是即時）** → 多半是漲停 / 跌停鎖死，看 §6.B parseRow 邏輯
3. **大量 [diag XXX] failed** → 檢查 `WARM_CACHE` 是否誤開
4. **診斷失敗** → 4 層 fallback 全掛、看 server log 哪層崩
5. **Supabase 寫入失敗** → `/api/predictions/healthcheck` 給具體 hint
6. **F5 跳回 2330** → `localStorage.twr:lastCode` 沒寫到，看 state.js
7. **Yahoo 永遠 429** → circuit breaker 開啟中，等 10 分鐘或重啟
8. **K 線每次不同** → 確認沒退回 mock fallback（已移除應不會發生）
9. **diagnose 拋錯** → TDZ 又中招，看變數宣告順序
10. **2408 / 漲停股 header 顯示前一日價（但 diagnose 對的）** → §6.L 多源覆寫衝突；MIS parseRow 看 §6.B
