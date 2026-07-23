import Link from "next/link";
import { TableShell, THead } from "@/app/_components/ui";
import { fmtPct, pctColor } from "@/app/_components/Format";

// 短線動能榜 + 題材熱度(2026-07-22)
//
// 起因:Andy 反映「漲幅很大卻無法靠前」。查證 —— 不是動能因子壞掉,是多因子排名的
//   fund 40% 權重把題材股拉下來。Andy 拍板不動權重(避開 L36 OOS 閘),並列純價格視角。
// 迭代:Andy「20 日太長,今天大漲的題材才是進場關鍵」→ 主軸改「最新交易日」,
//   20/60 日退成背景參考。口徑 = price_daily 各股最新兩筆收盤日變化(v_symbol_momentum /
//   v_industry_heat 一致,L42 不做兩套)。
//
// 定位(關鍵):這是「現在在漲」的清單,**不是「會繼續漲」的清單**。純價格、零因子、
//   零回測驗證。今日漲停有兩種:趨勢延續(緯穎:今日+10%/5日+8%/20日+18%)與超跌反彈
//   (華新科:今日+10% 但 5日−21%/20日−48%/RSI 8)—— 風險天差地別,靠「型態」欄與 5 日並看分辨。

export interface HeatRow {
  industry: string;
  n_stocks: number;
  avg_ret_5d: number | string | null;
  avg_ret_20d: number | string | null;
  med_ret_20d: number | string | null;
  avg_ret_60d: number | string | null;
  avg_rsi: number | string | null;
  avg_off_high: number | string | null;
  n_up_20d: number;
  top_symbol: string | null;
  top_ret_20d: number | string | null;
  avg_today_pct: number | string | null;
  med_today_pct: number | string | null;
  n_up_today: number;
  n_today_quoted: number;
  n_limit_up: number;
  today_top_symbol: string | null;
  today_top_pct: number | string | null;
}

export interface MomentumRow {
  symbol: string;
  name: string | null;
  industry: string | null;
  latest_day_pct: number | string | null;
  last_date: string | null;
  ret_5d_pct: number | string | null;
  ret_20d_pct: number | string | null;
  ret_60d_pct: number | string | null;
  rsi14: number | string | null;
  off_high_60d_pct: number | string | null;
  expected_rank: number | null;
  latest_close: number | string | null;
}

function n(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** RSI 色階:>80 過熱橘、<30 超賣藍、其餘中性 */
function rsiCls(v: number | null): string {
  if (v == null) return "text-zinc-500";
  if (v >= 80) return "text-warn";
  if (v <= 30) return "text-accent";
  return "text-zinc-400";
}

/**
 * 型態判讀:今日 / 5日 / 20日方向組合。分辨「今天漲」的兩種截然不同來源:
 *   趨勢延續(5日也正)vs 超跌反彈(5日仍深)。這是短線最容易看走眼的地方。
 */
function pattern(
  today: number | null,
  r5: number | null,
  r20: number | null,
  offHigh: number | null,
): { label: string; cls: string } {
  if (today == null || r5 == null || r20 == null) return { label: "—", cls: "text-zinc-600" };
  // 今天在漲
  if (today > 0) {
    if (r5 > 0 && r20 > 0) {
      if (offHigh != null && offHigh <= 5) return { label: "強勢創高", cls: "text-up" };
      return { label: "趨勢延續", cls: "text-up" };
    }
    if (r5 <= 0 && r20 <= 0) return { label: "超跌反彈", cls: "text-warn" };
    return { label: "剛轉強", cls: "text-warn" };
  }
  // 今天在跌
  if (r20 > 0) return { label: "高檔回落", cls: "text-down" };
  return { label: "弱勢", cls: "text-down" };
}

export function MomentumBoard({ heat, rows }: { heat: HeatRow[]; rows: MomentumRow[] }) {
  const asOf = rows.find((r) => r.last_date)?.last_date ?? null;

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-line bg-surface-1 p-4">
        <h1 className="text-xl font-semibold">短線動能</h1>
        <p className="mt-1 text-xs text-zinc-500">
          以<span className="text-zinc-300">最新交易日</span>
          漲跌排序{asOf ? `（${asOf}）` : ""}，純價格、
          <span className="text-zinc-300">不含基本面／籌碼因子，也沒有回測驗證</span>。
          這是「<span className="text-zinc-300">現在在漲</span>」的清單，不是「會繼續漲」的清單。
        </p>
        <p className="mt-1.5 text-xs text-zinc-600">
          今天漲停有兩種：<span className="text-up">趨勢延續</span>（5 日也在漲）與
          <span className="text-warn">超跌反彈</span>（5 日還深陷）——靠「型態」欄與 5 日欄分辨，別只看今天。
          與左側「多因子排名」是兩把不同的尺（那邊 40% 看基本面）。
        </p>
      </header>

      {/* ── 題材熱度(今日) ── */}
      <section>
        <h2 className="mb-1 text-base font-semibold text-zinc-100">
          題材熱度 · 最新交易日
        </h2>
        <p className="mb-2 text-xs text-zinc-500">
          資金今天輪到哪。<span className="text-zinc-400">上漲家數</span>與
          <span className="text-zinc-400">漲停數</span>看整個族群是不是一起動；
          右側 <span className="text-zinc-400">20 日</span>是背景——今天強但 20 日還負，代表是反彈不是趨勢。
        </p>
        {heat.length === 0 ? (
          <p className="rounded-2xl border border-line bg-surface-1 p-6 text-center text-sm text-zinc-500">
            無題材資料
          </p>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <THead>
                <tr>
                  <th className="px-3 py-2">題材</th>
                  <th className="px-3 py-2 text-right">檔數</th>
                  <th className="px-3 py-2 text-right">今日</th>
                  <th className="px-3 py-2 text-right">中位</th>
                  <th className="px-3 py-2 text-center">上漲</th>
                  <th className="px-3 py-2 text-center">漲停</th>
                  <th className="px-3 py-2">今日最強</th>
                  <th className="px-3 py-2 text-right">近5日</th>
                  <th className="px-3 py-2 text-right">20日</th>
                </tr>
              </THead>
              <tbody>
                {heat.map((h) => {
                  const up = h.n_up_today;
                  const quoted = h.n_today_quoted;
                  const allUp = up === quoted && quoted > 0;
                  const lim = h.n_limit_up;
                  return (
                    <tr key={h.industry} className="border-t border-line-soft">
                      <td className="whitespace-nowrap px-3 py-2 font-medium text-zinc-200">
                        {h.industry}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                        {h.n_stocks}
                      </td>
                      <td className={`px-3 py-2 text-right font-semibold tabular-nums ${pctColor(h.avg_today_pct)}`}>
                        {fmtPct(h.avg_today_pct)}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${pctColor(h.med_today_pct)}`}>
                        {fmtPct(h.med_today_pct)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-center text-xs tabular-nums">
                        <span className={allUp ? "text-up" : up === 0 ? "text-down" : "text-zinc-400"}>
                          {up}/{quoted}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center text-xs tabular-nums">
                        {lim > 0 ? (
                          <span className="text-up">🔴 {lim}</span>
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">
                        {h.today_top_symbol ? (
                          <Link
                            href={`/stocks/${h.today_top_symbol}`}
                            className="text-zinc-400 hover:text-zinc-100"
                          >
                            {h.today_top_symbol}
                            <span className={`ml-1 tabular-nums ${pctColor(h.today_top_pct)}`}>
                              {fmtPct(h.today_top_pct)}
                            </span>
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${pctColor(h.avg_ret_5d)}`}>
                        {fmtPct(h.avg_ret_5d)}
                      </td>
                      <td className={`px-3 py-2 text-right text-xs tabular-nums ${pctColor(h.avg_ret_20d)}`}>
                        {fmtPct(h.avg_ret_20d)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        )}
      </section>

      {/* ── 個股動能(今日) ── */}
      <section>
        <h2 className="mb-1 text-base font-semibold text-zinc-100">
          個股動能 · 最新交易日漲最多
        </h2>
        <p className="mb-2 text-xs text-zinc-500">
          今天漲最多的 40 檔。<span className="text-zinc-400">型態</span>欄用今日／5日／20日組合
          分辨<span className="text-up">趨勢延續</span>與<span className="text-warn">超跌反彈</span>——
          同樣今天漲停，前者風險報酬比後者好得多。
        </p>
        {rows.length === 0 ? (
          <p className="rounded-2xl border border-line bg-surface-1 p-6 text-center text-sm text-zinc-500">
            無資料
          </p>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <THead>
                <tr>
                  <th className="px-3 py-2">股號</th>
                  <th className="px-3 py-2">名稱</th>
                  <th className="px-3 py-2">題材</th>
                  <th className="px-3 py-2 text-right">現價</th>
                  <th className="px-3 py-2 text-right">今日</th>
                  <th className="px-3 py-2 text-right">近5日</th>
                  <th className="px-3 py-2 text-right">20日</th>
                  <th className="px-3 py-2 text-right">RSI</th>
                  <th className="px-3 py-2 text-right">距高點</th>
                  <th className="px-3 py-2">型態</th>
                  <th className="px-3 py-2 text-right">綜合排名</th>
                </tr>
              </THead>
              <tbody>
                {rows.map((r) => {
                  const today = n(r.latest_day_pct);
                  const r5 = n(r.ret_5d_pct);
                  const r20 = n(r.ret_20d_pct);
                  const oh = n(r.off_high_60d_pct);
                  const rsi = n(r.rsi14);
                  const pat = pattern(today, r5, r20, oh);
                  const isLimit = today != null && today >= 9.5;
                  return (
                    <tr key={r.symbol} className="border-t border-line-soft">
                      <td className="whitespace-nowrap px-3 py-2">
                        <Link
                          href={`/stocks/${r.symbol}`}
                          className="font-medium text-zinc-200 hover:text-accent"
                        >
                          {r.symbol}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-zinc-300">
                        {r.name ?? "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-500">
                        {r.industry ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                        {n(r.latest_close)?.toLocaleString("zh-TW") ?? "—"}
                      </td>
                      <td className={`px-3 py-2 text-right font-semibold tabular-nums ${pctColor(r.latest_day_pct)}`}>
                        {isLimit ? "🔴 " : ""}
                        {fmtPct(r.latest_day_pct)}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.ret_5d_pct)}`}>
                        {fmtPct(r.ret_5d_pct)}
                      </td>
                      <td className={`px-3 py-2 text-right text-xs tabular-nums ${pctColor(r.ret_20d_pct)}`}>
                        {fmtPct(r.ret_20d_pct)}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${rsiCls(rsi)}`}>
                        {rsi?.toFixed(0) ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                        {oh != null ? `−${oh.toFixed(1)}%` : "—"}
                      </td>
                      <td className={`whitespace-nowrap px-3 py-2 text-xs ${pat.cls}`}>
                        {pat.label}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                        {r.expected_rank != null ? `#${r.expected_rank}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        )}
      </section>

      <p className="text-xs text-zinc-600">
        「最新交易日」= price_daily 各股最近兩筆收盤的日變化（盤後 = 今天收盤，非盤中即時）。
        <span className="text-zinc-500">
          「距高點」越小越接近波段頂；RSI ≥80 標橘代表短線過熱，是追價風險提醒不是賣訊。
        </span>
      </p>
    </div>
  );
}
