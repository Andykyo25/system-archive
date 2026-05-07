import { createClient } from "@/lib/supabase/server";
import { fmtMoney, fmtPct, pctColor } from "../_components/Format";
import { PriceCell } from "../_components/PriceCell";

export const dynamic = "force-dynamic";

interface IndustryPick {
  id: number;
  industry: string;
  symbol: string;
  name: string | null;
  display_order: number;
  current_price: string | number | null;
  trade_date: string | null;
  is_provisional: boolean | null;
  pct_5d: string | number | null;
  pct_20d: string | number | null;
  eps_ttm: string | number | null;
  eps_yoy_pct: string | number | null;
  roe_ttm: string | number | null;
  fcf_ttm: string | number | null;
  eps_pos_quarters: number | null;
  quarters_available: number | null;
  pe: string | number | null;
  pb: string | number | null;
  peg: string | number | null;
  dividend_yield: string | number | null;
  score: number;
}

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

function scoreClass(score: number): string {
  if (score >= 5) return "bg-green-700 text-white";
  if (score >= 4) return "bg-green-800 text-green-100";
  if (score >= 3) return "bg-yellow-800 text-yellow-100";
  if (score >= 2) return "bg-orange-900 text-orange-200";
  if (score >= 1) return "bg-zinc-800 text-zinc-300";
  return "bg-zinc-900 text-zinc-500";
}

function fmtRoe(n: string | number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}%`;
}

function fmtFcf(n: string | number | null | undefined): {
  text: string;
  cls: string;
  title: string;
} {
  if (n == null) return { text: "—", cls: "text-zinc-600", title: "FCF 無資料" };
  const v = Number(n);
  if (!Number.isFinite(v)) {
    return { text: "—", cls: "text-zinc-600", title: "FCF 無資料" };
  }
  const title = `FCF (TTM) = ${v.toLocaleString()}`;
  // 台股慣例:紅 = 好(正 FCF),綠 = 差
  if (v > 0) return { text: "+", cls: "text-red-400", title };
  return { text: "−", cls: "text-green-400", title };
}

export default async function WatchlistPage() {
  const sb = createClient();
  const { data } = await sb.from("v_industry_picks").select("*");
  const rows = (data as IndustryPick[] | null) ?? [];

  const grouped = new Map<string, IndustryPick[]>();
  for (const r of rows) {
    const list = grouped.get(r.industry) ?? [];
    list.push(r);
    grouped.set(r.industry, list);
  }
  // 同產業內:score desc → pct_5d desc(同分時看動能)
  for (const [, list] of grouped) {
    list.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
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
      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-xs text-zinc-300 leading-relaxed">
        <p className="mb-1 font-semibold text-zinc-200">評分(0-5):依 Andy 給的 5 條規則自動計分</p>
        <ul className="list-inside list-disc space-y-0.5 text-zinc-400">
          <li>過去 8 季 EPS 全部為正(代理「EPS 連 10 年成長」)</li>
          <li>ROE &gt; 15%(TTM 淨利 / 最新權益)</li>
          <li>自由現金流(TTM)為正</li>
          <li>PEG &lt; 1.0(PE / EPS YoY%)</li>
          <li>P/B &lt; 2</li>
        </ul>
        <p className="mt-2 text-zinc-500">
          同分內依 5 日漲幅排序。第 6 條「逆勢布局」屬時機判斷,自行 review。
        </p>
      </div>

      {orderedIndustries.length === 0 && (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
          還沒有資料,等下次盤後 cron(平日 14:30 Taipei)
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
  rows: IndustryPick[];
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
              <th className="px-3 py-2 text-center">分</th>
              <th className="px-3 py-2 text-right">現價</th>
              <th className="px-3 py-2 text-right">5日%</th>
              <th className="px-3 py-2 text-right">20日%</th>
              <th className="px-3 py-2 text-right">EPS</th>
              <th className="px-3 py-2 text-right">YoY%</th>
              <th className="px-3 py-2 text-right">ROE</th>
              <th className="px-3 py-2 text-center">FCF</th>
              <th className="px-3 py-2 text-right">PE</th>
              <th className="px-3 py-2 text-right">PB</th>
              <th className="px-3 py-2 text-right">PEG</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const fcf = fmtFcf(r.fcf_ttm);
              return (
                <tr key={r.id} className="border-t border-zinc-800">
                  <td className="px-3 py-2 font-mono">{r.symbol}</td>
                  <td className="px-3 py-2 text-sm text-zinc-300">
                    {r.name ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-semibold tabular-nums ${scoreClass(r.score)}`}
                    >
                      {r.score}/5
                    </span>
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
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtMoney(r.eps_ttm, 2)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${pctColor(r.eps_yoy_pct)}`}
                  >
                    {fmtPct(r.eps_yoy_pct)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtRoe(r.roe_ttm)}
                  </td>
                  <td
                    className={`px-3 py-2 text-center font-bold ${fcf.cls}`}
                    title={fcf.title}
                  >
                    {fcf.text}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtMoney(r.pe, 1)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtMoney(r.pb, 2)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtMoney(r.peg, 2)}
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
