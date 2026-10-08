// 法人特徵的 PIT 檢驗用純函式(不碰檔案 / 網路)。
// PIT:訊號日 T 的法人買賣超在 T 收盤後約 16:00 公布;R2p 進場在 T+1 收盤,所以用到 T(含)以前的法人資料沒有前視。

// instByDate: Map<日期, Map<代號, [外資, 投信, 自營商, 三大合計]>>;dates: 交易日曆;index: 日期 → 位置。
// 回傳「近 k 日(含 T)某一類法人淨買賣超股數的合計 / (k × 20 日均量)」,即占均量的比例;
//   日曆上有任何一天整天沒有資料 → null(不猜);有資料但該股當天沒出現 → 視為 0(沒有法人買賣)。
export const CLASS = { foreign: 0, trust: 1, dealer: 2, total: 3 };

export function netShare(s, kind, k, { instByDate, dates, index }) {
  const i = index.get(s.d);
  const avg20 = s.volRatio ? s.vol / s.volRatio : null;
  if (i == null || !(avg20 > 0) || i - k + 1 < 0) return null;
  let sum = 0;
  for (let j = i - k + 1; j <= i; j++) {
    const day = instByDate.get(dates[j]);
    if (!day) return null;
    sum += day.get(s.sym)?.[CLASS[kind]] ?? 0;
  }
  return sum / (k * avg20);
}

// 分位門檻(線性內插);values 先去掉 null
export function quantile(values, q) {
  const a = values.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// 「高組 − 低組」平均報酬差的按日重抽信賴區間:同一個訊號日的交易視為一個群,整群抽取(L75:同一天的訊號不獨立)。
// hi / lo: [{ d, r }];回傳 { diff, lo95, hi95 };任一組為空 → null。
export function bootDiff(hi, lo, B = 1000, rand = Math.random) {
  if (!hi.length || !lo.length) return null;
  const byDate = new Map();
  const slot = (d) => byDate.get(d) ?? byDate.set(d, { hs: 0, hn: 0, ls: 0, ln: 0 }).get(d);
  for (const x of hi) { const c = slot(x.d); c.hs += x.r; c.hn++; }
  for (const x of lo) { const c = slot(x.d); c.ls += x.r; c.ln++; }
  const clusters = [...byDate.values()];
  const diffs = [];
  for (let b = 0; b < B; b++) {
    let hs = 0, hn = 0, ls = 0, ln = 0;
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[Math.floor(rand() * clusters.length)];
      hs += c.hs; hn += c.hn; ls += c.ls; ln += c.ln;
    }
    if (hn && ln) diffs.push(hs / hn - ls / ln);
  }
  diffs.sort((a, b) => a - b);
  return {
    diff: mean(hi.map((x) => x.r)) - mean(lo.map((x) => x.r)),
    lo95: diffs[Math.floor(diffs.length * 0.025)],
    hi95: diffs[Math.floor(diffs.length * 0.975)],
  };
}
