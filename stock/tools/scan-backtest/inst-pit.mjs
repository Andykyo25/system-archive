// 法人條件的 PIT 檢驗:R2p 上線規格的交易,依「訊號日 T 的法人買賣超(占 20 日均量)」分高 / 低組,看成績有沒有差。
// 用法(在本資料夾,需要 signals.json、market.json 與 data/inst_*.json):
//   node fetch-inst.mjs twse 2022-07-01 2026-09-25 && node fetch-inst.mjs tpex 2022-07-01 2026-09-25
//   node inst-pit.mjs [--partial]
//
// 紀律(README):2023–24 定門檻、2025–26 驗證;逐年同向才算數;同一個訊號日的交易不獨立,信賴區間按日重抽;
//   報酬為 R2p 規格(3×ATR14 停損、+10% 停利、最長 20 日),扣 0.585% 成本後的平均。
// PIT:T 的法人資料在 T 收盤後約 16:00 公布,R2p 於 T+1 收盤進場,沒有前視。
// 一個交易日要「證交所與櫃買兩邊都有資料」才算可用,否則整天視為缺資料(避免只有一邊時把另一邊的股票當成 0)。
import fs from "node:fs";
import { COST, IS, MKT, OOS, sim, stats } from "./lib.mjs";
import { r2pTraded } from "./intraday-lib.mjs";
import { bootDiff, netShare, quantile } from "./inst-pit-lib.mjs";

const PARTIAL = process.argv.includes("--partial");

// 1) 讀法人檔
const loaded = new Map(); // iso → { twse?: Map, tpex?: Map }
for (const f of fs.readdirSync("data")) {
  const m = /^inst_(twse|tpex)_(\d{8})\.json$/.exec(f);
  if (!m) continue;
  const iso = `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}`;
  const rows = JSON.parse(fs.readFileSync(`data/${f}`, "utf8")).rows ?? {};
  if (Object.keys(rows).length === 0) continue;
  (loaded.get(iso) ?? loaded.set(iso, {}).get(iso))[m[1]] = new Map(Object.entries(rows));
}
const instByDate = new Map();
for (const [iso, v] of loaded) if (v.twse && v.tpex) instByDate.set(iso, new Map([...v.twse, ...v.tpex]));

const dates = MKT.map((m) => m.d);
const index = new Map(dates.map((d, i) => [d, i]));
const usableDays = dates.filter((d) => instByDate.has(d)).length;
console.log(`法人資料可用的交易日:${usableDays} / ${dates.length}`);
if (usableDays < dates.length * 0.9 && !PARTIAL) {
  console.error("資料不足 90%,先把 fetch-inst.mjs 跑完(或加 --partial 只看流程)");
  process.exit(1);
}

// 2) R2p 交易與報酬
const { traded, stopOf } = r2pTraded(JSON.parse(fs.readFileSync("signals.json", "utf8")));
const ret = (s) => sim(s, { H: 20, tp: 10, stop: stopOf(s) });
const ctx = { instByDate, dates, index };
const base = stats(traded, ret);
console.log(`R2p 交易 ${traded.length} 筆:勝率 ${base.win.toFixed(1)}%、扣成本平均 ${base.mean.toFixed(2)}%、中位 ${base.med.toFixed(2)}%`);

// 3) 各特徵:IS 定三分位門檻 → IS / OOS 高低組比較
const FEATURES = [["total", 1], ["total", 3], ["total", 5], ["foreign", 1], ["foreign", 3], ["foreign", 5], ["trust", 1], ["trust", 3], ["trust", 5]];
const YEARS = ["2023", "2024", "2025", "2026"];
const f1 = (x) => (x == null ? "  -  " : x.toFixed(1).padStart(5));
const f2 = (x) => (x == null ? "   -  " : (x >= 0 ? "+" : "") + x.toFixed(2).padStart(5));
const meanNet = (rows) => (rows.length ? rows.reduce((a, s) => a + ret(s) - COST, 0) / rows.length : null);
let seed = 12345;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

console.log("\nfeature(占20日均量的淨買賣超)       cov%   IS 高/低 n   勝率 高/低    Δ均報   | OOS 高/低 n   勝率 高/低    Δ均報 [95% CI]        | 逐年 Δ(23 24 25 26)        結論");
const rows = [];
for (const [kind, k] of FEATURES) {
  const withX = traded.map((s) => ({ s, x: netShare(s, kind, k, ctx) })).filter((o) => o.x != null);
  const cov = (100 * withX.length) / traded.length;
  const isX = withX.filter((o) => IS(o.s));
  if (isX.length < 60) { console.log(`${(kind + k + "d").padEnd(34)} 樣本太少(IS ${isX.length})`); continue; }
  const lo = quantile(isX.map((o) => o.x), 1 / 3);
  const hi = quantile(isX.map((o) => o.x), 2 / 3);
  const grp = (set) => ({ H: set.filter((o) => o.x >= hi).map((o) => o.s), L: set.filter((o) => o.x <= lo).map((o) => o.s) });
  const gi = grp(isX);
  const go = grp(withX.filter((o) => OOS(o.s)));
  const win = (a) => (a.length ? (100 * a.filter((s) => ret(s) > 0).length) / a.length : null);
  const dIS = meanNet(gi.H) != null && meanNet(gi.L) != null ? meanNet(gi.H) - meanNet(gi.L) : null;
  const dOOS = meanNet(go.H) != null && meanNet(go.L) != null ? meanNet(go.H) - meanNet(go.L) : null;
  const ci = bootDiff(go.H.map((s) => ({ d: s.d, r: ret(s) - COST })), go.L.map((s) => ({ d: s.d, r: ret(s) - COST })), 1000, rand);
  const yearly = YEARS.map((y) => {
    const h = [...gi.H, ...go.H].filter((s) => s.d.startsWith(y));
    const l = [...gi.L, ...go.L].filter((s) => s.d.startsWith(y));
    return h.length >= 8 && l.length >= 8 ? meanNet(h) - meanNet(l) : null;
  });
  const signs = yearly.filter((v) => v != null).map((v) => Math.sign(v));
  const consistent = signs.length >= 3 && signs.every((v) => v === signs[0]);
  let verdict = "—";
  if (ci && dIS != null && consistent) {
    if (dOOS > 0 && dIS > 0 && ci.lo95 > 0 && signs[0] > 0) verdict = "法人高→較好 ✔";
    else if (dOOS < 0 && dIS < 0 && ci.hi95 < 0 && signs[0] < 0) verdict = "法人高→較差 ✔";
  }
  rows.push({ kind, k, verdict });
  console.log(
    `${(kind + k + "d").padEnd(34)} ${f1(cov)}  ${String(gi.H.length).padStart(3)}/${String(gi.L.length).padEnd(3)} ${f1(win(gi.H))}/${f1(win(gi.L))} ${f2(dIS)}  | ${String(go.H.length).padStart(3)}/${String(go.L.length).padEnd(3)} ${f1(win(go.H))}/${f1(win(go.L))} ${f2(dOOS)} [${f2(ci?.lo95)},${f2(ci?.hi95)}] | ${yearly.map(f2).join(" ")}   ${verdict}`,
  );
}
const hits = rows.filter((r) => r.verdict !== "—");
console.log(`\n9 個特徵中,通過「樣本外信賴區間不含 0 + 四個年度方向一致 + 樣本內同向」的有 ${hits.length} 個${hits.length ? ":" + hits.map((h) => `${h.kind}${h.k}d(${h.verdict})`).join("、") : ""}。`);
console.log("注意:9 個特徵同時檢定,偶然過關的期望值約 0.45 個;單一個過關要再獨立驗證(例如 paper-track)才能當 gate。");

// ── 事後假設(2026-10-08):投信 5 日「大量買超」 ───────────────────────────────────────────
// 上面 trust5d 通過的結果要小心解讀:投信有大量的 0(沒有動作),IS 三分位上緣門檻 = 0,
// 所以「高組」其實是「≥ 0(沒動作 + 買超)」,「低組」是投信賣超。看五分位後,穩定的是最大買超那一端。
// 這個切法是看過五分位表後才選的(事後假設):門檻只用 IS 定,但「測這一端」的選擇本身有資料窺探,
// 9 個特徵 + 1 個事後切法 → 只能當線索,要用前向資料(paper-track)獨立驗證才能當 gate(M10 紀律)。
{
  const T = traded.map((s) => ({ s, x: netShare(s, "trust", 5, ctx) })).filter((o) => o.x != null);
  const ISx = T.filter((o) => IS(o.s));
  const OOSx = T.filter((o) => OOS(o.s));
  const cut = quantile(ISx.map((o) => o.x).filter((v) => v > 0), 0.8); // IS 中「正的」trust5d 的 80 分位
  const isQ5 = (o) => o.x >= cut;
  const net = (s) => ret(s) - COST;
  const mean2 = (a) => (a.length ? a.reduce((x, s) => x + net(s), 0) / a.length : NaN);
  const win2 = (a) => (a.length ? (100 * a.filter((s) => ret(s) > 0).length) / a.length : NaN);
  const sg = (v) => (v >= 0 ? "+" : "") + v.toFixed(2);
  console.log(`\n── 事後假設:投信 5 日大量買超(IS 正值的 80 分位以上;門檻 ${cut.toFixed(4)} = 5 日合計約 ${(500 * cut).toFixed(0)}% 的 20 日均量)──`);
  console.log(`被標記的交易:IS ${ISx.filter(isQ5).length}/${ISx.length}、OOS ${OOSx.filter(isQ5).length}/${OOSx.length}`);
  for (const [lab, set] of [["IS 2023-24", ISx], ["OOS 2025-26", OOSx], ["全期", T]]) {
    const H = set.filter(isQ5).map((o) => o.s);
    const L = set.filter((o) => !isQ5(o)).map((o) => o.s);
    const ci = bootDiff(H.map((s) => ({ d: s.d, r: net(s) })), L.map((s) => ({ d: s.d, r: net(s) })), 2000, rand);
    console.log(`${lab.padEnd(12)} Q5 n ${String(H.length).padStart(4)} 勝率 ${win2(H).toFixed(1)} 扣成本平均 ${sg(mean2(H))} | 其他 n ${String(L.length).padStart(4)} 勝率 ${win2(L).toFixed(1)} 平均 ${sg(mean2(L))} | Δ ${sg(ci.diff)} [${sg(ci.lo95)}, ${sg(ci.hi95)}]`);
  }
  console.log("逐年(Q5 平均 / 其他平均 / Q5 筆數):");
  for (const y of YEARS) {
    const S = T.filter((o) => o.s.d.startsWith(y));
    const H = S.filter(isQ5).map((o) => o.s);
    console.log(`  ${y}  ${sg(mean2(H))} / ${sg(mean2(S.filter((o) => !isQ5(o)).map((o) => o.s)))} / n=${H.length}`);
  }
  for (const [lab, set] of [["IS", ISx], ["OOS", OOSx]]) {
    const all = set.map((o) => o.s);
    const kept = set.filter((o) => !isQ5(o)).map((o) => o.s);
    console.log(`若剔除 Q5(${lab}):n ${all.length}→${kept.length}、勝率 ${win2(all).toFixed(1)}→${win2(kept).toFixed(1)}、扣成本平均 ${sg(mean2(all))}→${sg(mean2(kept))}`);
  }
}
