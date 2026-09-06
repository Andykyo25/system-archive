// Local fixture server only. Never uses production credentials or writes a live DB.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const today = "2026-09-06";
const production = process.env.UI_SMOKE_MODE === "production";
if (production) {
  // Match the static/public layout copied by the Railway Dockerfile.
  await cp("public", ".next/standalone/public", { recursive: true });
  await cp(".next/static", ".next/standalone/.next/static", { recursive: true });
}
const base = {
  industry_category: "半導體業",
  trade_date: "2026-09-04",
  close: 54,
  day_pct: 8,
  volume_lots: 6200,
  ma20: 50,
  ma20_gap_pct: 8,
  ma20_slope_pct: 1,
  high_20d: 51,
  rsi14: 68,
  ret_5d_pct: 9,
  score_surge: 34,
  score_position: 33,
  score_momentum: 33,
  score_total: 100,
  passes_all: true,
  fgn_net_5d: 500000,
  atr14: 1.5,
};
const candidates = [
  { ...base, symbol: "TEST", name: "示範半導體" },
  {
    ...base,
    symbol: "DEMO",
    name: "示範光電",
    industry_category: "光電業",
    score_total: 81,
    score_surge: 15,
    passes_all: false,
    day_pct: 3,
    volume_lots: 2200,
    fgn_net_5d: null,
  },
];
const plans = [];
const riskContext = {
  cash: 300000,
  equity: 1000000,
  risk_pct: 0.01,
  fee_rate: 0.001425,
  tax_rate: 0.003,
  price_date: "2026-09-04",
  coverage_ok: true,
  positions: [{ symbol: "OTHER", industry: "半導體業", market_value: 700000 }],
  calculated_at: "2026-09-06T01:00:00Z",
};
const backtest = {
  id: "fixture",
  name: "逐日帳戶示範",
  status: "finished",
  created_at: today,
  params: {
    start_date: "2026-07-30",
    end_date: "2026-08-03",
    rebalance_days: 2,
    top_n: 2,
    weight_strategy: "equal",
    benchmark_symbol: "0050",
  },
  summary: {
    execution_version: "daily-stop-v4",
    accounting_version: "daily-cash-ledger-v1",
    initial_capital: 1000000,
    equity_dates: ["2026-07-30", "2026-07-31", "2026-08-03"],
    equity_curve: [1, 1.1, 0.99],
    benchmark_equity_curve: [1, 1.02, 1.03],
    cash_curve: [0.5, 0.5, 0.5],
    market_value_curve: [0.5, 0.6, 0.49],
    rebalance_dates: ["2026-07-30"],
    n_open_positions: 1,
    n_rebalances: 1,
    total_return_pct: -1,
    benchmark_return_pct: 3,
    alpha_vs_benchmark: -4,
    max_drawdown_pct: 10,
    n_trades: 0,
    stale_mark_days: 1,
    open_positions: [
      {
        symbol: "TEST",
        qty: 1000,
        last_price: 49,
        last_price_date: "2026-07-31",
        market_value: 490000,
        scheduled_exit_date: "2026-08-03",
      },
    ],
  },
};
let failTrack = false;
const mock = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname.split("/").at(-1);
  let payload = [];
  const json = () =>
    new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => resolve(b ? JSON.parse(b) : {}));
    });
  if (route === "v_breakout_scan") {
    payload = candidates;
    res.setHeader("Content-Range", "0-1/1146");
  } else if (route === "v_plan_risk_context") payload = riskContext;
  else if (route === "stock_industry")
    payload = [{ industry_category: "半導體業" }];
  else if (route === "backtest_runs")
    payload = url.searchParams.get("id")?.startsWith("eq.")
      ? backtest
      : [
          backtest,
          {
            ...backtest,
            id: "old",
            name: "舊版示範",
            summary: { ...backtest.summary, accounting_version: "legacy" },
          },
        ];
  else if (route === "price_daily") payload = [{ trade_date: "2026-09-04" }];
  else if (route === "v_scan_track_v2") {
    if (failTrack) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "fixture failure" }));
      return;
    }
    payload = [];
  } else if (route === "trade_plans") {
    if (req.method === "PATCH") {
      const patch = await json();
      Object.assign(plans[0], patch);
      payload = [{ id: plans[0].id }];
    } else payload = plans;
  } else if (route === "app_settings")
    payload = [
      { key: "commission_discount", value: 1 },
      { key: "commission_base_rate", value: 0.001425 },
      { key: "atr_stop_multiple", value: 2 },
      { key: "plan_slippage_pct", value: 0.3 },
    ];
  else if (
    route === "create_breakout_plan" ||
    route === "create_breakout_plan_with_risk"
  ) {
    const body = await json();
    const p = body.p_inputs ?? body;
    plans.unshift({
      id: "11111111-1111-4111-8111-111111111111",
      symbol: p.p_symbol,
      strategy_version: "breakout-v3-adjusted",
      signal_date: p.p_signal_date,
      signal_snapshot: candidates.find((r) => r.symbol === p.p_symbol),
      entry_min: p.p_entry_min,
      entry_max: p.p_entry_max,
      stop_price: p.p_stop_price,
      valid_until: p.p_valid_until,
      entry_reason: p.p_entry_reason,
      exit_rule: p.p_exit_rule,
      status: "watching",
      risk_snapshot: body.p_risk_snapshot ?? null,
    });
    payload = plans[0].id;
  } else if (route === "record_plan_buy") {
    const fill = await json();
    plans[0].status = "entered";
    plans[0].holdings_transactions = [
      { price: fill.p_price, qty: fill.p_qty, txn_date: fill.p_txn_date },
    ];
    payload = null;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
});
await new Promise((resolve) => mock.listen(4189, "127.0.0.1", resolve));
const child = spawn(
  process.execPath,
  production ? [".next/standalone/server.js"] : [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3189",
  ],
  {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:4189",
      SUPABASE_SERVICE_ROLE_KEY: "fixture-only-key",
      NODE_ENV: production ? "production" : "development",
      PORT: "3189",
      HOSTNAME: "127.0.0.1",
    },
  },
);
let log = "";
child.stdout.on("data", (b) => (log += b));
child.stderr.on("data", (b) => (log += b));
let browser;
try {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch("http://127.0.0.1:3189/scan");
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  const response = await page.goto("http://127.0.0.1:3189/scan");
  assert.equal(response.status(), 200);
  assert.equal(response.headers()["www-authenticate"], undefined);
  await page.getByRole("heading", { name: "先找型態，再訂進退" }).waitFor();
  await mkdir(".next/ui-qa", { recursive: true });
  await page.screenshot({
    path: ".next/ui-qa/scan-desktop.png",
    fullPage: true,
    caret: "initial",
  });
  await page.getByRole("textbox", { name: "搜尋股號或名稱" }).fill("不存在");
  await page.getByText("目前沒有符合條件的候選").waitFor();
  await page.getByRole("button", { name: "清除篩選" }).click();
  await page.getByRole("button", { name: "五條件全過", exact: true }).click();
  assert.equal(await page.getByRole("link", { name: /示範光電/ }).count(), 0);
  await page.getByText("查看依據與建立計畫", { exact: true }).click();
  // Auto-filled before any typing: close 54, ma20 50, atr14 1.5, multiple 2.
  const valueOf = async (label) =>
    Number(await page.getByLabel(label, { exact: true }).inputValue());
  assert.equal(await valueOf("買入下限"), 52.38); // 54 × 0.97
  assert.equal(await valueOf("買入上限"), 55.62); // 54 × 1.03 < 50 × 1.15
  assert.equal(await valueOf("初始停損"), 51); // 54 − 2×1.5, tighter than MA20 50
  assert.equal(
    await page.getByLabel("有效至", { exact: true }).inputValue(),
    "2026-09-20",
  );
  for (const label of ["進場依據與觸發條件", "出場規則與失效條件"]) {
    const text = await page.getByLabel(label).inputValue();
    assert.ok(text.length >= 5, `${label} should be prefilled`);
  }
  assert.ok(
    (await page.getByLabel("出場規則與失效條件").inputValue()).includes("51.00"),
  );
  // Now override with explicit values and confirm the estimate follows.
  await page.getByLabel("買入下限", { exact: true }).fill("52");
  await page.getByLabel("買入上限", { exact: true }).fill("54");
  await page.getByLabel("初始停損", { exact: true }).fill("49");
  await page.getByLabel("有效至", { exact: true }).fill("2026-09-10");
  await page.getByLabel("進場依據與觸發條件").fill("突破回測後在區間內進場");
  await page.getByLabel("出場規則與失效條件").fill("收盤跌破支撐就退出部位");
  await page.getByLabel("一併保存股數估算").check();
  await page.getByLabel("單邊滑價 %", { exact: true }).fill("0.1");
  // No concentration caps configured, so only risk budget and cash apply.
  await page.getByText("估算上限 1,853 股", { exact: true }).waitFor();
  await page.getByText(/限制來自：單筆風險預算/).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: ".next/ui-qa/scan-plan-mobile.png",
    fullPage: true,
    caret: "initial",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "保存交易計畫", exact: true }).click();
  await page
    .getByText("計畫已保存。可在「我的計畫」記錄實際買入。", { exact: true })
    .waitFor();
  assert.equal(plans.length, 1);
  assert.equal(plans[0].risk_snapshot.shares, 1853);
  assert.equal(plans[0].risk_snapshot.positionPct, null);
  assert.equal(plans[0].risk_snapshot.industryPct, null);
  await page.getByText("記錄實際買入", { exact: true }).click();
  await page.getByLabel("股數", { exact: true }).fill("2000");
  await page.getByLabel("成交價", { exact: true }).fill("53");
  await page.getByLabel("成交日", { exact: true }).fill(today);
  await page.getByRole("button", { name: "確認記錄成交", exact: true }).click();
  await page.getByText("已成交、到期與取消的計畫（1）").waitFor();
  assert.equal(plans[0].status, "entered");
  await page.getByText("已成交、到期與取消的計畫（1）").click();
  await page.getByText(/成交在價格區間內/).waitFor();
  await page.getByText(/建立時估算上限 1,853 股/).waitFor();
  await page.getByText(/成交股數超過建立時估算上限/).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:3189/scan");
  await page.getByRole("heading", { name: "先找型態，再訂進退" }).waitFor();
  await page.screenshot({
    path: ".next/ui-qa/scan-mobile.png",
    fullPage: true,
    caret: "initial",
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  failTrack = true;
  await page.reload();
  await page.getByText("前向追蹤載入失敗，暫時無法評估。").waitFor();
  await page.goto("http://127.0.0.1:3189/backtest/fixture");
  await page.getByRole("heading", { name: "期末帳戶狀態" }).waitFor();
  await page.getByRole("heading", { name: "月度帳戶報酬" }).waitFor();
  await page
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "資產曲線 vs Benchmark" }),
    })
    .getByText("26-08-03", { exact: true })
    .waitFor();
  await page.getByText(/尚未成交 · 估值日/).waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".next/ui-qa/backtest-desktop.png",
    fullPage: true,
    caret: "initial",
  });
  await page.goto("http://127.0.0.1:3189/backtest/compare?ids=fixture&ids=old");
  await page.getByText(/所選回測的版本、日期或基準不一致，暫不疊圖/).waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "資產曲線疊圖" }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    `UI PASS (${production ? "production standalone" : "development"}): no login, desktop/mobile, search, filter, risk snapshot, create plan, record fill, error state, daily backtest, comparison guard, no horizontal overflow.`,
  );
} catch (e) {
  console.error(log.slice(-2500));
  const activePage = browser?.contexts()[0]?.pages()[0];
  if (activePage) console.error((await activePage.locator("body").innerText()).slice(-4000));
  console.error("Fixture plan states:", plans.map(p => ({status:p.status, fills:p.holdings_transactions})));
  throw e;
} finally {
  await browser?.close();
  child.kill();
  await new Promise((resolve) => mock.close(resolve));
}
