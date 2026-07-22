import Link from "next/link";
import { TableShell, THead } from "@/app/_components/ui";
import { fmtPct, pctColor } from "@/app/_components/Format";

// 短線動能榜 + 題材熱度(2026-07-22)
//
// 起因:Andy 反映「漲幅很大卻無法靠前」。查證後 —— 不是動能因子壞掉,是多因子排名
//   的 fund 權重 40% 把題材股拉下來(fund 7 項全是價值/品質指標)。Andy 拍板不動權重
//   (避開 L36 OOS 閘),改為並列一個純價格視角的榜。
//
// 定位(關鍵):這是「現在在漲」的清單,**不是「會繼續漲」的清單**。
//   純價格排序、零因子、零回測驗證。跟多因子排名是兩把不同的尺,不要混用。
//   2026-07-22 聯茂事件正是反例:當天漲最凶的時候買進 = 買在當日最高附近。

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
}

export interface MomentumRow {
  symbol: string;
  name: string | null;
  industry: string | null;
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
 * 型態判讀:20 日與 60 日方向組合 + 距高點,一眼分辨「正在漲」與「漲完在崩」。
 * 這是今天最容易誤判的地方 —— 2492 華新科 60 日 +132% 但 20 日 −47.7%。
 */
function pattern(r20: number | null, r60: number | null, offHigh: number | null): {
  label: string;
  cls: string;
} {
  if (r20 == null || r60 == null) return { label: "—", cls: "text-zinc-600" };
  if (r20 > 0 && r60 > 0) {
    if (offHigh != null && offHigh <= 5) return { label: "強勢創高", cls: "text-up" };
    return { label: "續漲", cls: "text-up" };
  }
  if (r20 > 0 && r60 <= 0) return { label: "剛轉強", cls: "text-warn" };
  if (r20 <= 0 && r60 > 0) return { label: "漲完回檔", cls: "text-down" };
  return { label: "弱勢", cls: "text-down" };
}

export function MomentumBoard({
  heat,
  rows,
}: {
  heat: HeatRow[];
  rows: MomentumRow[];
}) {
  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-line bg-surface-1 p-4">
        <h1 className="text-xl font-semibold">短線動能</h1>
        <p className="mt-1 text-xs text-zinc-500">
          純價格排序（近 20 日報酬），
          <span className="text-zinc-300">
            不含任何基本面／籌碼因子，也沒有經過回測驗證
          </span>
          。這是「<span className="text-zinc-300">現在在漲</span>」的清單，
          不是「會繼續漲」的清單——20 日漲最多的股票，同時也是回檔風險最大的。
        </p>
        <p className="mt-1.5 text-xs text-zinc-600">
          與左側「多因子排名」是<span className="text-zinc-400">兩把不同的尺</span>：
          那邊 40% 權重看基本面（EPS／ROE／FCF／PEG），題材股與循環股反轉初期天生分低。
          兩邊都靠前的才是兩套標準都認可。
        </p>
      </header>

      {/* ── 題材熱度 ── */}
      <section>
        <h2 className="mb-1 text-base font-semibold text-zinc-100">題材熱度</h2>
        <p className="mb-2 text-xs text-zinc-500">
          資金輪動在哪。<span className="text-zinc-400">平均</span>會被單一暴衝股拉高，
          所以並列<span className="text-zinc-400">中位數</span>與
          <span className="text-zinc-400">上漲家數</span>——三者一致才是整個族群在動。
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
                  <th className="px-3 py-2 text-right">近5日</th>
                  <th className="px-3 py-2 text-right">近20日</th>
                  <th className="px-3 py-2 text-right">中位</th>
                  <th className="px-3 py-2 text-right">近60日</th>
                  <th className="px-3 py-2 text-center">上漲</th>
                  <th className="px-3 py-2 text-right">RSI</th>
                  <th className="px-3 py-2">最強</th>
                </tr>
              </THead>
              <tbody>
                {heat.map((h) => {
                  const up = h.n_up_20d;
                  const all = h.n_stocks;
                  const allUp = up === all && all > 0;
                  const allDown = up === 0 && all > 0;
                  return (
                    <tr key={h.industry} className="border-t border-line-soft">
                      <td className="whitespace-nowrap px-3 py-2 font-medium text-zinc-200">
                        {h.industry}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                        {all}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${pctColor(h.avg_ret_5d)}`}>
                        {fmtPct(h.avg_ret_5d)}
                      </td>
                      <td className={`px-3 py-2 text-right font-semibold tabular-nums ${pctColor(h.avg_ret_20d)}`}>
                        {fmtPct(h.avg_ret_20d)}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${pctColor(h.med_ret_20d)}`}>
                        {fmtPct(h.med_ret_20d)}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${pctColor(h.avg_ret_60d)}`}>
                        {fmtPct(h.avg_ret_60d)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-center text-xs tabular-nums">
                        <span
                          className={
                            allUp ? "text-up" : allDown ? "text-down" : "text-zinc-400"
                          }
                        >
                          {up}/{all}
                        </span>
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${rsiCls(n(h.avg_rsi))}`}>
                        {n(h.avg_rsi)?.toFixed(0) ?? "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">
                        {h.top_symbol ? (
                          <Link
                            href={`/stocks/${h.top_symbol}`}
                            className="text-zinc-400 hover:text-zinc-100"
                          >
                            {h.top_symbol}
                            <span className={`ml-1 tabular-nums ${pctColor(h.top_ret_20d)}`}>
                              {fmtPct(h.top_ret_20d)}
                            </span>
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        )}
      </section>

      {/* ── 個股動能 ── */}
      <section>
        <h2 className="mb-1 text-base font-semibold text-zinc-100">個股短線動能</h2>
        <p className="mb-2 text-xs text-zinc-500">
          依近 20 日報酬排序。「型態」欄用 20 日與 60 日方向組合分辨
          <span className="text-down">漲完回檔</span>與
          <span className="text-up">續漲</span>——
          光看 60 日漲幅會把已經崩了一半的股票誤認成強勢股。
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
                  <th className="px-3 py-2 text-right">近5日</th>
                  <th className="px-3 py-2 text-right">近20日</th>
                  <th className="px-3 py-2 text-right">近60日</th>
                  <th className="px-3 py-2 text-right">RSI</th>
                  <th className="px-3 py-2 text-right">距高點</th>
                  <th className="px-3 py-2">型態</th>
                  <th className="px-3 py-2 text-right">綜合排名</th>
                </tr>
              </THead>
              <tbody>
                {rows.map((r) => {
                  const r20 = n(r.ret_20d_pct);
                  const r60 = n(r.ret_60d_pct);
                  const oh = n(r.off_high_60d_pct);
                  const rsi = n(r.rsi14);
                  const pat = pattern(r20, r60, oh);
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
                      <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.ret_5d_pct)}`}>
                        {fmtPct(r.ret_5d_pct)}
                      </td>
                      <td className={`px-3 py-2 text-right font-semibold tabular-nums ${pctColor(r.ret_20d_pct)}`}>
                        {fmtPct(r.ret_20d_pct)}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.ret_60d_pct)}`}>
                        {fmtPct(r.ret_60d_pct)}
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
        「距高點」= 現價距近 60 日最高點的跌幅。數字越小越接近高點；
        <span className="text-zinc-500">
          RSI ≥80 標橘色代表短線過熱，不是賣出訊號，只是提醒此時追價的風險報酬比較差
        </span>
        。
      </p>
    </div>
  );
}
