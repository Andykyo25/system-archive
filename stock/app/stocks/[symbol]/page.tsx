import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { KLineChart, type OHLCV } from "@/app/_components/KLineChart";
import { fmtPct, pctColor } from "@/app/_components/Format";
import { PriceCell } from "@/app/_components/PriceCell";
import { FactorRadar, type FactorAxis } from "@/app/_components/FactorRadar";

export const dynamic = "force-dynamic";

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
          href="/watchlist"
          className="text-sm text-zinc-400 hover:text-zinc-200"
        >
          ← 回產業列表
        </Link>
      </div>

      <header className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
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
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2">
          <KLineChart data={ohlcv} />
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          紅 K = 漲(台股慣例)· 底下副圖為成交量 · {rows.length} 筆資料
        </p>
      </section>

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
        <p className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-500">
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

      <div className="grid gap-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4 md:grid-cols-2">
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
  // M9.2 共 18 個軸:基本面 7 + 動能 4(加突破)+ 反轉 2 + 籌碼 5
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
    mk("fund_peg_low", "PEG<1.2", r.fund_peg_low, "fund"),
    mk("fund_rev_yoy", "月營收+", r.fund_rev_yoy, "fund"),
    mk("fund_gross_up", "毛利率升", r.fund_gross_up, "fund"),
    mk("mom_ma_golden", "黃金交叉", r.mom_ma_golden, "mom"),
    mk("mom_ret_diff", "動能加速", r.mom_ret_diff, "mom"),
    mk("mom_rsi_strong", "RSI>50", r.mom_rsi_strong, "mom"),
    mk("mom_breakout", "突破", r.mom_breakout, "mom"),
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
    <details className="rounded border border-zinc-800 bg-zinc-950 p-2 text-xs">
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
        <p className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-500">
          尚無新聞,等下次 cron(UTC 0/6/12/18 = Taipei 8/14/20/02)抓回。
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((n, i) => (
            <li key={i} className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
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
