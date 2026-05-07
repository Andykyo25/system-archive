import { createClient } from "@/lib/supabase/server";
import { addWatch, removeWatch } from "./actions";
import type { Watchlist } from "@/lib/types";

export const dynamic = "force-dynamic";

const inputCls =
  "rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none";
const btnCls =
  "rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700";

export default async function WatchlistPage() {
  const sb = createClient();
  const { data } = await sb
    .from("watchlist")
    .select("*")
    .order("added_at", { ascending: false });
  const rows = (data as Watchlist[] | null) ?? [];

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-lg font-semibold">加入觀察</h2>
        <form
          action={addWatch}
          className="grid grid-cols-1 gap-3 md:grid-cols-3"
        >
          <input
            name="symbol"
            placeholder="股號"
            required
            className={inputCls}
          />
          <input name="note" placeholder="備註 (選填)" className={inputCls} />
          <button className={btnCls}>加入</button>
        </form>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">
          Watchlist ({rows.length})
        </h2>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
            沒有 watchlist,加進來的股號 cron 才會抓
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
            <table className="w-full text-sm">
              <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
                <tr>
                  <th className="px-3 py-2">股號</th>
                  <th className="px-3 py-2">加入時間</th>
                  <th className="px-3 py-2">備註</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.id} className="border-t border-zinc-800">
                    <td className="px-3 py-2 font-mono">{w.symbol}</td>
                    <td className="px-3 py-2 text-sm text-zinc-400">
                      {new Date(w.added_at).toLocaleDateString("zh-TW")}
                    </td>
                    <td className="px-3 py-2 text-sm text-zinc-400">
                      {w.note ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <form action={removeWatch}>
                        <input type="hidden" name="id" value={w.id} />
                        <button className="text-xs text-red-400 hover:text-red-300">
                          移除
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
