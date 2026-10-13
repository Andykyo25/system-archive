const num = (v) => { const s = String(v ?? "").replace(/,/g, "").trim(); const x = Number(s); return s && Number.isFinite(x) ? x : null; };
// 民國日期:證交所「114年06月12日」/「111/10/03」、櫃買「114/06/02」/ 減資表「1111003」→ ISO
export function rocToIso(s) {
  const t = String(s).trim();
  const m = t.match(/^(\d{3})(\d{2})(\d{2})$/) ?? t.match(/(\d{2,3})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? `${Number(m[1]) + 1911}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}
// 除權息計算結果表 → [iso, sym, 除權息前收盤價, 除權息參考價];只留 4 碼普通股與 0050(同日線檔範圍)
export function parseExright(mkt, raw) {
  const [iDate, iSym, iPrev, iRef] = [0, 1, 3, 4];
  const out = [];
  for (const r of raw) {
    const sym = String(r[iSym] ?? "").trim();
    if (!/^[0-9]{4}$/.test(sym) && sym !== "0050") continue;
    const d = rocToIso(r[iDate]), prev = num(r[iPrev]), ref = num(r[iRef]);
    if (d && prev > 0 && ref > 0) out.push([d, sym, prev, ref]);
  }
  return out;
}

// 官方除權息事件([iso, sym, prev, ref])對照日線:事件日的前收是否吻合、X 日(漲跌缺)有多少被事件解釋、
// 剩下的大跳空(多半是減資 / 面額變更等,要另外的官方表)逐筆列出。
export function auditOfficial(days, official, { minTwseRows = 500, jump = 0.11 } = {}) {
  const ev = new Map(official.map(([d, sym, prev, ref]) => [`${sym}|${d}`, { d, sym, prev, ref, ratio: ref / prev }]));
  const dates = [...days.keys()].filter((d) => Object.keys(days.get(d).twse ?? {}).length > minTwseRows).sort();
  const last = new Map();
  let matched = 0, prevMismatch = 0, xDays = 0, xExplained = 0;
  const unexplained = [], mismatches = [];
  for (const d of dates) for (const mkt of ["twse", "tpex"]) for (const [sym, r] of Object.entries(days.get(d)[mkt] ?? {})) {
    const close = r[3];
    if (!(close > 0)) continue;
    const prev = last.get(sym);
    last.set(sym, close);
    const e = ev.get(`${sym}|${d}`);
    if (e) {
      matched++;
      if (prev != null && Math.abs(e.prev - prev) > 0.0051) { prevMismatch++; if (mismatches.length < 10) mismatches.push({ sym, d, official: e.prev, daily: prev }); }
    }
    if (prev == null || r[5] != null) continue;
    xDays++;
    if (e) { xExplained++; continue; }
    if (Math.abs(close / prev - 1) > jump) unexplained.push({ sym, d, mkt, prev, close, label: r[6] ?? null });
  }
  return { stats: { officialEvents: ev.size, matchedToDaily: matched, prevMismatch, xDays, xExplained, unexplainedBigJumps: unexplained.length }, unexplained, mismatches };
}

// 停牌後復牌:前一個市場交易日沒有成交時,交易所當日漲跌是相對「參考價」(例:0050 2025-06-18 分割後復牌
// 漲跌 +0.41 → ref 47.16 = 分割前收盤 / 4)。官方三張表沒有 ETF 分割與櫃買面額變更,用這個補;只收
// |ratio−1| ≥ minMove 且當天沒有官方事件者。2026-10-13 實測:櫃買冷門股沒成交後的漲跌常差 5~30%(同幾檔反覆
// 出現、比例不整齊,是參考價誤差不是除權),真分割比例整齊(0.5 / 0.25 / 0.1 / 0.05)→ 預設 0.35。
// 回傳 [iso, sym, prev, ref, mkt]。
export function resumeEvents(days, officialKeys, { minTwseRows = 500, minMove = 0.35 } = {}) {
  const dates = [...days.keys()].filter((d) => Object.keys(days.get(d).twse ?? {}).length > minTwseRows).sort();
  const lastBar = new Map(); // sym -> [dateIndex, close]
  const out = [];
  dates.forEach((d, i) => {
    for (const mkt of ["twse", "tpex"]) for (const [sym, r] of Object.entries(days.get(d)[mkt] ?? {})) {
      const close = r[3], change = r[5];
      if (!(close > 0)) continue;
      const prev = lastBar.get(sym);
      lastBar.set(sym, [i, close]);
      if (!prev || prev[0] === i - 1 || change == null || officialKeys.has(`${sym}|${d}`)) continue;
      const ref = Math.round((close - change) * 10000) / 10000;
      if (ref > 0 && Math.abs(ref / prev[1] - 1) >= minMove) out.push([d, sym, prev[1], ref, mkt]);
    }
  });
  return out;
}

// days: Map<iso, { twse?: rows, tpex?: rows }>,rows[sym] = [open, high, low, close, volume, signedChange|null, ...]
// 交易日 = 證交所當天有 > 500 檔(與 engine.mjs 相同);每檔依交易日排序後比對「ref = 收盤 − 漲跌」與前收。
export function buildEvents(days, { minTwseRows = 500 } = {}) {
  const dates = [...days.keys()]
    .filter((d) => Object.keys(days.get(d).twse ?? {}).length > minTwseRows)
    .sort();
  const last = new Map(); // sym -> previous close
  const events = [];
  const unadjustedJumps = [];
  let bars = 0, nullChange = 0;
  for (const d of dates) {
    for (const mkt of ["twse", "tpex"]) {
      for (const [sym, r] of Object.entries(days.get(d)[mkt] ?? {})) {
        const close = r[3], change = r[5];
        if (!(close > 0)) continue;
        bars++;
        const prev = last.get(sym);
        last.set(sym, close);
        if (prev == null) continue;
        if (change == null) {
          nullChange++;
          if (Math.abs(close / prev - 1) > 0.11) unadjustedJumps.push({ sym, d, prev, close });
          continue;
        }
        // 兩位小數相減避免浮點誤差
        const ref = Math.round((close - change) * 10000) / 10000;
        if (!(ref > 0) || Math.abs(ref - prev) < 1e-6) continue;
        events.push({ sym, d, prev, ref, ratio: ref / prev, mkt });
      }
    }
  }
  return {
    events,
    unadjustedJumps,
    stats: {
      dates: dates.length, first: dates[0], last: dates.at(-1), bars, events: events.length,
      symbolsWithEvents: new Set(events.map((e) => e.sym)).size,
      nullChangePct: bars ? Math.round((10000 * nullChange) / bars) / 100 : null,
      unadjustedJumps: unadjustedJumps.length,
    },
  };
}
