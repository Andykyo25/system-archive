// fetch-stock-names — 全市場股名(2026-07-17,動態熱股無中文名 gap 根治)
//
// 2 源(零 quota,欄位 2026-07-17 實證):
//   TWSE /opendata/t187ap03_L        上市公司基本資料(公司代號 / 公司簡稱)~1090 檔
//   TPEX /mopsfin_t187ap03_O         上櫃公司基本資料(SecuritiesCompanyCode / CompanyAbbreviation)~891 檔
// 寫入 stock_names(upsert DO UPDATE,名稱變更自動跟上)。每源獨立 try/catch + fetch_log。
// Cron:每週日 20:30 Taipei(名稱極低頻)。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

interface NameRow {
  symbol: string;
  name: string;
  market: string;
  updated_at: string;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(atob(pad));
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
  const now = new Date().toISOString();

  const sources: {
    name: string;
    url: string;
    parse: (rows: Record<string, unknown>[]) => NameRow[];
  }[] = [
    {
      name: "twse_names",
      url: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
      parse: (rows) => {
        const out: NameRow[] = [];
        for (const r of rows) {
          const symbol = okSymbol(r["公司代號"]);
          const nm = String(r["公司簡稱"] ?? "").trim();
          if (!symbol || !nm) continue;
          out.push({ symbol, name: nm.slice(0, 40), market: "twse", updated_at: now });
        }
        return out;
      },
    },
    {
      name: "tpex_names",
      url: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
      parse: (rows) => {
        const out: NameRow[] = [];
        for (const r of rows) {
          const symbol = okSymbol(r["SecuritiesCompanyCode"]);
          const nm = String(r["CompanyAbbreviation"] ?? "").trim();
          if (!symbol || !nm) continue;
          out.push({ symbol, name: nm.slice(0, 40), market: "tpex", updated_at: now });
        }
        return out;
      },
    },
  ];

  const result: Record<string, { written: number; error: string | null }> = {};
  for (const src of sources) {
    let written = 0;
    let errMsg: string | null = null;
    try {
      const rows = src.parse(await fetchJson(src.url));
      const seen = new Set<string>();
      const deduped = rows.filter((r) =>
        seen.has(r.symbol) ? false : (seen.add(r.symbol), true),
      );
      for (let i = 0; i < deduped.length; i += 500) {
        const batch = deduped.slice(i, i + 500);
        const { error } = await sb
          .from("stock_names")
          .upsert(batch, { onConflict: "symbol", ignoreDuplicates: false });
        if (error) throw new Error(error.message);
        written += batch.length;
      }
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    }
    result[src.name] = { written, error: errMsg };
    await sb.from("fetch_log").insert({
      source: src.name,
      success: errMsg == null,
      rows_written: written,
      error: errMsg,
      finished_at: new Date().toISOString(),
    });
  }

  return Response.json(result);
});
