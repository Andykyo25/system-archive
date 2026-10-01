// 盤中即時分析的純函式:MIS 報價解析、均線 / ATR、上方套牢區、快照比對與解讀文字。
// 無 runtime import(只有型別),Node test、API route、client component 與 CLI 共用同一份。
// 只呈現事實與既有規則換算的參考價位,不產生新的買賣訊號;五檔買賣比僅供參考(掛單可撤)。

// ---------- 型別 ----------
export interface MisRaw {
  c?: string; n?: string;
  z?: string; pz?: string; y?: string; o?: string; h?: string; l?: string; v?: string;
  a?: string; f?: string; b?: string; g?: string; // 委賣價/量、委買價/量,"_" 分隔,最佳價在前
  tlong?: string;
}
export interface Level { price: number; lots: number }
export interface Quote {
  price: number | null;
  priceIsMid: boolean; // 無成交價,以五檔中價代替
  prev: number | null;
  chgPct: number | null;
  open: number | null;
  hi: number | null;
  lo: number | null;
  vol: number | null; // 累積成交量(張)
  ask: Level[];
  bid: Level[];
  askTot: number;
  bidTot: number;
  ratio: number | null; // 委買合計 / 委賣合計
  quotedAt: number | null; // 報價時間(ms)
}
export interface DailyBar { d: string; h: number | null; l: number | null; c: number; v: number | null; f: number }
export interface DailyStats { asOf: string; ma5: number; ma20: number; ma60: number; atr14: number | null; maSpreadPct: number }
export interface SupplyBin { lo: number; hi: number; lots: number }
export interface Supply { sharePct: number | null; bins: SupplyBin[] }
export interface VerdictInfo { watchDate: string; entryMin: number | null; entryMax: number | null; stopPrice: number | null; state: string; reason: string | null }
export interface Analysis {
  symbol: string;
  name: string | null;
  fetchedAt: number;
  quote: Quote | null;
  quoteError: string | null;
  fallback: { price: number; quotedAt: number } | null; // MIS 失敗時 price_intraday_cache 的最新價
  daily: DailyStats | null;
  supply: Supply | null;
  verdict: VerdictInfo | null;
  holding: { lots: number; avgCost: number } | null;
  atrMultiple: number;
}
// 前端輪詢時存的快照,用來做「和 N 分鐘前比」
export interface Snapshot {
  t: number; price: number; chgPct: number | null; hi: number | null; lo: number | null; vol: number | null;
  ratio: number | null; askTot: number; bidTot: number; priceIsMid: boolean;
}

// ---------- 小工具 ----------
const num = (v: unknown): number | null => {
  if (v == null || v === "" || v === "-") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const levelList = (s: string | undefined): number[] =>
  String(s ?? "").split("_").filter((x) => x !== "").map(Number).filter(Number.isFinite);
const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const round2 = (x: number) => Math.round(x * 100) / 100;

export const fmt = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? "—" : String(Math.round(x * 100) / 100);
export const pctText = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;

// 台灣無日光節約時間
const taipei = (ms: number) => new Date(ms + 8 * 3600e3);
export const taipeiHM = (ms: number) => taipei(ms).toISOString().slice(11, 16);
export const taipeiYmd = (ms: number) => taipei(ms).toISOString().slice(0, 10);
export function isMarketHours(ms: number): boolean {
  const c = taipei(ms), day = c.getUTCDay(), m = c.getUTCHours() * 60 + c.getUTCMinutes();
  return day >= 1 && day <= 5 && m >= 9 * 60 && m <= 13 * 60 + 35;
}
// 開盤後已過分鐘數(1–270),用來算全日平均量能速度
function minutesSinceOpen(ms: number): number {
  const c = taipei(ms), m = c.getUTCHours() * 60 + c.getUTCMinutes() - 9 * 60;
  return Math.min(270, Math.max(1, m));
}

// ---------- MIS 報價 ----------
export function toQuote(q: MisRaw): Quote | null {
  const ap = levelList(q.a), av = levelList(q.f), bp = levelList(q.b), bv = levelList(q.g);
  const prev = num(q.y);
  const mid = ap[0] != null && bp[0] != null ? (ap[0] + bp[0]) / 2 : null;
  const trade = num(q.z) ?? num(q.pz); // z 可能被 MIS throttle 成 "-"
  const price = trade ?? mid;
  if (price == null && ap.length === 0 && bp.length === 0) return null;
  const ask = ap.map((price, i) => ({ price, lots: av[i] ?? 0 }));
  const bid = bp.map((price, i) => ({ price, lots: bv[i] ?? 0 }));
  const askTot = ask.reduce((s, x) => s + x.lots, 0), bidTot = bid.reduce((s, x) => s + x.lots, 0);
  return {
    price, priceIsMid: trade == null && mid != null, prev,
    chgPct: price != null && prev ? ((price - prev) / prev) * 100 : null,
    open: num(q.o), hi: num(q.h), lo: num(q.l), vol: num(q.v),
    ask, bid, askTot, bidTot, ratio: askTot > 0 ? bidTot / askTot : null,
    quotedAt: num(q.tlong),
  };
}

// ---------- 日線指標 ----------
// bars 由舊到新。均線與 ATR 在還原價上算,再除以最新 adj_factor 換回目前報價單位(同 v_breakout_scan)。
export function dailyStats(bars: DailyBar[]): DailyStats | null {
  if (bars.length < 60) return null;
  const last = bars[bars.length - 1], F = last.f || 1;
  const adj = bars.map((b) => b.c * b.f);
  const ma = (k: number) => avg(adj.slice(-k)) / F;
  const ma5 = ma(5), ma20 = ma(20), ma60 = ma(60);
  let atr14: number | null = null;
  const tr: number[] = [];
  for (let i = bars.length - 14; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    if (!p || b.h == null || b.l == null) { tr.length = 0; break; }
    tr.push(Math.max(b.h * b.f - b.l * b.f, Math.abs(b.h * b.f - p.c * p.f), Math.abs(b.l * b.f - p.c * p.f)));
  }
  if (tr.length === 14) atr14 = avg(tr) / F;
  const mas = [ma5, ma20, ma60];
  return { asOf: last.d, ma5, ma20, ma60, atr14, maSpreadPct: ((Math.max(...mas) - Math.min(...mas)) / Math.min(...mas)) * 100 };
}

// 上方套牢:與 scan_supply_share 同口徑 —— 近 120 根日線,收盤在現價之上且 ≤ 現價 ×1.2 的量 / 全部量。
// 密集區用現價 1% 寬的價格帶,取量最大的 3 帶(由低到高)。
export function supplyAbove(bars: DailyBar[], price: number): Supply {
  const w = bars.slice(-120), tot = w.reduce((s, b) => s + (b.v ?? 0), 0);
  const above = w.filter((b) => b.c > price && b.c <= price * 1.2);
  const sharePct = tot > 0 ? (above.reduce((s, b) => s + (b.v ?? 0), 0) / tot) * 100 : null;
  const width = Math.max(price * 0.01, 0.05), m = new Map<number, SupplyBin>();
  for (const b of above) {
    const k = Math.floor((b.c - price) / width), e = m.get(k) ?? { lo: Infinity, hi: -Infinity, lots: 0 };
    e.lo = Math.min(e.lo, b.c); e.hi = Math.max(e.hi, b.c); e.lots += (b.v ?? 0) / 1000;
    m.set(k, e);
  }
  const bins = [...m.values()].sort((a, b) => b.lots - a.lots).slice(0, 3).sort((a, b) => a.lo - b.lo);
  return { sharePct, bins };
}

// ---------- 關鍵價位 ----------
export interface KeyLevels {
  support: number | null; // 現價下方最近的均線
  resistance: number | null; // 現價上方最近的均線
  atrStop: number | null; // 現價 − atr_stop_multiple × ATR14(持股建議用的既有倍數)
}
export function keyLevels(a: Analysis): KeyLevels | null {
  const price = a.quote?.price ?? a.fallback?.price ?? null;
  if (price == null || !a.daily) return null;
  const mas = [a.daily.ma5, a.daily.ma20, a.daily.ma60];
  return {
    support: mas.filter((m) => m < price).sort((x, y) => y - x)[0] ?? null,
    resistance: mas.filter((m) => m > price).sort((x, y) => x - y)[0] ?? null,
    atrStop: a.daily.atr14 != null ? round2(price - a.atrMultiple * a.daily.atr14) : null,
  };
}

// ---------- 快照 ----------
export function toSnapshot(a: Analysis): Snapshot | null {
  const q = a.quote;
  if (!q || q.price == null) return null;
  return { t: a.fetchedAt, price: q.price, chgPct: q.chgPct, hi: q.hi, lo: q.lo, vol: q.vol, ratio: q.ratio, askTot: q.askTot, bidTot: q.bidTot, priceIsMid: q.priceIsMid };
}

export interface Reading { kind: "compare" | "range" | "book" | "ma" | "supply"; text: string }

// 與基準快照的差異(成交量速度對比全日平均,判斷量縮 / 量增)
export function compareReadings(cur: Snapshot, base: Snapshot | null): Reading[] {
  if (!base) return [];
  const out: Reading[] = [];
  const mins = (cur.t - base.t) / 60000;
  const dp = cur.price - base.price;
  const parts: string[] = [Math.abs(dp) < 1e-9 ? "價格持平" : `${dp > 0 ? "上漲" : "下跌"} ${fmt(Math.abs(dp))}`];
  if (cur.lo != null && base.lo != null) parts.push(cur.lo < base.lo ? "已創今日新低" : "未破今日低點");
  if (cur.hi != null && base.hi != null && cur.hi > base.hi) parts.push("已創今日新高");
  out.push({ kind: "compare", text: `與 ${taipeiHM(base.t)} 相比:${parts.join("、")}。` });
  // 量能速度只在兩個快照都在盤中時才有意義(收盤後量不變,「量縮」是假象)
  if (cur.vol != null && base.vol != null && mins >= 2 && isMarketHours(cur.t) && isMarketHours(base.t)) {
    const added = cur.vol - base.vol, rate = added / mins, dayRate = cur.vol / minutesSinceOpen(cur.t);
    const tag = dayRate > 0 ? (rate < dayRate * 0.6 ? "量縮" : rate > dayRate * 1.5 ? "量增" : "量能持平") : "";
    out.push({ kind: "compare", text: `這 ${Math.round(mins)} 分鐘增加約 ${Math.round(added).toLocaleString()} 張(每分鐘 ${Math.round(rate)} 張,全日平均 ${Math.round(dayRate)} 張)${tag ? `,${tag}` : ""}。` });
  }
  return out;
}

// 靜態解讀:區間位置、五檔、均線、套牢
export function staticReadings(a: Analysis): Reading[] {
  const out: Reading[] = [];
  const q = a.quote, price = q?.price ?? a.fallback?.price ?? null;
  if (price == null) return out;
  if (q && q.hi != null && q.lo != null && q.hi > q.lo)
    out.push({ kind: "range", text: `今日區間:距低點 ${pctText((price / q.lo - 1) * 100)}、距高點 ${pctText((price / q.hi - 1) * 100)}。` });
  if (q && q.ratio != null) {
    const tone = q.ratio >= 1.3 ? "買盤掛單較厚" : q.ratio <= 1 / 1.3 ? "賣壓掛單較重" : "買賣掛單大致均衡";
    out.push({ kind: "book", text: `五檔買/賣比 ${q.ratio.toFixed(2)}:${tone}(掛單可撤,僅供參考)。` });
  }
  const d = a.daily;
  if (d) {
    const rel = (m: number, nm: string) => `${nm} ${fmt(m)}(現價${price >= m ? "在上" : "在下"} ${pctText((price / m - 1) * 100)})`;
    out.push({ kind: "ma", text: `均線(截至 ${d.asOf} 收盤):${rel(d.ma5, "MA5")};${rel(d.ma20, "MA20")};${rel(d.ma60, "MA60")}。` });
    if (d.maSpreadPct <= 3) out.push({ kind: "ma", text: `三條均線糾結在 ${fmt(Math.min(d.ma5, d.ma20, d.ma60))}–${fmt(Math.max(d.ma5, d.ma20, d.ma60))}(價差 ${d.maSpreadPct.toFixed(1)}%)。` });
  }
  const s = a.supply;
  if (s && s.sharePct != null)
    out.push({ kind: "supply", text: `上方套牢量佔近 120 日量 ${s.sharePct.toFixed(1)}%(現價至 +20% 內)${s.bins.length ? ";密集區:" + s.bins.map((b) => `${fmt(b.lo)}–${fmt(b.hi)}(約 ${Math.round(b.lots).toLocaleString()} 張)`).join("、") : ""}。` });
  return out;
}

// 操作參考文字(網頁與 CLI 共用):只換算既有規則 —— 看多名單進出價、ATR×atr_stop_multiple、MA20 —— 不產生新訊號
export function adviceText(a: Analysis): { flat: string; heldLabel: string; held: string[] } {
  const price = a.quote?.price ?? a.fallback?.price ?? null;
  const kl = keyLevels(a), d = a.daily, v = a.verdict, h = a.holding;
  const state = v ? (v.state === "block" ? `停止進場${v.reason ? `,${v.reason}` : ""}` : v.state === "ok" ? "可進場" : "觀察中") : "";
  const flat = v
    ? `在今日看多名單(名單日 ${v.watchDate},盤中狀態:${state})。進場區間 ${fmt(v.entryMin)}–${fmt(v.entryMax)},停損 ${fmt(v.stopPrice)}。`
    : `不在今日看多名單,系統沒有進場訊號。${kl?.support != null ? `可觀察 ${fmt(kl.support)} 附近是否量縮止穩(僅供觀察,非進場建議)。` : ""}`;
  const held: string[] = [];
  if (h && price != null) held.push(`${h.lots} 張、均價 ${fmt(h.avgCost)}、損益 ${pctText((price / h.avgCost - 1) * 100)}`);
  held.push(`停損參考 ${kl?.atrStop != null ? fmt(kl.atrStop) : "—"}(現價 − ${a.atrMultiple}×ATR14${d?.atr14 != null ? ` ${fmt(d.atr14)}` : ""},沿用持股建議的倍數)`);
  if (d) held.push(`收盤跌破 MA20 ${fmt(d.ma20)} 視為原始進場理由消失`);
  return { flat, heldLabel: h ? "已有持股" : "若持有", held };
}
