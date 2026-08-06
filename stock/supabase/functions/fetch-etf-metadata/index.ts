// 自動同步 etf_metadata:從 FinMind TaiwanStockInfo 抓「industry_category 包含 ETF」的 row
//
// 寫入策略:
// - source='manual' 的 row:不動(Andy 手動填的 expense_ratio / fund_size_billion 保留)
// - source='auto' 的 row 或不存在的:upsert symbol + name + category(從名稱推斷)
// - last_synced_at 更新為 now()
//
// expense_ratio / fund_size_billion:免費 FinMind 沒這資料,維持 null;Andy 想填的話到 /settings 手動填

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const FINMIND_DAILY_BUDGET = 600;

interface EtfMeta {
  symbol: string;
  name: string;
  category: string;
  source: "auto";
  is_active_etf: boolean;
  last_synced_at: string;
  updated_at: string;
}

// 錯誤訊息序列化(2026-07-22 修)
// 問題:supabase-js 的 PostgrestError 是 plain object 不是 Error 實例,
//   `catch (e) { String(e) }` 會產生 "[object Object]" → fetch_log 錯誤欄位變瞎的,
//   看不到真因。2026-07-18 的 etf_metadata_sync 失敗就是這樣被隱藏的。
// 做法:先取 Error.message,再取物件的 message/code/details,最後才 fallback JSON/String。
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    if (typeof o.message === "string" && o.message) {
      const parts = [o.message];
      if (o.code) parts.push(`code=${String(o.code)}`);
      if (typeof o.details === "string" && o.details) parts.push(o.details);
      if (typeof o.hint === "string" && o.hint) parts.push(`hint=${o.hint}`);
      return parts.join(" | ");
    }
    try { return JSON.stringify(e); } catch { /* circular 等 → 落到最後 */ }
  }
  return String(e);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return JSON.parse(atob(pad));
}

// 從 ETF 中文名稱推斷類型
function inferCategory(name: string, symbol: string): { category: string; isActive: boolean } {
  // 主動式 ETF:股號開頭 4 + 字母 A,如 00940A、00400A
  const isActive = /^\d{4,5}A$/.test(symbol);
  if (isActive) return { category: "主動式", isActive: true };

  // 債券 ETF:股號開頭 4 + 字母 B,或名稱含「債」
  if (/^\d{4,5}B$/.test(symbol) || name.includes("債")) return { category: "債券", isActive: false };

  // 高股息:名稱含「高息」「高股息」「高股利」「高配息」
  if (/高股息|高配息|高息|高股利/.test(name)) return { category: "高股息", isActive: false };

  // 市值型:50 / 100 / 加權 / 市值
  if (/0050|006208|50$|加權|市值|台50|MSCI/i.test(name) || /^00(50|6208)$/.test(symbol)) {
    return { category: "市值型", isActive: false };
  }

  // 主題型:其餘 ETF
  return { category: "主題", isActive: false };
}

async function fetchAllEtfInfo(token: string): Promise<{ stock_id: string; stock_name: string; industry_category: string }[]> {
  const u = new URL(FINMIND_URL);
  u.searchParams.set("dataset", "TaiwanStockInfo");
  u.searchParams.set("token", token);
  const res = await fetch(u);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== 200) throw new Error(`FinMind status=${j.status} msg=${j.msg}`);
  if (!Array.isArray(j.data)) return [];
  // 篩 industry_category 含 ETF 或包含「投信」/「指數股票型基金」
  // deno-lint-ignore no-explicit-any
  return (j.data as any[]).filter((r) => {
    const ic = String(r.industry_category ?? "");
    return ic.includes("ETF") || ic.includes("指數股票型") || ic === "ETF";
  }).map((r) => ({
    stock_id: String(r.stock_id),
    stock_name: String(r.stock_name),
    industry_category: String(r.industry_category ?? ""),
  }));
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
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);

  const tokenRes = await supabase.rpc("read_finmind_token");
  if (tokenRes.error || !tokenRes.data) {
    return Response.json({ error: "missing finmind_token in vault", detail: tokenRes.error?.message }, { status: 500 });
  }
  const TOKEN = tokenRes.data as string;

  const today = new Date().toISOString().slice(0, 10);

  // quota:這個 EF 只打 1 個 API call(TaiwanStockInfo 不需 data_id),但仍計 quota
  await supabase.from("api_quota_state").upsert(
    { source: "finmind", quota_date: today, used: 0, budget: FINMIND_DAILY_BUDGET },
    { onConflict: "source,quota_date", ignoreDuplicates: true },
  );
  const { data: quotaRow } = await supabase
    .from("api_quota_state").select("used, budget")
    .eq("source", "finmind").eq("quota_date", today).single();
  const usedSoFar = quotaRow?.used ?? 0;
  const budget = quotaRow?.budget ?? FINMIND_DAILY_BUDGET;
  if (budget - usedSoFar < 1) {
    return Response.json({ skipped: "quota_exhausted", quota: { used: usedSoFar, budget } });
  }

  const { data: logRow } = await supabase
    .from("fetch_log").insert({ source: "etf_metadata_sync" }).select("id").single();
  const logId = logRow!.id;

  let written = 0;
  let skipped = 0;
  const errors: string[] = [];

  try {
    const etfs = await fetchAllEtfInfo(TOKEN);

    // 取目前 etf_metadata 的 source 對映,避免覆蓋 manual
    const { data: existing } = await supabase
      .from("etf_metadata")
      .select("symbol, source");
    const sourceMap = new Map<string, string>();
    for (const r of existing ?? []) sourceMap.set(r.symbol, r.source);

    const rowsToUpsert: EtfMeta[] = [];
    const now = new Date().toISOString();
    for (const e of etfs) {
      const existingSource = sourceMap.get(e.stock_id);
      if (existingSource === "manual") {
        skipped++;
        continue;
      }
      const { category, isActive } = inferCategory(e.stock_name, e.stock_id);
      rowsToUpsert.push({
        symbol: e.stock_id,
        name: e.stock_name,
        category,
        source: "auto",
        is_active_etf: isActive,
        last_synced_at: now,
        updated_at: now,
      });
    }

    if (rowsToUpsert.length > 0) {
      // TaiwanStockInfo 同一 stock_id 會回多筆(不同 date),payload 內出現重複 key 時
      // ON CONFLICT DO UPDATE 會報 "command cannot affect row a second time" → 整批失敗。
      // 實測 2026-08-06:此 EF 近 7 天 0/1 成功,就是這個原因(靜默停更,無人察覺)。
      // 以 symbol 去重、保留最後一筆(Map 後寫入者勝)。
      const deduped = [...new Map(rowsToUpsert.map((r) => [r.symbol, r])).values()];
      // upsert with onConflict symbol,source='auto' 會被覆蓋,source='manual' 已過濾
      const { error } = await supabase
        .from("etf_metadata")
        .upsert(deduped, { onConflict: "symbol" });
      if (error) throw new Error(`etf_metadata upsert: ${errMsg(error)}`);
      written = deduped.length;
    }
  } catch (e) {
    errors.push(errMsg(e));
  }

  // 1 個 API call
  // B1:原子遞增(取代 read-modify-write,並行不覆蓋)
  await supabase.rpc("increment_quota", { p_source: "finmind", p_date: today, p_n: 1 });

  await supabase.from("fetch_log").update({
    finished_at: new Date().toISOString(),
    success: errors.length === 0,
    rows_written: written,
    rows_skipped: skipped,
    error: errors.length > 0 ? errors.join("; ").slice(0, 1000) : null,
  }).eq("id", logId);

  return Response.json({
    written,
    skipped_manual: skipped,
    errors: errors.length,
    quota: { used: usedSoFar + 1, budget },
  });
});
