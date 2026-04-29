import { state, on } from '../state.js';
import { fmt, sign } from '../utils/format.js';
import { newsMock, flowMock } from '../data/mock.js';
import { api } from '../data/api.js';

let flowBox, flowTotalEl, newsListEl, futuresEl;
let newsTimer = null;

export function mount() {
  flowBox = document.getElementById('flow-bars');
  flowTotalEl = document.getElementById('flow-total');
  newsListEl = document.getElementById('news-list');
  futuresEl = document.getElementById('futures-box');

  state.flow = state.flow.length ? state.flow : flowMock;
  renderFlow();
  renderFutures();
  loadNews();

  // 新聞每 90 秒重抓一次（鉅亨網更新頻率 ~1-2 分鐘）
  newsTimer = setInterval(loadNews, 90 * 1000);

  on('flow:changed', renderFlow);
  on('indices:changed', renderFutures);
}

async function loadNews() {
  try {
    const list = await api.news('tw_stock', 20);
    renderNews(list);
  } catch (e) {
    console.warn('[news]', e.message);
    if (!newsListEl.children.length) renderNews(newsMock); // 首次失敗用 mock
  }
}

function renderFlow() {
  const flow = state.flow.length ? state.flow : flowMock;
  const max = Math.max(...flow.flatMap((f) => [f.buy, f.sell]));
  flowBox.innerHTML = flow.map((f) => {
    const net = f.buy - f.sell;
    const buyW = (f.buy / max) * 48, sellW = (f.sell / max) * 48;
    return `
      <div class="flow-bar">
        <span class="who">${f.who}</span>
        <div class="bar-wrap">
          <div class="bar sell" style="width:${sellW}%"></div>
          <div class="bar buy"  style="width:${buyW}%"></div>
        </div>
        <span class="num" style="color:${net > 0 ? 'var(--up)' : 'var(--down)'}">${sign(net)}</span>
      </div>`;
  }).join('');
  const total = flow.reduce((s, f) => s + (f.buy - f.sell), 0);
  flowTotalEl.textContent = `${sign(total)} 億`;
  flowTotalEl.style.color = total > 0 ? 'var(--up)' : 'var(--down)';
}

function renderNews(list) {
  if (!list || !list.length) {
    newsListEl.innerHTML = `<div class="news-item"><div class="title" style="color:var(--dim)">新聞載入中…</div></div>`;
    return;
  }
  newsListEl.innerHTML = list.slice(0, 15).map((n) => {
    // 判定急件：5 分鐘內或標題含「快訊」「公告」「升降」等關鍵字
    const urgent = (n.publishAt && (Date.now() / 1000 - n.publishAt < 300))
      || /快訊|公告|央行|升息|降息|跌停|漲停|獲利|警示/.test(n.title);
    const tag = n.category || (urgent ? '快訊' : '台股');
    const url = n.url ? `href="${n.url}" target="_blank" rel="noopener"` : '';
    return `
      <a class="news-item" ${url} style="display:block;color:inherit;text-decoration:none">
        <div class="time">${n.time}<span class="tag ${urgent ? 'urgent' : ''}" style="margin-left:6px">${tag}</span></div>
        <div class="title">${n.title}</div>
      </a>`;
  }).join('');
}

function renderFutures() {
  const i = state.indices || {};
  const items = [
    { name: '費半 SOX',   v: i.sox },
    { name: 'NASDAQ',     v: i.ixic },
    { name: 'S&P 500',    v: i.gspc },
    { name: '道瓊',       v: i.dji },
  ];
  futuresEl.innerHTML = items.map((it) => {
    if (!it.v || it.v.price == null && it.v.close == null) {
      return `<div class="news-item"><div class="title">${it.name}</div><div class="time">--</div></div>`;
    }
    const price = it.v.price ?? it.v.close;
    const prev = it.v.prevClose ?? (price - (it.v.change || 0));
    const chg = it.v.change ?? (price - prev);
    return `
      <div class="news-item" style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div class="title">${it.name}</div>
          <div class="time">${it.v.symbol || ''}</div>
        </div>
        <div style="text-align:right;font-family:'JetBrains Mono',monospace">
          <div style="font-weight:700">${fmt(price, 2)}</div>
          <div style="color:${chg > 0 ? 'var(--up)' : 'var(--down)'};font-size:11px">${sign(chg)}</div>
        </div>
      </div>`;
  }).join('');
}
