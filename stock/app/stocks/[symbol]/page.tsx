import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Clock3,
  Database,
  Gauge,
  Layers3,
  Newspaper,
  Target,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { KLineChart, type OHLCV } from "@/app/_components/KLineChart";
import { fmtPct, formatPriceTimestamp, pctColor } from "@/app/_components/Format";
import { FactorRadar, type FactorAxis } from "@/app/_components/FactorRadar";
import { Badge } from "@/app/_components/ui";
import { StockPerformanceChart } from "@/app/_components/StockPerformanceChart";
import {
  Sparkline,
  SparkBars,
  ValuationBar,
  type ChipPoint,
} from "@/app/_components/ChipSparkline";

export const dynamic = "force-dynamic";

interface ChipSeriesRow {
  series_key: string;
  as_of: string;
  value: number | string;
}

interface ValuationRow {
  as_of: string | null;
  pe_now: number | string | null;
  pb_now: number | string | null;
  dividend_yield: number | string | null;
  pe_p20: number | string | null;
  pe_p50: number | string | null;
  pe_p80: number | string | null;
  pe_n: number | null;
  pe_since: string | null;
  pe_pctile: number | string | null;
  pb_p20: number | string | null;
  pb_p50: number | string | null;
  pb_p80: number | string | null;
  pb_n: number | null;
  pb_since: string | null;
  pb_pctile: number | string | null;
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

interface PriceStats {
  ma20: number | null;
  ma60: number | null;
  distMa20: number | null;
  distMa60: number | null;
  range20Position: number | null;
  high20: number | null;
  low20: number | null;
  maxDrawdown60: number | null;
  volumeRatio: number | null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculatePriceStats(rows: PriceRow[]): PriceStats {
  const closes = rows.map((row) => Number(row.close)).filter(Number.isFinite);
  const latest = closes.at(-1) ?? null;
  const close20 = closes.slice(-20);
  const close60 = closes.slice(-60);
  const ma20 = average(close20);
  const ma60 = close60.length >= 40 ? average(close60) : null;
  const high20 = close20.length > 0 ? Math.max(...close20) : null;
  const low20 = close20.length > 0 ? Math.min(...close20) : null;

  let maxDrawdown60: number | null = null;
  if (close60.length >= 2) {
    let peak = close60[0];
    let worst = 0;
    for (const close of close60) {
      peak = Math.max(peak, close);
      worst = Math.min(worst, ((close / peak) - 1) * 100);
    }
    maxDrawdown60 = worst;
  }

  const volumes = rows.map((row) => num(row.volume)).filter((value): value is number => value != null && value > 0);
  const volume5 = average(volumes.slice(-5));
  const volume20 = average(volumes.slice(-20));

  return {
    ma20,
    ma60,
    distMa20: latest != null && ma20 ? ((latest / ma20) - 1) * 100 : null,
    distMa60: latest != null && ma60 ? ((latest / ma60) - 1) * 100 : null,
    range20Position:
      latest != null && high20 != null && low20 != null && high20 !== low20
        ? ((latest - low20) / (high20 - low20)) * 100
        : null,
    high20,
    low20,
    maxDrawdown60,
    volumeRatio: volume5 != null && volume20 ? volume5 / volume20 : null,
  };
}

interface PriceRow {
  symbol: string;
  trade_date: string;
  open: number | string | null;
  high: number | string | null;
  low: number | string | null;
  close: number | string;
  volume: number | string | null;
  source: string;
  is_provisional: boolean;
}

interface StockMeta {
  symbol: string;
  name: string | null;
  industry: string | null;
}

export default async function StockDetailPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = await params;
  const sb = createClient();

  // 過去 ~90 天 OHLCV
  // Dynamic Server Component：每次 request 重新計算查詢起點，不進入 client render。
  // eslint-disable-next-line react-hooks/purity
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400 * 1000)
    .toISOString()
    .slice(0, 10);

  const [
    { data: priceRows },
    { data: industryRow },
    { data: etfRow },
    { data: scoreRow },
    { data: newsRows },
    { data: factorRow },
    { data: entryRow },
    { data: latestPriceRow },
    { data: chipRows },
    { data: valuationRow },
  ] = await Promise.all([
    sb
      .from("price_daily")
      .select(
        "symbol,trade_date,open,high,low,close,volume,source,is_provisional",
      )
      .eq("symbol", symbol)
      .gte("trade_date", ninetyDaysAgo)
      .order("trade_date", { ascending: true }),
    sb
      .from("industry_stocks")
      .select("symbol, name, industry, display_order")
      .eq("symbol", symbol)
      .order("display_order")
      .limit(1)
      .maybeSingle(),
    sb
      .from("etf_metadata")
      .select("symbol, name, category")
      .eq("symbol", symbol)
      .maybeSingle(),
    sb.from("v_industry_picks").select("*").eq("symbol", symbol).limit(1).maybeSingle(),
    sb
      .from("stock_news")
      .select("title, url, published_at, source")
      .eq("symbol", symbol)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(20),
    sb.from("v_stock_rank").select("*").eq("symbol", symbol).maybeSingle(),
    sb
      .from("v_entry_signal")
      .select("symbol, is_entry_signal, signal_strength, weighted_score, expected_rank")
      .eq("symbol", symbol)
      .maybeSingle(),
    sb
      .from("v_latest_price_realtime")
      .select("current_price, as_of_ts, trade_date, source, is_provisional")
      .eq("symbol", symbol)
      .maybeSingle(),
    // 籌碼時序(近 120 天長格式,前端分組畫 sparkline)
    sb
      .from("v_symbol_chip_series")
      .select("series_key, as_of, value")
      .eq("symbol", symbol)
      .order("as_of", { ascending: true }),
    // 估值分位帶(樣本量以 pe_n/pe_since 為準,UI 需誠實標註)
    sb
      .from("v_symbol_valuation_band")
      .select("*")
      .eq("symbol", symbol)
      .maybeSingle(),
  ]);

  const rows = (priceRows as PriceRow[] | null) ?? [];
  const meta: StockMeta = {
    symbol,
    name:
      (industryRow as StockMeta | null)?.name ??
      (etfRow as { name: string | null } | null)?.name ??
      null,
    industry:
      (industryRow as StockMeta | null)?.industry ??
      (etfRow as { category: string | null } | null)?.category ??
      null,
  };

  const ohlcv: OHLCV[] = rows.map((r) => ({
    time: r.trade_date,
    open: Number(r.open ?? r.close),
    high: Number(r.high ?? r.close),
    low: Number(r.low ?? r.close),
    close: Number(r.close),
    volume: r.volume == null ? undefined : Number(r.volume),
  }));

  const latest = rows[rows.length - 1];
  const score = (scoreRow as { score: number } | null)?.score;
  const pct5d = (scoreRow as { pct_5d: string | number | null } | null)?.pct_5d;
  const pct20d = (scoreRow as { pct_20d: string | number | null } | null)?.pct_20d;
  const lp = latestPriceRow as {
    current_price: number | string | null;
    as_of_ts: string | null;
    trade_date: string | null;
    source: string | null;
    is_provisional: boolean | null;
  } | null;
  const rank = factorRow as FactorRankRow | null;
  const signal = entryRow as EntrySignalRow | null;
  const priceStats = calculatePriceStats(rows);
  const realtimePrice = num(lp?.current_price);
  const livePrice = realtimePrice ?? num(latest?.close);
  const priceStamp = realtimePrice != null
    ? formatPriceTimestamp(lp?.as_of_ts, lp?.source, lp?.trade_date)
    : formatPriceTimestamp(null, null, latest?.trade_date);
  const priceIsProvisional = realtimePrice != null
    ? Boolean(lp?.is_provisional || priceStamp.provisional)
    : Boolean(latest?.is_provisional);
  const decision = decisionMeta(signal);
  const closePoints = ohlcv.map((point) => ({ time: point.time, close: point.close }));

  return (
    <div className="space-y-7 pb-4">
      <Link
        href="/rank"
        className="inline-flex items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-sky-300"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        回選股排名
      </Link>

      <header className="surface-card rounded-[1.75rem] p-5 sm:p-7">
        <div className="absolute -right-20 -top-28 h-72 w-72 rounded-full bg-sky-400/10 blur-3xl" aria-hidden="true" />
        <div className="relative grid gap-7 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.6fr)] xl:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">{meta.industry ?? "未分類"}</Badge>
              {priceIsProvisional && <Badge tone="warn">備援／暫定資料</Badge>}
              <span className="text-[11px] text-slate-600">日線樣本 {rows.length} 筆</span>
            </div>
            <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-2">
              <h1 className="font-mono text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">{symbol}</h1>
              <p className="pb-1 text-lg text-slate-300 sm:text-xl">{meta.name ?? "名稱資料待補"}</p>
            </div>
            <div className="mt-5 flex flex-wrap items-end gap-x-5 gap-y-2">
              <p className={`text-4xl font-semibold tracking-[-0.04em] tabular-nums sm:text-5xl ${priceIsProvisional ? "text-amber-300" : "text-white"}`}>
                {fmtPrice(livePrice)}
              </p>
              <div className="pb-1">
                <p className="flex items-center gap-1.5 text-xs text-slate-400" title={priceStamp.tooltip}>
                  <Clock3 size={13} aria-hidden="true" />
                  {priceStamp.text}
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-600">
                  <Database size={12} aria-hidden="true" />
                  {realtimePrice != null ? (lp?.source ?? "來源未標示") : (latest?.source ?? "來源未標示")}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-black/15 p-4 sm:p-5">
            <p className="eyebrow">模型狀態</p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xl font-semibold text-slate-100">{decision.title}</p>
              <Badge tone={decision.tone} className="px-2 py-1">{decision.label}</Badge>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">{decision.description}</p>
            <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-xs">
              <span className="text-slate-500">19 因子綜合排名</span>
              <span className="font-semibold tabular-nums text-slate-100">{rank?.expected_rank != null ? `#${rank.expected_rank}` : "—"}</span>
            </div>
          </div>
        </div>

        <div className="relative mt-7 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3 xl:grid-cols-5">
          <HeroMetric label="5 日漲跌" value={fmtPct(pct5d)} tone={pctColor(pct5d)} sub="短線價格變化" />
          <HeroMetric label="20 日漲跌" value={fmtPct(pct20d)} tone={pctColor(pct20d)} sub="中短期背景" />
          <HeroMetric
            label="20 日區間位置"
            value={priceStats.range20Position == null ? "—" : `${priceStats.range20Position.toFixed(0)}%`}
            sub={priceStats.low20 == null ? "樣本不足" : `${fmtPrice(priceStats.low20)} – ${fmtPrice(priceStats.high20)}`}
          />
          <HeroMetric
            label="60 日最大回撤"
            value={priceStats.maxDrawdown60 == null ? "—" : `${priceStats.maxDrawdown60.toFixed(1)}%`}
            tone={
              priceStats.maxDrawdown60 == null
                ? "text-slate-100"
                : priceStats.maxDrawdown60 <= -15
                  ? "text-red-300"
                  : priceStats.maxDrawdown60 <= -8
                    ? "text-amber-300"
                    : "text-slate-100"
            }
            sub="樣本期內峰谷跌幅"
          />
          <HeroMetric label="財務規則分" value={score == null ? "—" : `${score}/6`} sub="與 19 因子分開解讀" className="col-span-2 sm:col-span-1" />
        </div>
      </header>

      <nav className="sticky top-16 z-20 -mx-1 flex gap-1 overflow-x-auto rounded-2xl border border-line bg-[#09101b]/86 p-1.5 backdrop-blur-xl" aria-label="個股分析區段">
        {[
          ["#trend", "趨勢價格"],
          ["#factors", "因子分析"],
          ["#chips", "籌碼動向"],
          ["#valuation", "估值位置"],
          ["#news", "相關新聞"],
        ].map(([href, label]) => (
          <a key={href} href={href} className="shrink-0 rounded-xl px-3 py-2 text-xs text-slate-400 transition-colors hover:bg-white/5 hover:text-sky-200">
            {label}
          </a>
        ))}
      </nav>

      <section id="trend" className="section-anchor space-y-4">
        <SectionTitle
          icon={<BarChart3 size={18} />}
          eyebrow="Price action"
          title="趨勢與價格"
          description={`日線範圍 ${rows[0]?.trade_date ?? "—"} 至 ${latest?.trade_date ?? "—"}；即時價格另依頁首時間戳判讀。`}
        />
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(300px,0.7fr)]">
          <div className="surface-card min-w-0 rounded-3xl p-2 sm:p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-2 pt-1">
              <p className="text-sm font-medium text-slate-200">K 線與成交量</p>
              <Badge tone="neutral">布林通道 20, 2</Badge>
            </div>
            <KLineChart data={ohlcv} />
          </div>
          <TrendSnapshot stats={priceStats} latestClose={num(latest?.close)} />
        </div>
        <div className="surface-card rounded-3xl p-4 sm:p-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <p className="eyebrow">Relative performance</p>
              <h3 className="mt-1 text-base font-semibold text-slate-100">收盤價區間績效</h3>
            </div>
            <span className="text-[10px] text-slate-600">非盤中走勢</span>
          </div>
          <StockPerformanceChart data={closePoints} />
        </div>
      </section>

      <FactorSection rank={rank} signal={signal} />
      <ChipSection rows={(chipRows as ChipSeriesRow[] | null) ?? []} />
      <ValuationSection row={valuationRow as ValuationRow | null} />
      <NewsSection rows={(newsRows as NewsRow[] | null) ?? []} />
    </div>
  );
}

function decisionMeta(signal: EntrySignalRow | null): {
  title: string;
  label: string;
  description: string;
  tone: "warn" | "accent" | "neutral";
} {
  if (signal?.is_entry_signal && signal.signal_strength === "strong") {
    return {
      title: "多維度同步轉強",
      label: "強訊號",
      description: "多因子門檻已通過；仍需確認即時成交價、部位大小與停損空間。",
      tone: "warn",
    };
  }
  if (signal?.is_entry_signal) {
    return {
      title: "條件達標，可續看",
      label: "標準訊號",
      description: "模型已通過基本門檻，請再檢查趨勢位置、資料時效與個人風險預算。",
      tone: "accent",
    };
  }
  if (signal?.signal_strength === "insufficient_data") {
    return {
      title: "資料尚不足",
      label: "待累積",
      description: "部分因子尚無足夠樣本，不以缺值推論方向；可先查看已有的價格與籌碼資料。",
      tone: "neutral",
    };
  }
  return {
    title: "尚未觸發進場門檻",
    label: "觀察中",
    description: "目前沒有同時通過全部門檻；下方可直接查看是哪個維度仍有缺口。",
    tone: "neutral",
  };
}

function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function HeroMetric({
  label,
  value,
  sub,
  tone = "text-slate-100",
  className = "",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: string;
  className?: string;
}) {
  return (
    <div className={`bg-[#0b121e]/88 p-3.5 sm:p-4 ${className}`}>
      <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-600">{label}</p>
      <p className={`mt-1.5 text-lg font-semibold tabular-nums ${tone}`}>{value}</p>
      <p className="mt-0.5 truncate text-[10px] text-slate-600">{sub}</p>
    </div>
  );
}

function SectionTitle({
  icon,
  eyebrow,
  title,
  description,
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-sky-300/15 bg-sky-400/10 text-sky-300">
        {icon}
      </span>
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="mt-0.5 text-lg font-semibold text-slate-100">{title}</h2>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">{description}</p>
      </div>
    </div>
  );
}

function TrendSnapshot({ stats, latestClose }: { stats: PriceStats; latestClose: number | null }) {
  const items = [
    {
      label: "相對 20 日均線",
      value: stats.distMa20 == null ? "—" : fmtPct(stats.distMa20),
      tone: pctColor(stats.distMa20),
      hint: stats.ma20 == null ? "樣本不足" : `MA20 ${fmtPrice(stats.ma20)}`,
    },
    {
      label: "相對 60 日均線",
      value: stats.distMa60 == null ? "—" : fmtPct(stats.distMa60),
      tone: pctColor(stats.distMa60),
      hint: stats.ma60 == null ? "樣本不足" : `MA60 ${fmtPrice(stats.ma60)}`,
    },
    {
      label: "近 5 日均量／20 日",
      value: stats.volumeRatio == null ? "—" : `${stats.volumeRatio.toFixed(2)}×`,
      tone: stats.volumeRatio != null && stats.volumeRatio >= 1.2 ? "text-amber-300" : "text-slate-100",
      hint: "僅表示量能活躍度",
    },
  ];

  return (
    <aside className="surface-card rounded-3xl p-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="eyebrow">Trend snapshot</p>
          <h3 className="mt-1 text-base font-semibold text-slate-100">技術面快照</h3>
        </div>
        <Gauge size={20} className="text-sky-300" aria-hidden="true" />
      </div>

      <div className="mt-5 space-y-3">
        {items.map((item) => (
          <div key={item.label} className="rounded-2xl border border-line bg-black/10 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-slate-400">{item.label}</span>
              <span className={`text-sm font-semibold tabular-nums ${item.tone}`}>{item.value}</span>
            </div>
            <p className="mt-1 text-[10px] text-slate-600">{item.hint}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-2xl border border-line bg-black/10 p-3">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-400">20 日價格位置</span>
          <span className="tabular-nums text-slate-200">{stats.range20Position == null ? "—" : `${stats.range20Position.toFixed(0)}%`}</span>
        </div>
        <div className="relative mt-3 h-1.5 rounded-full bg-slate-800">
          <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-emerald-400 via-sky-400 to-red-400" style={{ width: "100%" }} />
          {stats.range20Position != null && (
            <span
              className="absolute top-1/2 h-3.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_10px_rgba(255,255,255,0.65)]"
              style={{ left: `${Math.max(0, Math.min(100, stats.range20Position))}%` }}
            />
          )}
        </div>
        <div className="mt-2 flex justify-between text-[10px] text-slate-600">
          <span>{fmtPrice(stats.low20)}</span>
          <span>日線收盤 {fmtPrice(latestClose)}</span>
          <span>{fmtPrice(stats.high20)}</span>
        </div>
      </div>
    </aside>
  );
}

interface FactorRankRow {
  symbol: string;
  weighted_score: number | string | null;
  expected_rank: number;
  fund_count_pos: number;
  fund_count_total: number;
  mom_count_pos: number;
  mom_count_total: number;
  rev_count_pos: number;
  rev_count_total: number;
  chip_count_pos: number;
  chip_count_total: number;
  fund_eps_pos: number | null;
  fund_eps_yoy: number | null;
  fund_roe_high: number | null;
  fund_fcf_pos: number | null;
  fund_peg_low: number | null;
  fund_rev_yoy: number | null;
  fund_gross_up: number | null;
  mom_ma_golden: number | null;
  mom_ret_diff: number | null;
  mom_rsi_strong: number | null;
  mom_breakout: number | null;
  mom_above_ma200: number | null;
  rev_off_high: number | null;
  rev_vol_dry: number | null;
  chip_foreign_3d_buy: number | null;
  chip_margin_drop: number | null;
  chip_lending_drop: number | null;
  chip_share_concentrate: number | null;
  chip_inst_concentration: number | null;
}

interface EntrySignalRow {
  is_entry_signal: boolean;
  signal_strength: "strong" | "normal" | "none" | "insufficient_data";
  weighted_score: number | string | null;
  expected_rank: number;
}

function FactorSection({
  rank,
  signal,
}: {
  rank: FactorRankRow | null;
  signal: EntrySignalRow | null;
}) {
  if (!rank) {
    return (
      <section id="factors" className="section-anchor space-y-4">
        <SectionTitle
          icon={<Target size={18} />}
          eyebrow="Factor model"
          title="19 因子分析"
          description="維持原模型權重，將基本面、動能、反轉與籌碼拆開呈現。"
        />
        <p className="surface-card rounded-3xl p-6 text-sm text-slate-500">
          尚未產生因子資料(可能 universe 還沒包含此股,或資料量不足 60 個交易日)
        </p>
      </section>
    );
  }

  const axes = buildFactorAxes(rank);
  const isEntry = signal?.is_entry_signal ?? false;
  const strength = signal?.signal_strength ?? "none";

  return (
    <section id="factors" className="section-anchor space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionTitle
          icon={<Target size={18} />}
          eyebrow="Factor model"
          title="19 因子分析"
          description="四個維度分開閱讀；總分與進場門檻沿用原模型，不因新版介面調整。"
        />
        <div className="flex items-center gap-2">
          <Badge tone="neutral">排名 #{rank.expected_rank}</Badge>
          <Badge tone="accent">總分 {fmtScore(rank.weighted_score)}</Badge>
          {isEntry && <Badge tone={strength === "strong" ? "warn" : "accent"}>{strength === "strong" ? "強訊號" : "標準訊號"}</Badge>}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.2fr)]">
        <div className="surface-card rounded-3xl p-4 sm:p-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <p className="eyebrow">Factor footprint</p>
              <h3 className="mt-1 text-sm font-semibold text-slate-100">全因子輪廓</h3>
            </div>
            <Layers3 size={19} className="text-violet-300" aria-hidden="true" />
          </div>
          <div className="mx-auto max-w-[390px]">
            <FactorRadar axes={axes} size={340} />
          </div>
          <p className="text-center text-[10px] leading-relaxed text-slate-600">
            外圈代表通過；中心代表未通過；灰點為資料不足。
          </p>
        </div>

        <div className="surface-card rounded-3xl p-4 sm:p-5">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <p className="eyebrow">Dimension score</p>
              <h3 className="mt-1 text-sm font-semibold text-slate-100">維度通過率</h3>
            </div>
            <p className="text-[10px] text-slate-600">通過數／有效因子數</p>
          </div>
          <div className="space-y-4 text-sm">
          <DimRow
            label="基本面"
            pos={rank.fund_count_pos}
            total={rank.fund_count_total}
            color="text-blue-400"
            barClass="bg-blue-400"
          />
          <DimRow
            label="動能"
            pos={rank.mom_count_pos}
            total={rank.mom_count_total}
            color="text-amber-400"
            barClass="bg-amber-400"
          />
          <DimRow
            label="反轉"
            pos={rank.rev_count_pos}
            total={rank.rev_count_total}
            color="text-violet-400"
            barClass="bg-violet-400"
          />
          <DimRow
            label="籌碼"
            pos={rank.chip_count_pos}
            total={rank.chip_count_total}
            color="text-emerald-400"
            barClass="bg-emerald-400"
          />
          </div>
          <FactorList axes={axes} />
        </div>
      </div>
    </section>
  );
}

function buildFactorAxes(r: FactorRankRow): FactorAxis[] {
  // M9.3 共 19 個軸:基本面 7 + 動能 5(加突破 + 站上 MA200)+ 反轉 2 + 籌碼 5
  const mk = (key: string, label: string, v: number | null, group: FactorAxis["group"]): FactorAxis => ({
    key,
    label,
    value: v === 1 ? 1 : v === 0 ? 0 : null,
    group,
  });
  return [
    mk("fund_eps_pos", "EPS 連正", r.fund_eps_pos, "fund"),
    mk("fund_eps_yoy", "EPS YoY", r.fund_eps_yoy, "fund"),
    mk("fund_roe_high", "ROE>10%", r.fund_roe_high, "fund"),
    mk("fund_fcf_pos", "FCF+", r.fund_fcf_pos, "fund"),
    mk("fund_peg_low", "PEG<1.5", r.fund_peg_low, "fund"),
    mk("fund_rev_yoy", "月營收+", r.fund_rev_yoy, "fund"),
    mk("fund_gross_up", "毛利率升", r.fund_gross_up, "fund"),
    mk("mom_ma_golden", "黃金交叉", r.mom_ma_golden, "mom"),
    mk("mom_ret_diff", "動能加速", r.mom_ret_diff, "mom"),
    mk("mom_rsi_strong", "RSI>50", r.mom_rsi_strong, "mom"),
    mk("mom_breakout", "突破", r.mom_breakout, "mom"),
    mk("mom_above_ma200", "站上MA200", r.mom_above_ma200, "mom"),
    mk("rev_off_high", "深蹲", r.rev_off_high, "rev"),
    mk("rev_vol_dry", "量縮跌", r.rev_vol_dry, "rev"),
    mk("chip_foreign_3d_buy", "法人3日買", r.chip_foreign_3d_buy, "chip"),
    mk("chip_margin_drop", "融資減", r.chip_margin_drop, "chip"),
    mk("chip_lending_drop", "借券減", r.chip_lending_drop, "chip"),
    mk("chip_share_concentrate", "外資升", r.chip_share_concentrate, "chip"),
    mk("chip_inst_concentration", "法人集中", r.chip_inst_concentration, "chip"),
  ];
}

function DimRow({
  label,
  pos,
  total,
  color,
  barClass,
}: {
  label: string;
  pos: number;
  total: number;
  color: string;
  barClass: string;
}) {
  if (total === 0) {
    return (
      <div className="rounded-2xl border border-line bg-black/10 p-3">
        <div className="flex items-baseline justify-between">
          <span className={`font-medium ${color}`}>{label}</span>
          <span className="text-xs text-slate-600">— 無資料</span>
        </div>
      </div>
    );
  }
  const pct = (pos / total) * 100;
  return (
    <div className="rounded-2xl border border-line bg-black/10 p-3">
      <div className="flex items-baseline justify-between">
        <span className={`font-medium ${color}`}>{label}</span>
        <span className="text-xs tabular-nums text-slate-400">
          {pos}/{total} ({pct.toFixed(0)}%)
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded ${barClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function FactorList({ axes }: { axes: FactorAxis[] }) {
  return (
    <details className="mt-4 rounded-2xl border border-line bg-surface-sunken p-3 text-xs">
      <summary className="cursor-pointer select-none font-medium text-slate-400 hover:text-slate-200">展開 19 項因子明細</summary>
      <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {axes.map((a) => (
          <li
            key={a.key}
            className={`rounded-lg border border-line-soft px-2 py-1.5 ${
              a.value === 1
                ? "bg-emerald-400/5 text-emerald-300"
                : a.value === 0
                ? "bg-black/10 text-slate-500"
                : "bg-black/10 text-slate-600 italic"
            }`}
          >
            {a.value === 1 ? "✓" : a.value === 0 ? "✗" : "?"} {a.label}
          </li>
        ))}
      </ul>
    </details>
  );
}

function fmtScore(n: string | number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

interface NewsRow {
  title: string;
  url: string;
  published_at: string | null;
  source: string | null;
}

function NewsSection({ rows }: { rows: NewsRow[] }) {
  return (
    <section id="news" className="section-anchor space-y-4">
      <SectionTitle
        icon={<Newspaper size={18} />}
        eyebrow="News monitor"
        title="相關新聞"
        description="Google News 排程每 6 小時抓取；每則新聞仍以原始發布時間與來源為準。"
      />
      {rows.length === 0 ? (
        <p className="surface-card rounded-3xl p-6 text-sm text-slate-500">
          尚無新聞,等下次 cron(UTC 0/6/12/18 = Taipei 8/14/20/02)抓回。
        </p>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {rows.map((n, i) => (
            <li key={i} className="surface-card group rounded-2xl px-4 py-3">
              <a
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="line-clamp-2 text-sm leading-relaxed text-slate-200 transition-colors group-hover:text-sky-200"
              >
                {n.title}
              </a>
              <div className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-600">
                <Clock3 size={11} aria-hidden="true" />
                {n.published_at
                  ? new Date(n.published_at).toLocaleString("zh-TW", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })
                  : "—"}
                {n.source ? `　·　${n.source}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── 籌碼時序(2026-07-22)──────────────────────────────────────────
// 動機:籌碼 4 表原本只被壓成 v_chip_factors 的布林燈號(過/不過),
//   看不到「往哪個方向走、走多久了」。這裡把原始時序攤開。
// 單位處理:法人淨買賣 FinMind 給的是股數 → /1000 換算成張(台股慣用);
//   融資餘額 FinMind 定義即為張;借券量單位不明確故不標單位(寧可不標也不標錯)。
const CHIP_META: Record<
  string,
  { label: string; hint: string; kind: "bars" | "line"; stroke: string; unit: string; divide: number }
> = {
  inst_net: {
    label: "三大法人淨買賣",
    hint: "紅=買超 綠=賣超",
    kind: "bars",
    stroke: "#f87171",
    unit: " 張",
    divide: 1000,
  },
  margin_balance: {
    label: "融資餘額",
    hint: "升=散戶加槓桿",
    kind: "line",
    stroke: "#fbbf24",
    unit: " 張",
    divide: 1,
  },
  lending_volume: {
    label: "借券賣出量",
    hint: "升=空方增溫",
    kind: "line",
    stroke: "#a78bfa",
    unit: "",
    divide: 1,
  },
  foreign_ratio: {
    label: "外資持股比",
    hint: "週更",
    kind: "line",
    stroke: "#60a5fa",
    unit: "%",
    divide: 1,
  },
};

const CHIP_ORDER = ["inst_net", "margin_balance", "lending_volume", "foreign_ratio"];

function ChipSection({ rows }: { rows: ChipSeriesRow[] }) {
  const grouped: Record<string, ChipPoint[]> = {};
  for (const r of rows) {
    const v = num(r.value);
    if (v == null) continue;
    (grouped[r.series_key] ??= []).push({ as_of: r.as_of, value: v });
  }

  const available = CHIP_ORDER.filter((k) => (grouped[k]?.length ?? 0) >= 2);
  if (available.length === 0) {
    return (
      <section id="chips" className="section-anchor space-y-4">
        <SectionTitle
          icon={<Activity size={18} />}
          eyebrow="Positioning flow"
          title="籌碼動向"
          description="近 120 天法人、融資、借券與外資持股序列；只呈現方向，不直接推論買賣。"
        />
        <p className="surface-card rounded-3xl p-6 text-center text-sm text-slate-500">
          此標的近 120 天無籌碼資料（ETF 與部分上櫃股不在收料範圍）
        </p>
      </section>
    );
  }

  return (
    <section id="chips" className="section-anchor space-y-4">
      <SectionTitle
        icon={<Activity size={18} />}
        eyebrow="Positioning flow"
        title="籌碼動向"
        description="近 120 天序列。紅綠依台股慣例顯示；這些指標的個股預測力尚未經本系統驗證。"
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {available.map((key) => {
          const meta = CHIP_META[key];
          const pts = grouped[key];
          const last = pts[pts.length - 1];
          const first = pts[0];
          const delta = last.value - first.value;
          const shown = last.value / meta.divide;
          return (
            <div
              key={key}
              className="surface-card rounded-3xl p-4"
            >
              <div className="mb-3 flex items-start justify-between gap-2">
                <span className="text-xs font-medium text-slate-300">
                  {meta.label}
                </span>
                <span className="rounded-lg border border-line bg-black/10 px-1.5 py-0.5 text-[9px] text-slate-600">{meta.hint}</span>
              </div>
              <div className="mb-3 flex items-baseline gap-2">
                <span className="text-xl font-semibold tracking-tight tabular-nums text-slate-100">
                  {shown.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}
                  <span className="ml-1 text-[10px] font-normal text-slate-500">
                    {meta.unit}
                  </span>
                </span>
                {key !== "inst_net" && (
                  <span
                    className={`text-[11px] tabular-nums ${
                      delta > 0 ? "text-up" : delta < 0 ? "text-down" : "text-flat"
                    }`}
                  >
                    {delta > 0 ? "▲" : delta < 0 ? "▼" : "―"}{" "}
                    {Math.abs(delta / meta.divide).toLocaleString("zh-TW", {
                      maximumFractionDigits: 2,
                    })}
                  </span>
                )}
              </div>
              {meta.kind === "bars" ? (
                <SparkBars points={pts} />
              ) : (
                <Sparkline points={pts} stroke={meta.stroke} />
              )}
              <div className="mt-2 flex justify-between text-[9px] text-slate-600">
                <span>{first.as_of}</span>
                <span>{pts.length} 筆</span>
                <span>{last.as_of}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── 估值分位帶(2026-07-22)────────────────────────────────────────
// ⚠ 樣本量誠實揭露:stock_pe_pb_daily 對多數個股是 2026-05 才開始收(約 50 個交易日),
//   不是 3 年。view 窗口設 3 年讓資料累積後自動變準,但 UI 一律顯示實際樣本數與起始日。
//   樣本 < MIN_SAMPLE 直接不畫分位帶,只顯示現值(L23 精神:資料不足就別假裝可評)。
const MIN_SAMPLE = 30;

function ValuationSection({ row }: { row: ValuationRow | null }) {
  if (!row) return null;
  const peNow = num(row.pe_now);
  const pbNow = num(row.pb_now);
  const dy = num(row.dividend_yield);
  if (peNow == null && pbNow == null) return null;

  return (
    <section id="valuation" className="section-anchor space-y-4">
      <SectionTitle
        icon={<Gauge size={18} />}
        eyebrow="Valuation context"
        title="估值位置"
        description="只和此標的實際可用樣本比較；便宜不等於低風險，昂貴也不必然代表高估。"
      />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ValuationCard
          title="本益比 PE"
          now={peNow}
          p20={num(row.pe_p20)}
          p50={num(row.pe_p50)}
          p80={num(row.pe_p80)}
          n={row.pe_n}
          since={row.pe_since}
          pctile={num(row.pe_pctile)}
        />
        <ValuationCard
          title="股價淨值比 PB"
          now={pbNow}
          p20={num(row.pb_p20)}
          p50={num(row.pb_p50)}
          p80={num(row.pb_p80)}
          n={row.pb_n}
          since={row.pb_since}
          pctile={num(row.pb_pctile)}
        />
      </div>
      {dy != null && dy > 0 && (
        <p className="rounded-2xl border border-line bg-surface-1 px-4 py-3 text-xs text-slate-500">
          現金殖利率 <span className="font-semibold tabular-nums text-slate-200">{dy}%</span>
          <span className="ml-1 text-slate-600">
            （{row.as_of ?? "—"}）
          </span>
        </p>
      )}
    </section>
  );
}

function ValuationCard({
  title,
  now,
  p20,
  p50,
  p80,
  n,
  since,
  pctile,
}: {
  title: string;
  now: number | null;
  p20: number | null;
  p50: number | null;
  p80: number | null;
  n: number | null;
  since: string | null;
  pctile: number | null;
}) {
  const hasBand =
    now != null && p20 != null && p50 != null && p80 != null && (n ?? 0) >= MIN_SAMPLE;

  return (
    <div className="surface-card rounded-3xl p-4 sm:p-5">
      <div className="mb-4 flex items-baseline justify-between gap-2">
        <div>
          <p className="eyebrow">Historical band</p>
          <span className="mt-1 block text-sm font-medium text-slate-300">{title}</span>
        </div>
        <span className="text-2xl font-semibold tracking-tight tabular-nums text-slate-100">
          {now != null ? now.toFixed(2) : "—"}
        </span>
      </div>

      {hasBand ? (
        <>
          <ValuationBar now={now} p20={p20} p50={p50} p80={p80} />
          <div className="mt-2 flex justify-between text-[10px] tabular-nums text-slate-600">
            <span>低 {p20.toFixed(1)}</span>
            <span>中位 {p50.toFixed(1)}</span>
            <span>高 {p80.toFixed(1)}</span>
          </div>
          <p className="mt-4 rounded-xl border border-line bg-black/10 px-3 py-2 text-[11px] text-slate-500">
            比樣本期內{" "}
            <span className="font-semibold tabular-nums text-slate-200">
              {pctile != null ? `${pctile}%` : "—"}
            </span>{" "}
            的交易日更貴
          </p>
        </>
      ) : (
        <p className="rounded-xl border border-amber-400/10 bg-amber-400/5 px-3 py-4 text-[11px] text-amber-300/70">
          樣本不足（{n ?? 0} 筆，需 ≥{MIN_SAMPLE}），不計算分位
        </p>
      )}

      <p className="mt-3 text-[10px] text-slate-600">
        樣本 {n ?? 0} 個交易日{since ? `，自 ${since}` : ""}
      </p>
    </div>
  );
}
