-- verdict_plan_levels 與前端 planDefaults 逐分對齊(2026-09-23)
-- numeric round 為「四捨五入遠離零」,JS Math.round(n*100)/100 走 float8:
--   332.5 × 0.97 = 322.525 → numeric 322.53、JS 322.52(float 為 322.52499…)。
-- 改用 float8 + floor(x*100 + 0.5)/100,與 JS 相同 IEEE 運算。
-- rollback:重跑 20260923000004 的 verdict_plan_levels 定義。
create or replace function public.verdict_plan_levels(p_close numeric, p_atr14 numeric, p_ma20 numeric, p_mult numeric)
returns table (entry_min numeric, entry_max numeric, stop_price numeric)
language plpgsql immutable as $$
declare
  c float8 := p_close::float8;
  emin float8 := floor(c * 0.97 * 100 + 0.5) / 100;
  emax float8 := floor(c * 1.03 * 100 + 0.5) / 100;
  atr_stop float8 := case when p_atr14 is not null and p_mult is not null
                          then c - p_mult::float8 * p_atr14::float8 end;
  ceiling float8 := floor(emin * 0.99 * 100 + 0.5) / 100;
  stop float8;
begin
  stop := greatest(case when atr_stop > 0 then atr_stop end,
                   case when p_ma20 > 0 then p_ma20::float8 end);
  if stop is null then stop := emin * (1 - 0.08); end if;
  if stop > ceiling then stop := ceiling; end if;
  stop := floor(stop * 100 + 0.5) / 100;
  if stop >= emin then stop := floor((emin - 0.01) * 100 + 0.5) / 100; end if;
  return query select emin::numeric, emax::numeric, case when stop > 0 then stop::numeric end;
end $$;
