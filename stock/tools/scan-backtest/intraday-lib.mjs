// 停損 / 停利「同日誰先到」的分 K 判定(純函式,不碰檔案 / 網路 / DB)。
//
// 背景:lib.mjs 的 sim() 對「同一天低點 ≤ 停損、高點 ≥ 停利」固定先判停損(保守假設),日 K 無法分辨先後。
// 這裡數出「同日兩邊都碰到」的交易有多少,判斷這個假設會不會造成偏誤(2026-10-08:上線規格 R2p 為 0 / 2,066)。
//
// 單位:s.path[j] = [開, 高, 低, 收],都是「相對進場日(T+1)收盤」的百分比(還原價);
//       停損 stopE 與停利 tp 也是相對進場收盤的百分比。路徑第 j 天的日期 = 交易日曆[T 的位置 + 2 + j]。
//
// 若日後某個出場設定的模糊比例明顯偏高(例如 > 1%),可用分 K 判定(富邦 historical/candles timeframe=1,
// 2023-05-23 起):分 K 是原始(未還原)價,同一天內還原因子不變,所以用「當日開盤」做錨把百分比換算成價位:
//   price_raw(L) = (1 + L/100) × OPEN_raw / (1 + o_pct/100),
// 再逐分鐘找第一個 low ≤ 停損價 或 high ≥ 停利價;同一分鐘兩邊都碰到 = 無法判定。換算後的日高 / 日低要貼近日 K 才採信。

// 上線規格 R2p 的交易集合(與 r2p.mjs 相同)。
export function r2pTraded(SIG) {
  const stopOf = (s) => 1 - (3 * s.atrPct) / 100;
  const pass = (s) => s.score >= 80 && s.offHi60 > -5 && s.supply90 <= 0.1 && s.e50_ma60 > 0;
  const byD = new Map();
  for (const s of SIG.filter(pass)) {
    if (!byD.has(s.d)) byD.set(s.d, []);
    byD.get(s.d).push(s);
  }
  const listed = [...byD.values()].flatMap((a) => a.sort((x, y) => y.score - x.score || y.dayPct - x.dayPct).slice(0, 3));
  return { traded: listed.filter((s) => s.path?.length >= 20 && s.l1 != null && 1 + s.l1 / 100 > stopOf(s)), stopOf };
}

// 停損相對進場收盤的百分比(與 sim 一致)
export const stopPct = (s, stop) => (stop / (1 + s.day1 / 100) - 1) * 100;

// 找出 sim 的「先判停損」假設會影響結果的那一天:
//   第一個有任何事件的日子,若同時 l ≤ 停損 且 h ≥ 停利(開盤沒有先跳過任何一邊)→ 回傳該日。
//   另含「開盤已 ≥ 停利、但低點也 ≤ 停損」:sim 會誤判成停損,實際開盤就已達標。
// 沒有這種日子(或交易在此之前已結束)→ null。
export function ambiguousDay(s, { H = 20, stop, tp }) {
  if (s.day1 == null || !s.path || s.path.length < H) return null;
  const stopE = stopPct(s, stop);
  for (let j = 0; j < H; j++) {
    const [o, h, l] = s.path[j];
    if (o <= stopE) return null; // 開盤跳空破停損:確定停損
    if (l <= stopE) return h >= tp || o >= tp ? { j, stopE, tp, o, h, l } : null;
    if (o >= tp || h >= tp) return null; // 只有停利:確定
  }
  return null;
}
