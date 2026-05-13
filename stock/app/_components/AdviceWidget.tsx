import Link from "next/link";

// 「給 Andy 的建議」widget
//
// 4 個 section:
//   1. 出場紀律(靜態文字 — 分批停利)
//   2. 分散產業(動態:從 fund>=5/5 非半導體挑 1-2 檔)
//   3. 可關注標的(動態:v_stock_rank top 5, fund>=5/5,不在 holdings 內)
//   4. 避免追的(hardcode)

export interface AdvicePickRow {
  symbol: string;
  name: string | null;
  weighted_score: number | string | null;
  fund_count_pos: number;
  fund_count_total: number;
  industry: string | null; // 從 industry_stocks 推
}

const AVOID_HARDCODE: { symbol: string; name: string; reason: string }[] = [
  { symbol: "2454", name: "聯發科", reason: "EPS 預估下修 + PB 偏高" },
  { symbol: "3711", name: "日月光投控", reason: "PEG 2.38 過高 + FCF 受 CapEx 拖累" },
  { symbol: "3035", name: "智原", reason: "估值偏貴 + 客戶集中度高" },
];

const SEMI_KEYWORDS = ["半導體", "電子零組件", "晶圓", "封測", "IC設計"];

function isSemi(industry: string | null): boolean {
  if (!industry) return false;
  return SEMI_KEYWORDS.some((k) => industry.includes(k));
}

export function AdviceWidget({ picks }: { picks: AdvicePickRow[] }) {
  // 非半導體挑 1-2 檔做對沖建議
  const nonSemi = picks.filter((p) => !isSemi(p.industry)).slice(0, 2);
  // 可關注標的:top 5 整體
  const top5 = picks.slice(0, 5);

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900">
      <header className="border-b border-zinc-800 px-4 py-3">
        <h2 className="text-base font-semibold text-zinc-100">
          給 Andy 的建議
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          基於你目前的交易風格與持股分布。系統用基本面 7 條 + 動能 5(加突破 + 站上 MA200)+ 反轉 2 + 籌碼 5,共 19 因子;
          進場訊號 = 基本面 ≥ 3 條 + 月營收 YoY 必須正 + 動能 ≥ 2 條。
        </p>
      </header>

      <div className="grid grid-cols-1 gap-0 md:grid-cols-2">
        <AdviceCard
          title="出場紀律"
          accent="amber"
          icon="🎯"
          body={
            <>
              <p>
                你目前勝率 100% 但容易太早出場(2408 兩天 +23% 跑掉,PEG
                0.05 本可抱更長)。**你只買整張不買零股**,所以不分批,改用觀察點:
              </p>
              <p className="mt-2 font-medium text-zinc-300">單張部位:</p>
              <ul className="mt-0.5 list-inside list-disc space-y-0.5 text-zinc-400">
                <li>+20% 觀察點(看 RSI 是否 &lt; 80,若還強 → 抱)</li>
                <li>+30% 第二觀察點(看法人是否還連買 → 弱就整張出)</li>
                <li>+40% 強制整張出(末段勿貪)</li>
                <li>-10% 強制整張停損(認錯)</li>
              </ul>
              <p className="mt-2 font-medium text-zinc-300">多張部位(≥2 張):</p>
              <ul className="mt-0.5 list-inside list-disc space-y-0.5 text-zinc-400">
                <li>+20% 出 1 張(回收成本)</li>
                <li>+40% 再出 1 張</li>
                <li>剩餘抱到基本面反轉或跌破 MA20</li>
              </ul>
            </>
          }
        />

        <AdviceCard
          title="分散產業"
          accent="rose"
          icon="⚠"
          body={
            <>
              <p>
                你近期集中半導體 + AI ETF。一旦類股回檔,整體曝險過大。
              </p>
              <p className="mt-1 font-medium text-zinc-300">
                建議對沖標的(非半導體 + 基本面強):
              </p>
              {nonSemi.length === 0 ? (
                <p className="mt-1 text-zinc-500">
                  (資料累積中,稍後再推薦)
                </p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {nonSemi.map((p) => (
                    <li key={p.symbol}>
                      <Link
                        href={`/stocks/${p.symbol}`}
                        className="inline-flex items-center gap-1.5 rounded-md border border-rose-900/40 bg-rose-950/20 px-2 py-0.5 text-rose-200 hover:bg-rose-950/40"
                      >
                        <span className="font-mono">{p.symbol}</span>
                        <span className="text-rose-300">{p.name ?? "—"}</span>
                        {p.industry && (
                          <span className="ml-1 text-[10px] text-rose-400/70">
                            {p.industry}
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[11px] text-zinc-500">
                * 推薦標的不代表買進建議,僅顯示符合基本面門檻者
              </p>
            </>
          }
        />

        <AdviceCard
          title="可關注標的"
          accent="emerald"
          icon="⭐"
          body={
            <>
              <p>排名 top 5 + 基本面達標,等回檔或進場訊號浮現時可加入觀察:</p>
              {top5.length === 0 ? (
                <p className="mt-1 text-zinc-500">
                  (factor 資料累積中)
                </p>
              ) : (
                <ul className="mt-1.5 space-y-1">
                  {top5.map((p, idx) => (
                    <li
                      key={p.symbol}
                      className="flex items-center justify-between rounded-md border border-emerald-900/30 bg-emerald-950/15 px-2 py-1 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-emerald-500/70 tabular-nums">
                          #{idx + 1}
                        </span>
                        <Link
                          href={`/stocks/${p.symbol}`}
                          className="font-mono text-emerald-200 hover:underline"
                        >
                          {p.symbol}
                        </Link>
                        <span className="text-zinc-400">
                          {p.name ?? "—"}
                        </span>
                      </div>
                      <span className="text-emerald-400/80 tabular-nums">
                        {fmt(p.weighted_score)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Link
                href="/rank"
                className="mt-2 inline-block text-[11px] text-emerald-400/80 hover:text-emerald-300"
              >
                看完整排名 →
              </Link>
            </>
          }
        />

        <AdviceCard
          title="避免追高"
          accent="zinc"
          icon="🚫"
          body={
            <>
              <p>以下標的目前估值偏貴或基本面下行,即使線型強也不建議追:</p>
              <ul className="mt-1.5 space-y-1">
                {AVOID_HARDCODE.map((a) => (
                  <li
                    key={a.symbol}
                    className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/stocks/${a.symbol}`}
                        className="font-mono text-zinc-300 hover:underline"
                      >
                        {a.symbol}
                      </Link>
                      <span className="text-zinc-500">{a.name}</span>
                    </div>
                    <span className="text-zinc-500">{a.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          }
        />
      </div>
    </section>
  );
}

function fmt(n: string | number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

type Accent = "amber" | "rose" | "emerald" | "zinc";

const ACCENT_DOT: Record<Accent, string> = {
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  emerald: "bg-emerald-500",
  zinc: "bg-zinc-500",
};

function AdviceCard({
  title,
  body,
  accent,
  icon,
}: {
  title: string;
  body: React.ReactNode;
  accent: Accent;
  icon: string;
}) {
  return (
    <div className="border-b border-zinc-800 px-4 py-4 last:border-b-0 md:border-r md:[&:nth-child(2n)]:border-r-0">
      <div className="mb-2 flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${ACCENT_DOT[accent]}`} />
        <span className="text-sm font-semibold text-zinc-100">{title}</span>
        <span aria-hidden="true" className="ml-auto text-base opacity-60">
          {icon}
        </span>
      </div>
      <div className="text-xs leading-relaxed text-zinc-400">{body}</div>
    </div>
  );
}
