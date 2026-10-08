import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "jsr:@supabase/supabase-js@2";
import {authorizeServiceRequest} from "../_shared/authorize.ts";
Deno.serve(async(req:Request)=>{
  const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!key) return Response.json({error:"unauthorized"},{status:401});
  const sb=createClient(Deno.env.get("SUPABASE_URL")!,key);
  if(!await authorizeServiceRequest(req,key,async()=>{const r=await sb.rpc("read_edge_function_auth");return r.error?null:r.data;}))
    return Response.json({error:"unauthorized"},{status:401});
  const lease=crypto.randomUUID();
  try{
    const evaluated=await sb.rpc("evaluate_holding_risks");if(evaluated.error) throw new Error("risk evaluation failed");
    const events=await sb.rpc("claim_holding_risks",{p_token:lease});if(events.error) throw new Error("risk event claim failed");
    let delivered=0;
    if(events.data?.length){
      const [token,chat]=await Promise.all([sb.rpc("read_telegram_bot_token"),sb.rpc("read_telegram_chat_id")]);
      for(const e of events.data){
        let ok=false;
        try{
          if(token.error||chat.error||!token.data||!chat.data) throw new Error("notification unavailable");
          const stamp=new Date(e.created_at).toLocaleString("zh-TW",{timeZone:"Asia/Taipei",hour12:false});
          const response=await fetch(`https://api.telegram.org/bot${token.data}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({chat_id:chat.data,text:`持股風險 #${e.id}｜${e.symbol}\n${e.reason}\n檢查時間 ${stamp}\n${JSON.stringify(e.snapshot)}\n請核對原有部位計畫。此為風險變化提醒，未下單。`}),signal:AbortSignal.timeout(5000)});
          const payload=await response.json();ok=response.ok && payload.ok===true;
        }catch{ok=false;}
        const done=await sb.rpc("finish_holding_risk",{p_id:e.id,p_token:lease,p_delivered:ok});
        if(done.error||!done.data) throw new Error("risk delivery persistence failed");
        if(ok) delivered++;
      }
    }
    const pending=(events.data?.length??0)-delivered;
    const log=await sb.from("fetch_log").insert({source:"holding_risks",finished_at:new Date().toISOString(),success:pending===0,rows_written:delivered,error:pending?"pending deliveries will retry":null});
    if(log.error) throw new Error("risk log write failed");
    return Response.json({events:evaluated.data,delivered,pending});
  }catch{
    await sb.from("fetch_log").insert({source:"holding_risks",finished_at:new Date().toISOString(),success:false,error:"holding risk monitor failed"});
    return Response.json({error:"holding risk monitor failed"},{status:500});
  }
});
