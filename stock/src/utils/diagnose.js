// 技術診斷 — rule-based，從 K 線 + 三大法人推導訊號
// 輸出結構固定，給 stockPanel 的「技術診斷」區塊渲染

const avg = (arr) => arr.reduce((s, x) => s + x, 0) / (arr.length || 1);

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

export function diagnose(k, inst = []) {
  if (!k || k.length < 5) return null;
  const last = k[k.length - 1];
  const prev = k[k.length - 2];

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

  // 三大法人
  const recentInst = (inst || []).slice(-3); // 近 3 日
  const sumByName = (kw) => recentInst
    .filter((r) => (r.name || '').includes(kw))
    .reduce((s, r) => s + ((+r.buy || 0) - (+r.sell || 0)), 0);
  const foreign = sumByName('外資') || sumByName('Foreign');
  const trust   = sumByName('投信');
  const dealer  = sumByName('自營');
  const bias = (n) => n > 0 ? '偏買超' : n < 0 ? '偏賣超' : '中性';
  const totalInst = foreign + trust + dealer;
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

  const score = bullishPts - bearishPts; // -5 ~ +5
  const winRate = Math.round(50 + score * 9); // 5 → 95%、-5 → 5%

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
    inst: { foreign, trust, dealer, total: totalInst, mainForce, bias: { foreign: bias(foreign), trust: bias(trust), dealer: bias(dealer) } },
    range: { high60, low60, distToHigh, distToLow },
    signals,
    score, winRate,
    overall, action,
  };
}
