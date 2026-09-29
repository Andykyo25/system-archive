// Local replica of production 今日看多 pipeline over full-market TWSE/TPEx history.
//   v_breakout_scan (score) -> scan_pattern_features / scan_supply_share / scan_pattern -> v_scan_track_v2 returns
// Adjusted prices: total-return index built from exchange "change" field (ref = close - change),
// so ex-dividend / capital-reduction days are neutral without any corporate-action table.
// Output: signals.json (every scan candidate score>=70 or day_pct>=9.5) with features + forward outcomes.
import fs from "node:fs";

const DIR = "data";
const incl = new Set(fs.readFileSync("incl.txt", "utf8").trim().split(","));
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
const byDate = new Map();
for (const f of files) {
  const [mkt, c] = f.replace(".json", "").split("_");
  const iso = `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}`;
  const j = JSON.parse(fs.readFileSync(`${DIR}/${f}`, "utf8"));
  if (!byDate.has(iso)) byDate.set(iso, { twse: null, tpex: null, idx: null });
  const e = byDate.get(iso);
  e[mkt] = j.rows;
  if (mkt === "twse") e.idx = j.idx;
}
// trading day = TWSE had data
const dates = [...byDate.keys()].filter((d) => byDate.get(d).twse && Object.keys(byDate.get(d).twse).length > 500).sort();
const D = dates.length;

// per-symbol bar series
const S = new Map(); // sym -> {di:[], o,h,l,c,v,chg}
for (let i = 0; i < D; i++) {
  const e = byDate.get(dates[i]);
  for (const mkt of ["twse", "tpex"]) {
    const rows = e[mkt]; if (!rows) continue;
    for (const [sym, r] of Object.entries(rows)) {
      const [o, h, l, c, v, chg] = r;
      if (!(c > 0)) continue;
      if (!S.has(sym)) S.set(sym, { mkt, di: [], o: [], h: [], l: [], c: [], v: [], chg: [] });
      const s = S.get(sym);
      s.di.push(i); s.o.push(o ?? c); s.h.push(h ?? c); s.l.push(l ?? c); s.c.push(c); s.v.push(v ?? 0); s.chg.push(chg);
    }
  }
}
// adjusted total-return index
let nullChg = 0, bars = 0;
for (const s of S.values()) {
  const n = s.c.length; s.a = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    bars++;
    if (k === 0) { s.a[k] = s.c[k]; continue; }
    let ref = s.chg[k] == null ? null : s.c[k] - s.chg[k];
    if (ref == null || !(ref > 0)) { nullChg++; ref = s.c[k - 1]; }
    s.a[k] = s.a[k - 1] * (s.c[k] / ref);
  }
  s.pos = new Map(s.di.map((di, k) => [di, k]));
}

// market series: TAIEX total return index + breadth
const idx = dates.map((d) => byDate.get(d).idx);
const ma = (arr, i, n) => { if (i < n - 1) return null; let t = 0; for (let j = i - n + 1; j <= i; j++) t += arr[j]; return t / n; };

// equal-weight benchmark (all symbols close>=20 on scan date) for horizon h, entry=t+1 close, exit=t+1+h close
const benchCache = new Map();
function bench(t, h) {
  const key = t * 100 + h; if (benchCache.has(key)) return benchCache.get(key);
  let sum = 0, n = 0;
  for (const s of S.values()) {
    const k0 = s.pos.get(t); if (k0 == null || s.c[k0] < 20) continue;
    const ke = s.pos.get(t + 1), kx = s.pos.get(t + 1 + h);
    if (ke == null || kx == null) continue;
    sum += s.a[kx] / s.a[ke] - 1; n++;
  }
  const r = n ? (100 * sum) / n : null; benchCache.set(key, r); return r;
}

// 0050 adjusted close vs its MA60 (production-feasible regime proxy)
const e50 = new Array(D).fill(null);
{ const s = S.get("0050"); for (let k = 59; k < s.a.length; k++) { let m = 0; for (let j = k - 59; j <= k; j++) m += s.a[j]; m /= 60; e50[s.di[k]] = Math.round(10000 * (s.a[k] / m - 1)) / 100; } }
const out = [];
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
for (const [sym, s] of S) {
  if (!incl.has(sym)) continue;
  const n = s.c.length;
  const ah = (k) => s.h[k] * (s.a[k] / s.c[k]);
  const al = (k) => s.l[k] * (s.a[k] / s.c[k]);
  const ma20At = (k) => { if (k < 19) return null; let t = 0; for (let j = k - 19; j <= k; j++) t += s.a[j]; return t / 20; };
  for (let k = 25; k < n; k++) {
    const t = s.di[k];
    // production window: bars within 120 calendar days of signal date
    if ((Date.parse(dates[t]) - Date.parse(dates[s.di[k - 24]])) / 864e5 > 120) continue;
    const c = s.c[k], a = s.a[k];
    if (c < 20) continue;
    const dayPct = 100 * (a / s.a[k - 1] - 1);
    const ma20 = ma20At(k), ma20p = ma20At(k - 5);
    let ma5 = 0; for (let j = k - 4; j <= k; j++) ma5 += s.a[j]; ma5 /= 5;
    let hi20 = -Infinity; for (let j = k - 20; j <= k - 1; j++) hi20 = Math.max(hi20, ah(j));
    let g = 0, l = 0; for (let j = k - 13; j <= k; j++) { const d = s.a[j] - s.a[j - 1]; if (d > 0) g += d; else l -= d; }
    const rsi = g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l);
    const gap = 100 * (a / ma20 - 1), slope = 100 * (ma20 / ma20p - 1), ret5 = 100 * (a / s.a[k - 5] - 1);
    const vol = s.v[k];
    const sc = {
      move: dayPct >= 7 ? 14 : dayPct >= 4 ? 7 : 0,
      brk: a > hi20 ? 12 : 0,
      vol: vol >= 5e6 ? 8 : vol >= 2e6 ? 4 : 0,
      slope: slope > 0 ? 13 : 0,
      gap: gap < 10 ? 12 : gap < 15 ? 6 : 0,
      above: a > ma20 ? 8 : 0,
      rsi: rsi >= 50 && rsi <= 70 ? 13 : (rsi >= 30 && rsi < 50) || (rsi > 70 && rsi <= 80) ? 6 : 0,
      ma: ma5 > ma20 ? 12 : 0,
      ret5: ret5 > 0 ? 8 : 0,
    };
    const score = Object.values(sc).reduce((x, y) => x + y, 0);
    if (score < 70 && dayPct < 9.5) continue;
    // pattern features: last 60 bars adj close
    let hi60 = -Infinity; for (let j = Math.max(0, k - 59); j <= k; j++) hi60 = Math.max(hi60, s.a[j]);
    const offHi60 = 100 * (a / hi60 - 1);
    // supply share: last 120 bars, close in (p, 1.2p] (adjusted units)
    let vTot = 0, vUp = 0;
    for (let j = Math.max(0, k - 119); j <= k; j++) { vTot += s.v[j]; if (s.a[j] > a && s.a[j] <= a * 1.2) vUp += s.v[j]; }
    const supply = vTot ? vUp / vTot : null;
    let v90 = 0, u90 = 0;
    for (let j = Math.max(0, k - 89); j <= k; j++) { v90 += s.v[j]; if (s.a[j] > a && s.a[j] <= a * 1.2) u90 += s.v[j]; }
    const supply90 = v90 ? u90 / v90 : null;
    const pattern = dayPct >= 9.5 && offHi60 < -15 ? (supply <= 0.3 ? "A" : "D") : dayPct >= 9.5 || gap >= 15 ? "B" : "C";
    // ATR14 (SMA of TR, adjusted units)
    let atr = 0; for (let j = k - 13; j <= k; j++) atr += Math.max(ah(j), s.a[j - 1]) - Math.min(al(j), s.a[j - 1]); atr /= 14;
    // extra research features
    let hi250 = -Infinity; for (let j = Math.max(0, k - 249); j <= k; j++) hi250 = Math.max(hi250, s.a[j]);
    let v20 = 0; for (let j = k - 20; j <= k - 1; j++) v20 += s.v[j]; v20 /= 20;
    const ret60 = k >= 60 ? 100 * (a / s.a[k - 60] - 1) : null;
    const ret20 = 100 * (a / s.a[k - 20] - 1);
    const sealed = s.h[k] > 0 ? c >= s.h[k] - 1e-9 : false; // closed at high
    const upperShadow = s.h[k] > 0 ? 100 * (s.h[k] / c - 1) : null;
    let prevLU = 0; for (let j = k - 5; j <= k - 1; j++) if (100 * (s.a[j] / s.a[j - 1] - 1) >= 9.5) prevLU++;
    // forward outcomes (global calendar: entry t+1 close, exit t+1+h close)
    const ke = s.pos.get(t + 1);
    const fw = {};
    if (ke != null) {
      const ea = s.a[ke];
      fw.gap_next = r2(100 * (s.o[ke] * (s.a[ke] / s.c[ke]) / a - 1)); // next open vs signal close
      fw.day1 = r2(100 * (ea / a - 1)); // signal close -> T+1 close
      fw.l1 = r2(100 * (s.l[ke] * (s.a[ke] / s.c[ke]) / a - 1)); // T+1 low vs signal close
      fw.h1 = r2(100 * (s.h[ke] * (s.a[ke] / s.c[ke]) / a - 1));
      for (const h of [3, 5, 10, 20]) {
        const kx = s.pos.get(t + 1 + h);
        if (kx != null) { fw[`r${h}`] = r2(100 * (s.a[kx] / ea - 1)); fw[`b${h}`] = r2(bench(t, h)); }
        // entry at T+1 open instead
        if (kx != null) fw[`o${h}`] = r2(100 * (s.a[kx] / (s.o[ke] * (s.a[ke] / s.c[ke])) - 1));
      }
      // path over 20 bars after entry for exit-rule research: adj closes/highs/lows/opens relative to entry close
      const path = [];
      for (let h = 1; h <= 20; h++) {
        const kx = s.pos.get(t + 1 + h); if (kx == null) break;
        const f = s.a[kx] / s.c[kx];
        path.push([r2(100 * (s.o[kx] * f / ea - 1)), r2(100 * (s.h[kx] * f / ea - 1)), r2(100 * (s.l[kx] * f / ea - 1)), r2(100 * (s.a[kx] / ea - 1))]);
      }
      fw.path = path;
    }
    const mi = t; // market regime at signal date
    out.push({
      d: dates[t], sym, mkt: s.mkt, c, dayPct: r2(dayPct), vol, score, sc,
      gap: r2(gap), slope: r2(slope), rsi: r2(rsi), ret5: r2(ret5), ret20: r2(ret20), ret60: r2(ret60),
      offHi60: r2(offHi60), offHi250: r2(100 * (a / hi250 - 1)), supply: supply == null ? null : Math.round(supply * 1000) / 1000, supply90: supply90 == null ? null : Math.round(supply90 * 1000) / 1000, e50_ma60: e50[t],
      pattern, atrPct: r2(100 * atr / a), ma20Dist: r2(100 * (a / ma20 - 1)), volRatio: v20 ? r2(vol / v20) : null,
      sealed, upperShadow: r2(upperShadow), prevLU,
      mkt_ma20: idx[mi] && ma(idx, mi, 20) ? r2(100 * (idx[mi] / ma(idx, mi, 20) - 1)) : null,
      mkt_ma60: idx[mi] && ma(idx, mi, 60) ? r2(100 * (idx[mi] / ma(idx, mi, 60) - 1)) : null,
      mkt_ret20: mi >= 20 && idx[mi - 20] ? r2(100 * (idx[mi] / idx[mi - 20] - 1)) : null,
      ...fw,
    });
  }
}
out.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : x.sym < y.sym ? -1 : 1));
fs.writeFileSync("signals.json", JSON.stringify(out));
// daily market stats for regime research
const mkt = dates.map((d, i) => ({ d, idx: idx[i], ma20: r2(ma(idx, i, 20)), ma60: r2(ma(idx, i, 60)) }));
fs.writeFileSync("market.json", JSON.stringify(mkt));
console.log({ dates: D, first: dates[0], last: dates[D - 1], symbols: S.size, bars, nullChgPct: r2(100 * nullChg / bars), signals: out.length });
