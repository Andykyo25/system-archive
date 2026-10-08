// notify-broker-recon 的純邏輯(不碰網路 / DB),讓 node --experimental-strip-types 能直接單元測試。
// I/O(查 view、讀 vault、送 Telegram、寫去重表與 fetch_log)在 ../notify-broker-recon/index.ts。

export type Num = number | string | null;

export type InventoryRow = {
  snapshot_date: string;
  symbol: string;
  system_qty: Num;
  broker_qty: Num;
  system_avg_cost: Num;
  broker_avg_cost: Num;
  status: string;
};

export type SettlementRow = {
  trade_date: string;
  status: string;
  buy_value_diff: Num;
  sell_value_diff: Num;
  buy_fee_diff: Num;
  sell_fee_diff: Num;
  system_sell_tax: Num;
  broker_sell_tax: Num;
  sell_tax_diff: Num;
  broker_buy_value: Num;
  broker_sell_value: Num;
};

export type SyncRun = { started_at: string; success: boolean | null; error: string | null };

export type Alert = {
  kind: "inventory" | "settlement" | "sync";
  key: string;
  status: string;
  line: string;
};

const num = (v: Num): number => Number(v ?? 0);
const fmt = (v: Num): string => num(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
const signed = (v: Num): string => (num(v) > 0 ? "+" : "") + fmt(v);
const mmdd = (iso: string): string => iso.slice(5).replace("-", "/");

export function taipeiDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 持股對帳:只看今天的快照(舊快照代表 worker 沒跑,那由 syncAlerts 處理)。
// key 含快照日 → 沒修好的差異「每天」都會再提醒一次。
export function inventoryAlerts(rows: InventoryRow[], today: string): Alert[] {
  const out: Alert[] = [];
  for (const r of rows) {
    if (r.snapshot_date !== today || r.status === "match") continue;
    const sys = fmt(r.system_qty);
    const brk = fmt(r.broker_qty);
    let line: string;
    switch (r.status) {
      case "qty_diff":
        line = `持股 ${r.symbol}：系統 ${sys} 股／券商 ${brk} 股（數量不符）`;
        break;
      case "missing_in_system":
        line = `持股 ${r.symbol}：券商有 ${brk} 股，系統沒有紀錄（漏記買進？）`;
        break;
      case "missing_at_broker":
        line = `持股 ${r.symbol}：系統有 ${sys} 股，券商沒有（漏記賣出？）`;
        break;
      case "cost_diff":
        line = `持股 ${r.symbol}：成本 系統 ${fmt(r.system_avg_cost)}／券商 ${fmt(r.broker_avg_cost)}（差異超過 1%）`;
        break;
      default:
        line = `持股 ${r.symbol}：${r.status}`;
    }
    out.push({ kind: "inventory", key: `${r.symbol}@${r.snapshot_date}`, status: r.status, line });
  }
  return out;
}

// 交割款對帳:近 3 天(含今天),match / pending 不報。key = 交易日 → 同一 (日期, 狀態) 只發一次。
export function settlementAlerts(rows: SettlementRow[], today: string): Alert[] {
  const from = addDays(today, -3);
  const out: Alert[] = [];
  for (const r of rows) {
    if (r.trade_date < from || r.trade_date > today) continue;
    if (r.status === "match" || r.status === "pending") continue;
    const d = mmdd(r.trade_date);
    let line: string;
    switch (r.status) {
      case "tax_diff":
        line = `交割款 ${d}：賣出稅 系統 ${fmt(r.system_sell_tax)}／券商 ${fmt(r.broker_sell_tax)}（差 ${signed(r.sell_tax_diff)}），可能是當沖半稅沒記`;
        break;
      case "value_diff":
        line = `交割款 ${d}：買進金額差 ${signed(r.buy_value_diff)}、賣出金額差 ${signed(r.sell_value_diff)}（系統減券商）`;
        break;
      case "fee_diff":
        line = `交割款 ${d}：手續費差 買 ${signed(r.buy_fee_diff)}／賣 ${signed(r.sell_fee_diff)}（系統減券商）`;
        break;
      case "missing_in_system":
        line = `交割款 ${d}：券商有成交（買 ${fmt(r.broker_buy_value)}／賣 ${fmt(r.broker_sell_value)}），系統沒有紀錄`;
        break;
      case "missing_at_broker":
        line = `交割款 ${d}：系統有交易，券商沒有成交`;
        break;
      default:
        line = `交割款 ${d}：${r.status}`;
    }
    out.push({ kind: "settlement", key: r.trade_date, status: r.status, line });
  }
  return out;
}

// 同步:傳入「近 3 小時內」的 broker-sync 紀錄。沒有 → 沒跑;最新一筆沒成功 → 失敗。每天只發一次(key = 今天)。
export function syncAlerts(runs: SyncRun[], today: string): Alert[] {
  if (runs.length === 0) {
    return [{ kind: "sync", key: today, status: "missing", line: "broker-sync：近 3 小時沒有執行紀錄（cron 沒觸發？）" }];
  }
  const latest = [...runs].sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
  if (latest.success === true) return [];
  const why = (latest.error ?? "").slice(0, 120) || "未知原因";
  return [{ kind: "sync", key: today, status: "failed", line: `broker-sync：最近一次同步失敗：${why}` }];
}

export const alertId = (a: Pick<Alert, "kind" | "key" | "status">): string => `${a.kind}|${a.key}|${a.status}`;

export function pickNew(alerts: Alert[], sent: Set<string>): Alert[] {
  return alerts.filter((a) => !sent.has(alertId(a)));
}

export function formatMessage(alerts: Alert[], today: string): string {
  const order = { sync: 0, inventory: 1, settlement: 2 };
  const lines = [...alerts]
    .sort((a, b) => order[a.kind] - order[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((a) => `• ${a.line}`);
  return `⚠️ 券商對帳異常（${today}）\n${lines.join("\n")}\n詳見 /holdings 的「券商對帳」區塊。此為通知，未動任何資料。`;
}

// 驗證用:每種狀態各一筆的固定樣本。部署後以 {"sample":true} 取得訊息雜湊,與本機比對,確認中文逐字一致。
export function sampleMessage(): string {
  const d = "2026-01-02";
  const inv = (status: string): InventoryRow => ({
    snapshot_date: d,
    symbol: "0000",
    system_qty: 1000,
    broker_qty: 800,
    system_avg_cost: 100,
    broker_avg_cost: 110,
    status,
  });
  const stl = (status: string): SettlementRow => ({
    trade_date: d,
    status,
    buy_value_diff: -1000,
    sell_value_diff: 0,
    buy_fee_diff: 5,
    sell_fee_diff: 0,
    system_sell_tax: 2262,
    broker_sell_tax: 1710,
    sell_tax_diff: 552,
    broker_buy_value: 375500,
    broker_sell_value: 754000,
  });
  const failed: SyncRun = { started_at: "2026-01-02T10:00:00Z", success: false, error: "partial: sample" };
  return formatMessage(
    [
      ...syncAlerts([], d),
      ...syncAlerts([failed], d),
      ...["qty_diff", "missing_in_system", "missing_at_broker", "cost_diff"].flatMap((s) => inventoryAlerts([inv(s)], d)),
      ...["tax_diff", "value_diff", "fee_diff", "missing_in_system", "missing_at_broker"].flatMap((s) => settlementAlerts([stl(s)], d)),
    ],
    d,
  );
}
