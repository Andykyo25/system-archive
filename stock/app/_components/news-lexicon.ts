// 新聞標題關鍵字計分(晨間情報 2026-07-11)
// ⚠ 誠實定位:標題級關鍵字統計,不是語意理解 — 反諷/否定句/複合語境會誤判。
// UI 一律附命中詞(tooltip),讓使用者可自行覆核;絕不當投資指令。

const BULL_ZH = [
  "漲停", "大漲", "急漲", "飆漲", "創高", "新高", "看好", "看多", "上調", "調升",
  "調高", "買超", "敲進", "加碼", "擴產", "漲價", "報價上漲", "供不應求", "缺貨",
  "上看", "超預期", "優於預期", "轉盈", "獲利成長", "突破", "利多", "回補",
  "訂單暢旺", "產能滿載", "大賺", "海賺", "完銷", "短缺", "多頭",
];
const BEAR_ZH = [
  "跌停", "大跌", "重挫", "崩跌", "創低", "新低", "看壞", "看空", "下修", "調降",
  "降評", "賣超", "調節", "砍單", "跌價", "報價下跌", "供過於求", "低於預期",
  "不如預期", "轉虧", "虧損擴大", "跌破", "利空", "疑慮", "警訊", "衰退", "裁員",
  "出脫", "拋售",
];
const BULL_EN = [
  "surge", "soar", "jump", "rally", "record high", "beat", "upgrade", "raise",
  "outperform", "boom", "expand", "invest", "breakthrough", "strong demand",
  "shortage", "buy rating",
];
const BEAR_EN = [
  "plunge", "slump", "tumble", "downgrade", "miss", "warn", "weak", "oversupply",
  "layoff", "decline", "sell-off", "lawsuit", "probe", "recall", "cut forecast",
];

export interface TitleSentiment {
  dir: "bull" | "bear" | "neutral";
  hits: string[];
}

export function scoreTitle(title: string): TitleSentiment {
  const lower = title.toLowerCase();
  const hits: string[] = [];
  let bull = 0;
  let bear = 0;
  for (const w of BULL_ZH) if (title.includes(w)) { bull++; hits.push(w); }
  for (const w of BEAR_ZH) if (title.includes(w)) { bear++; hits.push(w); }
  for (const w of BULL_EN) if (lower.includes(w)) { bull++; hits.push(w); }
  for (const w of BEAR_EN) if (lower.includes(w)) { bear++; hits.push(w); }
  return {
    dir: bull > bear ? "bull" : bear > bull ? "bear" : "neutral",
    hits,
  };
}

export interface NewsSentimentSummary {
  bullTitles: number;
  bearTitles: number;
  scored: number; // 有命中任一關鍵字的標題數
  total: number;
  dir: "bull" | "bear" | "neutral";
  sampleHits: string[]; // 去重命中詞(tooltip 用,cap 12)
}

export function summarizeNews(titles: string[]): NewsSentimentSummary {
  let bullTitles = 0;
  let bearTitles = 0;
  let scored = 0;
  const hitSet = new Set<string>();
  for (const t of titles) {
    const s = scoreTitle(t);
    if (s.hits.length > 0) scored++;
    for (const h of s.hits) hitSet.add(h);
    if (s.dir === "bull") bullTitles++;
    else if (s.dir === "bear") bearTitles++;
  }
  return {
    bullTitles,
    bearTitles,
    scored,
    total: titles.length,
    dir:
      bullTitles > bearTitles ? "bull" : bearTitles > bullTitles ? "bear" : "neutral",
    sampleHits: [...hitSet].slice(0, 12),
  };
}
