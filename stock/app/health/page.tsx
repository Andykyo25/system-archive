import { TableShell, THead, Card, StatTile, SignalLight } from "@/app/_components/ui";
import { createClient } from "@/lib/supabase/server";
import { unwrap } from "@/lib/db";

// 資料健康(2026-07-22)
// 動機:L42/L46/L55 沉默 drift 已重演三次 —— 系統「看起來在跑」但靜靜停止收料,
//   每次都靠 Andy 肉眼發現(截圖問「這數字怎麼怪怪的」)。這頁把「資料還在不在流入」
//   變成看得見的東西。資料全部來自 v_data_health(單一事實來源,前端不自組 SQL)。
// 定位:維運頁,平時不用看;dashboard 的 DataHealthWidget 有異常才會叫你過來。

export const dynamic = "force-dynamic";

interface HealthRow {
  category: "source" | "freshness" | "quota";
  key: string;
  label: string;
  level: "ok" | "warn" | "danger";
  metric_num: number | string | null;
  metric_text: string | null;
  detail: string | null;
  last_at: string | null;
  sort_group: number;
}

// L24:完整字面字串,不動態組裝
const LEVEL_TONE = {
  ok: "ok",
  warn: "warn",
  danger: "danger",
} as const;

const LEVEL_TEXT = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
} as const;

const LEVEL_LABEL = {
  ok: "正常",
  warn: "注意",
  danger: "異常",
} as const;

const ROW_BG = {
  ok: "",
  warn: "bg-warn/5",
  danger: "bg-danger/5",
} as const;

function fmtAgo(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const min = (Date.now() - t) / 60000;
  if (min < 0) return "—";
  if (min < 60) return `${Math.round(min)} 分鐘前`;
  if (min < 60 * 24) return `${Math.round(min / 60)} 小時前`;
  return `${Math.round(min / 1440)} 天前`;
}

function HealthTable({
  rows,
  metricHead,
}: {
  rows: HealthRow[];
  metricHead: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-2xl border border-line bg-surface-1 p-6 text-center text-sm text-zinc-500">
        沒有資料
      </p>
    );
  }
  return (
    <TableShell>
      <table className="w-full text-sm">
        <THead>
          <tr>
            <th className="px-3 py-2">狀態</th>
            <th className="px-3 py-2">項目</th>
            <th className="px-3 py-2">{metricHead}</th>
            <th className="px-3 py-2">最後成功</th>
            <th className="px-3 py-2">說明</th>
          </tr>
        </THead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.category}-${r.key}`}
              className={`border-t border-line-soft ${ROW_BG[r.level]}`}
            >
              <td className="whitespace-nowrap px-3 py-2">
                <SignalLight
                  tone={LEVEL_TONE[r.level]}
                  label={LEVEL_LABEL[r.level]}
                />
              </td>
              <td className="px-3 py-2 font-medium text-zinc-200">{r.label}</td>
              <td className="whitespace-nowrap px-3 py-2 text-zinc-400">
                {r.metric_text ?? "—"}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-500">
                {r.category === "source" ? fmtAgo(r.last_at) : "—"}
              </td>
              <td className="px-3 py-2 text-xs text-zinc-500">
                {r.detail ? (
                  <span className={LEVEL_TEXT[r.level]}>{r.detail}</span>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableShell>
  );
}

export default async function HealthPage() {
  const sb = createClient();
  const res = await sb
    .from("v_data_health")
    .select("*")
    .order("sort_group")
    .order("level")
    .order("key");
  const rows = (unwrap(res, "v_data_health") as HealthRow[] | null) ?? [];

  const danger = rows.filter((r) => r.level === "danger");
  const warn = rows.filter((r) => r.level === "warn");
  const sources = rows.filter((r) => r.category === "source");
  const freshness = rows.filter((r) => r.category === "freshness");
  const quota = rows.filter((r) => r.category === "quota");

  // 排序:壞的排前面,方便一眼看到問題
  const byLevel = (a: HealthRow, b: HealthRow) => {
    const w = { danger: 0, warn: 1, ok: 2 };
    return w[a.level] - w[b.level] || a.label.localeCompare(b.label);
  };

  const overall: "ok" | "warn" | "danger" =
    danger.length > 0 ? "danger" : warn.length > 0 ? "warn" : "ok";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-zinc-100">資料健康</h1>
        <p className="mt-1 text-xs text-zinc-500">
          監控資料是否仍在流入。系統「有在跑」不等於「有在收料」——
          配額耗盡、上游 500、schema drift 都會讓 EF 正常回應但資料靜靜停更。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <StatTile
          label="整體狀態"
          value={
            <span className={LEVEL_TEXT[overall]}>{LEVEL_LABEL[overall]}</span>
          }
          sub={`${rows.length} 項檢查`}
        />
        <StatTile
          label="異常"
          value={danger.length}
          tone={danger.length > 0 ? "up" : "neutral"}
          sub="最近一次執行失敗 / 資料嚴重落後"
        />
        <StatTile
          label="注意"
          value={warn.length}
          sub="間歇失敗 / 輕微落後 / 配額吃緊"
        />
      </div>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-zinc-100">
          資料源（近 7 天）
        </h2>
        <p className="text-xs text-zinc-500">
          「異常」= 最近一次執行就失敗（現在正壞著）；「注意」= 期間曾失敗但已恢復（間歇）。
        </p>
        <HealthTable rows={[...sources].sort(byLevel)} metricHead="成功率" />
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-zinc-100">資料新鮮度</h2>
        <p className="text-xs text-zinc-500">
          比較基準是 <code className="text-zinc-400">price_daily</code>{" "}
          的最新交易日（非今天），所以週末與國定假日不會誤報。
        </p>
        <HealthTable
          rows={[...freshness].sort(byLevel)}
          metricHead="最新資料日"
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-zinc-100">今日 API 配額</h2>
        <p className="text-xs text-zinc-500">
          配額耗盡不會噴錯、EF 也不會崩，只會讓排在後面的 cron 靜靜 skip（L55）。
        </p>
        <HealthTable rows={[...quota].sort(byLevel)} metricHead="已用 / 額度" />
      </section>

      <Card title="已知且刻意不修的項目">
        <ul className="space-y-1.5 text-xs text-zinc-500">
          <li>
            <span className="text-zinc-300">tpex</span> —
            上游 TPEX 間歇性 connection reset（L06）。有 dead-letter + reconcile 補洞，主力資料不受影響。
          </li>
          <li>
            <span className="text-zinc-300">telegram_holdings_advice</span> —
            「stale price」不是 bug，是<span className="text-ok">正確的防護行為</span>：
            偵測到報價過期就不推播，避免給出假數字。
          </li>
          <li>
            <span className="text-zinc-300">backfill_price 6213</span> —
            聯茂在 FinMind 端回 HTTP 400，但主力 TWSE 正常收到，資料完整性不受影響。
          </li>
        </ul>
      </Card>
    </div>
  );
}
