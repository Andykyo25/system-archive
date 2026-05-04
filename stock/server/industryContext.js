// 產業同業 60 日報酬統計 — 用於 cross-sectional industry RS rank
// 一天計算一次（產業變動慢），cache 24h
import { memo } from './cache.js';
import * as finmind from './providers/finmind.js';
import * as yahoo from './providers/yahoo.js';
import * as stooq from './providers/stooq.js';

const TTL = 24 * 60 * 60 * 1000;

// 涵蓋台灣 50 / 0050 + 主要產業領頭羊（~60 檔）
const PEERS = [
  '2330','2317','2454','2308','2891','2882','2412','3008','2303','2881',
  '2884','2886','2885','2880','2890','1301','1303','2002','1216','2207',
  '3711','2382','2912','3034','2615','2603','2618','5871','3045','4904',
  '2887','2105','9904','1102','2606','3037','3231','5347','6505','2474',
  '2376','3702','2357','2059','3017','2049','3553','2360','2392','3056',
  '2455','3035','2421','2027','1326','2379','2603','2609','2610',
];

export async function getAllIndustryStats() {
  return memo('industry:stats:v1', TTL, async () => {
    const allInfo = await memo('finmind:stockInfo', TTL, () => finmind.stockInfo()).catch(() => []);
    const codeToIndustry = {};
    (allInfo || []).forEach((r) => {
      if (r.stock_id) codeToIndustry[r.stock_id] = r.industry_category || '其他';
    });

    const start = new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10);
    const tasks = [...new Set(PEERS)].map(async (code) => {
      // FinMind → Yahoo fallback
      let closes = [];
      try {
        const k = await memo(`kline:${code}:90`, 60000, () => finmind.stockPrice(code, start));
        if (k && k.length >= 61) closes = k.map((r) => +r.close).filter(Number.isFinite);
      } catch { /* try Yahoo */ }
      if (closes.length < 61) {
        try {
          const yh = await memo(`yhKline:${code}:90`, 5 * 60 * 1000, () => yahoo.chart(`${code}.TW`, '3mo', '1d'));
          if (yh && yh.length >= 61) closes = yh.map((d) => +d.close).filter(Number.isFinite);
        } catch { /* try stooq */ }
      }
      if (closes.length < 61) {
        try {
          const sq = await memo(`sqKline:${code}:90`, 30 * 60 * 1000, () => stooq.chart(`${code}.tw`, 100));
          if (sq && sq.length >= 61) closes = sq.map((d) => +d.close).filter(Number.isFinite);
        } catch { /* skip */ }
      }
      if (closes.length < 61) return null;
      const last = closes[closes.length - 1];
      const back60 = closes[closes.length - 61];
      if (!(back60 > 0)) return null;
      return {
        code,
        industry: codeToIndustry[code] || '其他',
        ret60d: +(((last - back60) / back60) * 100).toFixed(2),
      };
    });
    const peers = (await Promise.all(tasks)).filter(Boolean);

    const byIndustry = {};
    peers.forEach((p) => {
      if (!byIndustry[p.industry]) byIndustry[p.industry] = [];
      byIndustry[p.industry].push(p);
    });
    return { byIndustry, codeToIndustry, allPeers: peers };
  });
}

// 給定 code 回傳該股在自己產業內的同業列表（含自己）
export async function getIndustryStatsFor(code) {
  const { byIndustry, codeToIndustry } = await getAllIndustryStats();
  const industry = codeToIndustry[code];
  if (!industry) return null;
  const peers = byIndustry[industry] || [];
  if (peers.length < 3) return { industry, peers, insufficientPeers: true };
  return { industry, peers };
}
