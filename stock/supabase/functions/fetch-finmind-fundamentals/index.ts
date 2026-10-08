import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { authorizeServiceRequest } from "../_shared/authorize.ts";
import { collectionOrder, collectionNumber } from "../../../lib/collection.ts";

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const LOOKBACK_DAYS = 800; // ~2 年的季報

interface FundamentalRow {
  symbol: string;
  period_end: string;
  eps: number | null;
  net_income: number | null;
  revenue: number | null;
  gross_profit: number | null;
  operating_income: number | null;
  total_equity: number | null;
  total_assets: number | null;
  total_liabilities: number | null;
  ocf: number | null;
  ic: number | null;
  fcf: number | null;
}

async function fetchFinmindData(
  token: string,
  dataset: string,
  dataId: string,
  startDate: string,
  endDate: string,
  // deno-lint-ignore no-explicit-any
): Promise<any[]> {
  const u = new URL(FINMIND_URL);
  u.searchParams.set("dataset", dataset);
  u.searchParams.set("data_id", dataId);
  u.searchParams.set("start_date", startDate);
  u.searchParams.set("end_date", endDate);
  u.searchParams.set("token", token);
  const r = await fetch(u, {signal:AbortSignal.timeout(8000)});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.status !== 200) throw new Error(`FinMind status=${j.status} msg=${j.msg}`);
  return Array.isArray(j.data) ? j.data : [];
}

// long-format -> Map<period_end, Map<type, value>>
function pivotByPeriod(
  // deno-lint-ignore no-explicit-any
  rows: any[],
): Map<string, Map<string, number>> {
  const map = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!map.has(r.date)) map.set(r.date, new Map());
    const v = collectionNumber(r.value);
    if (v != null && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) map.get(r.date)!.set(r.type, v);
  }
  return map;
}

async function processSymbol(
  token: string,
  symbol: string,
  startDate: string,
  endDate: string,
): Promise<FundamentalRow[]> {
  const [fs, bs, cf] = await Promise.all([
    fetchFinmindData(token, "TaiwanStockFinancialStatements", symbol, startDate, endDate),
    fetchFinmindData(token, "TaiwanStockBalanceSheet", symbol, startDate, endDate),
    fetchFinmindData(token, "TaiwanStockCashFlowsStatement", symbol, startDate, endDate),
  ]);

  const fsMap = pivotByPeriod(fs);
  const bsMap = pivotByPeriod(bs);
  const cfMap = pivotByPeriod(cf);
  const allPeriods = new Set([...fsMap.keys(), ...bsMap.keys(), ...cfMap.keys()]);

  const rows: FundamentalRow[] = [];
  for (const period of allPeriods) {
    const f = fsMap.get(period);
    const b = bsMap.get(period);
    const c = cfMap.get(period);

    const ocf = c?.get("CashFlowsFromOperatingActivities") ?? null;
    const ic = c?.get("CashProvidedByInvestingActivities") ?? null;
    const fcf = (ocf != null && ic != null) ? ocf + ic : null;

    rows.push({
      symbol,
      period_end: period,
      eps: f?.get("EPS") ?? null,
      // 損益表內 EquityAttributableToOwnersOfParent = 歸屬母公司淨利(注意:跟 BS 同名但意義不同)
      net_income: f?.get("EquityAttributableToOwnersOfParent") ?? null,
      revenue: f?.get("Revenue") ?? null,
      gross_profit: f?.get("GrossProfit") ?? null,
      operating_income: f?.get("OperatingIncome") ?? null,
      // 資產負債表內 EquityAttributableToOwnersOfParent = 歸屬母公司權益合計
      total_equity: b?.get("EquityAttributableToOwnersOfParent") ?? null,
      total_assets: b?.get("TotalAssets") ?? null,
      total_liabilities: b?.get("Liabilities") ?? null,
      ocf,
      ic,
      fcf,
    });
  }
  return rows;
}

Deno.serve(async (req: Request) => {
  const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) return Response.json({error:"unauthorized"},{status:401});
  const sb=createClient(Deno.env.get("SUPABASE_URL")!,key);
  if (!await authorizeServiceRequest(req,key,async()=>{
    const r=await sb.rpc("read_edge_function_auth"); return r.error?null:r.data;
  })) return Response.json({error:"unauthorized"},{status:401});
  const started=Date.now();
  try {
    const [targets,statuses,token]=await Promise.all([
      sb.from("v_collection_priority").select("symbol,priority,is_etf"),
      sb.from("collection_status").select("symbol,status,observed_at").eq("dataset","fundamentals"),
      sb.rpc("read_finmind_token"),
    ]);
    if(targets.error || statuses.error || token.error || !token.data) throw new Error("collection configuration unavailable");
    const due=collectionOrder(targets.data??[],statuses.data??[]).slice(0,12);
    const {data:log,error:logError}=await sb.from("fetch_log").insert({source:"finmind_fundamentals"}).select("id").single();
    if(logError || !log) throw new Error("collection log unavailable");
    let written=0,calls=0,errors=0,processed=0;
    const today=new Date().toISOString().slice(0,10);
    const startDate=new Date(started-LOOKBACK_DAYS*86400_000).toISOString().slice(0,10);
    for(const target of due){
      if(Date.now()-started>100_000) break;
      const reserved=await sb.rpc("reserve_collection_quota",{p_n:3});
      if(reserved.error) throw new Error("quota reservation failed");
      if(!reserved.data) break;
      calls+=3;
      let status="ok",reason:string|null=null,dataDate:string|null=null;
      try {
        const rows=await processSymbol(token.data,target.symbol,startDate,today);
        if(!rows.length) {status="empty";reason="來源未回傳季報；尚無可評資料";}
        else {
          const enriched=rows.map(r=>({...r,source:"finmind",fetched_at:new Date().toISOString(),published_at:null}));
          const up=await sb.from("stock_fundamentals_quarterly").upsert(enriched,{onConflict:"symbol,period_end"});
          if(up.error) throw new Error("write failed");
          written+=rows.length;dataDate=rows.map(r=>r.period_end).sort().at(-1)??null;
        }
      } catch {status="error";reason="來源或寫入失敗；待排程重試";errors++;}
      const saved=await sb.from("collection_status").upsert({symbol:target.symbol,dataset:"fundamentals",source:"finmind",status,reason,data_date:dataDate,observed_at:new Date().toISOString(),published_at:null});
      if(saved.error) throw new Error("collection status write failed");
      processed++;
    }
    const finished=await sb.from("fetch_log").update({finished_at:new Date().toISOString(),success:errors===0 && processed===due.length,rows_written:written,error:errors?`${errors} symbols failed`:processed<due.length?"quota or runtime budget reached; queued for next run":null}).eq("id",log.id);
    if(finished.error) throw new Error("collection log write failed");
    return Response.json({processed,queued:due.length-processed,written,api_calls:calls,errors});
  }catch{return Response.json({error:"fundamental collection failed"},{status:500});}
});