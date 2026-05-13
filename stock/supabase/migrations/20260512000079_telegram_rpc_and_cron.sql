-- M9.3+: Telegram notify RPC + cron
--
-- Andy 需先在 supabase dashboard SQL editor 設 vault secret:
--   select vault.create_secret('<BOT_TOKEN>', 'telegram_bot_token');
--   select vault.create_secret('<CHAT_ID>', 'telegram_chat_id');
--
-- EF notify-holdings-telegram 透過 RPC 讀(L10:vault + SECURITY DEFINER RPC 模式)

create or replace function public.read_telegram_bot_token()
returns text
language sql security definer set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'telegram_bot_token' limit 1
$$;
revoke execute on function public.read_telegram_bot_token() from public, anon, authenticated;
grant execute on function public.read_telegram_bot_token() to service_role;

create or replace function public.read_telegram_chat_id()
returns text
language sql security definer set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'telegram_chat_id' limit 1
$$;
revoke execute on function public.read_telegram_chat_id() from public, anon, authenticated;
grant execute on function public.read_telegram_chat_id() to service_role;

-- Cron 13:35 Taipei (UTC 05:35) 平日推送(收盤後 5 分鐘)
do $$ begin perform cron.unschedule(jobid) from cron.job where jobname = 'telegram-holdings-advice-postclose'; exception when others then null; end $$;
select cron.schedule(
  'telegram-holdings-advice-postclose',
  '35 5 * * 1-5',
  $cron$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/notify-holdings-telegram',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
      'Content-Type','application/json'
    ),
    timeout_milliseconds := 60000
  );
  $cron$
);

-- 開盤前 08:55 Taipei (UTC 00:55)
do $$ begin perform cron.unschedule(jobid) from cron.job where jobname = 'telegram-holdings-advice-preopen'; exception when others then null; end $$;
select cron.schedule(
  'telegram-holdings-advice-preopen',
  '55 0 * * 1-5',
  $cron$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/notify-holdings-telegram',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
      'Content-Type','application/json'
    ),
    timeout_milliseconds := 60000
  );
  $cron$
);
