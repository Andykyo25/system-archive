import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fmtMoney, fmtPct, pctColor } from "@/app/_components/Format";

export const dynamic = "force-dynamic";

interface RankRow {
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
  fund_score_pct: number | string | null;
  mom_score_pct: number | string | null;
  rev_score_pct: number | string | null;
  chip_score_pct: number | string | null;
  latest_close: number | string | null;
  latest_date: string | null;
  ret_20d_pct: number | string | null;
  rsi14: number | string | null;
  off_high_60d_pct: number | string | null;
}

interface SignalRow {
  symbol: string;
  is_entry_signal: boolean;
  signal_strength: "strong" | "normal" | "none" | "insufficient_data";
}

interface NameMap {
  [symbol: string]: string | null;
}

export default async function RankPage() {
  const sb = createClient();

  const [{ data: ranks }, { data: signals }] = await Promise.all([
    sb
      .from("v_stock_rank")
      .select("*")
      .order("expected_rank", { ascending: true })
      .limit(30),
    sb.from("v_entry_signal").select("symbol, is_entry_signal, signal_strength"),
  ]);

  const rankRows = (ranks as RankRow[] | null) ?? [];
  const signalRows = (signals as SignalRow[] | null) ?? [];
  const signalMap = new Map<string, SignalRow>(
    signalRows.map((s) => [s.symbol, s] as const),
  );
  const entryCount = signalRows.filter((s) => s.is_entry_signal).length;

  // 拉 name (industry_stocks + stock_universe + etf_metadata)
  const symbols = rankRows.map((r) => r.symbol);
  const nameMap: NameMap = {};
  if (symbols.length > 0) {
    const [is, su, em] = await Promise.all([
      sb.from("industry_stocks").select("symbol, name").in("symbol", symbols),
      sb.from("stock_universe").select("symbol, name").in("symbol", symbols),
      sb.from("etf_metadata").select("symbol, name").in("symbol", symbols),
    ]);
    for (const r of (em.data as { symbol: string; name: string | null }[] | null) ?? []) {
      if (r.name) nameMap[r.symbol] = r.name;
    }
    for (const r of (su.data as { symbol: string; name: string | null }[] | null) ?? []) {
      if (!nameMap[r.symbol] && r.name) nameMap[r.symbol] = r.name;
    }
    for (const r of (is.data as { symbol: string; name: string | null }[] | null) ?? []) {
      if (!nameMap[r.symbol] && r.name) nameMap[r.symbol] = r.name;
    }
  }

  return (
    <div className="space-y-6">
      <header className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold">多因子排名 (Top 30)</h1>
          <div className="text-sm text-zinc-400">
            進場訊號 (
            <span className="text-yellow-400">⭐</span>):
            <span className="ml-1 font-semibold text-yellow-300 tabular-nums">{entryCount}</span>{" "}
            檔
          </div>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          權重:基本面 50% / 動能 25% / 反轉 15% / 籌碼 10%。
          資料缺維度時權重 reallocate 給其他維度。
          M8 籌碼資料尚需 cron 累積,若該維度全空,訊號條件會放寬。
        </p>
      </header>

      {rankRows.length === 0 ? (
        <EmptyState />
      ) : (
        <RankTable rows={rankRows} nameMap={nameMap} signalMap={signalMap} />
      )}

      <Legend />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center">
      <p className="text-zinc-400">尚無排名資料</p>
      <p className="mt-2 text-sm text-zinc-500">
        確認 stock_universe 已 seed,且 price_daily 有近 60 日資料(M9 動能因子需要 60d MA)
      </p>
    </div>
  );
}

function RankTable({
  rows,
  nameMap,
  signalMap,
}: {
  rows: RankRow[];
  nameMap: NameMap;
  signalMap: Map<string, SignalRow>;
}) {
  return (
    <section>
      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-right">#</th>
              <th className="px-3 py-2">股號</th>
              <th className="px-3 py-2">名稱</th>
              <th className="px-3 py-2 text-right">總分</th>
              <th className="px-3 py-2 text-right">基本面</th>
              <th className="px-3 py-2 text-right">動能</th>
              <th className="px-3 py-2 text-right">反轉</th>
              <th className="px-3 py-2 text-right">籌碼</th>
              <th className="px-3 py-2 text-right">現價</th>
              <th className="px-3 py-2 text-right">20 日%</th>
              <th className="px-3 py-2 text-right">RSI14</th>
              <th className="px-3 py-2 text-right">距 60d 高</th>
              <th className="px-3 py-2 text-center">訊號</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const sig = signalMap.get(r.symbol);
              const isEntry = sig?.is_entry_signal ?? false;
              const strength = sig?.signal_strength ?? "none";
              return (
                <tr
                  key={r.symbol}
                  className={`border-t border-zinc-800 ${isEntry ? "bg-yellow-950/15" : ""}`}
                >
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                    {r.expected_rank}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    <Link
                      href={`/stocks/${r.symbol}`}
                      className="text-blue-400 hover:text-blue-300 hover:underline"
                    >
                      {r.symbol}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-zinc-300">{nameMap[r.symbol] ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-semibold">
                      {fmtPctValue(r.weighted_score)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <DimensionCell
                      pos={r.fund_count_pos}
                      total={r.fund_count_total}
                      pct={r.fund_score_pct}
                      color="text-blue-400"
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <DimensionCell
                      pos={r.mom_count_pos}
                      total={r.mom_count_total}
                      pct={r.mom_score_pct}
                      color="text-amber-400"
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <DimensionCell
                      pos={r.rev_count_pos}
                      total={r.rev_count_total}
                      pct={r.rev_score_pct}
                      color="text-violet-400"
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <DimensionCell
                      pos={r.chip_count_pos}
                      total={r.chip_count_total}
                      pct={r.chip_score_pct}
                      color="text-emerald-400"
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtMoney(r.latest_close, 2)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.ret_20d_pct)}`}>
                    {fmtPct(r.ret_20d_pct)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.rsi14, 1)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                    {fmtPct(toMaybeNeg(r.off_high_60d_pct))}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {isEntry ? (
                      <span
                        title={`進場訊號:${strength}`}
                        className={`text-lg ${
                          strength === "strong" ? "text-yellow-300" : "text-yellow-500"
                        }`}
                      >
                        ⭐
                      </span>
                    ) : (
                      <span className="text-zinc-700">·</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DimensionCell({
  pos,
  total,
  pct,
  color,
}: {
  pos: number;
  total: number;
  pct: number | string | null;
  color: string;
}) {
  if (total === 0) {
    return <span className="text-zinc-600">—</span>;
  }
  return (
    <span title={`${pos} / ${total} 通過 = ${fmtPctValue(pct)}`}>
      <span className={color}>{pos}</span>
      <span className="text-zinc-600">/{total}</span>
    </span>
  );
}

function fmtPctValue(n: string | number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

// off_high_60d_pct view 算的是「(high - close)/high」即正值表示折價,
// UI 慣例顯示為負值(距高點 -X%),所以反相
function toMaybeNeg(n: string | number | null | undefined): string | number | null {
  if (n == null) return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return -v;
}

function Legend() {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-400">
      <div className="mb-1 font-semibold text-zinc-300">因子說明</div>
      <ul className="grid grid-cols-1 gap-1 md:grid-cols-2">
        <li>
          <span className="text-blue-400">基本面 (6)</span>:EPS 連 4 季正 / EPS YoY+ / ROE&gt;15% /
          FCF+ / PEG&lt;1 / 月營收 YoY+
        </li>
        <li>
          <span className="text-amber-400">動能 (3)</span>:MA20&gt;MA60 黃金交叉 / 20 日 vs 60 日報酬加速 /
          RSI14&lt;70
        </li>
        <li>
          <span className="text-violet-400">反轉 (2)</span>:距 60 日高點折價&gt;10% / 5 日跌幅&gt;3% 且量縮
        </li>
        <li>
          <span className="text-emerald-400">籌碼 (4)</span>:法人 3 日買超 / 融資餘額減 / 借券減 /
          外資持股升
        </li>
      </ul>
      <div className="mt-2 text-zinc-500">
        進場訊號條件:基本面 ≥ 4/6 + 動能 ≥ 2/3 + 籌碼 ≥ 2/4(籌碼資料未到位時放寬)
      </div>
    </div>
  );
}
