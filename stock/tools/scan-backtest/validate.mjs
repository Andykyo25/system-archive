// Compare local replica vs production frozen scan_picks (score>=80) on sample dates.
import fs from "node:fs";
const sig = JSON.parse(fs.readFileSync("signals.json", "utf8"));
const prod = JSON.parse(fs.readFileSync("prod_picks.json", "utf8"));
let tp = 0, fp = 0, fn = 0, patOk = 0, patN = 0;
for (const [d, s] of Object.entries(prod)) {
  const P = new Map(s.split(" ").map((x) => x.split(":")));
  const L = new Map(sig.filter((x) => x.d === d && x.score >= 80).map((x) => [x.sym, x]));
  const onlyP = [...P.keys()].filter((k) => !L.has(k)), onlyL = [...L.keys()].filter((k) => !P.has(k));
  const both = [...P.keys()].filter((k) => L.has(k));
  tp += both.length; fn += onlyP.length; fp += onlyL.length;
  for (const k of both) { patN++; if (L.get(k).pattern === P.get(k)) patOk++; else console.log(d, k, "pattern prod", P.get(k), "local", L.get(k).pattern, JSON.stringify({ dp: L.get(k).dayPct, off: L.get(k).offHi60, sup: L.get(k).supply, gap: L.get(k).gap })); }
  const why = (k) => { const x = sig.find((y) => y.d === d && y.sym === k); return x ? `${k}(${x.score})` : `${k}(n/a)`; };
  console.log(d, "prod", P.size, "local", L.size, "both", both.length, "| prod-only", onlyP.map(why).join(" "), "| local-only", onlyL.map((k) => `${k}(${L.get(k).score})`).join(" "));
}
console.log({ recall: (tp / (tp + fn)).toFixed(3), precision: (tp / (tp + fp)).toFixed(3), patternAgree: `${patOk}/${patN}` });
