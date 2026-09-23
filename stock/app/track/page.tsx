import Link from "next/link";
import { unstable_cache } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { readAll, unwrap } from "@/lib/db";
import { TableShell, THead } from "@/app/_components/ui";
import { fmtMoney, fmtPct, pctColor } from "@/app/_components/Format";
import {
  SYSTEMS,
  VERDICT,
  horizonStats,
  sortPicks,
  toNum,
  verdictCounts,
  type Horizon,
  type PickRow,
  type TrackSort,
  type TrackSystem,
  type Verdict,
} from "@/lib/track";
import { PATTERN_LABEL, type VerdictRow } from "@/lib/scan";

export const dynamic = "force-dynamic";

type PatternStat = Pick<VerdictRow, "pattern" | "n10" | "up10_pct"> & {
  confidence: VerdictRow["confidence"] | null;
};

const loadPatterns = unstable_cache(async () => {
  const sb = createClient();
  const res = await sb
    .from("v_scan_pattern_stats")
    .select("pattern,n10,up10_pct,confidence")
    .order("pattern");
  return (unwrap(res, "型態勝率") ?? []) as PatternStat[];
}, ["track:patterns:v2"], { revalidate: 300 });

// mv_pick_scorecard 平日 15:30 / 22:30 刷新,頁面快取 5 分鐘足夠。
const loadPicks = unstable_cache(async () => {
  const sb = createClient();
  const result = await readAll<PickRow>((from, to) =>
    sb
      .from("mv_pick_scorecard")
      .select("*")
      .order("pick_id")
      .range(from, to),
  );
  return unwrap(result, "選股成績單") ?? [];
}, ["track:picks:v1"], { revalidate: 300 });

const SYSTEM_KEYS = Object.keys(SYSTEMS) as TrackSystem[];
const VERDICT_FILTERS: { key: Verdict | "all"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "win", label: "✅ 漲且贏大盤" },
  { key: "lag", label: "⚠️ 漲但輸大盤" },
  { key: "loss", label: "❌ 跌" },
  { key: "pending", label: "⏳ 未到期" },
];
const SORTS: { key: TrackSort; label: string }[] = [
  { key: "recent", label: "最新" },
  { key: "best", label: "最好" },
  { key: "worst", label: "最差" },
];
const LIST_LIMIT = 300;

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

function href(sys: TrackSystem, v: Verdict | "all", sort: TrackSort) {
  const q = new URLSearchParams({ sys });
  if (v !== "all") q.set("v", v);
  if (sort !== "recent") q.set("sort", sort);
  return `/track?${q.toString()}`;
}

function Pct({ v }: { v: number | null }) {
  return <span className={pctColor(v)}>{fmtPct(v)}</span>;
}

const pill =
  "rounded-lg px-2.5 py-1 text-xs transition-colors";
const pillOn = "bg-sky-400/10 font-medium text-sky-200 ring-1 ring-inset ring-sky-300/20";
const pillOff = "text-zinc-400 hover:bg-surface-2 hover:text-zinc-100";

export default async function TrackPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const sys = pick(sp.sys, SYSTEM_KEYS, "scan");
  const vf = pick(sp.v, ["all", "win", "lag", "up", "loss", "pending"] as const, "all");
  const sort = pick(sp.sort, ["recent", "best", "worst"] as const, "recent");

  const [all, patterns] = await Promise.all([loadPicks(), loadPatterns()]);
  const refreshedAt = all[0]?.refreshed_at ?? null;
  const bySys = new Map<TrackSystem, PickRow[]>(
    SYSTEM_KEYS.map((k) => [k, all.filter((r) => r.system === k)]),
  );
  const rows = bySys.get(sys) ?? [];
  const cfg = SYSTEMS[sys];
  const filtered = sortPicks(
    vf === "all" ? rows : rows.filter((r) => r.verdict === vf),
    sort,
  );
  const shown = filtered.slice(0, LIST_LIMIT);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">選股成績單</h1>
        {refreshedAt && (
          <p className="mt-1 text-xs text-zinc-500">
            更新於{" "}
            {new Date(refreshedAt).toLocaleString("zh-TW", {
              timeZone: "Asia/Taipei",
              hour12: false,
            })}
          </p>
        )}
      </div>

      {/* 四套系統總覽:點卡片切換 */}
      <nav className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="選股系統">
        {SYSTEM_KEYS.map((k) => {
          const rs = bySys.get(k) ?? [];
          const c = verdictCounts(rs);
          const settled = rs.length - c.pending;
          const upShare = settled ? ((c.win + c.lag + c.up) / settled) * 100 : null;
          const active = k === sys;
          return (
            <Link
              key={k}
              href={href(k, "all", "recent")}
              aria-current={active ? "page" : undefined}
              className={`surface-card rounded-2xl p-4 transition-colors ${active ? "ring-1 ring-sky-300/30" : "hover:bg-white/[0.03]"}`}
            >
              <p className="text-xs text-zinc-500">{SYSTEMS[k].label}</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight">
                {upShare == null ? "—" : `${upShare.toFixed(0)}%`}
                <span className="ml-1 text-xs font-normal text-zinc-500">上漲</span>
              </p>
              <p className="mt-1 text-xs text-zinc-400">
                ✅ {c.win + c.up} · ⚠️ {c.lag} · ❌ {c.loss}
                <span className="text-zinc-500"> · ⏳ {c.pending}</span>
              </p>
            </Link>
          );
        })}
      </nav>

      {/* 所選系統:分天期統計 */}
      <section className="surface-card rounded-2xl p-4">
        <h2 className="text-sm font-semibold">{cfg.label} · 分天期表現</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <THead>
              <tr>
                <th className="py-2 pr-3 font-medium">天期</th>
                <th className="py-2 pr-3 text-right font-medium">樣本</th>
                <th className="py-2 pr-3 text-right font-medium">上漲比例</th>
                <th className="py-2 pr-3 text-right font-medium">贏大盤</th>
                <th className="py-2 text-right font-medium">報酬中位數</th>
              </tr>
            </THead>
            <tbody className="divide-y divide-line">
              {cfg.horizons.map((h: Horizon) => {
                const s = horizonStats(rows, h);
                return (
                  <tr key={h}>
                    <td className="py-2 pr-3">T+{h}</td>
                    {s == null ? (
                      <td colSpan={4} className="py-2 text-right text-zinc-500">
                        尚無到期樣本
                      </td>
                    ) : (
                      <>
                        <td className="py-2 pr-3 text-right tabular-nums">{s.n}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {s.upPct == null ? "—" : `${s.upPct.toFixed(0)}%`}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {s.beatPct == null ? "—" : `${s.beatPct.toFixed(0)}%`}
                        </td>
                        <td className="py-2 text-right tabular-nums"><Pct v={s.medianRet} /></td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 起漲掃描:型態勝率 → 決定「今日看多」上榜與否 */}
      {sys === "scan" && patterns.length > 0 && (
        <section className="surface-card rounded-2xl p-4">
          <h2 className="text-sm font-semibold">型態勝率 · 決定今日看多</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <THead>
                <tr>
                  <th className="py-2 pr-3 font-medium">型態</th>
                  <th className="py-2 pr-3 text-right font-medium">樣本</th>
                  <th className="py-2 pr-3 text-right font-medium">10 日上漲</th>
                  <th className="py-2 text-right font-medium">結論</th>
                </tr>
              </THead>
              <tbody className="divide-y divide-line">
                {patterns.map((p) => (
                  <tr key={p.pattern}>
                    <td className="py-2 pr-3">{PATTERN_LABEL[p.pattern]}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{p.n10}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {Number(p.up10_pct).toFixed(0)}%
                    </td>
                    <td className="py-2 text-right">
                      {p.confidence ? (
                        <span className="text-rose-300">看多 · 信心{p.confidence}</span>
                      ) : (
                        <span className="text-zinc-500">不列入</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 逐檔清單 */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label="判定篩選">
            {VERDICT_FILTERS.map((f) => (
              <Link
                key={f.key}
                href={href(sys, f.key, sort)}
                className={`${pill} ${vf === f.key ? pillOn : pillOff}`}
              >
                {f.label}
              </Link>
            ))}
          </div>
          <div className="flex gap-1" role="group" aria-label="排序">
            {SORTS.map((s) => (
              <Link
                key={s.key}
                href={href(sys, vf, s.key)}
                className={`${pill} ${sort === s.key ? pillOn : pillOff}`}
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>

        <TableShell>
          <table className="w-full min-w-[820px] text-sm">
            <THead>
              <tr>
                <th className="px-3 py-2 font-medium">挑選日</th>
                <th className="px-3 py-2 font-medium">股票</th>
                <th className="px-3 py-2 text-right font-medium">
                  {sys === "rank" || sys === "swing" ? "名次" : sys === "mine" ? "來源" : "分數"}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {sys === "mine" ? "成交價" : sys === "rank" ? "進場(還原)" : "訊號價"}
                </th>
                <th className="px-3 py-2 text-right font-medium">T+5</th>
                <th className="px-3 py-2 text-right font-medium">T+10</th>
                <th className="px-3 py-2 text-right font-medium">T+20</th>
                <th className="px-3 py-2 font-medium">判定</th>
              </tr>
            </THead>
            <tbody className="divide-y divide-line">
              {shown.map((r) => {
                const v = VERDICT[r.verdict];
                const exc = toNum(r.verdict_exc);
                return (
                  <tr key={r.pick_id} className="hover:bg-white/[0.02]">
                    <td className="px-3 py-2 tabular-nums text-zinc-400">{r.pick_date}</td>
                    <td className="px-3 py-2">
                      <Link href={`/stocks/${r.symbol}`} className="hover:text-sky-300">
                        <span className="tabular-nums">{r.symbol}</span>
                        <span className="ml-1.5 text-zinc-400">{r.name ?? ""}</span>
                      </Link>
                      {r.tag && sys !== "mine" && (
                        <span className="ml-1.5 rounded border border-line px-1 text-[11px] text-zinc-500">
                          {r.tag}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                      {sys === "mine"
                        ? <span className="text-xs text-zinc-400">{r.tag}</span>
                        : sys === "scan"
                          ? fmtMoney(r.score)
                          : r.pick_rank ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.entry_px, 2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums"><Pct v={toNum(r.ret_5)} /></td>
                    <td className="px-3 py-2 text-right tabular-nums"><Pct v={toNum(r.ret_10)} /></td>
                    <td className="px-3 py-2 text-right tabular-nums"><Pct v={toNum(r.ret_20)} /></td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span>{v.icon} {v.label}</span>
                      {r.verdict !== "pending" && (
                        <span className="ml-1.5 text-xs text-zinc-500">
                          T+{r.verdict_h}
                          {exc != null && <> · 超額 <Pct v={exc} /></>}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-zinc-500">
                    沒有符合條件的紀錄
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableShell>
        <p className="text-xs leading-5 text-zinc-500">
          共 {filtered.length} 筆{filtered.length > LIST_LIMIT && `，顯示前 ${LIST_LIMIT} 筆`}
        </p>
      </section>
    </div>
  );
}
