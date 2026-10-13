// 官方價格調整表,按月存 data/{exright|capred|parval}_{twse|tpex}_YYYYMM.json(可續抓):
//   parval  = 變更股票面額恢復買賣參考價(證交所 TWTB8U)
//   exright = 除權息計算結果表(證交所 TWT49U、櫃買 exDailyQ):除權息前收盤價 / 除權息參考價
//   capred  = 減資恢復買賣參考價(證交所 TWTAUU、櫃買 revivt):停止買賣前收盤價 / 恢復買賣參考價
//   兩者欄位順序都是 [日期, 代號, 名稱, 前收, 參考價, …]。日線檔在這些日子的漲跌是 X / 文字,ref 只能從這裡拿。
// usage: node fetch-exright.mjs 2022-07 2026-10
import fs from "node:fs";
import { parseExright } from "./adj-events-lib.mjs";

const [START, END] = process.argv.slice(2);
const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36", Accept: "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let a = 1; a <= 4; a++) {
    try { const r = await fetch(url, { headers: H }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
    catch (e) { if (a === 4) throw e; await sleep(a * 5000); }
  }
}
const pad = (n) => String(n).padStart(2, "0");
for (let d = new Date(START + "-01T00:00:00Z"); d <= new Date(END + "-01T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 1)) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const tw = `startDate=${y}${pad(m)}01&endDate=${y}${pad(m)}${last}&response=json`;
  const tp = `startDate=${y}%2F${pad(m)}%2F01&endDate=${y}%2F${pad(m)}%2F${last}&response=json`;
  const sources = [
    ["exright", "twse", `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?${tw}`],
    ["exright", "tpex", `https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?${tp}`],
    ["capred", "twse", `https://www.twse.com.tw/rwd/zh/reducation/TWTAUU?${tw}`],
    ["capred", "tpex", `https://www.tpex.org.tw/www/zh-tw/bulletin/revivt?${tp}`],
    // 面額變更(股票分割):參考價 = 停止買賣前收盤價 / 換股率。稽核後剩下的大跳空都在上市,櫃買未發現案例
    ["parval", "twse", `https://www.twse.com.tw/rwd/zh/change/TWTB8U?${tw}`],
  ];
  for (const [kind, mkt, url] of sources) {
    const f = `data/${kind}_${mkt}_${y}${pad(m)}.json`;
    if (fs.existsSync(f)) continue;
    try {
      const j = await get(url);
      if (mkt === "twse" && j?.stat !== "OK" && !/沒有符合|查無/.test(j?.stat ?? "")) throw new Error(`stat ${j?.stat}`);
      const raw = mkt === "twse" ? j?.data ?? [] : j?.tables?.[0]?.data ?? [];
      const rows = parseExright(mkt, raw);
      fs.writeFileSync(f, JSON.stringify(rows));
      console.log(y, m, kind, mkt, raw.length, rows.length);
    } catch (e) { console.log(y, m, kind, mkt, "ERR", e.message); await sleep(30000); }
    await sleep(3200);
  }
}
console.log("DONE");
