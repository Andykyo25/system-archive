-- Apply after verifying all four Edge Functions with JWT verification enabled.
-- Target project was checked against website env and the authenticated Dashboard.
create function public.invoke_optimization_worker(p_name text)
returns bigint language plpgsql security definer set search_path=public as $$
begin
  if p_name not in ('fetch-finmind-fundamentals','fetch-official-fundamentals','run-r2p-forward','check-holding-risks') then
    raise exception 'worker not allowed';
  end if;
  if public.read_edge_function_auth() is null then raise exception 'worker credential unavailable';end if;
  return net.http_post(
    url:='https://trnvkwievjewhghdvniq.supabase.co/functions/v1/'||p_name,
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||public.read_edge_function_auth()),
    body:='{}'::jsonb,timeout_milliseconds:=120000
  );
end $$;
revoke all on function public.invoke_optimization_worker(text) from public,anon,authenticated;
grant execute on function public.invoke_optimization_worker(text) to service_role;
select cron.schedule('capture-collection-candidates','5 10,15 * * 1-5','select public.capture_collection_candidates()');
select cron.schedule('priority-fundamentals','20 10-17 * * 1-5',
  $$select public.invoke_optimization_worker('fetch-finmind-fundamentals')$$);
select cron.schedule('official-fundamentals','30 11 * * 1-5',
  $$select public.invoke_optimization_worker('fetch-official-fundamentals')$$);
select cron.schedule('freeze-r2p-forward','15 10,15 * * 1-5','select public.freeze_r2p_forward()');
select cron.schedule('run-r2p-forward','25 10,15 * * 1-5',
  $$select public.invoke_optimization_worker('run-r2p-forward')$$);
select cron.schedule('holding-risk-monitor','*/10 * * * *',
  $$do $job$ begin
    if exists(select 1 from public.v_holdings_current)
       or exists(select 1 from public.holding_risk_events where not notified and delivery_after<=now()) then
      perform public.invoke_optimization_worker('check-holding-risks');
    end if;
  end $job$;$$);
-- Rollback: deactivate these six named jobs, restore the backed-up stock universe
-- view and the previous fundamentals worker. Keep research/monitor tables and
-- migration history; do not delete holdings or reinterpret frozen batches.
