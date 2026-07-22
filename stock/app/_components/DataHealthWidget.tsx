import Link from "next/link";

// Dashboard 資料健康摘要(2026-07-22)
// 設計原則:平時不吵,有問題擋不住。
//   全綠 → 一行淡字(存在感低,但讓 Andy 知道有在監控)
//   有異常 → 紅/黃框列出前 3 項 + 連到 /health
// 動機同 /health:L42/L46/L55 沉默 drift 三次都靠肉眼發現,要讓它主動跳出來。

export interface HealthSummaryRow {
  category: string;
  key: string;
  label: string;
  level: "ok" | "warn" | "danger";
  metric_text: string | null;
  detail: string | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  source: "資料源",
  freshness: "新鮮度",
  quota: "配額",
};

/**
 * rows  = 只含 level != 'ok' 的檢查項(dashboard 端已過濾,省傳輸)
 * total = 檢查項總數(全綠時顯示「N 項全綠」用)
 */
export function DataHealthWidget({
  rows,
  total,
}: {
  rows: HealthSummaryRow[];
  total: number;
}) {
  const danger = rows.filter((r) => r.level === "danger");
  const warn = rows.filter((r) => r.level === "warn");
  const bad = [...danger, ...warn];

  if (bad.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-zinc-600">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ok"
        />
        資料管線正常（{total} 項檢查全綠）
        <Link href="/health" className="text-zinc-500 hover:text-zinc-300">
          明細 →
        </Link>
      </p>
    );
  }

  const isDanger = danger.length > 0;
  const top = bad.slice(0, 3);

  return (
    <section
      className={`rounded-2xl border p-4 ${
        isDanger
          ? "border-danger/30 bg-danger/5"
          : "border-warn/30 bg-warn/5"
      }`}
    >
      <header className="mb-2 flex items-center justify-between gap-3">
        <h2
          className={`text-sm font-semibold ${
            isDanger ? "text-danger" : "text-warn"
          }`}
        >
          {isDanger ? "⛔" : "⚠"} 資料管線異常
          <span className="ml-2 font-normal text-zinc-400">
            {danger.length > 0 && `${danger.length} 項異常`}
            {danger.length > 0 && warn.length > 0 && " · "}
            {warn.length > 0 && `${warn.length} 項注意`}
          </span>
        </h2>
        <Link
          href="/health"
          className="shrink-0 text-xs text-zinc-400 hover:text-zinc-200"
        >
          查看全部 →
        </Link>
      </header>

      <ul className="space-y-1.5">
        {top.map((r) => (
          <li key={`${r.category}-${r.key}`} className="text-xs">
            <span
              aria-hidden="true"
              className={`mr-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full align-middle ${
                r.level === "danger" ? "bg-danger" : "bg-warn"
              }`}
            />
            <span className="text-zinc-500">
              {CATEGORY_LABEL[r.category] ?? r.category}
            </span>
            <span className="mx-1.5 text-zinc-300">{r.label}</span>
            {r.metric_text && (
              <span className="text-zinc-500">{r.metric_text}</span>
            )}
            {r.detail && (
              <span className="ml-1.5 text-zinc-600">— {r.detail}</span>
            )}
          </li>
        ))}
      </ul>

      {bad.length > top.length && (
        <p className="mt-2 text-[11px] text-zinc-600">
          另有 {bad.length - top.length} 項未列出
        </p>
      )}
    </section>
  );
}
