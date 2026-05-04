// 鉅亨網新聞 — anue API（公開、無需 token）
// https://api.cnyes.com/media/api/v1/newslist/category/<category>?limit=20

const BASE = 'https://api.cnyes.com/media/api/v1/newslist/category';

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 TWSE-WarRoom/1.0',
    },
  });
  if (!res.ok) throw new Error(`cnyes HTTP ${res.status}`);
  return res.json();
}

function decodeHTML(s) {
  if (!s) return '';
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function timeLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = Date.now();
  const diffMin = (now - d.getTime()) / 60000;
  if (diffMin < 60) return `${Math.round(diffMin)} 分前`;
  if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)} 小時前`;
  return d.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' });
}

// category 可選：tw_stock / wd_stock / cn_stock / forex / future / headline
export async function newsList(category = 'tw_stock', limit = 20) {
  const url = `${BASE}/${category}?limit=${limit}`;
  const j = await fetchJson(url);
  const list = j?.items?.data || [];
  return list.map((n) => ({
    id: n.newsId,
    time: timeLabel(n.publishAt),
    publishAt: n.publishAt,
    title: decodeHTML(n.title),
    summary: decodeHTML(n.summary || n.content || '').slice(0, 80),
    url: `https://news.cnyes.com/news/id/${n.newsId}`,
    category: n.categoryName || '',
    source: '鉅亨網',
    keyword: n.keyword || [],
  }));
}

// 多分類聚合 — 抓多個 category 後依 publishAt 去重 & 排序，給「個股新聞」搜尋用
export async function newsAggregate(categories = ['tw_stock', 'headline', 'wd_stock'], limitEach = 60) {
  const all = await Promise.allSettled(categories.map((c) => newsList(c, limitEach)));
  const merged = [];
  const seen = new Set();
  all.forEach((r) => {
    if (r.status !== 'fulfilled') return;
    r.value.forEach((n) => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      merged.push(n);
    });
  });
  // 由新到舊
  merged.sort((a, b) => (b.publishAt || 0) - (a.publishAt || 0));
  return merged;
}

// 個股 / 大盤日線歷史（K 線備援 — 免 quota、穩定）
// 鉅亨網 charting API — 嘗試多種 URL / symbol 變體（API 會時不時改規格）
async function tryCnyesChart(symbol, from, to) {
  const urls = [
    `https://ws.api.cnyes.com/ws/api/v1/charting/history?symbol=${symbol}&resolution=D&from=${from}&to=${to}&quote=1`,
    `https://ws.api.cnyes.com/ws/api/v1/charting/history?symbol=${symbol}&resolution=D&from=${from}&to=${to}`,
    `https://api.cnyes.com/charting/api/v1/history?symbol=${symbol}&resolution=D&from=${from}&to=${to}`,
  ];
  for (const url of urls) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-TW,zh;q=0.9',
          Origin: 'https://www.cnyes.com',
          Referer: 'https://www.cnyes.com/',
        },
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const j = await res.json();
      // 各端點回傳格式略不同，找含 t/c 陣列的 key
      const d = j.data || j;
      const ts = d.t || d.time || [];
      const c = d.c || d.close || [];
      if (ts.length && c.length) return { ts, o: d.o || d.open || [], h: d.h || d.high || [], l: d.l || d.low || [], c, v: d.v || d.volume || [] };
    } catch { clearTimeout(t); }
  }
  return null;
}

export async function chart(code, days = 365, market = 'TWS', kind = 'STOCK') {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;

  // 試多種 symbol 變體（cnyes 不同股票可能用不同前綴）
  // 大盤 TAIEX 嘗試常見代號：IX0001 / Y9999 / TAIEX / t00
  const symbols = kind === 'INDEX'
    ? ['TWS:IX0001:INDEX', 'TWS:Y9999:INDEX', 'TWS:TAIEX:INDEX', 'TWS:t00:INDEX'].map(encodeURIComponent)
    : [`${market}:${code}:STOCK`, `TWS:${code}:STOCK`, `TWG:${code}:STOCK`].map(encodeURIComponent);

  for (const sym of symbols) {
    const data = await tryCnyesChart(sym, from, to);
    if (data && data.ts.length) {
      const out = data.ts.map((sec, i) => ({
        date: new Date(sec * 1000).toISOString().slice(0, 10),
        open: data.o[i] != null ? +data.o[i] : null,
        high: data.h[i] != null ? +data.h[i] : null,
        low: data.l[i] != null ? +data.l[i] : null,
        close: data.c[i] != null ? +data.c[i] : null,
        volume: data.v[i] != null ? +data.v[i] : 0,
      })).filter((x) => Number.isFinite(x.close));
      out.sort((a, b) => a.date.localeCompare(b.date));
      if (out.length) return out;
    }
  }
  throw new Error(`cnyes chart empty (tried ${symbols.length} variants)`);
}

// 鉅亨網全文搜尋 — 用於精準個股新聞（依代號或股名搜尋）
// API: https://api.cnyes.com/media/api/v1/search/news?q=<keyword>&limit=30
export async function newsSearch(keyword, limit = 30) {
  if (!keyword) return [];
  const url = `https://api.cnyes.com/media/api/v1/search/news?q=${encodeURIComponent(keyword)}&limit=${limit}`;
  try {
    const j = await fetchJson(url);
    const list = j?.items?.data || j?.data?.items || j?.items || [];
    return list.map((n) => ({
      id: n.newsId || n.id,
      time: timeLabel(n.publishAt),
      publishAt: n.publishAt,
      title: decodeHTML(n.title),
      summary: decodeHTML(n.summary || n.content || '').slice(0, 80),
      url: `https://news.cnyes.com/news/id/${n.newsId || n.id}`,
      category: n.categoryName || '搜尋',
      source: '鉅亨網',
      keyword: n.keyword || [],
    })).filter((n) => n.id && n.title);
  } catch (e) {
    console.warn('[cnyes search]', e.message);
    return [];
  }
}
