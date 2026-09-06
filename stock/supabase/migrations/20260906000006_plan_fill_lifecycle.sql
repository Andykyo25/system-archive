-- Use the same plan-before-transaction lock order as record_plan_buy.
-- Removing a mistaken linked BUY restores its original plan atomically.
create or replace function public.delete_transaction_with_plan(p_txn_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare linked_plan uuid; deleted_plan uuid;
begin
  select plan_id into linked_plan from public.holdings_transactions where id=p_txn_id;
  if linked_plan is not null then
    perform 1 from public.trade_plans where id=linked_plan for update;
  end if;
  delete from public.holdings_transactions where id=p_txn_id returning plan_id into deleted_plan;
  if deleted_plan is not null then
    update public.trade_plans p set status='watching'
    where p.id=deleted_plan and p.status='entered'
      and not exists(select 1 from public.holdings_transactions t where t.plan_id=p.id and t.txn_type='BUY');
  end if;
end $$;
revoke all on function public.delete_transaction_with_plan(uuid) from public,anon,authenticated;
grant execute on function public.delete_transaction_with_plan(uuid) to service_role;
