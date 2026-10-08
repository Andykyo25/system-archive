import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "jsr:@supabase/supabase-js@2";
import {authorizeServiceRequest} from "../_shared/authorize.ts";
import {POLICY,initialState,forwardSession,type ForwardState,type Signal,type Bar} from "./engine.ts";
Deno.serve(async(req:Request)=>{
  const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!key) return Response.json({error:"unauthorized"},{status:401});
  const sb=createClient(Deno.env.get("SUPABASE_URL")!,key);
  if(!await authorizeServiceRequest(req,key,async()=>{const r=await sb.rpc("read_edge_function_auth");return r.error?null:r.data;}))
    return Response.json({error:"unauthorized"},{status:401});
  try{
    const saved=await sb.from("r2p_forward_state").select("revision,payload").eq("strategy_version",POLICY.version).maybeSingle();
    if(saved.error) throw new Error("state read failed");
    let state:ForwardState=saved.data?.payload??initialState(),revision=saved.data?.revision??-1;
    const first=await sb.from("r2p_forward_batches").select("signal_date").eq("strategy_version",POLICY.version).order("signal_date").limit(1);
    if(first.error) throw new Error("signals read failed");
    if(!first.data?.length) return Response.json({waiting:"first prospective freeze"});
    const since=state.lastDate??first.data[0].signal_date;
    const batches=await sb.from("r2p_forward_batches").select("signal_date,evidence").eq("strategy_version",POLICY.version).gte("signal_date",since).order("signal_date").limit(32);
    if(batches.error) throw new Error("signals read failed");
    const signals:Signal[]=(batches.data??[]).flatMap(b=>b.evidence);
    const calendar=await sb.from("price_daily").select("trade_date").eq("symbol","0050").gte("trade_date",since).order("trade_date").limit(32);
    if(calendar.error) throw new Error("calendar read failed");
    let completed=0;
    for(let i=0;i<(calendar.data?.length??0);i++){
      const date=calendar.data![i].trade_date;
      if(state.lastDate && date<=state.lastDate) continue;
      // Data after a freeze but before the next freeze may be a partial closing batch.
      if(!(batches.data??[]).some(b=>b.signal_date===date)) break;
      const previousDate=i>0?calendar.data![i-1].trade_date:null;
      const symbols=[...new Set(["0050",...state.positions.map(p=>p.signal.symbol),...signals.filter(s=>s.date===previousDate).map(s=>s.symbol)])];
      const prices=await sb.from("price_daily").select("symbol,trade_date,open,high,low,close,volume,adj_factor").eq("trade_date",date).in("symbol",symbols);
      if(prices.error) throw new Error("prices read failed");
      const bars:Bar[]=(prices.data??[]).map(b=>({symbol:b.symbol,date:b.trade_date,open:Number(b.open),high:Number(b.high),low:Number(b.low),close:Number(b.close),volume:Number(b.volume),factor:b.adj_factor==null?NaN:Number(b.adj_factor)}));
      const next=forwardSession(state,date,previousDate,signals,bars);
      const commit=await sb.rpc("commit_r2p_forward",{p_revision:revision,p_state:next});
      if(commit.error || !commit.data) throw new Error("ledger conflict; retry next run");
      state=next;revision=revision<0?0:revision+1;completed++;
      if(completed>=5) break;
    }
    const log=await sb.from("fetch_log").insert({source:"r2p_forward",finished_at:new Date().toISOString(),success:true,rows_written:completed});
    if(log.error) throw new Error("log write failed");
    return Response.json({completed,last_date:state.lastDate});
  }catch(e){
    const error=e instanceof Error?e.message:"forward run failed";
    await sb.from("fetch_log").insert({source:"r2p_forward",finished_at:new Date().toISOString(),success:false,error});
    return Response.json({error},{status:500});
  }
});
