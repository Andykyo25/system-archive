import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { authorizeServiceRequest } from "../_shared/authorize.ts";
import {
  addDays,
  alertId,
  formatMessage,
  inventoryAlerts,
  pickNew,
  sampleMessage,
  settlementAlerts,
  syncAlerts,
  taipeiDate,
  type InventoryRow,
  type SettlementRow,
  type SyncRun,
} from "../_shared/broker-recon.ts";

// notify-broker-recon
// Reads v_broker_recon / v_broker_settlement_recon / fetch_log (broker-sync) and sends a Telegram
// message only when there is a NEW problem.
// Dedupe: broker_recon_alerted (written only after Telegram accepted the message; a failed send is retried on the next run).
// Nothing new: no message, just one fetch_log row (source=broker_recon_notify) so /health can see it is alive.
// body: {"dry_run":true} returns what would be sent; sends nothing, writes no dedupe rows and no fetch_log.
//       {"sample":true}  returns a fixed sample message and its sha256 (compare with the local hash after a deploy).
const SOURCE = "broker_recon_notify";

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) return Response.json({ error: "unauthorized" }, { status: 401 });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, key);
  if (!await authorizeServiceRequest(req, key, async () => {
    const result = await sb.rpc("read_edge_function_auth");
    return result.error ? null : result.data;
  })) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  if (body?.sample === true) {
    const message = sampleMessage();
    return Response.json({ sample: true, message, message_sha256: await sha256Hex(message) });
  }
  const dryRun = body?.dry_run === true;
  const log = async (success: boolean, rows: number, error: string | null) => {
    if (dryRun) return;
    await sb.from("fetch_log").insert({
      source: SOURCE,
      success,
      rows_written: rows,
      error,
      finished_at: new Date().toISOString(),
    });
  };

  try {
    const now = new Date();
    const today = taipeiDate(now);
    const since3h = new Date(now.getTime() - 3 * 3600 * 1000).toISOString();
    const sinceSent = new Date(now.getTime() - 10 * 86400 * 1000).toISOString();
    const [inv, stl, runs, sent] = await Promise.all([
      sb.from("v_broker_recon")
        .select("snapshot_date,symbol,system_qty,broker_qty,system_avg_cost,broker_avg_cost,status"),
      sb.from("v_broker_settlement_recon")
        .select("trade_date,status,buy_value_diff,sell_value_diff,buy_fee_diff,sell_fee_diff,system_sell_tax,broker_sell_tax,sell_tax_diff,broker_buy_value,broker_sell_value")
        .gte("trade_date", addDays(today, -3)),
      sb.from("fetch_log")
        .select("started_at,success,error")
        .eq("source", "broker-sync")
        .gte("started_at", since3h),
      sb.from("broker_recon_alerted")
        .select("kind,key,status")
        .gte("alerted_at", sinceSent),
    ]);
    const failed = [inv, stl, runs, sent].find((r) => r.error);
    if (failed) throw new Error(`read failed: ${failed.error!.message}`);

    const alerts = [
      ...syncAlerts((runs.data ?? []) as SyncRun[], today),
      ...inventoryAlerts((inv.data ?? []) as InventoryRow[], today),
      ...settlementAlerts((stl.data ?? []) as SettlementRow[], today),
    ];
    const already = new Set(
      (sent.data ?? []).map((r: { kind: string; key: string; status: string }) => alertId(r)),
    );
    const fresh = pickNew(alerts, already);
    if (fresh.length === 0) {
      await log(true, 0, null);
      return Response.json({ alerts: alerts.length, sent: 0 });
    }
    const message = formatMessage(fresh, today);
    if (dryRun) return Response.json({ dry_run: true, alerts: alerts.length, would_send: fresh.length, message });

    const [token, chat] = await Promise.all([
      sb.rpc("read_telegram_bot_token"),
      sb.rpc("read_telegram_chat_id"),
    ]);
    if (token.error || chat.error || !token.data || !chat.data) {
      throw new Error("telegram configuration unavailable");
    }
    let delivered = false;
    try {
      const response = await fetch(`https://api.telegram.org/bot${token.data}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat.data, text: message, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8000),
      });
      const payload = await response.json();
      delivered = response.ok && payload.ok === true;
    } catch {
      // Never log the exception: its text can contain the bot-token URL.
    }
    if (!delivered) throw new Error("telegram delivery failed; will retry on the next run");

    const recorded = await sb.from("broker_recon_alerted").upsert(
      fresh.map((a) => ({ kind: a.kind, key: a.key, status: a.status })),
      { onConflict: "kind,key,status", ignoreDuplicates: true },
    );
    if (recorded.error) throw new Error("message sent but could not record it; it may be sent again");
    await log(true, fresh.length, null);
    return Response.json({ alerts: alerts.length, sent: fresh.length });
  } catch (e) {
    const message = e instanceof Error ? e.message : "notify failed";
    await log(false, 0, message.slice(0, 200)).catch(() => {});
    return Response.json({ error: message }, { status: 500 });
  }
});
