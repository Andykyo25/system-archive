// 三大法人買賣超日報(證交所 T86 / 櫃買)→ { 代號: [外資, 投信, 自營商, 三大合計] }(股數,買賣超)。純函式,不碰檔案 / 網路。
//
// 欄位(2026-10-08 以 2022-07-01 與 2026-09-30 兩天實測):
//   TWSE T86(fields 0..18):4 = 外陸資買賣超(不含外資自營商)、10 = 投信買賣超、11 = 自營商買賣超(合計)、18 = 三大法人買賣超
//   TPEx(0..23,每 3 欄一組 買進 / 賣出 / 買賣超):4 = 外資及陸資(不含外資自營商)買賣超、13 = 投信買賣超、
//                                                  22 = 自營商合計買賣超、23 = 三大法人合計
// 外資一律取「不含外資自營商」的口徑,兩個市場一致,也與富邦 API 的 foreign 欄位相同。

const n = (v) => {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (!s || /^-+$/.test(s)) return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};
const isStock = (s) => /^[0-9]{4}$/.test(s);

function pick(row, cols) {
  const v = cols.map((c) => n(row[c]));
  return v.some((x) => x === null) ? null : v;
}

export function parseTwseT86(j) {
  if (j?.stat !== 'OK' || !Array.isArray(j.data)) return {};
  const out = {};
  for (const r of j.data) {
    const sym = String(r[0] ?? '').trim();
    if (!isStock(sym)) continue;
    const v = pick(r, [4, 10, 11, 18]);
    if (v) out[sym] = v;
  }
  return out;
}

export function parseTpexInst(j) {
  const data = j?.tables?.[0]?.data;
  if (String(j?.stat).toLowerCase() !== 'ok' || !Array.isArray(data)) return {};
  const out = {};
  for (const r of data) {
    const sym = String(r[0] ?? '').trim();
    if (!isStock(sym)) continue;
    const v = pick(r, [4, 13, 22, 23]);
    if (v) out[sym] = v;
  }
  return out;
}
