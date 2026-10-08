// 抓證交所 T86 / 櫃買三大法人買賣超日報,按日存成 data/inst_{mkt}_{yyyymmdd}.json(可續抓,與 fetch.mjs 同模式)。
// usage: node fetch-inst.mjs twse|tpex START END      例:node fetch-inst.mjs twse 2022-07-01 2026-09-25
// 內容:{ rows: { 代號: [外資, 投信, 自營商, 三大合計] } }(股數買賣超;非交易日 rows 為空物件)。
import fs from "node:fs";
import { parseTpexInst, parseTwseT86 } from "./inst-lib.mjs";

const [mkt, START, END] = process.argv.slice(2);
if (!["twse", "tpex"].includes(mkt) || !START || !END) {
  console.error("usage: node fetch-inst.mjs twse|tpex START END");
  process.exit(1);
}
const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36", Accept: "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let a = 1; a <= 4; a++) {
    try {
      const r = await fetch(url, { headers: H });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (a === 4) throw e;
      await sleep(a * 5000);
    }
  }
}
fs.mkdirSync("data", { recursive: true });
for (let d = new Date(START + "T00:00:00Z"); d <= new Date(END + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) continue;
  const iso = d.toISOString().slice(0, 10);
  const c = iso.replace(/-/g, "");
  const f = `data/inst_${mkt}_${c}.json`;
  if (fs.existsSync(f)) continue;
  try {
    let rows;
    if (mkt === "twse") {
      rows = parseTwseT86(await get(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${c}&selectType=ALLBUT0999&response=json`));
      await sleep(3200);
    } else {
      rows = parseTpexInst(await get(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${encodeURIComponent(iso.replace(/-/g, "/"))}&id=&response=json`));
      await sleep(2200);
    }
    fs.writeFileSync(f, JSON.stringify({ rows }));
    console.log(iso, mkt, Object.keys(rows).length);
  } catch (e) {
    console.log(iso, mkt, "ERR", e.message);
    await sleep(30000);
  }
}
console.log("DONE", mkt);
