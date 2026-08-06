import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { KLineChart, type OHLCV } from "@/app/_components/KLineChart";
import { fmtPct, pctColor } from "@/app/_components/Format";
import { PriceCell } from "@/app/_components/PriceCell";
import { FactorRadar, type FactorAxis } from "@/app/_components/FactorRadar";
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

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/rank"
          className="text-sm text-zinc-400 hover:text-zinc-200"
        >
          ← 回排名
        </Link>
      </div>

      <header className="rounded-2xl border border-line bg-surface-1 p-4">
        <div className="flex items-baseline gap-3">
          <h1 className="font-mono text-2xl font-semibold">{symbol}</h1>
          <span className="text-lg text-zinc-300">{meta.name ?? "—"}</span>
          {meta.industry && (
            <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
              {meta.industry}
            </span>
          )}
          {score != null && (
            <span className="ml-auto rounded bg-blue-900 px-2 py-1 text-sm font-semibold text-blue-100 tabular-nums">
              {score}/6
            </span>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <Stat
            label="現價"
            value={
              lp?.current_price != null ? (
                <PriceCell
                  value={lp.current_price}
                  isProvisional={lp.is_provisional}
                  date={lp.trade_date}
                  asOfTs={lp.as_of_ts}
                  source={lp.source}
                />
              ) : latest ? (
                <PriceCell
                  value={Number(latest.close)}
                  isProvisional={latest.is_provisional}
                  date={latest.trade_date}
                />
              ) : (
                <span>—</span>
              )
            }
          />
          <Stat label="5 日%" value={<span className={pctColor(pct5d)}>{fmtPct(pct5d)}</span>} />
          <Stat label="20 日%" value={<span className={pctColor(pct20d)}>{fmtPct(pct20d)}</span>} />
          <Stat
            label="K 線範圍"
            value={
              <span className="text-zinc-300 tabular-nums">
                {rows[0]?.trade_date ?? "—"} ~ {latest?.trade_date ?? "—"}
              </span>
            }
          />
        </div>
      </header>

      <section>
        <h2 className="mb-3 text-lg font-semibold">K 線(過去 ~90 天)</h2>
        <div className="rounded-xl border border-line bg-surface-raised p-2">
          <KLineChart data={ohlcv} />
        </div>
      </section>

      <ChipSection rows={(chipRows as ChipSeriesRow[] | null) ?? []} />

      <ValuationSection row={valuationRow as ValuationRow | null} />

      <FactorSection
        rank={factorRow as FactorRankRow | null}
        signal={entryRow as EntrySignalRow | null}
      />

      <NewsSection rows={(newsRows as NewsRow[] | null) ?? []} />
    </div>
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
      <section>
        <h2 className="mb-3 text-lg font-semibold">因子分析</h2>
        <p className="rounded-2xl border border-line bg-surface-1 p-4 text-sm text-zinc-500">
          尚未產生因子資料(可能 universe 還沒包含此股,或資料量不足 60 個交易日)
        </p>
      </section>
    );
  }

  const axes = buildFactorAxes(rank);
  const isEntry = signal?.is_entry_signal ?? false;
  const strength = signal?.signal_strength ?? "none";

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">因子分析</h2>
        <div className="text-sm text-zinc-400">
          排名 <span className="font-semibold text-zinc-200 tabular-nums">#{rank.expected_rank}</span>
          {" · "}
          總分{" "}
          <span className="font-semibold text-zinc-200 tabular-nums">
            {fmtScore(rank.weighted_score)}
          </span>
          {isEntry && (
            <span
              className={`ml-2 rounded px-2 py-0.5 text-xs font-semibold ${
                strength === "strong"
                  ? "bg-yellow-700 text-yellow-100"
                  : "bg-yellow-900 text-yellow-200"
              }`}
            >
              ⭐ 進場訊號 ({strength === "strong" ? "強" : "標準"})
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-4 rounded-2xl border border-line bg-surface-1 p-4 md:grid-cols-2">
        <div>
          <FactorRadar axes={axes} size={320} />
        </div>
        <div className="space-y-3 text-sm">
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
      <div className="flex items-baseline justify-between">
        <span className={color}>{label}</span>
        <span className="text-xs text-zinc-600">— 無資料</span>
      </div>
    );
  }
  const pct = (pos / total) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className={color}>{label}</span>
        <span className="text-xs tabular-nums text-zinc-400">
          {pos}/{total} ({pct.toFixed(0)}%)
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded bg-zinc-800">
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
    <details className="rounded border border-line bg-surface-sunken p-2 text-xs">
      <summary className="cursor-pointer text-zinc-400">逐項因子狀態</summary>
      <ul className="mt-2 grid grid-cols-2 gap-1">
        {axes.map((a) => (
          <li
            key={a.key}
            className={
              a.value === 1
                ? "text-green-400"
                : a.value === 0
                ? "text-zinc-500"
                : "text-zinc-600 italic"
            }
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
    <section>
      <h2 className="mb-3 text-lg font-semibold">即時新聞(Google News,每 6 小時更新)</h2>
      {rows.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface-1 p-4 text-sm text-zinc-500">
          尚無新聞,等下次 cron(UTC 0/6/12/18 = Taipei 8/14/20/02)抓回。
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((n, i) => (
            <li key={i} className="rounded-2xl border border-line bg-surface-1 px-3 py-2">
              <a
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-zinc-100 hover:text-blue-300 hover:underline"
              >
                {n.title}
              </a>
              <div className="mt-0.5 text-xs text-zinc-500">
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

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-0.5 text-base tabular-nums">{value}</div>
    </div>
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
      <section>
        <h2 className="mb-3 text-lg font-semibold">籌碼動向</h2>
        <p className="rounded-2xl border border-line bg-surface-1 p-6 text-center text-sm text-zinc-500">
          此標的近 120 天無籌碼資料（ETF 與部分上櫃股不在收料範圍）
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold">籌碼動向</h2>
      <p className="mb-3 text-xs text-zinc-500">
        近 120 天走勢。這是<span className="text-zinc-400">資訊呈現</span>
        ，不是買賣訊號——籌碼指標對個股的預測力本系統未做驗證。
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
              className="rounded-2xl border border-line bg-surface-1 p-3"
            >
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-zinc-300">
                  {meta.label}
                </span>
                <span className="text-[10px] text-zinc-600">{meta.hint}</span>
              </div>
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-base font-semibold tabular-nums text-zinc-100">
                  {shown.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-zinc-500">
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
              <div className="mt-1 flex justify-between text-[10px] text-zinc-600">
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
    <section>
      <h2 className="mb-1 text-lg font-semibold">估值位置</h2>
      <p className="mb-3 text-xs text-zinc-500">
        現值在自身歷史區間的相對位置。
        <span className="text-zinc-400">這不是買賣訊號</span>
        ——便宜可能是基本面轉壞，貴可能是成長被市場認可。
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
        <p className="mt-2 text-xs text-zinc-500">
          現金殖利率 <span className="tabular-nums text-zinc-300">{dy}%</span>
          <span className="ml-1 text-zinc-600">
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
    <div className="rounded-2xl border border-line bg-surface-1 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-zinc-300">{title}</span>
        <span className="text-base font-semibold tabular-nums text-zinc-100">
          {now != null ? now.toFixed(2) : "—"}
        </span>
      </div>

      {hasBand ? (
        <>
          <ValuationBar now={now} p20={p20} p50={p50} p80={p80} />
          <div className="mt-1 flex justify-between text-[10px] tabular-nums text-zinc-600">
            <span>低 {p20.toFixed(1)}</span>
            <span>中位 {p50.toFixed(1)}</span>
            <span>高 {p80.toFixed(1)}</span>
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            比樣本期內{" "}
            <span className="tabular-nums text-zinc-300">
              {pctile != null ? `${pctile}%` : "—"}
            </span>{" "}
            的交易日更貴
          </p>
        </>
      ) : (
        <p className="py-2 text-[11px] text-zinc-600">
          樣本不足（{n ?? 0} 筆，需 ≥{MIN_SAMPLE}），不計算分位
        </p>
      )}

      <p className="mt-1 text-[10px] text-zinc-600">
        樣本 {n ?? 0} 個交易日{since ? `，自 ${since}` : ""}
      </p>
    </div>
  );
}
