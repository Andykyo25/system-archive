import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { KLineChart, type OHLCV } from "@/app/_components/KLineChart";
import { fmtMoney, fmtPct, pctColor } from "@/app/_components/Format";
import { PriceCell } from "@/app/_components/PriceCell";

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
              latest ? (
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
    </div>
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
