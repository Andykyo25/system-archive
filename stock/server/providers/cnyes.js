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

// category 可選：tw_stock / wd_stock / cn_stock / forex / future
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
