-- 讓 Edge Function 透過 RPC 從 vault 讀 FinMind token
-- security definer + 限制 service_role 才能執行,避免 anon/authenticated 拿到 secret
--
-- 前置:vault secret 'finmind_token' 必須先建立
-- 不放在 migration 內,避免 token 進版本歷史。手動建立指令:
--   select vault.create_secret(
--     '<finmind_token>',
--     'finmind_token',
--     'FinMind API token for fetch-finmind-fallback Edge Function'
--   );

create or replace function public.read_finmind_token()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'finmind_token' limit 1
$$;

revoke execute on function public.read_finmind_token() from public, anon, authenticated;
grant execute on function public.read_finmind_token() to service_role;
