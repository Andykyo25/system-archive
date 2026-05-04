// 市場狀態（regime）— 給每支股票診斷時注入大盤層級的 feature
//
// 內容：TAIEX 趨勢、20 日已實現波動度、5/60 日報酬、市場 breadth
// 用 server cache 5 分鐘共享給所有 diagnose 呼叫（盤中也夠新）

import { memo, memoFailsafe } from './cache.js';
import * as yahoo from './providers/yahoo.js';
import * as stooq from './providers/stooq.js';
import * as cnyes from './providers/cnyes.js';

const CTX_TTL = 5 * 60 * 1000;
const CTX_FAIL_TTL = 60 * 1000;        // 失敗 60 秒內不重試
const TAIEX_KLINE_TTL = 24 * 60 * 60 * 1000;

const avg = (arr) => arr.reduce((s, x) => s + x, 0) / (arr.length || 1);
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

export async function getMarketContext() {
  // 用 failsafe — TAIEX 撈不到時 60 秒內不重試（避免 log 暴增 + 拖慢 diagnose）
  return memoFailsafe('market:context', CTX_TTL, CTX_FAIL_TTL, async () => {
    // TAIEX 歷史：Cnyes（最穩）→ Stooq → Yahoo
    let taiexCloses = [];
    try {
      const data = await memo('taiex:cnyes:90', TAIEX_KLINE_TTL, () => cnyes.chart('TAIEX', 120, 'TWS', 'INDEX'));
      taiexCloses = (data || []).map((d) => +d.close).filter(Number.isFinite);
    } catch (e) { console.warn('[marketContext] cnyes TAIEX:', e.message); }
    if (taiexCloses.length < 60) {
      try {
        const data = await memo('taiex:stooq:90', TAIEX_KLINE_TTL, async () => {
          try { return await stooq.chart('^twii', 120); } catch {}
          try { return await stooq.chart('^twi', 120); } catch {}
          return [];
        });
        taiexCloses = (data || []).map((d) => +d.close).filter(Number.isFinite);
      } catch (e) { console.warn('[marketContext] stooq TAIEX:', e.message); }
    }
    if (taiexCloses.length < 60) {
      try {
        const data = await memo('taiex:yh:90', TAIEX_KLINE_TTL, () => yahoo.chart('^TWII', '3mo', '1d'));
        taiexCloses = (data || []).map((d) => +d.close).filter(Number.isFinite);
      } catch (e) { console.warn('[marketContext] yahoo TAIEX:', e.message); }
    }

    const ctx = {
      taiex_closes: taiexCloses,
      taiex_trend: 0,
      taiex_vol_20d: null,
      taiex_ma20_above_ma60: null,
      taiex_return_5d: null,
      taiex_return_60d: null,
      regime_label: '未知',
    };
    // TAIEX 拿不到 → throw 讓 memoFailsafe cache 失敗 sentinel 60 秒
    if (taiexCloses.length < 60) throw new Error('TAIEX 歷史不足');

    const last = taiexCloses[taiexCloses.length - 1];
    const ma20 = avg(taiexCloses.slice(-20));
    const ma60 = avg(taiexCloses.slice(-60));
    const ma20Above60 = ma20 > ma60;
    ctx.taiex_ma20_above_ma60 = ma20Above60 ? 1 : 0;

    if (ma20Above60 && last > ma20) {
      ctx.taiex_trend = 1;
      ctx.regime_label = '多頭';
    } else if (!ma20Above60 && last < ma20) {
      ctx.taiex_trend = -1;
      ctx.regime_label = '空頭';
    } else {
      ctx.regime_label = '盤整';
    }

    // 20 日年化波動度
    const rets = [];
    for (let i = taiexCloses.length - 20; i < taiexCloses.length; i++) {
      if (i > 0 && taiexCloses[i] > 0 && taiexCloses[i - 1] > 0) {
        rets.push(Math.log(taiexCloses[i] / taiexCloses[i - 1]));
      }
    }
    if (rets.length >= 10) {
      ctx.taiex_vol_20d = +(stdDev(rets) * Math.sqrt(252) * 100).toFixed(1);
    }

    // 報酬
    if (taiexCloses.length >= 6) {
      const back5 = taiexCloses[taiexCloses.length - 6];
      ctx.taiex_return_5d = back5 > 0 ? +(((last - back5) / back5) * 100).toFixed(2) : null;
    }
    if (taiexCloses.length >= 61) {
      const back60 = taiexCloses[taiexCloses.length - 61];
      ctx.taiex_return_60d = back60 > 0 ? +(((last - back60) / back60) * 100).toFixed(2) : null;
    }

    return ctx;
  });
}

export function describeRegime(ctx) {
  if (!ctx) return '未知';
  return ctx.regime_label || '未知';
}
