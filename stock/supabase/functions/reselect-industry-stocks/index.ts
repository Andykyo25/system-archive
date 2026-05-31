// 每月重選 industry_stocks 與 stock_universe metadata
//
// 邏輯:
// 1. 從 FinMind TaiwanStockInfo 抓所有 twse + tpex 個股(扣除 ETF 與權證等)
// 2. 將 industry_category 映射到 Andy 自定義的 10 產業(mapping 寫在 EF 內)
// 3. 對每個 mapped industry,抓近 30 個交易日的 TaiwanStockPrice,算「avg Trading_money」排名
// 4. 每產業取前 10 名,delete 既有「未 locked」row 後 insert
// 5. 同時更新 stock_universe 的 market_cap / avg_20d_volume 欄位
//
// quota:取最近 N 天 sample(7 天)做排名,N×|universe|/sample_size 才能算所有股
//   實務:取 50 大盤股 sample,反推前 10 不科學;改用 TWSE STOCK_DAY_ALL 全市場 1 個 API call
//   但 FinMind 沒 STOCK_DAY_ALL,只能逐 symbol 抓
//
// 妥協方案:
//   - 不重新抓資料,只用 DB 內 `price_daily` 算近 30 天成交額排名
//   - 這要求 price_daily 已有充足數據(M8 backfill 完成後)
//   - 第一次 run 時 price_daily 可能不夠,EF 內 graceful degrade(skip 該產業重選)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const FINMIND_DAILY_BUDGET = 600;
const TARGET_INDUSTRIES = [
  "半導體封測", "記憶體", "IC設計", "被動元件", "AI伺服器",
  "車用電動車", "面板", "航運", "生技", "金融",
];

// 映射 FinMind industry_category → Andy 10 產業
// FinMind 的 industry_category 比較粗,需要結合 stock_name keyword 細分
function classifyIndustry(industryCategory: string, name: string): string | null {
  const n = name;
  const ic = industryCategory;

  // 金融最直接
  if (ic.includes("金融保險") || ic === "金融業") return "金融";

  // 航運
  if (ic.includes("航運")) return "航運";

  // 生技
  if (ic.includes("生技") || ic.includes("醫療") || ic.includes("製藥") || ic.includes("生物")) return "生技";

  // 半導體相關 — 細分為封測 / 記憶體 / IC設計
  if (ic.includes("半導體")) {
    // 記憶體 keyword
    if (/南亞科|旺宏|華邦電|力積電|群聯|鈺創|晶豪|威剛|創見|宇瞻|記憶/.test(n)) return "記憶體";
    // 封測 keyword
    if (/日月光|京元|力成|同欣|南茂|華東|訊芯|矽格|辛耘|弘塑|封測|測試/.test(n)) return "半導體封測";
    // 設計 keyword(預設 IC 設計給其他半導體)
    return "IC設計";
  }

  // 被動元件
  if (ic.includes("電子零組件") && /國巨|華新科|奇力|立隆|美磊|興勤|乾坤|大毅|麗智|洋華|電阻|電容/.test(n)) {
    return "被動元件";
  }

  // AI 伺服器 / 電腦周邊
  if (ic.includes("電腦及週邊") || ic.includes("電腦")) {
    return "AI伺服器";
  }

  // 面板
  if (ic.includes("光電") && /友達|群創|彩晶|元太|富采|達運|聯鈞|大同|凌巨|TPK|面板/.test(n)) {
    return "面板";
  }

  // 車用 / EV
  if (ic.includes("汽車") || /信邦|朋程|為昇科|怡利電|同致|健和興|群電|致伸|裕日車/.test(n)) {
    return "車用電動車";
  }

  // 其他電子歸 IC 設計(默認)
  if (ic.includes("電子") || ic.includes("通信")) return "IC設計";

  return null; // 不屬於 10 個目標產業
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return JSON.parse(atob(pad));
}

async function fetchAllStockInfo(token: string): Promise<{ stock_id: string; stock_name: string; industry_category: string; type: string }[]> {
  const u = new URL(FINMIND_URL);
  u.searchParams.set("dataset", "TaiwanStockInfo");
  u.searchParams.set("token", token);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.status !== 200) throw new Error(`FinMind status=${j.status} msg=${j.msg}`);
  if (!Array.isArray(j.data)) return [];
  // deno-lint-ignore no-explicit-any
  return (j.data as any[]).filter((r) => {
    const ic = String(r.industry_category ?? "");
    // 過濾 ETF / 權證等非個股
    if (ic.includes("ETF") || ic.includes("指數股票型") || ic.includes("認購")) return false;
    return true;
  }).map((r) => ({
    stock_id: String(r.stock_id),
    stock_name: String(r.stock_name),
    industry_category: String(r.industry_category ?? ""),
    type: String(r.type ?? ""),
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

  const { data: logRow } = await supabase
    .from("fetch_log").insert({ source: "reselect_industry_stocks" }).select("id").single();
  const logId = logRow!.id;

  const errors: string[] = [];
  let totalSelected = 0;
  let totalRemoved = 0;
  const byIndustry: Record<string, number> = {};

  try {
    // 1. 抓全市場個股資訊 + 用 mapping 分類到 10 產業
    const all = await fetchAllStockInfo(TOKEN);
    const byMappedIndustry = new Map<string, { stock_id: string; stock_name: string }[]>();
    for (const s of all) {
      const ind = classifyIndustry(s.industry_category, s.stock_name);
      if (ind == null) continue;
      if (!byMappedIndustry.has(ind)) byMappedIndustry.set(ind, []);
      byMappedIndustry.get(ind)!.push({ stock_id: s.stock_id, stock_name: s.stock_name });
    }

    // 2. 用 price_daily 算近 30 個交易日 avg Trading_money(volume * close) 排名
    // 每產業取前 10
    const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);

    for (const industry of TARGET_INDUSTRIES) {
      const candidates = byMappedIndustry.get(industry) ?? [];
      if (candidates.length === 0) {
        byIndustry[industry] = 0;
        continue;
      }
      const candidateSymbols = candidates.map((c) => c.stock_id);

      // 直接 in() 一次查
      const { data: priceRows } = await supabase
        .from("price_daily")
        .select("symbol, close, volume")
        .in("symbol", candidateSymbols)
        .gte("trade_date", cutoff);

      const avgTurnover = new Map<string, number>();
      const countDays = new Map<string, number>();
      for (const r of priceRows ?? []) {
        const t = Number(r.close) * Number(r.volume);
        if (!Number.isFinite(t)) continue;
        avgTurnover.set(r.symbol, (avgTurnover.get(r.symbol) ?? 0) + t);
        countDays.set(r.symbol, (countDays.get(r.symbol) ?? 0) + 1);
      }

      // 算平均
      const ranking: { symbol: string; name: string | null; avg: number }[] = [];
      for (const c of candidates) {
        const days = countDays.get(c.stock_id) ?? 0;
        const sum = avgTurnover.get(c.stock_id) ?? 0;
        if (days === 0) continue;
        ranking.push({ symbol: c.stock_id, name: c.stock_name, avg: sum / days });
      }
      ranking.sort((a, b) => b.avg - a.avg);
      const top10 = ranking.slice(0, 10);

      // 3. B3:先算 top10 toInsert(不動 DB),非空才 delete+insert。
      //    原本無條件先 delete 再 insert → 若候選空 / price_daily 近 30 天無資料
      //    使 top10 空,該產業舊 row 已刪、新 row 沒進 → 產業從 universe 消失(沉默
      //    drift,月初一次、半年才發現)。改成非空才換。
      const { data: existing } = await supabase
        .from("industry_stocks")
        .select("symbol, locked")
        .eq("industry", industry);
      const lockedSet = new Set((existing ?? []).filter((r) => r.locked).map((r) => r.symbol));

      let order = 1;
      const toInsert: { industry: string; symbol: string; name: string | null; display_order: number; selected_at: string; locked: boolean }[] = [];
      for (const r of top10) {
        if (lockedSet.has(r.symbol)) continue;
        toInsert.push({
          industry,
          symbol: r.symbol,
          name: r.name,
          display_order: order++,
          selected_at: new Date().toISOString(),
          locked: false,
        });
      }

      if (toInsert.length > 0) {
        // 非空才刪舊未 locked row(delete 緊接 insert,失敗窗口最小化)
        const { data: removed } = await supabase
          .from("industry_stocks")
          .delete()
          .eq("industry", industry)
          .eq("locked", false)
          .select("symbol");
        totalRemoved += removed?.length ?? 0;

        const { error } = await supabase
          .from("industry_stocks")
          .insert(toInsert);
        if (error) errors.push(`insert ${industry}: ${error.message}`);
        else {
          totalSelected += toInsert.length;
          byIndustry[industry] = toInsert.length;
        }
      } else {
        // top10 空 → 保留舊 row 不刪(避免產業消失)
        byIndustry[industry] = 0;
      }
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // 1 個 API call(TaiwanStockInfo)
  const today = new Date().toISOString().slice(0, 10);
  await supabase.from("api_quota_state").upsert(
    { source: "finmind", quota_date: today, used: 0, budget: FINMIND_DAILY_BUDGET },
    { onConflict: "source,quota_date", ignoreDuplicates: true },
  );
  // B1:原子遞增(取代 read-modify-write,並行不覆蓋;免去先 select 再寫的 race)
  await supabase.rpc("increment_quota", { p_source: "finmind", p_date: today, p_n: 1 });

  await supabase.from("fetch_log").update({
    finished_at: new Date().toISOString(),
    success: errors.length === 0,
    rows_written: totalSelected,
    error: errors.length > 0 ? errors.join("; ").slice(0, 1000) : null,
  }).eq("id", logId);

  return Response.json({
    total_selected: totalSelected,
    total_removed: totalRemoved,
    by_industry: byIndustry,
    errors,
  });
});
