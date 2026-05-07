import { Fragment } from "react";
import { createClient } from "@/lib/supabase/server";
import { fmtMoney, fmtPct, pctColor } from "../_components/Format";
import { PriceCell } from "../_components/PriceCell";
import { summarizeForRow, type AnalysisOut } from "../_components/Analyze";

export const dynamic = "force-dynamic";

interface EtfPick {
  symbol: string;
  name: string | null;
  category: string;
  expense_ratio: string | number | null;
  fund_size_billion: string | number | null;
  is_active_etf: boolean;
  notes: string | null;
  current_price: string | number | null;
  trade_date: string | null;
  is_provisional: boolean | null;
  pct_5d: string | number | null;
  pct_20d: string | number | null;
  dividend_yield: string | number | null;
  pe: string | number | null;
  pb: string | number | null;
  avg_20d_volume: string | number | null;
  score: number;
}

const CATEGORY_ORDER = ["市值型", "高股息", "主題", "主動式", "債券", "其他"];

function scoreClass(score: number): string {
  if (score >= 5) return "bg-green-700 text-white";
  if (score >= 4) return "bg-green-800 text-green-100";
  if (score >= 3) return "bg-yellow-800 text-yellow-100";
  if (score >= 2) return "bg-orange-900 text-orange-200";
  if (score >= 1) return "bg-zinc-800 text-zinc-300";
  return "bg-zinc-900 text-zinc-500";
}

function fmtPctMaybe(n: string | number | null | undefined, digits = 2): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

function fmtVolume(n: string | number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)} 億`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)} 萬`;
  return v.toLocaleString();
}

function analyzeEtf(r: EtfPick): AnalysisOut {
  let headline: string;
  if (r.score >= 4) headline = "📈 體質佳";
  else if (r.score >= 3) headline = "🔍 中等";
  else if (r.score >= 2) headline = "⚠️ 偏弱";
  else headline = "🚧 多項風險";

  const notes: string[] = [];
  const exp = r.expense_ratio == null ? null : Number(r.expense_ratio);
  if (exp != null) {
    notes.push(
      exp < 0.5
        ? `✓ 內扣費用 ${exp.toFixed(2)}%`
        : `✗ 內扣費用 ${exp.toFixed(2)}% (>0.5%,偏高)`,
    );
  } else {
    notes.push("— 內扣費用未填(設定頁可加)");
  }
  const fs = r.fund_size_billion == null ? null : Number(r.fund_size_billion);
  if (fs != null) {
    notes.push(
      fs > 100
        ? `✓ 規模 ${fs.toFixed(0)} 億`
        : `✗ 規模 ${fs.toFixed(0)} 億 (偏小,流動性可能不足)`,
    );
  } else {
    notes.push("— 規模未填");
  }
  const yld = r.dividend_yield == null ? null : Number(r.dividend_yield);
  if (yld != null) {
    notes.push(
      yld > 4
        ? `✓ 殖利率 ${yld.toFixed(1)}%`
        : `◎ 殖利率 ${yld.toFixed(1)}%(高股息類期待 >4%)`,
    );
  }
  const p5 = r.pct_5d == null ? null : Number(r.pct_5d);
  if (p5 != null) {
    notes.push(
      p5 > 0
        ? `✓ 5 日動能 +${p5.toFixed(1)}%`
        : `✗ 5 日動能 ${p5.toFixed(1)}%`,
    );
  }
  const vol = r.avg_20d_volume == null ? null : Number(r.avg_20d_volume);
  if (vol != null) {
    notes.push(
      vol > 1_000_000
        ? `✓ 流動性 ${fmtVolume(vol)}/日`
        : `✗ 流動性偏低 ${fmtVolume(vol)}/日`,
    );
  }
  if (r.is_active_etf) {
    notes.push("⚡ 主動式 ETF(由經理人選股,費率較高但有超額報酬機會)");
  }

  return { headline, notes };
}

function buildTooltip(r: EtfPick): string {
  const a = analyzeEtf(r);
  return [a.headline, "", ...a.notes].join("\n");
}

export default async function EtfPage() {
  const sb = createClient();
  const { data } = await sb.from("v_etf_picks").select("*");
  const rows = (data as EtfPick[] | null) ?? [];

  const grouped = new Map<string, EtfPick[]>();
  for (const r of rows) {
    const key = r.category || "其他";
    const list = grouped.get(key) ?? [];
    list.push(r);
    grouped.set(key, list);
  }
  for (const [, list] of grouped) {
    list.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const av = a.fund_size_billion == null ? -Infinity : Number(a.fund_size_billion);
      const bv = b.fund_size_billion == null ? -Infinity : Number(b.fund_size_billion);
      return bv - av;
    });
  }
  const orderedCategories = [
    ...CATEGORY_ORDER.filter((c) => grouped.has(c)),
    ...Array.from(grouped.keys()).filter((c) => !CATEGORY_ORDER.includes(c)),
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <p className="text-xs text-zinc-500">
          ETF 評分 5 條:內扣費用&lt;0.5% / 規模&gt;100億 / 殖利率&gt;4% / 5日動能正 / 流動性 &gt;100萬股 · 分數 hover 看分析
        </p>
        <p className="text-xs text-zinc-500">
          編輯內扣費用、規模、類型在 <a href="/settings" className="underline hover:text-zinc-300">設定</a>
        </p>
      </div>

      {orderedCategories.length === 0 && (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
          沒有 ETF metadata。到「設定」頁新增。
        </p>
      )}

      {orderedCategories.map((cat) => (
        <CategoryBlock key={cat} category={cat} rows={grouped.get(cat) ?? []} />
      ))}

      <p className="text-xs text-zinc-500">
        FinMind 免費版不開放 NAV / 折溢價,所以這個 tab 沒做 NAV 計算。
      </p>
    </div>
  );
}

function CategoryBlock({ category, rows }: { category: string; rows: EtfPick[] }) {
  const COL_COUNT = 10;
  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">{category}</h2>
      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
            <tr>
              <th className="px-3 py-2">股號</th>
              <th className="px-3 py-2">名稱</th>
              <th className="px-3 py-2 text-center" title="hover 看分析">分</th>
              <th className="px-3 py-2 text-right">現價</th>
              <th className="px-3 py-2 text-right">5日%</th>
              <th className="px-3 py-2 text-right">20日%</th>
              <th className="px-3 py-2 text-right" title="從 FinMind dividend_yield 抓">殖利率</th>
              <th className="px-3 py-2 text-right" title="設定頁編輯">內扣費用</th>
              <th className="px-3 py-2 text-right" title="規模(億)">規模</th>
              <th className="px-3 py-2 text-right" title="20 日平均成交股數">流動性</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const analysis = analyzeEtf(r);
              const tooltip = [analysis.headline, "", ...analysis.notes].join("\n");
              const summary = summarizeForRow(analysis);
              return (
                <Fragment key={r.symbol}>
                <tr className="border-t border-zinc-800">
                  <td className="px-3 py-2 font-mono">
                    {r.symbol}
                    {r.is_active_etf && (
                      <span className="ml-1 rounded bg-purple-900 px-1 text-[10px] text-purple-200">主動</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm text-zinc-300">{r.name ?? "—"}</td>
                  <td className="px-3 py-2 text-center" title={tooltip}>
                    <span className={`cursor-help rounded px-2 py-0.5 text-xs font-semibold tabular-nums ${scoreClass(r.score)}`}>
                      {r.score}/5
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <PriceCell value={r.current_price} isProvisional={r.is_provisional} date={r.trade_date} />
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.pct_5d)}`}>{fmtPct(r.pct_5d)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.pct_20d)}`}>{fmtPct(r.pct_20d)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPctMaybe(r.dividend_yield, 1)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.expense_ratio == null ? "—" : `${Number(r.expense_ratio).toFixed(2)}%`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.fund_size_billion == null ? "—" : `${Number(r.fund_size_billion).toFixed(0)}`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{fmtVolume(r.avg_20d_volume)}</td>
                </tr>
                <tr className="border-t border-zinc-900/30 bg-zinc-950/30">
                  <td colSpan={COL_COUNT} className="px-3 pb-2 pt-1 text-[11px] leading-snug text-zinc-500">
                    {summary}
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
