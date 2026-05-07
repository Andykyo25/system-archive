import { Fragment } from "react";
import { createClient } from "@/lib/supabase/server";
import { fmtMoney, fmtPct, pctColor } from "../_components/Format";
import { PriceCell } from "../_components/PriceCell";
import { analyzeRow } from "../_components/Analyze";

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
  last_q_eps_yoy_pct: string | number | null;
  forecast_eps_yoy_pct: string | number | null;
  roe_ttm: string | number | null;
  fcf_ttm: string | number | null;
  eps_pos_quarters: number | null;
  quarters_available: number | null;
  gross_margin_pct: string | number | null;
  gross_margin_yoy_pp: string | number | null;
  pe: string | number | null;
  pb: string | number | null;
  peg: string | number | null;
  peg_basis: string | null;
  pb_threshold: string | number | null;
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
  if (!Number.isFinite(v)) return { text: "—", cls: "text-zinc-600", title: "—" };
  const title = `FCF (TTM) = ${v.toLocaleString()}`;
  if (v > 0) return { text: "+", cls: "text-red-400", title };
  return { text: "−", cls: "text-green-400", title };
}

function pbCellClass(
  pb: number | string | null | undefined,
  threshold: number | string | null | undefined,
): string {
  if (pb == null || threshold == null) return "text-zinc-400";
  const pbN = Number(pb);
  const thN = Number(threshold);
  if (!Number.isFinite(pbN) || !Number.isFinite(thN)) return "text-zinc-400";
  return pbN < thN ? "text-red-400" : "text-zinc-400";
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
      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-xs leading-relaxed text-zinc-300">
        <p className="mb-1 font-semibold text-zinc-200">評分 0-5:依 5 條規則自動計分,每股下方有中文短評</p>
        <ul className="list-inside list-disc space-y-0.5 text-zinc-400">
          <li>過去 8 季 EPS 全部為正</li>
          <li>ROE &gt; 15%(TTM)</li>
          <li>自由現金流(TTM)為正</li>
          <li>PEG &lt; 1.0(優先順序:法人預估 → 最近一季 EPS YoY → TTM EPS YoY)</li>
          <li>P/B &lt; <strong>產業門檻</strong>(IC 設計 8、AI 伺服器 5、車用/記憶體 3、其他 2)</li>
        </ul>
        <p className="mt-2 text-zinc-500">
          要把聯發科這類 forecast-driven 股升上來,在 SQL 跑:
          <code className="ml-1 rounded bg-zinc-800 px-1 text-zinc-300">
            update industry_stocks set analyst_forecast_eps_growth_pct = 100 where symbol = &apos;2454&apos;;
          </code>
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
  const COL_COUNT = 13;
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
              <th className="px-3 py-2 text-right" title="最近一季 EPS YoY">EPS Q-YoY</th>
              <th className="px-3 py-2 text-right">ROE</th>
              <th className="px-3 py-2 text-center">FCF</th>
              <th className="px-3 py-2 text-right" title="最近一季毛利率(YoY pp 變化於分析行)">毛利</th>
              <th className="px-3 py-2 text-right">PE</th>
              <th className="px-3 py-2 text-right" title="PB(產業門檻 hover 顯示)">PB</th>
              <th className="px-3 py-2 text-right" title="PEG / 計算依據(預=forecast、季=last quarter、TTM=trailing)">PEG</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const fcf = fmtFcf(r.fcf_ttm);
              const pegYoy = r.last_q_eps_yoy_pct ?? r.eps_yoy_pct;
              const analysis = analyzeRow(r);
              return (
                <Fragment key={r.id}>
                  <tr className="border-t border-zinc-800">
                    <td className="px-3 py-2 font-mono">{r.symbol}</td>
                    <td className="px-3 py-2 text-sm text-zinc-300">{r.name ?? "—"}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`rounded px-2 py-0.5 text-xs font-semibold tabular-nums ${scoreClass(r.score)}`}>
                        {r.score}/5
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <PriceCell value={r.current_price} isProvisional={r.is_provisional} date={r.trade_date} />
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.pct_5d)}`}>{fmtPct(r.pct_5d)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.pct_20d)}`}>{fmtPct(r.pct_20d)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pctColor(pegYoy)}`}>{fmtPct(pegYoy)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtRoe(r.roe_ttm)}</td>
                    <td className={`px-3 py-2 text-center font-bold ${fcf.cls}`} title={fcf.title}>
                      {fcf.text}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums" title={`毛利 YoY: ${fmtPct(r.gross_margin_yoy_pp)} pp`}>
                      {fmtRoe(r.gross_margin_pct)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.pe, 1)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pbCellClass(r.pb, r.pb_threshold)}`} title={`產業門檻 < ${r.pb_threshold ?? "—"}`}>
                      {fmtMoney(r.pb, 2)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums" title={`依據: ${r.peg_basis ?? "—"}`}>
                      {fmtMoney(r.peg, 2)}
                    </td>
                  </tr>
                  <tr className="border-t border-zinc-900/50 bg-zinc-950/40">
                    <td colSpan={COL_COUNT} className="px-3 py-2 text-xs leading-relaxed text-zinc-400">
                      <span className="font-semibold text-zinc-200">{analysis.headline}</span>
                      {analysis.notes.length > 0 && (
                        <>
                          <br />
                          <span className="text-zinc-400">{analysis.notes.join("　·　")}</span>
                        </>
                      )}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
