// notify-holdings-telegram
//
// 讀 v_holdings_advice → 算每持股 status → 組 Telegram 訊息 → 送到 bot
//
// Vault secrets 需 Andy 先設:
//   - telegram_bot_token: BotFather 給的 token
//   - telegram_chat_id:   你跟 bot 對話 + getUpdates 拿到的 chat_id
//
// Cron:13:35 Taipei (UTC 05:35) 平日(收盤後 5 分鐘)
//
// 設計筆記:
// - 沒持股 → skip(不發空通知)
// - status text / icon / 紀律建議跟 HoldingsAdvice.tsx 一致(雙邊邏輯同步)
// - Markdown V2 mode(Telegram)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

interface AdviceRow {
  symbol: string;
  net_qty: number;
  avg_cost: number | string;
  lots: number;
  current_price: number | string | null;
  as_of_ts: string | null;
  pct_change: number | string | null;
  stop_loss_price: number | string;
  add_position_price: number | string;
  obs1_price: number | string;
  obs2_price: number | string;
  force_out_price: number | string;
  expected_rank: number | null;
  fund_count_pos: number | null;
  fund_count_total: number | null;
  mom_count_pos: number | null;
  mom_count_total: number | null;
  rsi14: number | string | null;
  fund_rev_yoy: number | null;
  is_entry_signal: boolean | null;
  signal_strength: string | null;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(atob(pad));
}

function n(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

// 跟 HoldingsAdvice.tsx 一致的 status 邏輯
function deriveStatus(r: AdviceRow): { icon: string; headline: string; detail: string } {
  const pct = n(r.pct_change);
  const rsi = n(r.rsi14);
  const fundPos = r.fund_count_pos ?? 0;
  const fundTotal = r.fund_count_total ?? 0;
  const lots = r.lots;
  const exitVerb = lots <= 1 ? "整張出" : `先賣 1 張(剩 ${lots - 1} 張)`;
  const stopVerb = lots <= 1 ? "整張停損" : `全部 ${lots} 張停損`;

  if (pct == null) {
    return { icon: "⏳", headline: "等資料", detail: "現價未取得" };
  }
  if (pct <= -10) {
    return { icon: "⛔", headline: stopVerb, detail: `跌 ${pct.toFixed(2)}% 超過 -10% 紀律線。不凹單。` };
  }
  if (pct <= -7) {
    return { icon: "⚠", headline: "警戒", detail: `現價 ${pct.toFixed(2)}%。沒量爆轉強就 -10% 出。` };
  }
  if (pct <= -5) {
    const canAdd = fundTotal >= 5 && fundPos >= Math.ceil(fundTotal * 0.7);
    return canAdd
      ? { icon: "🔵", headline: "可加 1 張攤平", detail: `跌 ${pct.toFixed(2)}% + 基本面 ${fundPos}/${fundTotal} 仍強。` }
      : { icon: "🔵", headline: "暫不加碼", detail: `基本面 ${fundPos}/${fundTotal} 偏弱,不建議加碼。` };
  }
  if (pct >= 40) {
    return { icon: "🚀", headline: lots <= 1 ? "整張出" : "整批出", detail: `+${pct.toFixed(2)}% 末段勿貪。` };
  }
  if (pct >= 30) {
    return { icon: "📈", headline: `${exitVerb} OR 看法人方向`, detail: `+${pct.toFixed(2)}%。看法人/RSI 決定。` };
  }
  if (pct >= 20) {
    const oh = rsi != null && rsi > 75 ? "(RSI 過熱)" : "";
    return { icon: "📊", headline: `第一觀察${oh}`, detail: `+${pct.toFixed(2)}%。RSI<80 + 法人連買 → 抱;否則 ${exitVerb}。` };
  }
  if (fundTotal >= 4 && fundPos < 3) {
    return { icon: "📉", headline: `考慮 ${exitVerb}`, detail: `基本面跌到 ${fundPos}/${fundTotal},持有理由破壞。` };
  }
  if (rsi != null && rsi > 80) {
    return { icon: "🔥", headline: "隨時準備出", detail: `RSI ${rsi.toFixed(0)} > 80 過熱。` };
  }
  return {
    icon: "✓",
    headline: "持續抱",
    detail: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%,fund ${fundPos}/${fundTotal}${rsi != null ? `, RSI ${rsi.toFixed(0)}` : ""}。`,
  };
}

// Telegram MarkdownV2 special chars 要 escape
function mdEsc(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function fmtMoney(v: number | string | null | undefined, digits = 2): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// 資料新鮮度:holding 的 as_of_ts 日期落後 price_daily 最新交易日 = 舊價
//   (用「日期 vs 最新交易日」而非「幾小時前」,週末/假日才不會誤報)
function isStale(r: AdviceRow, latestTradeDate: string | null): boolean {
  if (!latestTradeDate) return false;
  if (!r.as_of_ts) return true; // 完全沒時間戳 = 不可信
  const d = String(r.as_of_ts).slice(0, 10);
  return d < latestTradeDate;
}

function buildMessage(rows: AdviceRow[], latestTradeDate: string | null): string {
  const now = new Date();
  const taipei = now.toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });

  if (rows.length === 0) {
    return mdEsc(`📊 持股建議 (${taipei})\n\n目前無持股 — 沒有需要分析的部位`);
  }

  const anyStale = rows.some((r) => isStale(r, latestTradeDate));
  let msg = `*📊 持股建議* \\(${mdEsc(taipei)}\\)\n`;
  if (anyStale) {
    msg += `⚠ *資料延遲警示*:部分標的現價非最新交易日\\(最新 ${mdEsc(latestTradeDate ?? "?")}\\),標 ⚠ 者價格偏舊,勿據此下單\n`;
  }
  msg += `\n`;
  for (const r of rows) {
    const s = deriveStatus(r);
    const pct = n(r.pct_change);
    const pctStr = pct == null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
    const price = n(r.current_price);
    const rsi = n(r.rsi14);
    const signalStr = r.is_entry_signal ? ` ⭐ ${r.signal_strength}` : "";
    const staleMark = isStale(r, latestTradeDate)
      ? ` ⚠資料延遲\\(${mdEsc(r.as_of_ts ? String(r.as_of_ts).slice(0, 10) : "無時間戳")}\\)`
      : "";

    msg += `${s.icon} *${mdEsc(r.symbol)}* · ${r.lots} 張 @ ${mdEsc(fmtMoney(r.avg_cost))}\n`;
    msg += `現價 ${mdEsc(price == null ? "—" : fmtMoney(price))} \\(${mdEsc(pctStr)}\\)${staleMark}\n`;
    msg += `*${mdEsc(s.headline)}*\n`;
    msg += `${mdEsc(s.detail)}\n`;
    msg += `📌 停損 ${mdEsc(fmtMoney(r.stop_loss_price))} \\| 加碼 ${mdEsc(fmtMoney(r.add_position_price))} \\| `;
    msg += `\\+20% ${mdEsc(fmtMoney(r.obs1_price))} \\| \\+30% ${mdEsc(fmtMoney(r.obs2_price))} \\| \\+40% ${mdEsc(fmtMoney(r.force_out_price))}\n`;
    msg += `_系統 \\#${r.expected_rank ?? "—"} · fund ${r.fund_count_pos ?? 0}/${r.fund_count_total ?? 0} · mom ${r.mom_count_pos ?? 0}/${r.mom_count_total ?? 0}`;
    if (rsi != null) msg += ` · RSI ${rsi.toFixed(0)}`;
    msg += `${mdEsc(signalStr)}_\n\n`;
  }
  return msg;
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return Response.json({ error: "missing bearer" }, { status: 401 });
  let role: unknown;
  try { role = decodeJwtPayload(auth.slice(7)).role; }
  catch { return Response.json({ error: "invalid jwt" }, { status: 401 }); }
  if (role !== "service_role") return Response.json({ error: "forbidden", role }, { status: 403 });

  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SERVICE_ROLE) return Response.json({ error: "missing SUPABASE_SERVICE_ROLE_KEY env" }, { status: 500 });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);

  // 拿 vault secret
  const [tokenRes, chatRes] = await Promise.all([
    sb.rpc("read_telegram_bot_token"),
    sb.rpc("read_telegram_chat_id"),
  ]);
  if (tokenRes.error || !tokenRes.data) {
    return Response.json({
      error: "telegram_bot_token not in vault",
      hint: "supabase dashboard SQL: select vault.create_secret('<TOKEN>', 'telegram_bot_token');",
    }, { status: 500 });
  }
  if (chatRes.error || !chatRes.data) {
    return Response.json({
      error: "telegram_chat_id not in vault",
      hint: "supabase dashboard SQL: select vault.create_secret('<CHAT_ID>', 'telegram_chat_id');",
    }, { status: 500 });
  }
  const TOKEN = tokenRes.data as string;
  const CHAT_ID = chatRes.data as string;

  // 讀 advice rows
  const { data: rows, error: rowsErr } = await sb.from("v_holdings_advice").select("*");
  if (rowsErr) return Response.json({ error: `read v_holdings_advice: ${rowsErr.message}` }, { status: 500 });
  const advice = (rows as AdviceRow[] | null) ?? [];

  if (advice.length === 0) {
    // 沒持股不發
    return Response.json({ skipped: "no_holdings" });
  }

  // 資料新鮮度 guard:拿 price_daily 最新交易日,標示落後的 holding(不阻擋發送)
  const { data: ltd } = await sb
    .from("price_daily")
    .select("trade_date")
    .order("trade_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const latestTradeDate = (ltd?.trade_date as string | undefined) ?? null;
  const staleSymbols = advice
    .filter((r) => !r.as_of_ts || String(r.as_of_ts).slice(0, 10) < (latestTradeDate ?? ""))
    .map((r) => r.symbol);
  if (staleSymbols.length > 0) {
    // 觀測點:fetch_log 留警示(success=false 讓監控掃得到)
    await sb.from("fetch_log").insert({
      source: "telegram_holdings_advice",
      success: false,
      error: `stale price for ${staleSymbols.length} holding(s): ${staleSymbols.join(",")} (latest trade_date=${latestTradeDate})`,
      finished_at: new Date().toISOString(),
    });
  }

  const message = buildMessage(advice, latestTradeDate);

  // 送 Telegram
  const tgRes = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    }),
  });

  const tgJson = await tgRes.json();
  if (!tgRes.ok || !tgJson.ok) {
    // fallback:plain text 重送
    const fallbackRes = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message.replace(/\\/g, ""),
      }),
    });
    const fallbackJson = await fallbackRes.json();
    return Response.json({
      ok: fallbackRes.ok,
      original_error: tgJson,
      fallback: fallbackJson,
      holdings_count: advice.length,
    });
  }

  await sb.from("fetch_log").insert({
    source: "telegram_holdings_advice",
    success: true,
    rows_written: advice.length,
    finished_at: new Date().toISOString(),
  });

  return Response.json({ ok: true, holdings_count: advice.length, message_preview: message.slice(0, 200) });
});
