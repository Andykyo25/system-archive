// 技術診斷 — rule-based，從 K 線 + 三大法人推導訊號
// 輸出結構固定，給 stockPanel 的「技術診斷」區塊渲染

const avg = (arr) => arr.reduce((s, x) => s + x, 0) / (arr.length || 1);

function std(arr) {
  if (!arr.length) return 0;
  const m = avg(arr);
  const v = avg(arr.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

// 乖離率 = (last - MA(period)) / MA(period) * 100
export function calcBias(closes, period = 20) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const slice = closes.slice(-period);
  const m = avg(slice);
  if (!m) return null;
  return ((closes[closes.length - 1] - m) / m) * 100;
}

// Wilder ATR(14) — 平均真實波幅
export function calcATR(k, period = 14) {
  if (!Array.isArray(k) || k.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < k.length; i++) {
    const a = k[i].high - k[i].low;
    const b = Math.abs(k[i].high - k[i - 1].close);
    const c = Math.abs(k[i].low - k[i - 1].close);
    tr.push(Math.max(a, b, c));
  }
  // 第一個 ATR 用前 period 個 TR 的平均，之後用 Wilder smoothing
  let atr = avg(tr.slice(0, period));
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return atr;
}

// 扣抵值 = period 日前的收盤價（MA 反轉判讀用）
export function calcMaDeduct(closes, period = 20) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  return closes[closes.length - period];
}

// 量能 Z-score：(last - mean) / std，>2 表示異常爆量
export function calcVolZ(vols, period = 20) {
  if (!Array.isArray(vols) || vols.length < period + 1) return null;
  const ref = vols.slice(-period - 1, -1); // 不含當天
  const m = avg(ref);
  const s = std(ref);
  if (!s) return null;
  return (vols[vols.length - 1] - m) / s;
}

function calcKD(k, period = 9) {
  if (k.length < period) return { k: 50, d: 50 };
  let kVal = 50, dVal = 50;
  for (let i = period - 1; i < k.length; i++) {
    const slice = k.slice(i - period + 1, i + 1);
    const high = Math.max(...slice.map((x) => x.high));
    const low = Math.min(...slice.map((x) => x.low));
    const rsv = high === low ? 50 : ((k[i].close - low) / (high - low)) * 100;
    kVal = (2 / 3) * kVal + (1 / 3) * rsv;
    dVal = (2 / 3) * dVal + (1 / 3) * kVal;
  }
  return { k: kVal, d: dVal };
}

function calcKDSeries(k, period = 9) {
  // 用於判斷死叉黃金叉
  let kVal = 50, dVal = 50;
  const out = [];
  for (let i = 0; i < k.length; i++) {
    if (i < period - 1) { out.push({ k: kVal, d: dVal }); continue; }
    const slice = k.slice(i - period + 1, i + 1);
    const high = Math.max(...slice.map((x) => x.high));
    const low = Math.min(...slice.map((x) => x.low));
    const rsv = high === low ? 50 : ((k[i].close - low) / (high - low)) * 100;
    kVal = (2 / 3) * kVal + (1 / 3) * rsv;
    dVal = (2 / 3) * dVal + (1 / 3) * kVal;
    out.push({ k: kVal, d: dVal });
  }
  return out;
}

function calcMACD(closes) {
  const ema = (n) => {
    const k = 2 / (n + 1); let prev = closes[0]; const out = [prev];
    for (let i = 1; i < closes.length; i++) { prev = closes[i] * k + prev * (1 - k); out.push(prev); }
    return out;
  };
  const e12 = ema(12), e26 = ema(26);
  const dif = e12.map((v, i) => v - e26[i]);
  const k = 2 / 10; let prev = dif[0]; const dem = [prev];
  for (let i = 1; i < dif.length; i++) { prev = dif[i] * k + prev * (1 - k); dem.push(prev); }
  const osc = dif.map((v, i) => v - dem[i]);
  return { dif, dem, osc };
}

function ma(k, n) {
  if (k.length < n) return null;
  return avg(k.slice(-n).map((d) => d.close));
}

export function diagnose(k, inst = [], opts = {}) {
  if (!k || k.length < 5) return null;
  const last = k[k.length - 1];
  const prev = k[k.length - 2];
  const { sharesOutstanding } = opts;

  const ma5  = ma(k, 5);
  const ma20 = ma(k, 20);
  const ma60 = ma(k, 60);
  const aboveMa5  = ma5  != null && last.close >= ma5;
  const aboveMa20 = ma20 != null && last.close >= ma20;
  const aboveMa60 = ma60 != null && last.close >= ma60;

  // 趨勢判讀
  let trend, trendNote;
  if (aboveMa5 && aboveMa20 && aboveMa60 && ma5 > ma20 && ma20 > ma60) {
    trend = '多頭排列'; trendNote = '5/20/60 MA 由上而下，多頭格局健康';
  } else if (!aboveMa5 && !aboveMa20 && !aboveMa60) {
    trend = '空頭排列'; trendNote = '股價跌破三均線，弱勢';
  } else if (aboveMa20) {
    trend = '中期偏多'; trendNote = '股價站上 20MA，中期趨勢偏多';
  } else {
    trend = '中期偏空'; trendNote = '股價跌破 20MA，留意支撐';
  }

  // 短線
  const shortTrend = aboveMa5 ? '短線偏多' : '短線轉弱';

  // KD
  const kdSeries = calcKDSeries(k);
  const cur = kdSeries[kdSeries.length - 1];
  const prevKD = kdSeries[kdSeries.length - 2] || cur;
  let kdSignal, kdLevel;
  if (cur.k > 80 && cur.d > 80) kdLevel = '高檔鈍化';
  else if (cur.k < 20 && cur.d < 20) kdLevel = '低檔鈍化';
  else if (cur.k > 50) kdLevel = '中性偏多';
  else kdLevel = '中性偏空';

  if (prevKD.k <= prevKD.d && cur.k > cur.d) kdSignal = '黃金交叉';
  else if (prevKD.k >= prevKD.d && cur.k < cur.d) kdSignal = '死亡交叉';
  else if (cur.k > cur.d) kdSignal = '多頭排列';
  else kdSignal = '空頭排列';

  // MACD
  const macd = calcMACD(k.map((d) => d.close));
  const oscLast = macd.osc[macd.osc.length - 1];
  const oscPrev = macd.osc[macd.osc.length - 2] || 0;
  const difLast = macd.dif[macd.dif.length - 1];
  const demLast = macd.dem[macd.dem.length - 1];
  let macdSignal;
  if (difLast > demLast && oscLast > oscPrev) macdSignal = '多頭擴張';
  else if (difLast > demLast && oscLast < oscPrev) macdSignal = '多頭縮減';
  else if (difLast < demLast && oscLast < oscPrev) macdSignal = '空頭擴張';
  else macdSignal = '空頭縮減';

  // 量能 — 修正：若今日 vol=0（可能為 Yahoo 即時 + FinMind 還沒更新合成的占位），不做量能判讀
  const recentVol = k.slice(-5).map((d) => d.vol || 0);
  const avgVol = avg(recentVol.slice(0, 4)) || 1;
  const todayVol = last.vol || 0;
  const volMissing = todayVol <= 0;            // 量能資料未到位
  const volRatio = volMissing ? 1 : todayVol / avgVol;
  let volSignal;
  if (volMissing) volSignal = '量能待更新';
  else if (volRatio > 1.8) volSignal = '量能爆發';
  else if (volRatio > 1.3) volSignal = '量能放大';
  else if (volRatio < 0.7) volSignal = '量能萎縮';
  else volSignal = '量能持平';

  // 量價關係 — 量能未更新時不做判讀
  const priceUp = last.close > prev.close;
  const volUp = !volMissing && todayVol > (prev.vol || 0);
  let priceVol;
  if (volMissing) priceVol = '量能未到，量價判讀延後';
  else if (priceUp && volUp) priceVol = '價漲量增';
  else if (priceUp && !volUp) priceVol = '價漲量縮（背離）';
  else if (!priceUp && volUp) priceVol = '價跌量增（出貨疑慮）';
  else priceVol = '價跌量縮（止跌）';

  // 三大法人 — 取近 3 日所有 row（每天每法人各一列）
  const recentDates = [...new Set((inst || []).map((r) => r.date))].sort().slice(-3);
  const recentInst = (inst || []).filter((r) => recentDates.includes(r.date));
  const sumByName = (kw) => recentInst
    .filter((r) => (r.name || '').includes(kw))
    .reduce((s, r) => s + ((+r.buy || 0) - (+r.sell || 0)), 0);
  const foreign = sumByName('外資') || sumByName('Foreign');
  const trust   = sumByName('投信');
  const dealer  = sumByName('自營');
  const biasLabel = (n) => n > 0 ? '偏買超' : n < 0 ? '偏賣超' : '中性';
  const totalInst = foreign + trust + dealer;

  // 投信佔股本比：近 3 日投信淨買股數 / 流通股數 × 100
  // 若 inst row 帶有 trustPctOfCap（server-side 已 join），優先採用累加值
  let trustPctOfCap = null;
  const rowsWithPct = recentInst.filter((r) => r.name?.includes('投信') && Number.isFinite(+r.trustPctOfCap));
  if (rowsWithPct.length) {
    trustPctOfCap = rowsWithPct.reduce((s, r) => s + (+r.trustPctOfCap || 0), 0);
  } else if (sharesOutstanding && sharesOutstanding > 0) {
    trustPctOfCap = (trust / sharesOutstanding) * 100;
  }
  const mainForce =
    foreign > 0 && trust > 0 ? '外資+投信同向買超' :
    foreign < 0 && trust < 0 ? '外資+投信同向賣超' :
    Math.abs(totalInst) < 1000 ? '法人態度分歧' : '法人偏 ' + (totalInst > 0 ? '買' : '賣');

  // 高低點與支撐
  const high60 = Math.max(...k.slice(-60).map((d) => d.high));
  const low60 = Math.min(...k.slice(-60).map((d) => d.low));
  const distToHigh = ((high60 - last.close) / last.close) * 100;
  const distToLow  = ((last.close - low60) / last.close) * 100;

  // 近期訊號 — 加上交叉驗證（避免單一條件誤判）
  // 規則：訊號需「主條件 + 至少一個輔助條件」才掛上，降低偽訊號率
  const signals = [];

  // KD 高檔死叉：需 KD 在 70+ 且收盤跌破 5MA（否則只是技術噪音）
  if (kdSignal === '死亡交叉' && cur.k > 70 && (ma5 == null || last.close < ma5)) {
    signals.push({ tag: '警示', text: `KD 高檔死叉 + 跌破 5MA — 短線回測風險（K=${cur.k.toFixed(0)}）` });
  }
  // KD 低檔黃金叉：需 KD 在 30- 且收盤上彎（last > prev）
  if (kdSignal === '黃金交叉' && cur.k < 30 && priceUp) {
    signals.push({ tag: '機會', text: `KD 低檔黃金叉 + 收紅 — 短線可期反彈（K=${cur.k.toFixed(0)}）` });
  }
  // 帶量突破：量爆 + 價漲 + 收盤站上 5MA
  if (volSignal === '量能爆發' && priceUp && ma5 != null && last.close > ma5) {
    signals.push({ tag: '注意', text: `帶量突破（量 ${volRatio.toFixed(1)}x 均量）+ 站上 5MA — 主力進場跡象` });
  }
  // 高檔爆量收黑：需 接近 60 日高 OR Bias > 5（單純收黑不足以判出貨）
  if (volSignal === '量能爆發' && !priceUp && (distToHigh < 5 || (bias20 != null && bias20 > 5))) {
    signals.push({ tag: '警示', text: `高檔爆量收黑（量 ${volRatio.toFixed(1)}x）— 主力調節跡象` });
  }
  // 價量背離：價漲量縮 + 距離 60 日高 < 5%
  if (priceVol === '價漲量縮（背離）' && distToHigh < 5) {
    signals.push({ tag: '警示', text: '高檔價量背離 — 上漲動能轉弱、留意拉回' });
  }
  // 接近 60 日高：需 量能放大或爆發 才稱「突破關鍵」
  if (distToHigh < 3 && (volSignal === '量能放大' || volSignal === '量能爆發')) {
    signals.push({ tag: '注意', text: `逼近 60 日高 ${high60.toFixed(2)} + 量能配合 — 突破或回落關鍵` });
  } else if (distToHigh < 3) {
    signals.push({ tag: '中性', text: `逼近 60 日高 ${high60.toFixed(2)}（量能未放大）— 觀察是否假突破` });
  }
  // 接近 60 日低：需 收紅 或 KD < 20 才稱「支撐有效」
  if (distToLow < 3 && (priceUp || cur.k < 20)) {
    signals.push({ tag: '機會', text: `逼近 60 日低 ${low60.toFixed(2)} + 止跌訊號 — 支撐測試成功率較高` });
  } else if (distToLow < 3) {
    signals.push({ tag: '警示', text: `逼近 60 日低 ${low60.toFixed(2)}（仍弱勢）— 留意破底` });
  }
  // 三大法人同步買超：保留高信賴訊號
  if (foreign > 0 && trust > 0 && dealer > 0) {
    signals.push({ tag: '機會', text: `三大法人同步買超（外+${(foreign / 1000).toFixed(0)}張、投+${(trust / 1000).toFixed(0)}張）— 多方共識` });
  }
  // 外資+投信同向賣超：搭配股價跌破 20MA 才是真撤離
  if (foreign < 0 && trust < 0 && !aboveMa20) {
    signals.push({ tag: '警示', text: '外資+投信同步賣超 + 跌破 20MA — 主力撤離' });
  }
  // 軋空候選：需 KD 黃金叉 / 多頭排列 且 法人偏買，避免單純技術反彈誤判
  if (foreign > 0 && (kdSignal === '黃金交叉' || kdSignal === '多頭排列') && priceUp && volSignal !== '量能萎縮') {
    signals.push({ tag: '機會', text: '外資買超 + KD 多方 + 帶量上攻 — 短線追擊優選' });
  }

  if (!signals.length) signals.push({ tag: '中性', text: '目前無強烈買賣訊號（多項指標未同步）' });

  // 整體結論
  const bullishPts =
    (aboveMa20 ? 1 : 0) +
    (kdSignal === '黃金交叉' || kdSignal === '多頭排列' ? 1 : 0) +
    (macdSignal.startsWith('多頭') ? 1 : 0) +
    (priceUp && volUp ? 1 : 0) +
    (totalInst > 0 ? 1 : 0);
  const bearishPts =
    (!aboveMa20 ? 1 : 0) +
    (kdSignal === '死亡交叉' || kdSignal === '空頭排列' ? 1 : 0) +
    (macdSignal.startsWith('空頭') ? 1 : 0) +
    (!priceUp && volUp ? 1 : 0) +
    (totalInst < 0 ? 1 : 0);

  // 高權重台股指標
  const closes = k.map((d) => d.close);
  const vols = k.map((d) => d.vol || 0);
  const bias20 = calcBias(closes, 20);
  const atr14 = calcATR(k, 14);
  const maDeduct20 = calcMaDeduct(closes, 20);
  const volZ = calcVolZ(vols, 20);
  const turnoverRate = (sharesOutstanding && sharesOutstanding > 0 && last.vol)
    ? ((last.vol * 1000) / sharesOutstanding) * 100   // vol 為「張」，× 1000 換成股
    : null;

  const score0 = bullishPts - bearishPts; // -5 ~ +5（保留原 score 給 overall 判讀）
  const score = score0;

  // ─────── 勝率 v2：四面加權平均 + 風險懲罰 ───────
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // 1. 趨勢面 (0-100)：MA 排列 + Bias 偏離
  let trendScore = 50;
  if (aboveMa5)  trendScore += 5;
  if (aboveMa20) trendScore += 10;
  if (aboveMa60) trendScore += 10;
  if (ma5 != null && ma20 != null && ma60 != null) {
    if (ma5 > ma20 && ma20 > ma60) trendScore += 15;        // 多頭排列加分
    else if (ma5 < ma20 && ma20 < ma60) trendScore -= 25;   // 空頭排列重扣
  }
  if (bias20 != null) {
    if (bias20 > 10) trendScore -= 15;        // 過熱
    else if (bias20 > 5) trendScore -= 5;
    else if (bias20 < -10) trendScore += 10;  // 超跌反彈機會
  }
  trendScore = clamp(trendScore, 0, 100);

  // 2. 動能面 (0-100)：KD 事件 + MACD 趨勢
  let momentumScore = 50;
  if (kdSignal === '黃金交叉') momentumScore += 20;     // 事件加重
  else if (kdSignal === '多頭排列') momentumScore += 8;
  else if (kdSignal === '死亡交叉') momentumScore -= 25;
  else if (kdSignal === '空頭排列') momentumScore -= 10;
  if (kdLevel === '高檔鈍化') momentumScore -= 15;
  else if (kdLevel === '低檔鈍化') momentumScore += 8;
  if (macdSignal === '多頭擴張') momentumScore += 15;
  else if (macdSignal === '多頭縮減') momentumScore += 3;
  else if (macdSignal === '空頭擴張') momentumScore -= 20;
  else if (macdSignal === '空頭縮減') momentumScore -= 5;
  momentumScore = clamp(momentumScore, 0, 100);

  // 3. 量價面 (0-100)：今日量價組合 + 5 日量能趨勢
  let volPriceScore = 50;
  if (volSignal === '量能爆發' && priceUp) volPriceScore += 18;
  else if (volSignal === '量能爆發' && !priceUp) volPriceScore -= 30;  // 出貨型態
  else if (volSignal === '量能放大' && priceUp) volPriceScore += 10;
  else if (volSignal === '量能萎縮' && priceUp) volPriceScore -= 6;     // 動能衰竭
  if (priceVol === '價漲量增') volPriceScore += 10;
  else if (priceVol === '價漲量縮（背離）') volPriceScore -= 10;
  else if (priceVol === '價跌量增（出貨疑慮）') volPriceScore -= 15;
  // 5 日量能趨勢（近 5 日 / 前 5 日）
  if (vols.length >= 10) {
    const recent5 = avg(vols.slice(-5));
    const prior5 = avg(vols.slice(-10, -5)) || 1;
    const volTrend = recent5 / prior5;
    if (volTrend > 1.5 && priceUp) volPriceScore += 5;
    else if (volTrend < 0.7 && !priceUp) volPriceScore += 3;  // 量縮止跌
  }
  volPriceScore = clamp(volPriceScore, 0, 100);

  // 4. 籌碼面 (0-100)：法人方向（外資/投信權重高於自營）+ 投信佔比
  let chipScore = 50;
  // 外資 60% 權重、投信 30%、自營 10%
  const weightedInst = foreign * 0.6 + trust * 0.3 + dealer * 0.1;
  if (foreign > 0 && trust > 0 && dealer > 0) chipScore += 22;  // 三方共識
  else if (foreign > 0 && trust > 0) chipScore += 18;
  else if (foreign < 0 && trust < 0) chipScore -= 25;
  else if (weightedInst > 1000) chipScore += 8;
  else if (weightedInst < -1000) chipScore -= 12;
  // 投信佔股本比（中小型股作帳訊號）
  if (trustPctOfCap != null) {
    if (trustPctOfCap > 0.5) chipScore += 12;
    else if (trustPctOfCap > 0.2) chipScore += 6;
    else if (trustPctOfCap < -0.3) chipScore -= 10;
  }
  chipScore = clamp(chipScore, 0, 100);

  // 加權平均（四面）
  const baseScore = trendScore * 0.30 + momentumScore * 0.25
                  + volPriceScore * 0.20 + chipScore * 0.25;

  // 5. 風險懲罰
  let penalty = 0;
  if (bias20 != null && bias20 > 10 && cur.k > 80) penalty += 25;     // 高檔頂背離
  if (volZ != null && volZ > 2 && !priceUp && bias20 > 5) penalty += 20;  // 量爆收黑
  if (distToHigh < 2 && volSignal === '量能萎縮') penalty += 10;       // 接近高點量縮
  if (turnoverRate != null && turnoverRate > 15 && !priceUp) penalty += 10;  // 高週轉率收黑

  // 最終勝率：clamp 到 [10, 80]，避免極值（市場有黑天鵝）
  const winRate = Math.round(clamp(baseScore - penalty, 10, 80));

  // ─────── 進場 / 停損 / 目標價計算（用 ATR + MA） ───────
  const close = last.close;
  const atr = atr14 || close * 0.025;
  // 進場區間：依勝率方向
  // 多單：以 5MA / 20MA 為支撐買點，回測 0.5 ATR
  // 空頭：建議在反彈到 ma5 附近觀察
  const fmt2 = (n) => n != null ? +n.toFixed(2) : null;
  const entryLow  = fmt2(close - atr * 0.5);
  const entryHigh = fmt2(close + atr * 0.3);
  const support10 = ma5 != null ? fmt2(ma5) : fmt2(close - atr);
  const support20 = ma20 != null ? fmt2(ma20) : fmt2(close - atr * 2);
  const stopPrice = fmt2(Math.max(close - atr * 2, support20 || 0));
  const target1   = fmt2(close + atr * 1.5);
  const target2   = fmt2(close + atr * 3);

  // ─────── overall / action / playbook 判讀 ───────
  let overall, action, playbook;
  if (winRate >= 65) {
    overall = '多頭格局・趨勢向上';
    action = [
      `▶ 進場區：${entryLow} ~ ${entryHigh}（現價附近回測 0.5 ATR）`,
      `▶ 加碼區：跌至 20MA ${support20} 加碼 30%（突破前高 +20%）`,
      `▶ 停損：跌破 ${stopPrice}（-2 ATR）或失守 10MA ${support10}`,
      `▶ 目標：第一停利 ${target1}（+1.5 ATR），第二停利 ${target2}（+3 ATR）`,
    ];
    playbook = `多方明確：可分 3 批進場（首批 50% 立即/${entryLow}~${entryHigh}、回測 20MA ${support20} 加碼 30%、突破前高 ${high60.toFixed(2)} 再加 20%）。停損 ${stopPrice}，達 ${target1} 後停利點上移到成本價，超過 ${target2} 改用 20MA 動態出場。`;
  } else if (winRate >= 55) {
    overall = '中期偏多・短線觀察';
    action = [
      `▶ 進場區：等待回測 5MA ${support10} 或 20MA ${support20} 再進場`,
      `▶ 不追價：${close.toFixed(2)} 以上不主動追高`,
      `▶ 停損：跌破 ${stopPrice}（-2 ATR）出場`,
      `▶ 目標：${target1}（+1.5 ATR）為短線停利點`,
    ];
    playbook = `偏多但需等支撐：${close.toFixed(2)} 不追價，回測 ${support10}（5MA）輕倉 30%、回測 ${support20}（20MA）再加碼 30%。突破 ${high60.toFixed(2)} 才確認轉強。停損 ${stopPrice}，達 ${target1} 先停利一半。`;
  } else if (winRate >= 45) {
    overall = '盤整待變・方向未明';
    action = [
      `▶ 觀望優先：${close.toFixed(2)} 在多空交界，避免重押`,
      `▶ 短線區間：上 ${entryHigh}、下 ${support10}（區間操作）`,
      `▶ 試水部位：上限總部位 10%，停損 ${stopPrice}`,
      `▶ 等待訊號：突破 ${high60.toFixed(2)} 轉多 / 跌破 ${low60.toFixed(2)} 轉空`,
    ];
    playbook = `盤整格局：建議空手或極輕倉（≤10%）。等突破 ${high60.toFixed(2)} 確認多方，或跌破 ${low60.toFixed(2)} 確認空方再做方向。當沖可作 ${support10}~${entryHigh} 區間，但留意流動性。`;
  } else if (winRate >= 30) {
    overall = '中期偏空・反彈逢高減碼';
    action = [
      `▶ 持股減碼：反彈到 ${ma5 != null ? fmt2(ma5) : entryHigh} 即減 50%`,
      `▶ 不接刀：${close.toFixed(2)} 不嘗試逢低承接`,
      `▶ 停損嚴守：跌破 ${stopPrice} 全數出場`,
      `▶ 等待訊號：站回 20MA ${support20} 才考慮重新評估`,
    ];
    playbook = `偏空格局：手中部位逢反彈（${ma5 != null ? fmt2(ma5) : entryHigh}）即減碼 50%，跌破 ${stopPrice} 全部清空。新進場一律觀望，需見「站回 20MA + 法人翻買 + 量縮止跌」三條件齊備才考慮回補。`;
  } else {
    overall = '空頭格局・趨勢向下';
    action = [
      `▶ 空手為上：${close.toFixed(2)} 不持股、不抄底`,
      `▶ 既有部位停損：跌破 ${stopPrice} 立即出場`,
      `▶ 觀察點：${low60.toFixed(2)}（60 日低）+ KD 低檔背離`,
      `▶ 翻多訊號：站回 20MA ${support20} + 量增`,
    ];
    playbook = `空頭明確：堅持空手。重新進場需符合三條件：(1) 站回 20MA ${support20}；(2) 法人連 3 日買超；(3) KD 自低檔上彎。任一不滿足即繼續觀望，禁追跌不停損。`;
  }

  // 子項細分（給 UI 顯示拆解）
  const subScores = {
    trend: Math.round(trendScore),
    momentum: Math.round(momentumScore),
    volPrice: Math.round(volPriceScore),
    chip: Math.round(chipScore),
    penalty: Math.round(penalty),
  };

  return {
    trend, trendNote, shortTrend,
    ma: { ma5, ma20, ma60 },
    kd: { ...cur, signal: kdSignal, level: kdLevel },
    macd: { dif: difLast, dem: demLast, osc: oscLast, signal: macdSignal },
    vol: { ratio: volRatio, signal: volSignal, priceVol },
    inst: {
      foreign, trust, dealer, total: totalInst, mainForce,
      trustPctOfCap,
      bias: { foreign: biasLabel(foreign), trust: biasLabel(trust), dealer: biasLabel(dealer) },
    },
    range: { high60, low60, distToHigh, distToLow },
    bias20, atr14, maDeduct20, volZ, turnoverRate,
    signals,
    score, winRate,
    subScores,
    overall, action, playbook,
    levels: {
      entryLow, entryHigh,
      stop: stopPrice,
      target1, target2,
      support10, support20,
      high60: +high60.toFixed(2),
      low60: +low60.toFixed(2),
    },
  };
}
