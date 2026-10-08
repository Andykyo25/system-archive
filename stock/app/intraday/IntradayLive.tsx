"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { Badge, Card } from "@/app/_components/ui";
import { fmtMoney, fmtPct, pctColor } from "@/app/_components/Format";
import {
  adviceText,
  compareReadings,
  fmt,
  isMarketHours,
  keyLevels,
  pctText,
  staticReadings,
  taipeiHM,
  taipeiYmd,
  toSnapshot,
  type Analysis,
  type Snapshot,
} from "@/lib/intraday";

export interface QuickItem { symbol: string; name: string | null }

const POLL_MS = 30_000;
const MIN_GAP_MS = 45_000; // 兩筆快照至少間隔
const MAX_SNAPS = 150;

// 快照存 localStorage(同日、同代號);隱私模式 / 被禁用時退化成只有本次頁面的記憶體
const storeKey = (symbol: string, ymd: string) => `intraday:${symbol}:${ymd}`;
function readSnaps(key: string): Snapshot[] {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeSnaps(key: string, snaps: Snapshot[]) {
  try { localStorage.setItem(key, JSON.stringify(snaps)); } catch { /* ignore */ }
}

// 自動基準:距現在最接近 10 分鐘前、且至少早 2 分鐘的快照
function autoBase(snaps: Snapshot[], cur: Snapshot | null): Snapshot | null {
  if (!cur) return null;
  const older = snaps.filter((s) => s.t <= cur.t - 2 * 60_000);
  if (!older.length) return null;
  const target = cur.t - 10 * 60_000;
  return older.reduce((best, s) => (Math.abs(s.t - target) < Math.abs(best.t - target) ? s : best));
}

export function IntradayLive({
  initialSymbol,
  holdings,
  verdict,
}: {
  initialSymbol: string | null;
  holdings: QuickItem[];
  verdict: QuickItem[];
}) {
  const [symbol, setSymbol] = useState<string | null>(initialSymbol);
  const [input, setInput] = useState(initialSymbol ?? "");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null); // 最新一次更新失敗,但畫面仍保留上一筆成功資料
  const [loading, setLoading] = useState(false);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [baseSel, setBaseSel] = useState<string>("auto");
  const [now, setNow] = useState(() => Date.now());
  const [reloadKey, setReloadKey] = useState(0);

  // 每 5 秒更新「N 秒前」
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  // 取資料 + 輪詢:盤中且分頁可見才每 30 秒;收盤後只抓一次(手動重新整理仍可)
  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    const key = storeKey(symbol, taipeiYmd(Date.now()));

    const run = async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/intraday/${symbol}`, { cache: "no-store" });
        if (!r.ok) throw new Error(r.status === 404 ? "查無此代號" : `載入失敗(${r.status})`);
        const a = (await r.json()) as Analysis;
        if (!alive) return;
        // 這次即時報價失敗、但之前有成功資料 → 保留舊畫面(含五檔),只標示更新失敗
        setAnalysis((prev) => (!a.quote && prev?.quote ? prev : a));
        setWarn(a.quote ? null : a.quoteError);
        setError(null);
        const s = toSnapshot(a);
        const prev = readSnaps(key);
        const last = prev[prev.length - 1];
        // 收盤後不再累積重複快照(除非今天還沒有任何一筆)
        if (s && (!last || (s.t - last.t >= MIN_GAP_MS && isMarketHours(s.t)))) {
          const next = [...prev, s].slice(-MAX_SNAPS);
          writeSnaps(key, next);
          setSnaps(next);
        } else {
          setSnaps(prev);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "載入失敗");
      } finally {
        if (alive) setLoading(false);
      }
    };
    const tick = () => {
      if (document.visibilityState === "visible" && isMarketHours(Date.now())) void run();
    };
    void run();
    const id = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [symbol, reloadKey]);

  const go = (s: string) => {
    const v = s.trim().toUpperCase();
    if (!/^[0-9A-Z]{4,6}$/.test(v)) { setError("代號格式不正確(4–6 碼英數)"); return; }
    setInput(v);
    setAnalysis(null);
    setError(null);
    setWarn(null);
    setSnaps([]);
    setBaseSel("auto");
    setSymbol(v);
    setReloadKey((k) => k + 1);
    window.history.replaceState(null, "", `/intraday?symbol=${v}`);
  };

  const cur = analysis ? toSnapshot(analysis) : null;
  const base = useMemo(() => {
    if (!cur) return null;
    if (baseSel === "auto") return autoBase(snaps, cur);
    return snaps.find((s) => String(s.t) === baseSel) ?? autoBase(snaps, cur);
  }, [snaps, cur, baseSel]);
  const baseOptions = useMemo(() => {
    if (!cur) return [];
    const seen = new Set<string>();
    return snaps.filter((s) => s.t <= cur.t - 2 * 60_000).filter((s) => {
      const k = taipeiHM(s.t);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).reverse();
  }, [snaps, cur]);

  const open = analysis ? isMarketHours(analysis.fetchedAt) : isMarketHours(now);

  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <form
            onSubmit={(e) => { e.preventDefault(); go(input); }}
            className="flex items-center gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="輸入代號,如 4958"
              inputMode="text"
              aria-label="股票代號"
              className="w-40 rounded-xl border border-line bg-surface-2 px-3 py-2 font-mono text-sm outline-none focus:border-accent/60"
            />
            <button
              type="submit"
              className="rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-sm font-medium text-accent hover:bg-accent/15"
            >
              分析
            </button>
          </form>
          {symbol && (
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              aria-label="重新整理"
              className="inline-flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-sm text-slate-300 hover:bg-surface-2"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden />
              更新
            </button>
          )}
          <span className="ml-auto text-xs text-slate-500">
            {analysis
              ? `${open ? "盤中 · 每 30 秒自動更新" : "非盤中 · 顯示最後資料"} · 更新於 ${taipeiHM(analysis.fetchedAt)}(${Math.max(0, Math.round((now - analysis.fetchedAt) / 1000))} 秒前)`
              : ""}
          </span>
        </div>
        <QuickPicks title="持股" items={holdings} current={symbol} onPick={go} />
        <QuickPicks title="今日看多" items={verdict} current={symbol} onPick={go} />
      </header>

      {error && (
        <p role="alert" className="rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">
          {error}
        </p>
      )}

      {!symbol && (
        <p className="rounded-2xl border border-dashed border-line-strong p-10 text-center text-slate-400">
          輸入代號,或點上方持股 / 今日看多的股票,即可看到即時盤面、五檔、均線支撐與上方套牢區。
        </p>
      )}

      {symbol && !analysis && !error && (
        <p className="rounded-2xl border border-line p-10 text-center text-slate-400">載入 {symbol} …</p>
      )}

      {analysis && (
        <AnalysisView
          a={analysis}
          cur={cur}
          base={base}
          baseSel={baseSel}
          baseOptions={baseOptions}
          onBaseSel={setBaseSel}
          snapCount={snaps.length}
          warn={warn}
          snaps={snaps}
        />
      )}
    </div>
  );
}

function QuickPicks({
  title, items, current, onPick,
}: { title: string; items: QuickItem[]; current: string | null; onPick: (s: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-slate-500">{title}</span>
      {items.map((it) => (
        <button
          key={it.symbol}
          type="button"
          onClick={() => onPick(it.symbol)}
          className={`rounded-lg border px-2.5 py-1 text-xs ${
            current === it.symbol
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-line text-slate-300 hover:bg-surface-2"
          }`}
        >
          {it.name ?? it.symbol} <span className="font-mono text-slate-500">{it.symbol}</span>
        </button>
      ))}
    </div>
  );
}

function AnalysisView({
  a, cur, base, baseSel, baseOptions, onBaseSel, snapCount, warn, snaps,
}: {
  a: Analysis;
  cur: Snapshot | null;
  base: Snapshot | null;
  baseSel: string;
  baseOptions: Snapshot[];
  onBaseSel: (v: string) => void;
  snapCount: number;
  warn: string | null;
  snaps: Snapshot[];
}) {
  const q = a.quote;
  const price = q?.price ?? a.fallback?.price ?? null;
  const readings = [...(cur ? compareReadings(cur, base) : []), ...staticReadings(a)];
  const quoteLag = q?.quotedAt != null ? Math.round((a.fetchedAt - q.quotedAt) / 60000) : null;

  return (
    <div className="space-y-4">
      {q && warn && (
        <p role="status" className="rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">
          最新一次更新失敗({warn}),目前顯示 {taipeiHM(a.fetchedAt)} 的資料,下次輪詢會自動重試。
        </p>
      )}
      {!q && (
        <p role="alert" className="rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">
          即時五檔暫缺({a.quoteError})。{a.fallback
            ? `改顯示快取價 ${fmt(a.fallback.price)}(${taipeiHM(a.fallback.quotedAt)})。`
            : "且無快取價,以下只有日線資料。"}
        </p>
      )}

      <Card padded className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Link
            href={`/stocks/${a.symbol}`}
            className="inline-flex items-center gap-2 text-lg font-semibold hover:text-sky-300"
          >
            {a.name ?? a.symbol}
            <span className="font-mono text-sm font-normal text-slate-500">{a.symbol}</span>
            <ArrowUpRight size={16} aria-hidden />
          </Link>
          <div className="flex flex-wrap gap-2">
            {a.verdict && (
              <Badge tone="accent">
                今日看多 · {a.verdict.state === "block" ? "停止進場" : a.verdict.state === "ok" ? "可進場" : "觀察中"}
              </Badge>
            )}
            {a.holding && <Badge tone="neutral">持有 {a.holding.lots} 張</Badge>}
            {q?.priceIsMid && <Badge tone="neutral">無成交價 · 五檔中價</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className={`text-4xl font-medium tabular-nums ${pctColor(q?.chgPct)}`}>{fmtMoney(price, 2)}</span>
          <span className={`text-lg tabular-nums ${pctColor(q?.chgPct)}`}>{fmtPct(q?.chgPct)}</span>
          {quoteLag != null && quoteLag >= 2 && (
            <span className="text-xs text-slate-500">報價時間 {taipeiHM(q!.quotedAt!)},落後 {quoteLag} 分鐘</span>
          )}
        </div>
        {q && (
          <dl className="grid grid-cols-2 gap-3 border-t border-line pt-3 text-sm sm:grid-cols-5">
            {[
              ["開盤", fmt(q.open)], ["最高", fmt(q.hi)], ["最低", fmt(q.lo)], ["昨收", fmt(q.prev)],
              ["累積量", q.vol != null ? `${q.vol.toLocaleString()} 張` : "—"],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-slate-500">{k}</dt>
                <dd className="mt-0.5 tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="盤面對比"
          subtitle={base ? `基準 ${taipeiHM(base.t)} → 現在 ${taipeiHM(a.fetchedAt)}` : isMarketHours(a.fetchedAt) ? `累積快照中(${snapCount} 筆),約 2 分鐘後可比對` : "非盤中不累積快照;盤中開著此頁才會記錄走勢"}
          action={baseOptions.length > 0 ? (
            <select
              value={baseSel}
              onChange={(e) => onBaseSel(e.target.value)}
              aria-label="對比基準"
              className="rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs"
            >
              <option value="auto">約 10 分鐘前</option>
              {baseOptions.map((s) => (
                <option key={s.t} value={String(s.t)}>{taipeiHM(s.t)}</option>
              ))}
            </select>
          ) : undefined}
        >
          <Spark snaps={snaps} cur={cur} base={base} />
          <CompareTable cur={cur} base={base} />
        </Card>
        <Card title="五檔掛單" subtitle={q ? `委買 ${q.bidTot} 張 / 委賣 ${q.askTot} 張 · 買賣比 ${q.ratio != null ? q.ratio.toFixed(2) : "—"}(掛單可撤,僅供參考)` : undefined}>
          {q ? <OrderBook a={a} /> : <p className="text-sm text-slate-500">無五檔資料</p>}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="解讀">
          {readings.length ? (
            <ul className="space-y-2 text-sm leading-relaxed text-slate-300">
              {readings.map((r, i) => <li key={i}>· {r.text}</li>)}
            </ul>
          ) : <p className="text-sm text-slate-500">資料不足</p>}
        </Card>
        <Card title="價位階梯" subtitle="現價上下的關鍵價位(均線、今日高低、套牢密集區、系統價位)">
          <Ladder a={a} price={price} />
        </Card>
      </div>

      <Card title="操作參考" subtitle="既有系統規則換算,不是新的買賣訊號">
        {a.dataWarnings?.length ? <p role="alert" className="text-sm text-amber-200">{a.dataWarnings.join('；')}，相關分析受限。</p> : null}
        <Advice a={a} />
      </Card>
    </div>
  );
}

// 今日快照走勢(盤中開著頁面才會累積);基準點以空心圈標示
function Spark({ snaps, cur, base }: { snaps: Snapshot[]; cur: Snapshot | null; base: Snapshot | null }) {
  const pts = [...snaps];
  // 收盤後「現在」只是重抓最後資料,不併入走勢(否則時間軸被拉長成一條平線)
  if (cur && isMarketHours(cur.t) && (!pts.length || cur.t > pts[pts.length - 1].t)) pts.push(cur);
  if (pts.length < 3) return null;
  const W = 300, H = 56, pad = 3;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const lo = Math.min(...pts.map((p) => p.price)), hi = Math.max(...pts.map((p) => p.price));
  const sx = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * pad);
  const sy = (v: number) => H - pad - ((v - lo) / Math.max(1e-9, hi - lo)) * (H - 2 * pad);
  const last = pts[pts.length - 1];
  return (
    <figure className="mb-3">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-14 w-full" role="img"
        aria-label={`今日快照走勢 ${taipeiHM(t0)} 到 ${taipeiHM(t1)},價格 ${fmt(lo)} 到 ${fmt(hi)}`}>
        <polyline fill="none" stroke="currentColor" className="text-accent" strokeWidth="1.5" vectorEffect="non-scaling-stroke"
          points={pts.map((p) => `${sx(p.t).toFixed(1)},${sy(p.price).toFixed(1)}`).join(" ")} />
        {base && <circle cx={sx(base.t)} cy={sy(base.price)} r="3" fill="none" stroke="currentColor" className="text-slate-300" vectorEffect="non-scaling-stroke" />}
        <circle cx={sx(last.t)} cy={sy(last.price)} r="2.5" fill="currentColor" className="text-accent" />
      </svg>
      <figcaption className="mt-1 flex justify-between text-[11px] text-slate-500">
        <span>{taipeiHM(t0)} · {fmt(pts[0].price)}</span>
        <span>{pts.length} 筆快照 · 區間 {fmt(lo)}–{fmt(hi)}</span>
        <span>{taipeiHM(t1)} · {fmt(last.price)}</span>
      </figcaption>
    </figure>
  );
}

function CompareTable({ cur, base }: { cur: Snapshot | null; base: Snapshot | null }) {
  if (!cur) return <p className="text-sm text-slate-500">無報價</p>;
  const row = (label: string, b: string | null, c: string, d: string | null) => (
    <tr key={label} className="border-t border-line-soft">
      <td className="py-2 pr-3 text-slate-400">{label}</td>
      {base && <td className="py-2 pr-3 tabular-nums text-slate-300">{b ?? "—"}</td>}
      <td className="py-2 pr-3 tabular-nums">{c}</td>
      {base && <td className="py-2 text-right tabular-nums text-slate-400">{d ?? ""}</td>}
    </tr>
  );
  const diff = (x: number | null, y: number | null, unit = "") =>
    x == null || y == null ? null : `${y - x >= 0 ? "+" : ""}${fmt(y - x)}${unit}`;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-slate-500">
          <th className="pb-1 text-left font-normal">項目</th>
          {base && <th className="pb-1 text-left font-normal">{taipeiHM(base.t)}</th>}
          <th className="pb-1 text-left font-normal">{taipeiHM(cur.t)}</th>
          {base && <th className="pb-1 text-right font-normal">變化</th>}
        </tr>
      </thead>
      <tbody>
        {row("現價", base ? fmt(base.price) : null, fmt(cur.price), base ? diff(base.price, cur.price) : null)}
        {row("漲跌幅", base ? pctText(base.chgPct) : null, pctText(cur.chgPct), null)}
        {row("今日高 / 低", base ? `${fmt(base.hi)} / ${fmt(base.lo)}` : null, `${fmt(cur.hi)} / ${fmt(cur.lo)}`, null)}
        {row("累積量(張)", base?.vol != null ? base.vol.toLocaleString() : null, cur.vol != null ? cur.vol.toLocaleString() : "—", base ? diff(base.vol, cur.vol, " 張") : null)}
        {row("五檔買/賣比", base?.ratio != null ? base.ratio.toFixed(2) : null, cur.ratio != null ? cur.ratio.toFixed(2) : "—", null)}
      </tbody>
    </table>
  );
}

function OrderBook({ a }: { a: Analysis }) {
  const q = a.quote!;
  const max = Math.max(1, ...q.ask.map((l) => l.lots), ...q.bid.map((l) => l.lots));
  // 台股配色:買盤紅、賣盤綠
  const line = (price: number, lots: number, side: "ask" | "bid") => (
    <div key={`${side}${price}`} className="grid grid-cols-[3.5rem_3.5rem_1fr] items-center gap-2 py-0.5 text-sm tabular-nums">
      <span className={side === "bid" ? "text-up" : "text-down"}>{fmt(price)}</span>
      <span className="text-right text-slate-300">{lots}</span>
      <span className="h-2 rounded-sm bg-surface-2">
        <span
          className={`block h-2 rounded-sm ${side === "bid" ? "bg-up/60" : "bg-down/60"}`}
          style={{ width: `${(lots / max) * 100}%` }}
        />
      </span>
    </div>
  );
  return (
    <div>
      {[...q.ask].reverse().map((l) => line(l.price, l.lots, "ask"))}
      <div className="my-1 border-t border-line" />
      {q.bid.map((l) => line(l.price, l.lots, "bid"))}
    </div>
  );
}

interface LadderItem { price: number; hi?: number; label: string; kind: "now" | "ma" | "day" | "supply" | "stop" | "plan" }
const LADDER_STYLE: Record<LadderItem["kind"], string> = {
  now: "border-accent/50 bg-accent/10 text-accent",
  ma: "border-line text-sky-300",
  day: "border-line text-slate-300",
  supply: "border-amber-400/25 text-amber-200",
  stop: "border-line text-rose-300",
  plan: "border-line text-emerald-300",
};

function Ladder({ a, price }: { a: Analysis; price: number | null }) {
  if (price == null) return <p className="text-sm text-slate-500">無價格</p>;
  const items: LadderItem[] = [{ price, label: "現價", kind: "now" }];
  const q = a.quote, d = a.daily;
  if (q?.hi != null) items.push({ price: q.hi, label: "今日高", kind: "day" });
  if (q?.lo != null) items.push({ price: q.lo, label: "今日低", kind: "day" });
  if (d) {
    items.push({ price: d.ma5, label: "MA5", kind: "ma" }, { price: d.ma20, label: "MA20", kind: "ma" }, { price: d.ma60, label: "MA60", kind: "ma" });
  }
  for (const b of a.supply?.bins ?? [])
    items.push({ price: b.lo, hi: b.hi, label: `套牢密集 ${Math.round(b.lots).toLocaleString()} 張`, kind: "supply" });
  const kl = keyLevels(a);
  if (kl?.atrStop != null) items.push({ price: kl.atrStop, label: `ATR 停損參考(×${a.atrMultiple})`, kind: "stop" });
  if (a.verdict?.stopPrice != null) items.push({ price: a.verdict.stopPrice, label: "看多名單停損", kind: "stop" });
  if (a.verdict?.entryMin != null && a.verdict.entryMax != null)
    items.push({ price: a.verdict.entryMin, hi: a.verdict.entryMax, label: "看多名單進場區間", kind: "plan" });
  if (a.holding) items.push({ price: a.holding.avgCost, label: "持股均價", kind: "plan" });
  items.sort((x, y) => (y.hi ?? y.price) - (x.hi ?? x.price));
  return (
    <ol className="space-y-1.5">
      {items.map((it, i) => (
        <li
          key={i}
          className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-1.5 text-sm ${LADDER_STYLE[it.kind]}`}
        >
          <span>{it.label}</span>
          <span className="tabular-nums">
            {it.hi != null ? `${fmt(it.price)}–${fmt(it.hi)}` : fmt(it.price)}
            {it.kind !== "now" && (
              <span className="ml-2 text-xs text-slate-500">{pctText(((it.hi != null ? (it.price + it.hi) / 2 : it.price) / price - 1) * 100)}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Advice({ a }: { a: Analysis }) {
  const t = adviceText(a);
  return (
    <div className="grid gap-4 text-sm leading-relaxed text-slate-300 md:grid-cols-2">
      <div>
        <p className="mb-1 text-xs font-medium text-slate-500">沒有持股</p>
        <p>{t.flat}</p>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-slate-500">{t.heldLabel}</p>
        <ul className="space-y-1">
          {t.held.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      </div>
    </div>
  );
}
