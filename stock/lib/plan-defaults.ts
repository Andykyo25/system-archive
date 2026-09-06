// Type-only import: keeps this module free of runtime imports so the Node test
// runner can load it directly.
import type { ScanRow } from "./scan";

// Every default below is derived from the signal row or from an EXISTING
// app_settings value. Nothing here invents a personal allocation limit; the
// numbers are a starting point the user can still edit before saving.

export interface PlanDefaults {
  entryMin: number;
  entryMax: number;
  stopPrice: number;
  validUntil: string;
  entryReason: string;
  exitRule: string;
  stopBasis: string;
  notes: string[];
}

// 買入區間取訊號收盤 ±3%,上緣再受掃描自己的防追高規則約束。
const ENTRY_BAND_PCT = 3;
const MAX_MA20_GAP_PCT = 15;
// 約 10 個交易日。RPC 只接受 today + 30 天內,留足緩衝。
const PLAN_DAYS = 14;
// 只有在 ATR 與月線都缺的情況下才用得到的最後退路。
const FALLBACK_STOP_PCT = 8;

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: number | null | undefined): number | null =>
  v != null && Number.isFinite(Number(v)) ? Number(v) : null;

export function addDays(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(t)) return isoDate;
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

export function planDefaults(
  row: ScanRow,
  opts: {
    today: string;
    atrStopMultiple: number | null;
    // Supplied by the caller (lib/scan conditions) so this stays import-free.
    checks: { label: string; pass: boolean }[];
  },
): PlanDefaults | null {
  const close = num(row.close);
  if (close == null || close <= 0) return null;
  const ma20 = num(row.ma20);
  const atr14 = num(row.atr14);
  const mult = num(opts.atrStopMultiple);
  const notes: string[] = [];

  // --- 買入區間 -------------------------------------------------------
  const gapCap = ma20 == null ? null : ma20 * (1 + MAX_MA20_GAP_PCT / 100);
  let entryMin = round2(close * (1 - ENTRY_BAND_PCT / 100));
  const entryMax = round2(
    gapCap == null ? close * (1 + ENTRY_BAND_PCT / 100)
      : Math.min(close * (1 + ENTRY_BAND_PCT / 100), gapCap),
  );
  if (entryMax < entryMin) {
    // 現價已超出月線乖離上限:不給區間,只留「回到上限才進場」的單一價位。
    entryMin = entryMax;
    notes.push(
      `現價已超出月線 +${MAX_MA20_GAP_PCT}% 的防追高上限，買入價收斂為單一價位 ${entryMax.toFixed(2)}；不回落就不進場。`,
    );
  }
  if (ma20 == null)
    notes.push("缺月線資料，買入上限只用訊號收盤 +3%，沒有防追高約束。");

  // --- 停損:ATR×N 與月線取較緊(價格較高)者 --------------------------
  const atrStop = atr14 != null && mult != null ? close - mult * atr14 : null;
  const candidates: { price: number; label: string }[] = [];
  if (atrStop != null && atrStop > 0)
    candidates.push({ price: atrStop, label: `ATR14×${mult}` });
  if (ma20 != null && ma20 > 0) candidates.push({ price: ma20, label: "月線" });

  let stopPrice: number;
  let stopBasis: string;
  if (candidates.length === 0) {
    stopPrice = entryMin * (1 - FALLBACK_STOP_PCT / 100);
    stopBasis = `買入下限 −${FALLBACK_STOP_PCT}%`;
    notes.push("缺 ATR 與月線資料，停損退回固定百分比，請自行確認是否合適。");
  } else {
    const tightest = candidates.reduce((a, b) => (b.price > a.price ? b : a));
    stopPrice = tightest.price;
    stopBasis =
      candidates.length === 2
        ? `${tightest.label}（與另一基準取較緊者）`
        : tightest.label;
  }
  // 資料庫要求 stop_price < entry_min,且四捨五入後仍須成立。
  const ceiling = round2(entryMin * 0.99);
  if (stopPrice > ceiling) {
    stopPrice = ceiling;
    stopBasis = `${stopBasis}，已收斂到買入下限之下`;
  }
  stopPrice = round2(stopPrice);
  if (stopPrice >= entryMin) stopPrice = round2(entryMin - 0.01);
  if (stopPrice <= 0) return null;

  const stopPct = ((entryMax - stopPrice) / entryMax) * 100;
  if (stopPct > 12)
    notes.push(
      `以買入上限計算的停損距離約 ${stopPct.toFixed(1)}%，偏寬；股數估算會因此變小。`,
    );

  // --- 敘述 -----------------------------------------------------------
  const passed = opts.checks.filter((c) => c.pass).map((c) => c.label);
  const failed = opts.checks.filter((c) => !c.pass).map((c) => c.label);
  const entryReason = [
    `訊號日 ${row.trade_date}，收盤 ${close.toFixed(2)}，評分 ${row.score_total ?? "—"}`,
    `（起漲 ${row.score_surge ?? "—"} / 位置 ${row.score_position ?? "—"} / 動能 ${row.score_momentum ?? "—"}）。`,
    passed.length ? `已符合：${passed.join("、")}。` : "五條件皆未符合。",
    failed.length ? `未符合：${failed.join("、")}。` : "",
    `買入區間 ${entryMin.toFixed(2)}–${entryMax.toFixed(2)}，`,
    gapCap == null
      ? "取訊號收盤 ±3%。"
      : `取訊號收盤 ±3% 並以月線 +${MAX_MA20_GAP_PCT}% 為上限防追高。`,
    "區間外不追價。分數描述型態符合程度，不是上漲機率。",
  ]
    .filter(Boolean)
    .join("");
  const exitRule = [
    `停損 ${stopPrice.toFixed(2)}（依據：${stopBasis}），以收盤跌破為準，不往下調整。`,
    `有效期限 ${addDays(opts.today, PLAN_DAYS)} 前若未進入買入區間，計畫作廢不順延。`,
    "進場後若跌破停損或原始進場理由消失（如跌回月線之下），依此規則出場。",
  ].join("");

  return {
    entryMin,
    entryMax,
    stopPrice,
    validUntil: addDays(opts.today, PLAN_DAYS),
    entryReason,
    exitRule,
    stopBasis,
    notes,
  };
}
