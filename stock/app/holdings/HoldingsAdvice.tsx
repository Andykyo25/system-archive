import Link from "next/link";
import { fmtMoney, fmtPct } from "../_components/Format";

// /holdings 動態建議 widget
//
// 設計原則(Andy 風格):
// 1. 以張為單位(1 張 = 1000 股),不出零股
// 2. 單張部位:用觀察點 + 整張出(不分批)
// 3. 多張部位(≥2 張):分張賣
// 4. 5 個 threshold 從 v_holdings_advice 拿(stop / add / obs1 / obs2 / force_out)
// 5. 動態整合 factor(RSI / fund_count / signal_strength)
//
// UI: 每持股一張卡 + status badge + 建議動作 + 價位線

export interface HoldingAdviceRow {
  symbol: string;
  net_qty: number;
  avg_cost: number | string;
  lots: number;
  current_price: number | string | null;
  as_of_ts: string | null;
  price_source: string | null;
  market_state: string | null;
  pct_change: number | string | null;
  unrealized_pnl: number | string | null;
  stop_loss_price: number | string;
  add_position_price: number | string;
  obs1_price: number | string;
  obs2_price: number | string;
  force_out_price: number | string;
  expected_rank: number | null;
  weighted_score: number | string | null;
  fund_count_pos: number | null;
  fund_count_total: number | null;
  mom_count_pos: number | null;
  mom_count_total: number | null;
  chip_count_pos: number | null;
  chip_count_total: number | null;
  rsi14: number | string | null;
  fund_rev_yoy: number | null;
  mom_above_ma200: number | null;
  is_entry_signal: boolean | null;
  signal_strength: string | null;
}

// v_holdings_signals 規則層(L1+L2,純規則零 LLM)
export interface SignalEntry {
  key: string;
  label: string;
  level: "green" | "yellow" | "orange" | "red" | "gray";
  value: string;
}

export interface SignalRow {
  symbol: string;
  signal_level: "healthy" | "caution" | "warning" | "alert";
  today_chg_pct: number | string | null;
  bench_chg_pct: number | string | null;
  tail_days_5: number | null;
  down_days_5: number | null;
  signals: SignalEntry[];
}

type Status =
  | "NO_PRICE"
  | "INSUFFICIENT"
  | "STOP_LOSS"
  | "WARNING"
  | "CONSIDER_ADD"
  | "FORCE_OUT"
  | "OBS2"
  | "OBS1"
  | "FUND_WEAK"
  | "OVERHEAT"
  | "HOLD";

interface StatusInfo {
  badge: string;
  badgeColor: string;
  icon: string;
  headline: string;
  detail: string;
}

function deriveStatus(r: HoldingAdviceRow): {
  status: Status;
  info: StatusInfo;
} {
  const price = r.current_price == null ? null : Number(r.current_price);
  const pct = r.pct_change == null ? null : Number(r.pct_change);
  const rsi = r.rsi14 == null ? null : Number(r.rsi14);
  const fundPos = r.fund_count_pos ?? 0;
  const fundTotal = r.fund_count_total ?? 0;
  const lots = r.lots;

  // 單張用「觀察點+整張」,多張用「分張賣」描述
  const exitVerb = lots <= 1 ? "整張出" : `先賣 1 張(剩 ${lots - 1} 張)`;
  const stopVerb = lots <= 1 ? "整張停損" : `全部 ${lots} 張停損`;

  if (price == null || pct == null) {
    return {
      status: "NO_PRICE",
      info: {
        badge: "等資料",
        badgeColor: "bg-zinc-700 text-zinc-300",
        icon: "⏳",
        headline: "現價未取得",
        detail: "Cron 還沒抓到當日資料,等 15:30 finmind cron 或下午 4:00",
      },
    };
  }

  if (pct <= -10) {
    return {
      status: "STOP_LOSS",
      info: {
        badge: "強制停損",
        badgeColor: "bg-red-950 text-red-200",
        icon: "⛔",
        headline: `${stopVerb}`,
        detail: `現價已跌 ${pct.toFixed(2)}%(超過 -10% 紀律線)。不凹單,認錯出場。`,
      },
    };
  }

  // L42 沉默殘缺主動警示:fund+mom factor 全缺 → 排名/訊號是假象,不可默認「持續抱」。
  // 放停損之後:-10% 純價格紀律不受 factor 缺料影響,仍最優先。
  if (fundTotal === 0 && (r.mom_count_total ?? 0) === 0) {
    return {
      status: "INSUFFICIENT",
      info: {
        badge: "資料不足",
        badgeColor: "bg-red-950 text-red-200",
        icon: "🚧",
        headline: "因子無料,分析失效",
        detail:
          "基本面/動能 factor 全缺,排名與進場訊號不可信(沉默殘缺,非『沒問題』)。僅 -10% 價格紀律有效,先查資料管線是否漏抓此持股。",
      },
    };
  }

  if (pct <= -7) {
    return {
      status: "WARNING",
      info: {
        badge: "警戒",
        badgeColor: "bg-orange-950 text-orange-200",
        icon: "⚠",
        headline: "盯緊量價",
        detail: `現價 ${pct.toFixed(2)}%。今天有沒有量爆轉強(止跌訊號)?若沒,跌到 -10% 即出。`,
      },
    };
  }

  if (pct <= -5) {
    const canAdd =
      fundTotal >= 5 && fundPos >= Math.ceil(fundTotal * 0.7); // ≥70% fund 仍過
    return {
      status: "CONSIDER_ADD",
      info: {
        badge: "加碼觀察",
        badgeColor: "bg-blue-950 text-blue-200",
        icon: "🔵",
        headline: canAdd ? `可加 1 張(攤平均價)` : "暫不加碼",
        detail: canAdd
          ? `跌 ${pct.toFixed(2)}% 且基本面 ${fundPos}/${fundTotal} 仍強。加 1 張將均價降到 ~${(Number(r.avg_cost) * 0.975).toFixed(2)}。`
          : `基本面 ${fundPos}/${fundTotal} 偏弱,不建議加碼。觀察是否進一步惡化。`,
      },
    };
  }

  if (pct >= 40) {
    return {
      status: "FORCE_OUT",
      info: {
        badge: "強制停利",
        badgeColor: "bg-red-950 text-red-200",
        icon: "🚀",
        headline: lots <= 1 ? "整張出" : "整批出",
        detail: `現價漲 +${pct.toFixed(2)}%,末段勿貪。歷史經驗:此區段反轉機率高。`,
      },
    };
  }

  if (pct >= 30) {
    return {
      status: "OBS2",
      info: {
        badge: "第二觀察",
        badgeColor: "bg-amber-950 text-amber-200",
        icon: "📈",
        headline: `${exitVerb} OR 看法人方向`,
        detail: `+${pct.toFixed(2)}%。看法人是否還連續買超,若弱(或 RSI > 85)就 ${exitVerb}。`,
      },
    };
  }

  if (pct >= 20) {
    const overheatHint = rsi != null && rsi > 75 ? "(RSI 已過熱)" : "";
    return {
      status: "OBS1",
      info: {
        badge: "第一觀察",
        badgeColor: "bg-emerald-950 text-emerald-200",
        icon: "📊",
        headline: `第一觀察點${overheatHint}`,
        detail: `+${pct.toFixed(2)}%。${rsi != null ? `RSI=${rsi.toFixed(0)} ` : ""}若 RSI < 80 且法人仍買 → 抱;否則考慮 ${exitVerb}。`,
      },
    };
  }

  if (fundTotal >= 4 && fundPos < 3) {
    return {
      status: "FUND_WEAK",
      info: {
        badge: "基本面轉弱",
        badgeColor: "bg-orange-950 text-orange-200",
        icon: "📉",
        headline: `考慮 ${exitVerb}`,
        detail: `基本面跌到 ${fundPos}/${fundTotal}(月營收 YoY ${r.fund_rev_yoy === 1 ? "正" : "負/缺"}),持有理由破壞。`,
      },
    };
  }

  if (rsi != null && rsi > 80) {
    return {
      status: "OVERHEAT",
      info: {
        badge: "RSI 過熱",
        badgeColor: "bg-amber-950 text-amber-200",
        icon: "🔥",
        headline: "隨時準備出",
        detail: `RSI ${rsi.toFixed(0)} > 80,通常代表獲利了結賣壓快出現。觀察隔天動能,若轉跌就 ${exitVerb}。`,
      },
    };
  }

  return {
    status: "HOLD",
    info: {
      badge: "持續抱",
      badgeColor: "bg-zinc-800 text-zinc-200",
      icon: "✓",
      headline: "符合紀律,繼續持有",
      detail: `現價 ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%,基本面 ${fundPos}/${fundTotal}${rsi != null ? `,RSI ${rsi.toFixed(0)}` : ""}。等下個觀察點。`,
    },
  };
}

export function HoldingsAdvice({
  rows,
  signalsMap,
}: {
  rows: HoldingAdviceRow[];
  signalsMap?: Record<string, SignalRow>;
}) {
  if (rows.length === 0) {
    return (
      <section>
        <h2 className="mb-3 text-lg font-semibold">動態建議</h2>
        <p className="rounded-2xl border border-line bg-surface-1 p-6 text-center text-sm text-zinc-500">
          目前無持股 — 沒有需要分析的部位
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">動態建議</h2>
      <div className="grid grid-cols-1 gap-3">
        {rows.map((r) => (
          <AdviceCard
            key={r.symbol}
            row={r}
            signal={signalsMap?.[r.symbol]}
          />
        ))}
      </div>
    </section>
  );
}

// 訊號燈顏色 + emoji map(配合 SQL view 的 5 level)
const SIGNAL_STYLE: Record<
  SignalEntry["level"],
  { dot: string; bg: string; border: string; text: string; emoji: string }
> = {
  green: {
    dot: "bg-emerald-500",
    bg: "bg-emerald-950/40",
    border: "border-emerald-900",
    text: "text-emerald-200",
    emoji: "🟢",
  },
  yellow: {
    dot: "bg-yellow-500",
    bg: "bg-yellow-950/40",
    border: "border-yellow-900",
    text: "text-yellow-200",
    emoji: "🟡",
  },
  orange: {
    dot: "bg-orange-500",
    bg: "bg-orange-950/40",
    border: "border-orange-900",
    text: "text-orange-200",
    emoji: "🟠",
  },
  red: {
    dot: "bg-red-500",
    bg: "bg-red-950/40",
    border: "border-red-900",
    text: "text-red-200",
    emoji: "🔴",
  },
  gray: {
    dot: "bg-zinc-600",
    bg: "bg-zinc-900",
    border: "border-zinc-800",
    text: "text-zinc-500",
    emoji: "⚪",
  },
};

const LEVEL_STYLE: Record<
  SignalRow["signal_level"],
  { label: string; badge: string }
> = {
  healthy: { label: "健康", badge: "bg-emerald-950 text-emerald-200" },
  caution: { label: "注意", badge: "bg-yellow-950 text-yellow-200" },
  warning: { label: "警告", badge: "bg-orange-950 text-orange-200" },
  alert: { label: "警報", badge: "bg-red-950 text-red-200" },
};

// 主燈白名單:直接影響「該不該出場/加碼」的 6 個出場/警戒訊號。
// 順序即主燈區排列順序(穩定,不隨 SQL 吐出順序變動)。
// 其餘 key(chip/mom/fund/ma_arrange/ma20_dev/obs1_dist/ret_60d/mcap_tier/boll)為資訊性背景,收進「更多訊號」摺疊。
const PRIMARY_SIGNAL_KEYS = [
  "stop_buffer", // 距停損
  "vs_bench", // vs 0050
  "vol_div", // 量價背離
  "tail", // 長上影
  "down_streak", // 連跌
  "rsi", // 過熱
] as const;

// 次要燈達此 level 即「冒泡」到主區(高警示不該藏在摺疊裡)
const ESCALATE_LEVELS: ReadonlySet<SignalEntry["level"]> = new Set([
  "red",
  "orange",
]);

function SignalCell({ s }: { s: SignalEntry }) {
  const st = SIGNAL_STYLE[s.level];
  return (
    <div
      className={`flex flex-col items-start gap-0.5 rounded border ${st.border} ${st.bg} px-2 py-1.5`}
      title={`${s.label}: ${s.value}`}
    >
      <div className="flex w-full items-center gap-1">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${st.dot}`} />
        <span className="truncate text-[10px] text-zinc-400">{s.label}</span>
      </div>
      <span
        className={`block w-full truncate font-mono text-[11px] font-semibold ${st.text}`}
      >
        {s.value}
      </span>
    </div>
  );
}

function SignalsGrid({ signal }: { signal: SignalRow }) {
  const lv = LEVEL_STYLE[signal.signal_level];

  const byKey = new Map(signal.signals.map((s) => [s.key, s]));
  const primaryKeySet: ReadonlySet<string> = new Set(PRIMARY_SIGNAL_KEYS);

  // 主燈:依白名單固定順序取(SQL 漏吐某 key 就跳過,容錯)
  const primary = PRIMARY_SIGNAL_KEYS.map((k) => byKey.get(k)).filter(
    (s): s is SignalEntry => s != null,
  );

  // 次要:非主燈的其餘訊號,保留 SQL 原始順序
  const secondary = signal.signals.filter((s) => !primaryKeySet.has(s.key));

  // 冒泡:次要燈裡達 red/orange 的提升到主區(附「更多」標記),其餘留摺疊
  const escalated = secondary.filter((s) => ESCALATE_LEVELS.has(s.level));
  const collapsed = secondary.filter((s) => !ESCALATE_LEVELS.has(s.level));

  return (
    <div className="border-t border-line-soft px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          重點訊號
        </span>
        <span
          className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${lv.badge}`}
        >
          綜合 · {lv.label}
        </span>
      </div>

      {/* 主燈 + 冒泡的高警示次要燈 */}
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-6">
        {primary.map((s) => (
          <SignalCell key={s.key} s={s} />
        ))}
        {escalated.map((s) => (
          <SignalCell key={s.key} s={s} />
        ))}
      </div>

      {/* 次要(資訊/背景)訊號:預設收合 */}
      {collapsed.length > 0 && (
        <details className="group mt-2">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300">
            <span className="transition-transform group-open:rotate-90">▸</span>
            更多訊號 ({collapsed.length})
          </summary>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-6">
            {collapsed.map((s) => (
              <SignalCell key={s.key} s={s} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function AdviceCard({
  row,
  signal,
}: {
  row: HoldingAdviceRow;
  signal?: SignalRow;
}) {
  const { info } = deriveStatus(row);
  const pct = row.pct_change == null ? null : Number(row.pct_change);
  const pctColor =
    pct == null
      ? "text-zinc-400"
      : pct > 0
        ? "text-red-400"
        : pct < 0
          ? "text-green-400"
          : "text-zinc-300";
  const asOf = row.as_of_ts
    ? new Date(row.as_of_ts).toLocaleString("zh-TW", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface-1">
      {/* Header */}
      <header className="flex items-center justify-between gap-3 border-b border-line bg-zinc-950 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Link
            href={`/stocks/${row.symbol}`}
            className="font-mono text-sm font-semibold text-zinc-100 hover:underline"
          >
            {row.symbol}
          </Link>
          <span className="text-xs text-zinc-500">
            {row.lots} 張 · 均價 {fmtMoney(row.avg_cost, 2)}
          </span>
        </div>
        <span
          className={`rounded-md px-2.5 py-0.5 text-xs font-semibold ${info.badgeColor}`}
        >
          {info.icon} {info.badge}
        </span>
      </header>

      {/* 主訊息 */}
      <div className="px-4 py-3">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium text-zinc-200">
            {info.headline}
          </span>
          <span className={`tabular-nums text-sm font-semibold ${pctColor}`}>
            {row.current_price != null && (
              <>
                {fmtMoney(row.current_price, 2)}
                <span className="ml-2 text-xs">
                  ({pct != null && pct >= 0 ? "+" : ""}
                  {fmtPct(row.pct_change)})
                </span>
              </>
            )}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-zinc-400">{info.detail}</p>
      </div>

      {/* 即時訊號燈(v_holdings_signals 規則層) */}
      {signal && <SignalsGrid signal={signal} />}

      {/* 價位線 */}
      <div className="grid grid-cols-5 gap-0 border-t border-line-soft text-[10px]">
        <PriceTick
          label="停損"
          value={row.stop_loss_price}
          tag="-10%"
          color="text-red-400"
        />
        <PriceTick
          label="加碼"
          value={row.add_position_price}
          tag="-5%"
          color="text-blue-400"
        />
        <PriceTick
          label="觀察 1"
          value={row.obs1_price}
          tag="+20%"
          color="text-emerald-400"
        />
        <PriceTick
          label="觀察 2"
          value={row.obs2_price}
          tag="+30%"
          color="text-amber-400"
        />
        <PriceTick
          label="強制出"
          value={row.force_out_price}
          tag="+40%"
          color="text-red-400"
        />
      </div>

      {/* Footer:系統 factor + timestamp */}
      <footer className="flex items-center justify-between border-t border-line-soft bg-zinc-950 px-4 py-2 text-[10px] text-zinc-500">
        <span>
          系統排名 #{row.expected_rank ?? "-"} · fund {row.fund_count_pos ?? 0}/
          {row.fund_count_total ?? 0} · mom {row.mom_count_pos ?? 0}/
          {row.mom_count_total ?? 0}
          {row.rsi14 != null && ` · RSI ${Number(row.rsi14).toFixed(0)}`}
          {row.is_entry_signal && (
            <span className="ml-1.5 text-yellow-400">⭐ {row.signal_strength}</span>
          )}
        </span>
        <span>{asOf && `截至 ${asOf}`}</span>
      </footer>
    </div>
  );
}

function PriceTick({
  label,
  value,
  tag,
  color,
}: {
  label: string;
  value: number | string;
  tag: string;
  color: string;
}) {
  return (
    <div className="border-r border-zinc-800 px-2 py-2 last:border-r-0">
      <div className={`font-semibold ${color}`}>{label}</div>
      <div className="font-mono text-zinc-300 tabular-nums">
        {fmtMoney(value, 2)}
      </div>
      <div className="text-zinc-600">{tag}</div>
    </div>
  );
}
