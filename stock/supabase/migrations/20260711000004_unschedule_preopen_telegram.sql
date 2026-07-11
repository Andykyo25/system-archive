-- 取消盤前 08:55 Taipei 持股建議推播(Andy 2026-07-11:早上通知取消,保留盤後)
-- 盤後 telegram-holdings-advice-postclose(13:35 Taipei)不動。
-- 晨間資訊改由 dashboard HoldingsIntelWidget(韓美股 + 台/國際新聞整合)承接。
-- rollback:select cron.schedule('telegram-holdings-advice-preopen', '55 0 * * 1-5', <同 postclose 的 net.http_post body>);
select cron.unschedule('telegram-holdings-advice-preopen');
