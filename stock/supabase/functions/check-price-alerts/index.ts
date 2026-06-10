// check-price-alerts — 耐心價到價提醒(2026-06-10,「好股等好價」工程 D)
//
// 讀 alert_rules(enabled=true)→ 與 v_latest_price_realtime 比價 → 觸發者:
//   insert alert_events + Telegram 推播 + rule 設 enabled=false(one-shot,避免轟炸)
// conditions: price_below(等回檔買點,現價 <= threshold)/ price_above
// Cron: 盤中每 10 分(*/10 1-5 UTC = 09:00-13:55 Taipei)。零外部 API quota。
// TG 用 plain text(非 MarkdownV2,免 escape)。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

interface Rule {
  id: number;
  symbol: string;
  condition: string;
  threshold: number | string | null;
  note: string | null;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(atob(pad));
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return Response.json({ error: "missing bearer" }, { status: 401 });
  let role: unknown;
  try { role = decodeJwtPayload(auth.slice(7)).role; }
  catch { return Response.json({ error: "invalid jwt" }, { status: 401 }); }
  if (role !== "service_role") return Response.json({ error: "forbidden" }, { status: 403 });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: rulesData, error: rulesErr } = await sb
    .from("alert_rules")
    .select("id, symbol, condition, threshold, note")
    .eq("enabled", true);
  if (rulesErr) return Response.json({ error: rulesErr.message }, { status: 500 });
  const rules = (rulesData as Rule[] | null) ?? [];
  if (rules.length === 0) return Response.json({ checked: 0, triggered: 0 });

  const symbols = [...new Set(rules.map((r) => r.symbol))];
  const { data: priceData } = await sb
    .from("v_latest_price_realtime")
    .select("symbol, current_price")
    .in("symbol", symbols);
  const priceMap = new Map<string, number>();
  for (const p of (priceData as { symbol: string; current_price: number | string | null }[] | null) ?? []) {
    const c = num(p.current_price);
    if (c != null) priceMap.set(p.symbol, c);
  }

  const triggered: { rule: Rule; price: number }[] = [];
  for (const r of rules) {
    const price = priceMap.get(r.symbol);
    const th = num(r.threshold);
    if (price == null || th == null) continue;
    const hit =
      r.condition === "price_below" ? price <= th :
      r.condition === "price_above" ? price >= th : false;
    if (hit) triggered.push({ rule: r, price });
  }

  if (triggered.length === 0) {
    return Response.json({ checked: rules.length, triggered: 0 });
  }

  // one-shot:先 disable + 寫 events,再推播(推播失敗不會重複觸發)
  await sb.from("alert_rules").update({ enabled: false }).in("id", triggered.map((t) => t.rule.id));
  await sb.from("alert_events").insert(
    triggered.map((t) => ({
      rule_id: t.rule.id,
      symbol: t.rule.symbol,
      snapshot: { price: t.price, threshold: t.rule.threshold, condition: t.rule.condition },
      notified: true,
    })),
  );

  const [tokenRes, chatRes] = await Promise.all([
    sb.rpc("read_telegram_bot_token"),
    sb.rpc("read_telegram_chat_id"),
  ]);
  let tgOk = false;
  if (tokenRes.data && chatRes.data) {
    const lines = triggered.map((t) => {
      const dir = t.rule.condition === "price_below" ? "≤" : "≥";
      const noteStr = t.rule.note ? `(${t.rule.note})` : "";
      return `⏰ 到價:${t.rule.symbol} 現價 ${t.price} ${dir} ${t.rule.threshold} ${noteStr}`;
    });
    const text = lines.join("\n") + "\n好股等好價 — 進場前查 /rank 確認籌碼/訊號/海外 gate 再決定";
    const tgRes = await fetch(`https://api.telegram.org/bot${tokenRes.data}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatRes.data, text }),
    });
    tgOk = tgRes.ok;
  }

  await sb.from("fetch_log").insert({
    source: "check_price_alerts",
    success: true,
    rows_written: triggered.length,
    error: tgOk ? null : "tg send failed or token missing",
    finished_at: new Date().toISOString(),
  });

  return Response.json({ checked: rules.length, triggered: triggered.length, tg: tgOk });
});
