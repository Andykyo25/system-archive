// 顯示用 helpers
// 注意:台股配色慣例 → 紅 = 漲、綠 = 跌(與美股相反)

export function fmtMoney(
  n: string | number | null | undefined,
  digits = 0,
): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("zh-TW", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(n: string | number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function pctColor(n: string | number | null | undefined): string {
  if (n == null) return "text-zinc-400";
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return "text-zinc-400";
  return v > 0 ? "text-red-400" : "text-green-400";
}

// 集中度配色(部位市值 / 資本 %):>100 超額紅、>60 橘、>30 黃(BuyForm sizing + /holdings 占比共用)
export function concentrationClass(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "text-zinc-400";
  if (pct > 100) return "text-red-400 font-semibold";
  if (pct > 60) return "text-orange-400";
  if (pct > 30) return "text-amber-400";
  return "text-zinc-400";
}

// 把資料來源 + 時間戳壓縮成一行可讀字
// intraday(twse_mis / yahoo / etc.):「N min ago · twse_mis」
// 今日收盤(twse_today):「今日收盤」
// 昨日/更早收盤(twse_yesterday):「YYYY-MM-DD 收盤」
// FinMind:「YYYY-MM-DD · FinMind 備案」
// fallback:傳 date 字串
export function formatPriceTimestamp(
  asOfTs: string | null | undefined,
  source: string | null | undefined,
  fallbackDate?: string | null,
): { text: string; tooltip: string; provisional: boolean } {
  // 來自 daily 表的 date(沒 time component)
  if (!asOfTs && fallbackDate) {
    return {
      text: `${fallbackDate} 收盤`,
      tooltip: `主力資料(TWSE/TPEX)${fallbackDate}`,
      provisional: false,
    };
  }

  if (!asOfTs) {
    return { text: "—", tooltip: "無資料", provisional: false };
  }

  // intraday 即時報價(twse_mis / twse_mis_mid 五檔中價 / yahoo / 其他)
  if (source === "twse_mis" || source === "twse_mis_mid" || source === "yahoo") {
    const ago = minutesAgo(asOfTs);
    const label = source === "twse_mis"
      ? "TWSE MIS 揭示(成交價)"
      : source === "twse_mis_mid"
      ? "TWSE MIS 五檔中價(z 被 throttle 時 fallback)"
      : "Yahoo Finance";
    // mid 標明非實際成交價
    const tag = source === "twse_mis_mid" ? "twse_mis(中價)" : source;
    const text = ago == null ? `即時 · ${tag}` : `${ago} min ago · ${tag}`;
    return {
      text,
      tooltip: `${label} ${formatLocalDateTime(asOfTs)}`,
      provisional: false,
    };
  }

  // 今日收盤(主力資料當天就到)
  if (source === "twse_today") {
    const d = asOfTs.slice(0, 10);
    return {
      text: "今日收盤",
      tooltip: `TWSE/TPEX 主力 ${d}`,
      provisional: false,
    };
  }

  // 昨日 / 更早收盤
  if (source === "twse_yesterday") {
    const d = asOfTs.slice(0, 10);
    return {
      text: `${d} 收盤`,
      tooltip: `TWSE/TPEX 主力 ${d}(尚無今日收盤)`,
      provisional: false,
    };
  }

  // FinMind 備案
  if (source === "finmind") {
    const d = asOfTs.slice(0, 10);
    return {
      text: `${d} · FinMind`,
      tooltip: `FinMind 備案資料 ${d}`,
      provisional: true,
    };
  }

  // 主力 source 但走 daily 表(預設情境)
  const d = asOfTs.slice(0, 10);
  return {
    text: `${d} 收盤`,
    tooltip: `${source ?? "主力"} ${d}`,
    provisional: false,
  };
}

// 把 ISO timestamp 跟現在比,小於 60 min 顯示 N、小於 24h 顯示 H、再老就 null
function minutesAgo(iso: string): string | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diffMin = (Date.now() - t) / 60000;
  if (!Number.isFinite(diffMin) || diffMin < 0) return null;
  if (diffMin < 1) return "<1";
  if (diffMin < 60) return String(Math.round(diffMin));
  if (diffMin < 60 * 24) {
    const h = diffMin / 60;
    return `${h.toFixed(0)}h`;
  }
  return null;
}

function formatLocalDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-TW", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}
