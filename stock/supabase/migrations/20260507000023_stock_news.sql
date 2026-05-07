-- 個股新聞:Google News RSS,每 6 小時 cron 抓所有 target symbol

create table public.stock_news (
  id bigserial primary key,
  symbol text not null,
  title text not null,
  url text not null,
  source text,
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  unique(symbol, url)
);
create index idx_stock_news_symbol_time on public.stock_news (symbol, published_at desc nulls last);
alter table public.stock_news enable row level security;

-- 每 6 小時 cron(UTC 0/6/12/18,Taipei 8/14/20/02)
select cron.schedule(
  'fetch-stock-news-6h',
  '0 */6 * * *',
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-stock-news',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 600000
  );
  $$
);
