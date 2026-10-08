// /holdings「券商對帳」區塊的純邏輯(不碰 DB / React),方便用 node --experimental-strip-types 測試。
// 資料來源:broker_snapshot_run、v_broker_recon、broker_settlement、v_broker_settlement_recon(皆僅 service_role 可讀)。

export type Num = number | string | null;

export type BrokerRun = { snapshot_date: string; row_count: number; fetched_at: string };
export type InventoryReconRow = {
  symbol: string;
  system_qty: Num;
  broker_qty: Num;
  status: string;
};
export type UpcomingRow = { settlement_date: string | null; total_settlement_amount: Num };
export type SettlementReconRow = { trade_date: string; status: string; sell_tax_diff: Num };

export type Tone = "ok" | "warn" | "none";
export type Summary = { tone: Tone; headline: string; lines: string[] };

export const INVENTORY_STATUS_LABEL: Record<string, string> = {
  match: "一致",
  qty_diff: "數量不符",
  cost_diff: "成本差異",
  missing_in_system: "系統漏記",
  missing_at_broker: "券商無此持股",
};

export const SETTLEMENT_STATUS_LABEL: Record<string, string> = {
  match: "一致",
  pending: "待確認",
  tax_diff: "稅額不符",
  value_diff: "金額不符",
  fee_diff: "手續費不符",
  missing_in_system: "系統漏記",
  missing_at_broker: "券商無成交",
};

const n = (v: Num): number => Number(v ?? 0);
const int = (v: Num): string => n(v).toLocaleString("zh-TW", { maximumFractionDigits: 0 });

export const mmdd = (iso: string): string => iso.slice(5).replace("-", "/");

// 持股對帳:沒有快照 → none;全部 match → ok;否則 warn 並列出每檔差異。
export function inventorySummary(run: BrokerRun | null, recon: InventoryReconRow[]): Summary {
  if (!run) return { tone: "none", headline: "尚無快照", lines: ["worker 尚未成功寫入券商庫存"] };
  const diffs = recon.filter((r) => r.status !== "match");
  if (diffs.length === 0) {
    return { tone: "ok", headline: recon.length ? `${recon.length} 檔一致` : "券商與系統皆無持股", lines: [] };
  }
  return {
    tone: "warn",
    headline: `${diffs.length} 檔有差異`,
    lines: diffs.map(
      (r) =>
        `${r.symbol}　系統 ${int(r.system_qty)}／券商 ${int(r.broker_qty)}　${INVENTORY_STATUS_LABEL[r.status] ?? r.status}`,
    ),
  };
}

// 待交割款:交割日 >= 今天(含今天),同一交割日加總。正數 = 應收,負數 = 應付。
export function upcomingSettlements(
  rows: UpcomingRow[],
  today: string,
): { total: number; byDate: { date: string; amount: number }[] } {
  const by = new Map<string, number>();
  for (const r of rows) {
    if (!r.settlement_date || r.settlement_date < today) continue;
    by.set(r.settlement_date, (by.get(r.settlement_date) ?? 0) + n(r.total_settlement_amount));
  }
  const byDate = [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, amount]) => ({ date, amount }));
  return { total: byDate.reduce((s, x) => s + x.amount, 0), byDate };
}

export function settlementLine(date: string, amount: number): string {
  if (amount === 0) return `${mmdd(date)}　無淨額`;
  return `${mmdd(date)}　${amount > 0 ? "應收" : "應付"} ${int(Math.abs(amount))}`;
}

// 交割款對帳:rows 為近幾日(任意順序)。pending 不算差異。
export function settlementReconSummary(rows: SettlementReconRow[]): Summary {
  if (rows.length === 0) return { tone: "none", headline: "尚無資料", lines: [] };
  const diffs = rows.filter((r) => r.status !== "match" && r.status !== "pending");
  if (diffs.length === 0) return { tone: "ok", headline: `近 ${rows.length} 日一致`, lines: [] };
  const sorted = [...diffs].sort((a, b) => (a.trade_date < b.trade_date ? 1 : -1));
  return {
    tone: "warn",
    headline: `${diffs.length} 日有差異`,
    lines: sorted.map((r) => {
      const label = SETTLEMENT_STATUS_LABEL[r.status] ?? r.status;
      const tax = r.status === "tax_diff" ? `（稅差 ${n(r.sell_tax_diff) > 0 ? "+" : ""}${int(r.sell_tax_diff)}）` : "";
      return `${mmdd(r.trade_date)}　${label}${tax}`;
    }),
  };
}
