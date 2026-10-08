import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "jsr:@supabase/supabase-js@2";
import {authorizeServiceRequest} from "../_shared/authorize.ts";
// Latest official accumulated statements are supplementary. They must not be
// mixed into FinMind single-quarter ROE/FCF without unit and period reconciliation.
Deno.serve(async(req:Request)=>{
  const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!key) return Response.json({error:"unauthorized"},{status:401});
  const sb=createClient(Deno.env.get("SUPABASE_URL")!,key);
  if(!await authorizeServiceRequest(req,key,async()=>{const r=await sb.rpc("read_edge_function_auth");return r.error?null:r.data;}))
    return Response.json({error:"unauthorized"},{status:401});
  const targets=await sb.from("v_collection_priority").select("symbol,is_etf");
  if(targets.error) return Response.json({error:"collection universe unavailable"},{status:500});
  const wanted=new Set((targets.data??[]).filter(t=>!t.is_etf).map(t=>t.symbol));
  const observed_at=new Date().toISOString();
  let written=0,errors=0;
  for(const [dataset,path] of [
    ["income","t187ap06_L_ci"],["balance","t187ap07_L_ci"],
  ]){
    try{
      const response=await fetch("https://openapi.twse.com.tw/v1/opendata/"+path,{signal:AbortSignal.timeout(15000)});
      if(!response.ok) throw new Error("official API failed");
      const payload=await response.json();
      if(!Array.isArray(payload) || !payload.length) throw new Error("invalid official payload");
      const rows=payload.filter(r=>wanted.has(r["公司代號"])).filter(r=>r["年度"] && r["季別"]).map(r=>({
        symbol:r["公司代號"],dataset,period_label:r["年度"]+"Q"+r["季別"],source:"twse_openapi/"+path,
        payload:r,observed_at,published_at:null,
      }));
      if(rows.length){const saved=await sb.from("official_financial_snapshots").upsert(rows);if(saved.error) throw new Error("snapshot write failed");written+=rows.length;}
    }catch{errors++;}
  }
  const log=await sb.from("fetch_log").insert({source:"official_fundamentals",finished_at:new Date().toISOString(),success:errors===0,rows_written:written,error:errors?"Official general-industry statements unavailable; FinMind remains primary":null});
  return Response.json({written,errors:errors+(log.error?1:0)},{status:errors || log.error?502:200});
});
