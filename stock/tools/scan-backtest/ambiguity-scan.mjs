// 停損 / 停利「同日誰先到」模糊度掃描:數出 sim() 的「先判停損」假設會影響到的交易比例。
// 用法(在本資料夾,需要 signals.json):node ambiguity-scan.mjs
// 模糊 = 第一個有事件的日子,低點 ≤ 停損 且 高點 ≥ 停利(日 K 無法判斷先後)。
import fs from "node:fs";
import { r2pTraded, ambiguousDay } from "./intraday-lib.mjs";

const SIG = JSON.parse(fs.readFileSync("signals.json", "utf8"));
const { traded } = r2pTraded(SIG);
const base = SIG.filter((s) => s.score >= 80 && s.path?.length >= 20 && s.day1 != null && s.atrPct);
const TPS = [3, 5, 8, 10, 15];
console.log("ambiguous trades / total (H=20)");
console.log("set".padEnd(16), "stop".padEnd(7), TPS.map((t) => `tp${t}%`.padStart(14)).join(""));
for (const [name, set] of [["R2p picks", traded], ["all score>=80", base]]) {
  for (const mult of [1, 2, 3]) {
    const cells = TPS.map((tp) => {
      let k = 0;
      for (const s of set) if (ambiguousDay(s, { H: 20, stop: 1 - (mult * s.atrPct) / 100, tp })) k++;
      return `${k}/${set.length} ${((100 * k) / set.length).toFixed(1)}%`.padStart(14);
    });
    console.log(name.padEnd(16), `${mult}xATR`.padEnd(7), cells.join(""));
  }
}
