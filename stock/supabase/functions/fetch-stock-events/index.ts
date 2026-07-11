// fetch-stock-events — 事件日曆(規畫④B 2026-07-11)
//
// 4 源(皆免費 OpenAPI,零 quota;欄位 2026-07-11 實證,L47):
//   1. TWSE /exchangeReport/TWT48U_ALL       上市除權除息預告(Date 民國7碼 / Code / Exdividend / CashDividend)
//   2. TPEX /tpex_exright_prepost            上櫃除權除息預告(ExRrightsExDividendDate / SecuritiesCompanyCode / ExRrightsExDividend / CashDividend)
//   3. TWSE /opendata/t187ap38_L             上市股東會公告(公司代號 / 股東常(臨時)會日期-日期 / 停止過戶起訖日期-起)
//   4. TWSE /opendata/t187ap04_L             上市每日重大訊息 → filter 主旨含「法人說明會」,事實發生日 = 開會日
//      ⚠ 主旨欄 key 帶尾隨空格「主旨 」(實證);此源僅當日資料 → 累積式,部署日起才有覆蓋
//
// 寫入策略:
//   - 鏡像源(1-3):每次 run 先 DELETE 該 source 未來列(event_date >= today)再 INSERT
//     = 未來事件永遠是「當前預告的鏡像」(改期/取消自動修正),過去列保留當歷史
//   - 累積源(4):upsert ignoreDuplicates(法說會公告不重複確認,PK 撞 = 已記過)
//   - 每源獨立 try/catch + fetch_log 一筆(L06 隔離,單源掛不拖全體)
// 民國 7 碼 → ISO:年 +1911(L04)。symbol 僅收 4-6 碼英數(排除權證雜訊)。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

interface EventRow {
  symbol: string;
  event_type: string;
  event_date: string;
  detail: Record<string, unknown>;
  source: string;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(atob(pad));
}

function rocToIso(roc: unknown): string | null {
  const m = String(roc ?? "").trim().match(/^(\d{3})(\d{2})(\d{2})$/);
  if (!m) return null;
  const iso = `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function okSymbol(v: unknown): string | null {
  const t = String(v ?? "").trim();
  return /^[0-9A-Za-z]{4,6}$/.test(t) ? t : null;
}

async function fetchJson(url: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j)) throw new Error(`${url} -> non-array payload`);
  return j as Record<string, unknown>[];
}

function parseTwt48u(rows: Record<string, unknown>[]): EventRow[] {
  const out: EventRow[] = [];
  for (const r of rows) {
    const symbol = okSymbol(r["Code"]);
    const date = rocToIso(r["Date"]);
    if (!symbol || !date) continue;
    out.push({
      symbol,
      event_type: "ex_dividend",
      event_date: date,
      detail: {
        kind: String(r["Exdividend"] ?? ""),
        cash_dividend: String(r["CashDividend"] ?? ""),
        market: "twse",
      },
      source: "twse_twt48u",
    });
  }
  return out;
}

function parseTpexPrepost(rows: Record<string, unknown>[]): EventRow[] {
  const out: EventRow[] = [];
  for (const r of rows) {
    const symbol = okSymbol(r["SecuritiesCompanyCode"]);
    const date = rocToIso(r["ExRrightsExDividendDate"]);
    if (!symbol || !date) continue;
    out.push({
      symbol,
      event_type: "ex_dividend",
      event_date: date,
      detail: {
        kind: String(r["ExRrightsExDividend"] ?? ""),
        cash_dividend: String(r["CashDividend"] ?? ""),
        market: "tpex",
      },
      source: "tpex_prepost",
    });
  }
  return out;
}

function parseShareholderMeeting(rows: Record<string, unknown>[]): EventRow[] {
  const out: EventRow[] = [];
  for (const r of rows) {
    const symbol = okSymbol(r["公司代號"]);
    const date = rocToIso(r["股東常(臨時)會日期-日期"]);
    if (!symbol || !date) continue;
    out.push({
      symbol,
      event_type: "shareholder_meeting",
      event_date: date,
      detail: {
        kind: String(r["股東常(臨時)會日期-常或臨時"] ?? ""),
        book_closure_start: rocToIso(r["停止過戶起訖日期-起"]),
        market: "twse",
      },
      source: "twse_t187ap38",
    });
  }
  return out;
}

function parseInvestorConference(rows: Record<string, unknown>[]): EventRow[] {
  const out: EventRow[] = [];
  for (const r of rows) {
    // 主旨欄 key 帶尾隨空格(實證);防禦性兩種都試
    const subject = String(r["主旨 "] ?? r["主旨"] ?? "");
    if (!subject.includes("法人說明會")) continue;
    const symbol = okSymbol(r["公司代號"]);
    const date = rocToIso(r["事實發生日"]);
    if (!symbol || !date) continue;
    out.push({
      symbol,
      event_type: "investor_conference",
      event_date: date,
      detail: { subject: subject.slice(0, 200), market: "twse" },
      source: "twse_t187ap04",
    });
  }
  return out;
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
  const today = new Date().toISOString().slice(0, 10);

  const sources: {
    name: string;
    url: string;
    parse: (rows: Record<string, unknown>[]) => EventRow[];
    mode: "mirror" | "accumulate";
  }[] = [
    { name: "twse_twt48u", url: "https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL", parse: parseTwt48u, mode: "mirror" },
    { name: "tpex_prepost", url: "https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost", parse: parseTpexPrepost, mode: "mirror" },
    { name: "twse_t187ap38", url: "https://openapi.twse.com.tw/v1/opendata/t187ap38_L", parse: parseShareholderMeeting, mode: "mirror" },
    { name: "twse_t187ap04", url: "https://openapi.twse.com.tw/v1/opendata/t187ap04_L", parse: parseInvestorConference, mode: "accumulate" },
  ];

  const result: Record<string, { written: number; error: string | null }> = {};

  for (const src of sources) {
    let written = 0;
    let errMsg: string | null = null;
    try {
      const raw = await fetchJson(src.url);
      const rows = src.parse(raw);
      // 同 feed 內 PK 撞(如同日多筆法說公告)先去重,留第一筆
      const seen = new Set<string>();
      const deduped = rows.filter((r) => {
        const k = `${r.symbol}|${r.event_type}|${r.event_date}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (src.mode === "mirror") {
        const { error: delErr } = await sb
          .from("stock_events")
          .delete()
          .eq("source", src.name)
          .gte("event_date", today);
        if (delErr) throw new Error(`delete: ${delErr.message}`);
      }
      for (let i = 0; i < deduped.length; i += 500) {
        const batch = deduped.slice(i, i + 500);
        const { error: upErr } = await sb
          .from("stock_events")
          .upsert(batch, { onConflict: "symbol,event_type,event_date", ignoreDuplicates: true });
        if (upErr) throw new Error(`upsert: ${upErr.message}`);
        written += batch.length;
      }
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    }
    result[src.name] = { written, error: errMsg };
    await sb.from("fetch_log").insert({
      source: `events_${src.name}`,
      success: errMsg == null,
      rows_written: written,
      error: errMsg,
      finished_at: new Date().toISOString(),
    });
  }

  return Response.json({ today, result });
});
