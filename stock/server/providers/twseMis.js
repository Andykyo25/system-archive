// TWSE MIS（盤中即時行情）— 台灣本地 API、券商級用量、無 rate limit
// https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw|tse_t00.tw&json=1&delay=0
//
// 欄位對照：
//   @  股票代碼.市場（2330.tw）         c   代碼（2330）
//   n  簡稱                              nf  全名
//   z  即時成交價（"-" = 無成交）        tv  最近一筆成交量
//   v  累計量                            o   開盤    h 最高 l 最低
//   y  昨收                              u   漲停   w 跌停
//   a  五檔賣價（升序，_ 分隔）           f   五檔賣量
//   b  五檔買價（降序）                  g   五檔買量
//   t  時間 hh:mm:ss                     tlong unix ms
//   d  日期 YYYYMMDD
//
// 索引：個股用 tse_(code).tw（上市）、otc_(code).tw（上櫃）；指數 tse_t00.tw（加權）、otc_o00.tw（櫃買）

const BASE = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      Referer: 'https://mis.twse.com.tw/stock/index.jsp',
    },
  });
  if (!res.ok) throw new Error(`mis HTTP ${res.status}`);
  const text = await res.text();
  // MIS 回傳前綴可能有空行
  return JSON.parse(text);
}

// chunk 以避免 URL 過長
const CHUNK = 50;

function parseRow(r) {
  const num = (v) => {
    if (v == null || v === '' || v === '-') return null;
    const n = +v;
    return Number.isFinite(n) ? n : null;
  };
  const fives = (s) => (s ? s.split('_').filter(Boolean).map(num) : []);
  const z = num(r.z);
  const y = num(r.y);
  const o = num(r.o);
  const high = num(r.h);
  const low = num(r.l);
  const limitUp = num(r.u);
  const limitDown = num(r.w);
  // 五檔最佳買賣
  const bid = fives(r.b);   // 買盤五檔（高 → 低）
  const ask = fives(r.a);   // 賣盤五檔（低 → 高）
  const bestBid = bid[0] ?? null;
  const bestAsk = ask[0] ?? null;
  // ★ 改進 price 來源優先序（修復漲停／跌停鎖死取不到價的 bug）：
  //   1. z（即時成交價）— 正常成交時最準
  //   2. 漲停鎖死（bestBid 存在但 bestAsk 不存在 = 沒人賣）→ 取 bestBid（漲停價）
  //   3. 跌停鎖死（bestAsk 存在但 bestBid 不存在 = 沒人買）→ 取 bestAsk（跌停價）
  //   4. 兩邊都有 → 取中間價
  //   5. 都沒 → 用 high（盤中最高，比 open 接近現況）
  //   6. 最後才退到 open
  let price;
  if (z != null) price = z;
  else if (bestBid != null && bestAsk == null) price = bestBid;            // 漲停鎖死
  else if (bestAsk != null && bestBid == null) price = bestAsk;            // 跌停鎖死
  else if (bestBid != null && bestAsk != null) price = (bestBid + bestAsk) / 2;
  else if (high != null && limitUp != null && high >= limitUp) price = limitUp;   // 漲停但缺五檔
  else if (low != null && limitDown != null && low <= limitDown) price = limitDown;
  else price = high ?? o;
  return {
    code: r.c,
    name: r.n,
    fullName: r.nf,
    market: r.ex,           // tse / otc
    price,
    last: z,                // 真實最後成交（可能 -）
    open: o,
    high,
    low,
    prevClose: y,
    limitUp,
    limitDown,
    volume: num(r.v),       // 累計成交張數
    bestBid,
    bestAsk,
    bid,                    // 五檔買價陣列
    ask,                    // 五檔賣價陣列
    bidVol: fives(r.g),
    askVol: fives(r.f),
    time: r.t,              // hh:mm:ss
    tlong: +r.tlong,
    chg: price != null && y != null ? price - y : null,
    pct: price != null && y ? ((price - y) / y) * 100 : null,
    source: 'twse-mis',
  };
}

// 一次查多個個股（自動 chunk）
// codes: ['2330', '2317', ...]，會自動加 tse_ 或 otc_ 前綴
// market: 'tse' 預設，需要時可指定 'otc'
export async function quotes(codes, market = 'tse') {
  if (!Array.isArray(codes) || !codes.length) return [];
  const out = [];
  for (let i = 0; i < codes.length; i += CHUNK) {
    const batch = codes.slice(i, i + CHUNK);
    const ex_ch = batch.map((c) => `${market}_${c}.tw`).join('|');
    try {
      const j = await fetchJson(`${BASE}?ex_ch=${encodeURIComponent(ex_ch)}&json=1&delay=0`);
      const arr = (j.msgArray || []).map(parseRow);
      out.push(...arr);
    } catch (e) {
      // 整批失敗，給每個 code 一個錯誤標記
      batch.forEach((c) => out.push({ code: c, error: e.message, source: 'twse-mis' }));
    }
  }
  return out;
}

// 大盤指數（加權 / 櫃買）
export async function indices() {
  const j = await fetchJson(`${BASE}?ex_ch=tse_t00.tw|otc_o00.tw&json=1&delay=0`);
  const map = {};
  (j.msgArray || []).forEach((r) => {
    const parsed = parseRow(r);
    if (r.c === 't00') map.taiex = parsed;
    else if (r.c === 'o00') map.otc = parsed;
  });
  return map;
}

// 混合查詢（給 indices route 用，個股 + 指數）
export async function mixedQuote(items) {
  // items: [{ kind:'stock'|'index', code, market }]
  if (!items || !items.length) return [];
  const ex_ch = items.map((it) =>
    it.kind === 'index'
      ? (it.market === 'otc' ? 'otc_o00.tw' : 'tse_t00.tw')
      : `${it.market || 'tse'}_${it.code}.tw`
  ).join('|');
  const j = await fetchJson(`${BASE}?ex_ch=${encodeURIComponent(ex_ch)}&json=1&delay=0`);
  return (j.msgArray || []).map(parseRow);
}
