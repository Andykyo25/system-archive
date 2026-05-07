import { createClient } from "@/lib/supabase/server";
import { addHolding, deleteHolding } from "./actions";
import type { Holding } from "@/lib/types";
import { fmtMoney } from "../_components/Format";

export const dynamic = "force-dynamic";

const inputCls =
  "rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none";
const btnCls =
  "rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700";

export default async function HoldingsPage() {
  const sb = createClient();
  const { data } = await sb
    .from("holdings")
    .select("*")
    .is("closed_at", null)
    .order("created_at", { ascending: false });
  const rows = (data as Holding[] | null) ?? [];

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-lg font-semibold">新增持股</h2>
        <form
          action={addHolding}
          className="grid grid-cols-1 gap-3 md:grid-cols-5"
        >
          <input
            name="symbol"
            placeholder="股號 (e.g. 2330)"
            required
            className={inputCls}
          />
          <input
            name="qty"
            type="number"
            min="1"
            placeholder="股數"
            required
            className={inputCls}
          />
          <input
            name="avg_cost"
            type="number"
            step="0.01"
            placeholder="均價"
            required
            className={inputCls}
          />
          <input name="note" placeholder="備註 (選填)" className={inputCls} />
          <button className={btnCls}>新增</button>
        </form>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">當前持股 ({rows.length})</h2>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
            沒有持股
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
            <table className="w-full text-sm">
              <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
                <tr>
                  <th className="px-3 py-2">股號</th>
                  <th className="px-3 py-2 text-right">股數</th>
                  <th className="px-3 py-2 text-right">均價</th>
                  <th className="px-3 py-2">買入日</th>
                  <th className="px-3 py-2">備註</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={h.id} className="border-t border-zinc-800">
                    <td className="px-3 py-2 font-mono">{h.symbol}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {h.qty}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtMoney(h.avg_cost, 2)}
                    </td>
                    <td className="px-3 py-2 text-sm text-zinc-400">
                      {h.opened_at}
                    </td>
                    <td className="px-3 py-2 text-sm text-zinc-400">
                      {h.note ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <form action={deleteHolding}>
                        <input type="hidden" name="id" value={h.id} />
                        <button className="text-xs text-red-400 hover:text-red-300">
                          刪除
                        </button>
                      </form>
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
