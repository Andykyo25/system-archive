-- 離線化資料管線 — 第一刀
-- 目標：每日盤後 14:35 一次抓全市場資料灌進 Supabase，盤中前端只讀 Supabase 不打外網
--
-- 執行方式：Supabase Dashboard → SQL Editor → 貼上整段執行
-- 已存在：kline_cache、predictions、portfolio_holdings — 不動

-- ───────────────────────── 股票主檔 ─────────────────────────
CREATE TABLE IF NOT EXISTS stocks_list (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  market      TEXT,                  -- 'TSE' / 'OTC'
  industry    TEXT,
  is_etf      BOOLEAN DEFAULT FALSE,
  active      BOOLEAN DEFAULT TRUE,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────── 每日三大法人（個股別）─────────────────────────
-- 來源：TWSE T86（免 quota，一次回全市場）
-- 單位：張（千股）
CREATE TABLE IF NOT EXISTS daily_institutional (
  code         TEXT NOT NULL,
  date         DATE NOT NULL,
  foreign_net  BIGINT,
  trust_net    BIGINT,
  dealer_net   BIGINT,
  total_net    BIGINT,
  source       TEXT DEFAULT 'twse-t86',
  cached_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (code, date)
);
CREATE INDEX IF NOT EXISTS idx_inst_date ON daily_institutional(date DESC);
CREATE INDEX IF NOT EXISTS idx_inst_code ON daily_institutional(code);

-- ───────────────────────── 每日融資融券（個股別）─────────────────────────
-- 來源：TWSE MI_MARGN selectType=ALL（免 quota，一次回全市場）
-- 單位：張
CREATE TABLE IF NOT EXISTS daily_margin (
  code            TEXT NOT NULL,
  date            DATE NOT NULL,
  margin_buy      BIGINT,            -- 融資買進
  margin_sell     BIGINT,            -- 融資賣出
  margin_balance  BIGINT,            -- 融資餘額
  short_buy       BIGINT,            -- 融券買進（回補）
  short_sell      BIGINT,            -- 融券賣出
  short_balance   BIGINT,            -- 融券餘額
  source          TEXT DEFAULT 'twse-mi-margn',
  cached_at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (code, date)
);
CREATE INDEX IF NOT EXISTS idx_margin_date ON daily_margin(date DESC);
CREATE INDEX IF NOT EXISTS idx_margin_code ON daily_margin(code);

-- ───────────────────────── 大盤指數歷史 ─────────────────────────
-- 來源：TWSE indices() / Cnyes IX0001 / Stooq
-- symbol：'TAIEX'（加權）/ 'OTC'（櫃買）/ 'TW50' / 'SOX' / 'IXIC' / 'GSPC' / 'DJI' …
CREATE TABLE IF NOT EXISTS daily_index (
  symbol     TEXT NOT NULL,
  date       DATE NOT NULL,
  open       NUMERIC,
  high       NUMERIC,
  low        NUMERIC,
  close      NUMERIC NOT NULL,
  volume     BIGINT,
  source     TEXT,
  cached_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_index_date ON daily_index(date DESC);

-- ───────────────────────── 排程執行紀錄 ─────────────────────────
-- 用途：知道每天有沒有跑、抓了幾檔、錯了什麼
CREATE TABLE IF NOT EXISTS cron_runs (
  id           BIGSERIAL PRIMARY KEY,
  job          TEXT NOT NULL,        -- 'daily-backfill'
  trade_date   DATE,                 -- 該次處理的交易日
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  status       TEXT,                 -- 'success' / 'partial' / 'failed' / 'running'
  stats        JSONB,                -- { stocks: 1850, kline_rows, inst_rows, margin_rows, index_rows }
  errors       JSONB
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_date ON cron_runs(job, trade_date DESC);

-- ───────────────────────── （補）kline_cache 索引強化 ─────────────────────────
-- 已存在的 kline_cache 加日期索引，加速「取某天全市場」的查詢
CREATE INDEX IF NOT EXISTS idx_kline_cache_date ON kline_cache(date DESC);
