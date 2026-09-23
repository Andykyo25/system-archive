-- verdict_watch_tick:Telegram 訊息價格去掉尾零(68.3500 → 68.35)(2026-09-23)
-- 由 20260923000004 的函式定義機械替換 r.price_now → trim_scale(r.price_now),其餘不變。
-- rollback:重跑 20260923000004 的 verdict_watch_tick 定義。
create or replace function public.verdict_watch_tick() returns int
language plpgsql as $$
declare
  r record;
  token text := public.read_telegram_bot_token();
  chat text := public.read_telegram_chat_id();
  msg text;
  sent int := 0;
begin
  for r in select * from public.v_verdict_live loop
    update public.verdict_watch set live_state = r.state, live_reason = r.reason,
      live_price = r.price_now, live_at = now()
    where watch_date = r.watch_date and symbol = r.symbol;

    if r.state = 'wait' then continue; end if;
    -- 只推「轉為停止」與「由停止恢復」;第一次 ok 不推,避免雜訊
    if r.state = 'block' and r.notified_state is distinct from 'block' then
      msg := '🔴 停止進場 ' || r.symbol || ' ' || coalesce(r.name, '') || E'\n'
        || '現價 ' || trim_scale(r.price_now) || ' · ' || r.reason;
    elsif r.state = 'ok' and r.notified_state = 'block' then
      msg := '🟢 恢復可進場 ' || r.symbol || ' ' || coalesce(r.name, '') || E'\n'
        || '現價 ' || trim_scale(r.price_now) || ' · 買入 ' || r.entry_min || '–' || r.entry_max || ' · 停損 ' || r.stop_price;
    else
      if r.state = 'ok' and r.notified_state is null then
        update public.verdict_watch set notified_state = 'ok'
        where watch_date = r.watch_date and symbol = r.symbol;
      end if;
      continue;
    end if;

    if token is not null and chat is not null then
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || token || '/sendMessage',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('chat_id', chat, 'text', msg)
      );
      sent := sent + 1;
    end if;
    update public.verdict_watch set notified_state = r.state
    where watch_date = r.watch_date and symbol = r.symbol;
  end loop;
  return sent;
end $$;
