// Fetch TWSE/TPEx daily quotes per date into data/{mkt}_{yyyymmdd}.json (resumable).
// usage: node fetch.mjs twse|tpex START END
import fs from "node:fs";
const [mkt, START, END] = process.argv.slice(2);
const H = {"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36","Accept":"application/json"};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const n = (v) => { const s = String(v ?? "").replace(/,/g, "").trim(); if (!s || /^-+$/.test(s)) return null; const x = Number(s); return Number.isFinite(x) ? x : null; };
const isStock = (s) => /^[0-9]{4}$/.test(s) || s === "0050";
async function get(url) {
  for (let a = 1; a <= 4; a++) {
    try { const r = await fetch(url, { headers: H }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
    catch (e) { if (a === 4) throw e; await sleep(a * 5000); }
  }
}
for (let d = new Date(START + "T00:00:00Z"); d <= new Date(END + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
  const dow = d.getUTCDay(); if (dow === 0 || dow === 6) continue;
  const iso = d.toISOString().slice(0, 10), c = iso.replace(/-/g, "");
  const f = `data/${mkt}_${c}.json`; if (fs.existsSync(f)) continue;
  const out = { rows: {}, idx: null };
  try {
    if (mkt === "twse") {
      const j = await get(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${c}&type=ALLBUT0999&response=json`);
      if (j?.stat === "OK") {
        for (const t of j.tables ?? []) for (const r of t.data ?? []) {
          const k = String(r[0] ?? "");
          if (k.includes("發行量加權股價報酬指數")) out.idx = n(r[1]);
          if (t.fields?.[0] === "證券代號") {
            const s = k.trim(); if (!isStock(s)) continue;
            const sign = /\+/.test(r[9]) ? 1 : /-/.test(r[9]) ? -1 : (/X/.test(r[9]) ? null : 0);
            // [open, high, low, close, volume_shares, signed_change|null]
            out.rows[s] = [n(r[5]), n(r[6]), n(r[7]), n(r[8]), n(r[2]), sign == null || n(r[10]) == null ? null : sign * n(r[10])];
          }
        }
      }
      await sleep(3200);
    } else {
      const roc = `${d.getUTCFullYear() - 1911}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
      const j = await get(`https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${encodeURIComponent(roc)}&type=EW&response=json`);
      for (const r of j?.tables?.[0]?.data ?? []) {
        const s = String(r[0] ?? "").trim(); if (!isStock(s)) continue;
        const chg = n(String(r[3]).replace("+", ""));
        out.rows[s] = [n(r[4]), n(r[5]), n(r[6]), n(r[2]), n(r[7]), chg, String(r[3]).trim()];
      }
      await sleep(2200);
    }
    fs.writeFileSync(f, JSON.stringify(out));
    console.log(iso, mkt, Object.keys(out.rows).length, out.idx);
  } catch (e) { console.log(iso, mkt, "ERR", e.message); await sleep(30000); }
}
console.log("DONE", mkt);
