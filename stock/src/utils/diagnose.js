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

  // 量能
  const recentVol = k.slice(-5).map((d) => d.vol || 0);
  const avgVol = avg(recentVol.slice(0, 4)) || 1;
  const volRatio = (last.vol || 0) / avgVol;
  let volSignal;
  if (volRatio > 1.8) volSignal = '量能爆發';
  else if (volRatio > 1.3) volSignal = '量能放大';
  else if (volRatio < 0.7) volSignal = '量能萎縮';
  else volSignal = '量能持平';

  // 量價關係
  const priceUp = last.close > prev.close;
  const volUp = (last.vol || 0) > (prev.vol || 0);
  let priceVol;
  if (priceUp && volUp) priceVol = '價漲量增';
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

  // 近期訊號（取最關鍵的 5 點）
  const signals = [];
  if (kdSignal === '死亡交叉' && cur.k > 70) signals.push({ tag: '警示', text: 'KD 高檔死叉 — 短線回測風險' });
  if (kdSignal === '黃金交叉' && cur.k < 30) signals.push({ tag: '機會', text: 'KD 低檔黃金叉 — 短線可期反彈' });
  if (volSignal === '量能爆發' && priceUp) signals.push({ tag: '注意', text: '帶量突破 — 主力進場跡象' });
  if (volSignal === '量能爆發' && !priceUp) signals.push({ tag: '警示', text: '高檔爆量收黑 — 主力調節跡象' });
  if (priceVol === '價漲量縮（背離）') signals.push({ tag: '警示', text: '價量背離 — 上漲動能轉弱' });
  if (distToHigh < 3) signals.push({ tag: '注意', text: `逼近 60 日高 ${high60.toFixed(2)} — 突破或回落關鍵` });
  if (distToLow < 3) signals.push({ tag: '注意', text: `逼近 60 日低 ${low60.toFixed(2)} — 支撐測試` });
  if (foreign > 0 && trust > 0 && dealer > 0) signals.push({ tag: '機會', text: '三大法人同步買超 — 多方共識' });
  if (foreign < 0 && trust < 0) signals.push({ tag: '警示', text: '外資+投信同步賣超 — 主力撤離' });
  if (!signals.length) signals.push({ tag: '中性', text: '目前無強烈買賣訊號' });

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

  const score0 = bullishPts - bearishPts; // -5 ~ +5（原始五項加總）
  let score = score0;

  // 高權重指標懲罰／加分
  if (bias20 != null && bias20 > 10) score -= 2;
  if (bias20 != null && bias20 < -10 && kdSignal === '黃金交叉' && cur.k < 30) score += 2;
  if (volZ != null && volZ > 2 && !priceUp) score -= 2;
  if (cur.k > 80 && bias20 != null && bias20 > 8) score -= 2;

  let winRate = Math.max(5, Math.min(95, Math.round(50 + score * 9))); // clamp 5-95
  // 高檔頂背離硬上限：Bias > 10 且 KD > 80 屬典型過熱反轉模式，勝率封頂 35
  if (bias20 != null && bias20 > 10 && cur.k > 80) winRate = Math.min(winRate, 35);
  // 量爆收黑同樣強制壓低（出貨型態）
  if (volZ != null && volZ > 2 && !priceUp && bias20 != null && bias20 > 5) winRate = Math.min(winRate, 30);

  let overall, action;
  if (score >= 3) {
    overall = '多頭格局・趨勢向上';
    action = ['可分批佈局', '回測 20MA 加碼', '停損設於 10MA'];
  } else if (score >= 1) {
    overall = '中期偏多・短線觀察';
    action = ['等待回測支撐再進場', '不追高', '注意量能變化'];
  } else if (score >= -1) {
    overall = '盤整待變・方向未明';
    action = ['暫時觀望', '等待方向明確', '輕倉試水'];
  } else if (score >= -3) {
    overall = '中期偏空・反彈逢高減碼';
    action = ['不接刀', '反彈即減碼', '保守為主'];
  } else {
    overall = '空頭格局・趨勢向下';
    action = ['空手等待', '禁追高', '等待止穩訊號'];
  }

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
    overall, action,
  };
}
