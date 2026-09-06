import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { authorizeServiceRequest } from "../_shared/authorize.ts";

// The gateway is defense in depth. Do not trust a merely decoded JWT role.
Deno.serve(async (req: Request) => {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, key);
  if (!await authorizeServiceRequest(req,key,async()=>{
    const result=await sb.rpc("read_edge_function_auth");
    return result.error ? null : result.data;
  })) return Response.json({ error: "unauthorized" }, { status: 401 });
  const lease = crypto.randomUUID();
  try {
    const { data: events, error } = await sb.rpc("claim_price_alerts", {
      p_token: lease,
    });
    if (error) throw new Error(error.message);
    if (!events?.length) return Response.json({ claimed: 0, delivered: 0 });
    const [token, chat] = await Promise.all([
      sb.rpc("read_telegram_bot_token"),
      sb.rpc("read_telegram_chat_id"),
    ]);
    let delivered = 0;
    for (const event of events) {
      let failure: string | null = null;
      try {
        if (token.error || chat.error || !token.data || !chat.data)
          throw new Error("telegram configuration unavailable");
        const s = event.snapshot;
        const text = `⏰ 到價提醒 #${event.id}：${event.symbol}\n報價 ${s.price} ${s.condition === "price_below" ? "≤" : "≥"} ${s.threshold}\n報價時間 ${s.as_of_ts}\n${s.note ?? ""}\n請確認最新報價及原交易計畫。此為條件提醒，尚未下單。`;
        const response = await fetch(
          `https://api.telegram.org/bot${token.data}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chat.data, text }),
            signal: AbortSignal.timeout(5000),
          },
        );
        const payload = await response.json();
        if (!response.ok || payload.ok !== true)
          throw new Error(`telegram rejected delivery (${response.status})`);
      } catch {
        // Never log a fetch exception containing the bot token URL.
        failure = "telegram delivery failed; retry after lease expires";
      }
      const result = await sb
        .from("alert_events")
        .update({ notified: failure == null, delivery_error: failure })
        .eq("id", event.id)
        .eq("delivery_token", lease);
      if (result.error) throw new Error("could not persist delivery status");
      if (failure == null) delivered++;
    }
    const success = delivered === events.length;
    await sb
      .from("fetch_log")
      .insert({
        source: "check_price_alerts",
        success,
        rows_written: delivered,
        error: success ? null : "pending deliveries will retry",
        finished_at: new Date().toISOString(),
      });
    return Response.json({
      claimed: events.length,
      delivered,
      pending: events.length - delivered,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "alert delivery failed" },
      { status: 500 },
    );
  }
});
