import { fmtMoney } from "../_components/Format";
import {
  inventorySummary,
  mmdd,
  settlementLine,
  settlementReconSummary,
  upcomingSettlements,
  type BrokerRun,
  type InventoryReconRow,
  type SettlementReconRow,
  type Summary,
  type UpcomingRow,
} from "@/lib/broker-recon-view";

// 券商對帳(富邦 broker-sync 每個交易日 18:00 寫入):持股對帳 / 待交割款 / 近日交割款對帳。
// 這是輔助資訊:資料缺或讀取失敗只顯示小字,不影響本頁其他區塊。
export function BrokerReconSection({
  run,
  recon,
  upcoming,
  settleRecon,
  today,
  loadError,
}: {
  run: BrokerRun | null;
  recon: InventoryReconRow[];
  upcoming: UpcomingRow[];
  settleRecon: SettlementReconRow[];
  today: string;
  loadError: string | null;
}) {
  if (loadError) {
    return (
      <section>
        <h2 className="mb-3 text-lg font-semibold">券商對帳</h2>
        <p className="text-xs text-zinc-500">讀取失敗：{loadError}</p>
      </section>
    );
  }

  const inv = inventorySummary(run, recon);
  const up = upcomingSettlements(upcoming, today);
  const stl = settlementReconSummary(settleRecon);
  const fetched = run
    ? new Date(run.fetched_at).toLocaleTimeString("zh-TW", {
        timeZone: "Asia/Taipei",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : null;

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">券商對帳</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Panel label="持股對帳" summary={inv} foot={run ? `快照 ${mmdd(run.snapshot_date)} ${fetched}` : undefined} />
        <div className="rounded-2xl border border-line bg-surface-1 p-4">
          <div className="text-xs text-zinc-400">待交割款（含今日）</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {up.byDate.length === 0 ? "無" : `${up.total > 0 ? "+" : ""}${fmtMoney(up.total, 0)}`}
          </div>
          <div className="space-y-0.5 text-xs text-zinc-500">
            {up.byDate.length === 0 ? (
              <div>近三日沒有待交割</div>
            ) : (
              up.byDate.map((d) => <div key={d.date}>{settlementLine(d.date, d.amount)}</div>)
            )}
          </div>
        </div>
        <Panel label="交割款對帳" summary={stl} />
      </div>
    </section>
  );
}

function Panel({ label, summary, foot }: { label: string; summary: Summary; foot?: string }) {
  const tone =
    summary.tone === "ok" ? "text-emerald-300" : summary.tone === "warn" ? "text-amber-300" : "text-zinc-400";
  return (
    <div className="rounded-2xl border border-line bg-surface-1 p-4">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone}`}>{summary.headline}</div>
      <div className="space-y-0.5 text-xs text-zinc-500">
        {summary.lines.map((l) => (
          <div key={l}>{l}</div>
        ))}
        {foot && <div>{foot}</div>}
      </div>
    </div>
  );
}
