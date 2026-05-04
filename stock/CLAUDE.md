# 台股戰情室 — Claude Context

> 給 Claude / 未來協作者快速進入狀況用。**動 code 前先讀完整份**。

---

## 1. 專案定位

自用台股看盤 + 量化分析 + 自我學習回饋系統。**不是商用產品**，不是投顧服務，純粹是
"rule-based scoring + 真實預測追蹤 + 持股管理" 的整合工具。

- **使用者**：個人開發者，跑在 Railway（雲端）+ 本地測試
- **規模**：~10K LOC、單一倉庫、無前端框架（vanilla JS + ES Module）
- **後端**：Node 20+ / Express / Supabase

---

## 2. 高層架構

```
[ 6 個資料 Provider ]
   TWSE OpenAPI / TWSE MIS / FinMind / Yahoo / Stooq / 鉅亨網
        │  fallback 鏈：MIS → FinMind → Yahoo → TWSE STOCK_DAY → Stooq
        ▼
[ Express Server ]                       [ Supabase Postgres ]
   server/server.js                          predictions
   ├─ providers/*                            portfolio_holdings
   ├─ diagnose() 共用評分                  ▲
   ├─ marketContext / industryContext      │
   ├─ predictions（self-learning）─────────┤
   └─ portfolio（持股 CRUD）───────────────┘
        │
        ▼ /api/*
[ Frontend（vanilla ESM）]
   index.html + styles.css
   src/
   ├─ main.js（boot + 14 個 UI 模組 mount）
   ├─ scheduler.js（依交易時段調 polling 頻率）
   ├─ state.js（pub/sub + localStorage 記住 currentCode）
   ├─ data/api.js / mock.js
   ├─ ui/*.js（topbar、stockPanel、portfolio、holdings 等）
   └─ utils/diagnose.js（核心評分引擎，~1100 行）
```

---

## 3. 核心檔案 — 最重要的 5 個

| 檔案 | 內容 | 注意事項 |
|---|---|---|
| `src/utils/diagnose.js` | 4 維評分 + ensemble + walk-forward + feature engineering | **改之前先看 §6**。TDZ bug 過好幾次 |
| `server/server.js` | 30+ REST endpoints、`loadStockDiagnose` 共用邏輯 | endpoint 順序固定，別亂插 |
| `src/ui/stockPanel.js` | 個股主面板（K 線、AI 顧問卡片、診斷渲染） | 700+ 行，避免再加東西 — 該拆模組了 |
| `server/predictions.js` | 自我學習迴路（Memory + Supabase） | dirty queue 2s debounced；別改成同步 |
| `server/portfolio.js` | 持股 CRUD（直接打 Supabase） | RLS 用 service_role key |

---

## 4. 投資策略邏輯（全在 `diagnose.js`）

### 4 維獨立評分
- **趨勢面 (30%)**：MA5/20/60 排列 + Bias20 + RS vs TAIEX
- **動能面 (25%)**：KD 黃金/死叉、MACD、RSI(14)、RSI 5d delta
- **量價面 (20%)**：量爆發/萎縮、價量配合、5d 量趨勢
- **籌碼面 (25%)**：3 大法人 3d、投信佔股本、新聞情緒、產業 RS

### 過擬合對策（六道防線）
1. Ensemble 投票 + 一致性收縮（`shrinkFactor = 0.4 + 0.6 × consistency`）
2. 罰分上限 30
3. winRate clamp [15, 78]（不允許 100% 信心）
4. 多時間框架共振（日週共振 ×1.10、背離 ×0.75）
5. 流動性過濾（低流動性 ×0.7）
6. 交易成本可行性（不夠賺 1.17% × 2 → ×0.85）

### 自我學習迴路
- 每次 diagnose 寫入 `predictions` 表
- 5 個交易日後比對實際漲跌算 hit rate
- 連續 3 筆誤差 > 5% → confidence multiplier ×0.7
- 命中率 < 50% → 整體 winRate 收縮

### 強勢突破 override
漲停 / 大紅帶量 → +12 / +8 / +5，UI 顯示 🚀。**用戶反映保守時最大功臣**。

---

## 5. 資料 Fallback 鏈（極重要）

### K 線
```
FinMind  →  Yahoo  →  TWSE STOCK_DAY  →  Stooq
（402 quota）（429 rate limit）（穩定但慢）（無 quota 但偶爾掛）
```

**所有需要 K 線的地方都要 4 層**：`/api/kline`、`loadStockDiagnose`、
`backtest（已移除）`、`industryContext`。改任何一處時 4 層都要更新。

### 即時報價
```
TWSE MIS（主，無 quota）
  → Yahoo（備）
  → FinMind cache（盤中不發新請求）
  → lastGoodQuotes（記憶體最後一筆）
```

### 大盤指數
```
TWSE MIS  →  Yahoo TWII  →  Stooq ^twi
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
- 修法：把所有指標計算（`closes`/`vols`/`bias20`/`atr14` 等）放在函式開頭、scoring section 前

### B. Anomaly Detection 不要做
原本對 quotes 加 7% 跳動防呆，結果**漲停（+9.97%）被擋住**，2408 卡在昨收價。
**已拿掉**。lastGoodQuotes 只在所有來源失敗時當 fallback。

### C. 不要 mock K 線資料
原本 `genMockK()` 在 FinMind 失敗時生成隨機 K 線 → **每次 F5 都不同 → 診斷亂跳**。已拿掉。
失敗就顯示 empty state，不假裝有資料。

### D. Supabase RLS
- 用 `service_role` key（後端，跳過 RLS）
- 若用 `anon` key 必須加 policy `FOR ALL USING (true)`
- `predictions` PK 是 `(code, date)`，`portfolio_holdings` PK 是 `id`

### E. 損益計算
台股實際成本：
- 買進：手續費 0.1425%（最低 20 元）
- 賣出：手續費 0.1425% + 證交稅 0.3%
- 損益 = 賣出實得 - 買進總成本（見 `computePL()` in server.js）

### F. 台股跳動單位
價格不是任意小數。Yahoo / Stooq 偶爾回 242.13 這種非法值，必須過 `roundToTwTick()`：
```
< 10:    0.01
< 50:    0.05
< 100:   0.1
< 500:   0.5
< 1000:  1
≥ 1000:  5
```

### G. Quote 鎖死問題
- `lastGoodQuotes` 在記憶體中，server 重啟才清空
- 若舊邏輯把錯誤值寫進去，**重啟 server 才會解**

### H. Cache TTL 寫太長 = 改 code 沒效果
Supabase persist 5 分鐘 / diag 30 秒 / kline 60 秒 / industry 24 小時。
改 diagnose 邏輯後若沒重啟，可能還在用舊 cache。

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
FINMIND_TOKEN=<可空，但 quota 緊>
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=<service_role key 推薦，anon 要設 RLS>
WARM_CACHE=1                    # 啟動預熱權值股
CACHE_TTL_HISTORICAL_MS=86400000
CACHE_TTL_REALTIME_MS=5000
```

---

## 9. 開發 / 啟動

```bash
npm install
npm start                       # production
npm run dev                     # node --watch（自動重啟）
```

正常啟動 log：
```
▌ 台股戰情室 backend 啟動 → http://localhost:5174
  session=closed  finmind_token=set
  supabase=set
  predictions loaded from Supabase: N 檔
  warm cache ✓ 7 items in 3000ms
```

健康檢查：
```bash
curl localhost:5174/api/predictions/healthcheck   # Supabase round-trip 自檢
curl localhost:5174/api/diag                      # 6 個 provider 即時狀態
curl localhost:5174/api/predictions/status        # memory + supabase
```

---

## 10. UI 模組 mount 順序（main.js）

```
topbar → search → drawer → sidebar → indices → heatmap →
movers → aside → stockPanel → ranking → portfolio →
postPanel → holdings
```

每個模組獨立，不互相 import，靠 `state.js` 的 pub/sub 通訊。

關鍵事件：
- `select` → 用戶選股，emit('stock:selected', code)
- `stock:selected` → stockPanel 重新 render
- `indices:changed` → 大盤卡片更新
- `stocks:changed` → header 即時價格更新
- `ranking:updated` → AI 智選重配
- `holdings:changed` → AI 智選扣除已持股資金

---

## 11. 不要做的事

| ❌ 不要 | ✅ 改做 |
|---|---|
| 加 mock 假資料 fallback | 顯示 empty state |
| 對 quote 做 anomaly 攔截 | 信任 MIS，只 round to tick |
| Backtest 框架 | 已拿掉，太多 bug 不可信。要做請重寫 |
| 加 LSTM / 複雜 ML | 樣本不夠（< 5K），先 backfill predictions |
| 在 diagnose 中發 HTTP 請求 | diagnose 必須純函式 |
| 在前端硬寫加分規則 | 集中在 `diagnose.js` 後端 |
| 把 `service_role` key 提交到 git | 只放 .env（已 gitignore） |

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
2. **診斷失敗** → 看 server log，通常是 4 層 fallback 全掛
3. **Supabase 寫入失敗** → `/api/predictions/healthcheck` 會給具體 hint
4. **F5 跳回 2330** → `localStorage.twr:lastCode` 沒寫到，看 state.js
5. **K 線每次不同** → 確認沒退回 mock fallback
6. **diagnose 拋錯** → TDZ 又中招，看變數宣告順序
