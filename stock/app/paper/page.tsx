import { createClient } from "@/lib/supabase/server";
import { addPaperOrder } from "./actions";
import type { PaperOrder, PaperPnL } from "@/lib/types";
import { fmtMoney, fmtPct, pctColor } from "../_components/Format";
import { PriceCell } from "../_components/PriceCell";

export const dynamic = "force-dynamic";

const inputCls =
  "rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none";
const btnCls =
  "rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700";

export default async function PaperPage() {
  const sb = createClient();
  const [{ data: positions }, { data: orders }] = await Promise.all([
    sb.from("v_paper_pnl").select("*"),
    sb
      .from("paper_orders")
      .select("*")
      .order("ordered_at", { ascending: false })
      .limit(50),
  ]);
  const pos = (positions as PaperPnL[] | null) ?? [];
  const ord = (orders as PaperOrder[] | null) ?? [];

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-lg font-semibold">模擬下單</h2>
        <form
          action={addPaperOrder}
          className="grid grid-cols-2 gap-3 md:grid-cols-6"
        >
          <input
            name="symbol"
            placeholder="股號"
            required
            className={`${inputCls} col-span-2 md:col-span-1`}
          />
          <select name="side" required className={inputCls} defaultValue="buy">
            <option value="buy">買</option>
            <option value="sell">賣</option>
          </select>
          <input
            name="qty"
            type="number"
            min="1"
            placeholder="股數"
            required
            className={inputCls}
          />
          <input
            name="price"
            type="number"
            step="0.01"
            placeholder="價格"
            required
            className={inputCls}
          />
          <input
            name="note"
            placeholder="備註"
            className={`${inputCls} col-span-2 md:col-span-1`}
          />
          <button className={`${btnCls} col-span-2 md:col-span-1`}>下單</button>
        </form>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">當前模擬部位</h2>
        {pos.length === 0 ? (
          <p className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
            沒有模擬部位
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
            <table className="w-full text-sm">
              <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
                <tr>
                  <th className="px-3 py-2">股號</th>
                  <th className="px-3 py-2 text-right">股數</th>
                  <th className="px-3 py-2 text-right">均成本</th>
                  <th className="px-3 py-2 text-right">現價</th>
                  <th className="px-3 py-2 text-right">市值</th>
                  <th className="px-3 py-2 text-right">損益</th>
                  <th className="px-3 py-2 text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {pos.map((p) => (
                  <tr key={p.symbol} className="border-t border-zinc-800">
                    <td className="px-3 py-2 font-mono">{p.symbol}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {p.net_qty}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtMoney(p.avg_cost, 2)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <PriceCell
                        value={p.current_price}
                        isProvisional={p.is_provisional}
                        date={p.price_date}
                      />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtMoney(p.market_value, 0)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${pctColor(p.unrealized_pnl)}`}
                    >
                      {fmtMoney(p.unrealized_pnl, 0)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${pctColor(p.unrealized_pct)}`}
                    >
                      {fmtPct(p.unrealized_pct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">近期下單紀錄</h2>
        {ord.length === 0 ? (
          <p className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
            沒有紀錄
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
            <table className="w-full text-sm">
              <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
                <tr>
                  <th className="px-3 py-2">時間</th>
                  <th className="px-3 py-2">股號</th>
                  <th className="px-3 py-2">買賣</th>
                  <th className="px-3 py-2 text-right">股數</th>
                  <th className="px-3 py-2 text-right">價格</th>
                  <th className="px-3 py-2">備註</th>
                </tr>
              </thead>
              <tbody>
                {ord.map((o) => (
                  <tr key={o.id} className="border-t border-zinc-800">
                    <td className="px-3 py-2 text-sm text-zinc-400">
                      {new Date(o.ordered_at).toLocaleString("zh-TW", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="px-3 py-2 font-mono">{o.symbol}</td>
                    <td
                      className={`px-3 py-2 ${o.side === "buy" ? "text-red-400" : "text-green-400"}`}
                    >
                      {o.side === "buy" ? "買" : "賣"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {o.qty}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtMoney(o.price, 2)}
                    </td>
                    <td className="px-3 py-2 text-sm text-zinc-400">
                      {o.note ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
