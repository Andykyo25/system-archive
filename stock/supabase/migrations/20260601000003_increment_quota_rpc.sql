-- B1(全系統審查):FinMind quota 原子遞增 RPC(2026-06-01)
--
-- 問題:所有 finmind EF 用 read-modify-write 更新 api_quota_state.used:
--   讀 used → 加本次 apiCalls → 寫回 (update used = usedSoFar + apiCalls)。
--   兩個 EF 並行時,後寫的會覆蓋前者的扣減 → used 帳面低估 → quota gate
--   形同虛設 → 真實 API 呼叫可能衝破 600 → FinMind 402/429 → 當日後續
--   收料連環失敗(L42/L46 漏資料災難根源之一)。
--
-- 修法:單一 INSERT ... ON CONFLICT DO UPDATE SET used = used + n(Postgres
--   保證單 statement 原子),回新 used 值。EF 把「寫 used」改成 call 本 RPC。
--   gate 的「讀 used」保留(粗略防爆,讀不需原子;關鍵是寫不被覆蓋)。

create or replace function public.increment_quota(
  p_source text,
  p_date date,
  p_n int,
  p_budget int default 600
) returns int
language plpgsql
as $$
declare
  v_used int;
begin
  insert into public.api_quota_state (source, quota_date, used, budget)
  values (p_source, p_date, greatest(p_n, 0), p_budget)
  on conflict (source, quota_date)
  do update set used = public.api_quota_state.used + greatest(p_n, 0)
  returning used into v_used;
  return v_used;
end;
$$;

revoke execute on function public.increment_quota(text, date, int, int) from public, anon, authenticated;
grant execute on function public.increment_quota(text, date, int, int) to service_role;

comment on function public.increment_quota(text, date, int, int) is
  'B1(20260601):原子遞增 api_quota_state.used,取代各 finmind EF 的
   read-modify-write(並行覆蓋使 quota gate 失效)。單 INSERT...ON CONFLICT
   DO UPDATE 保證原子。回新 used。p_source 區分 finmind / finmind_2。';
