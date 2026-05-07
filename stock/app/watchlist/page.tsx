import { createClient } from "@/lib/supabase/server";
import { fmtPct, pctColor } from "../_components/Format";
import { PriceCell } from "../_components/PriceCell";

export const dynamic = "force-dynamic";

interface IndustryQuote {
  id: number;
  industry: string;
  symbol: string;
  name: string | null;
  display_order: number;
  current_price: string | number | null;
  trade_date: string | null;
  is_provisional: boolean | null;
  close_5d_ago: string | number | null;
  close_20d_ago: string | number | null;
  pct_5d: string | number | null;
  pct_20d: string | number | null;
}

// 產業顯示順序(技術股優先,傳產次之,金融最後)
const SECTOR_ORDER = [
  "半導體封測",
  "記憶體",
  "IC設計",
  "被動元件",
  "AI伺服器",
  "車用電動車",
  "面板",
  "航運",
  "生技",
  "金融",
];

export default async function WatchlistPage() {
  const sb = createClient();
  const { data } = await sb.from("v_industry_quotes").select("*");
  const rows = (data as IndustryQuote[] | null) ?? [];

  const grouped = new Map<string, IndustryQuote[]>();
  for (const r of rows) {
    const list = grouped.get(r.industry) ?? [];
    list.push(r);
    grouped.set(r.industry, list);
  }
  // 同產業內依 5 日漲幅由大到小排(動能 proxy)
  for (const [, list] of grouped) {
    list.sort((a, b) => {
      const av = a.pct_5d == null ? -Infinity : Number(a.pct_5d);
      const bv = b.pct_5d == null ? -Infinity : Number(b.pct_5d);
      return bv - av;
    });
  }
  const orderedIndustries = [
    ...SECTOR_ORDER.filter((s) => grouped.has(s)),
    ...Array.from(grouped.keys()).filter((s) => !SECTOR_ORDER.includes(s)),
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-amber-700/60 bg-amber-950/30 p-3 text-sm text-amber-200">
        ⚠ 目前排序為 <span className="font-semibold">5 日漲幅</span>(動能 proxy)。
        EPS / ROE / PEG / P/B 等基本面欄位待 <span className="font-semibold">M3.6 fundamentals layer</span> 接入後才能填。
      </div>

      {orderedIndustries.length === 0 && (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
          還沒抓到報價,等下次盤後 cron(平日 14:30 Taipei)
        </p>
      )}

      {orderedIndustries.map((industry) => (
        <SectorBlock
          key={industry}
          industry={industry}
          rows={grouped.get(industry) ?? []}
        />
      ))}
    </div>
  );
}

function SectorBlock({
  industry,
  rows,
}: {
  industry: string;
  rows: IndustryQuote[];
}) {
  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">{industry}</h2>
      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
            <tr>
              <th className="px-3 py-2">股號</th>
              <th className="px-3 py-2">名稱</th>
              <th className="px-3 py-2 text-right">現價</th>
              <th className="px-3 py-2 text-right">5日%</th>
              <th className="px-3 py-2 text-right">20日%</th>
              <th className="px-3 py-2 text-right text-zinc-600">EPS</th>
              <th className="px-3 py-2 text-right text-zinc-600">ROE</th>
              <th className="px-3 py-2 text-right text-zinc-600">PEG</th>
              <th className="px-3 py-2 text-right text-zinc-600">P/B</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-zinc-800">
                <td className="px-3 py-2 font-mono">{r.symbol}</td>
                <td className="px-3 py-2 text-sm text-zinc-300">
                  {r.name ?? "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  <PriceCell
                    value={r.current_price}
                    isProvisional={r.is_provisional}
                    date={r.trade_date}
                  />
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${pctColor(r.pct_5d)}`}
                >
                  {fmtPct(r.pct_5d)}
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${pctColor(r.pct_20d)}`}
                >
                  {fmtPct(r.pct_20d)}
                </td>
                <td className="px-3 py-2 text-right text-zinc-600">—</td>
                <td className="px-3 py-2 text-right text-zinc-600">—</td>
                <td className="px-3 py-2 text-right text-zinc-600">—</td>
                <td className="px-3 py-2 text-right text-zinc-600">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
