import { fmtMoney } from "./Format";

// 階梯式權益曲線(每筆平倉落袋後帳戶權益)。純 server-rendered SVG,移植自
// app/backtest/compare/page.tsx 的 EquityOverlay,pathFor 改階梯線(先水平再垂直)。
// 資料來源:v_equity_curve(BUY delta=-fee / SELL delta=+realized_pnl 的 running sum)。

export interface EquityPoint {
  event_date: string;
  symbol: string;
  event_type: "BUY" | "SELL" | "DAY_TRADE";
  qty: number | string;
  price: number | string;
  delta: number | string | null;
  realized_pnl: number | string | null;
  equity: number | string;
}

export function EquityLadderChart({
  points,
  initialCapital,
}: {
  points: EquityPoint[];
  initialCapital: number;
}) {
  if (points.length === 0) {
    return (
      <div className="rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-6 text-center text-sm text-zinc-500">
        尚無交易紀錄,無法繪製權益曲線。
      </div>
    );
  }

  // series = [本金起點 t0, 各事件後 equity...](n+1 點)
  const eqVals = points.map((p) => Number(p.equity));
  const series = [initialCapital, ...eqVals];
  const n = series.length;

  const W = 900;
  const H = 340;
  const padL = 70;
  const padR = 84;
  const padT = 24;
  const padB = 46;

  const minV = Math.min(...series);
  const maxV = Math.max(...series);
  const span = maxV - minV || 1;
  const lo = minV - span * 0.08;
  const hi = maxV + span * 0.08;

  const xStep = n > 1 ? (W - padL - padR) / (n - 1) : 0;
  const x = (i: number) => padL + i * xStep;
  const yScale = (v: number) =>
    padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));

  // 階梯 path:M x0 y0 (L xi y_{i-1}  L xi yi)... — 先水平移到該事件、再垂直跳到新值
  let d = `M ${x(0)} ${yScale(series[0])}`;
  for (let i = 1; i < n; i++) {
    d += ` L ${x(i)} ${yScale(series[i - 1])} L ${x(i)} ${yScale(series[i])}`;
  }

  const finalEquity = series[n - 1];
  const totalRet =
    initialCapital > 0 ? (finalEquity / initialCapital - 1) * 100 : 0;

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-4">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="text-xs">
        {/* 本金基準線 */}
        <line
          x1={padL}
          x2={W - padR}
          y1={yScale(initialCapital)}
          y2={yScale(initialCapital)}
          stroke="#52525b"
          strokeDasharray="4 3"
        />
        <text
          x={padL}
          y={yScale(initialCapital) - 5}
          className="fill-zinc-500"
          fontSize="10"
        >
          本金 {fmtMoney(initialCapital)}
        </text>

        {/* 階梯權益線 */}
        <path d={d} fill="none" stroke="#f59e0b" strokeWidth="2" />

        {/* SELL 跳升點:圓點 + 標的 + X 軸日期 */}
        {points.map((p, idx) => {
          if (p.event_type === "BUY") return null;
          const i = idx + 1; // series 偏移(t0 起點在最前)
          const px = x(i);
          const py = yScale(Number(p.equity));
          const isDt = p.event_type === "DAY_TRADE";
          return (
            <g key={idx}>
              <circle cx={px} cy={py} r="3.5" fill={isDt ? "#fb7185" : "#f59e0b"} />
              <text
                x={px}
                y={py - 8}
                textAnchor="middle"
                className="fill-zinc-300"
                fontSize="9"
              >
                {p.symbol}
              </text>
              <text
                x={px}
                y={H - padB + 16}
                textAnchor="middle"
                className="fill-zinc-500"
                fontSize="9"
              >
                {p.event_date.slice(5).replace("-", "/")}
              </text>
            </g>
          );
        })}

        {/* 終點現值標註 */}
        <circle
          cx={x(n - 1)}
          cy={yScale(finalEquity)}
          r="4"
          fill="#fbbf24"
        />
        <text
          x={W - padR + 6}
          y={yScale(finalEquity) + 4}
          className="fill-amber-400"
          fontSize="11"
          fontWeight="600"
        >
          {fmtMoney(finalEquity)}
        </text>

        {/* Y 軸 min/max label */}
        <text
          x={padL - 8}
          y={yScale(maxV) + 4}
          textAnchor="end"
          className="fill-zinc-500"
          fontSize="10"
        >
          {fmtMoney(maxV)}
        </text>
        <text
          x={padL - 8}
          y={yScale(minV) + 4}
          textAnchor="end"
          className="fill-zinc-500"
          fontSize="10"
        >
          {fmtMoney(minV)}
        </text>
      </svg>

      {/* 底部摘要 */}
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-400">
        <span>
          本金 <span className="text-zinc-200">{fmtMoney(initialCapital)}</span>
        </span>
        <span>
          現值 <span className="font-medium text-amber-400">{fmtMoney(finalEquity)}</span>
        </span>
        <span>
          總報酬{" "}
          <span className="font-medium text-rose-400">
            {totalRet >= 0 ? "+" : ""}
            {totalRet.toFixed(1)}%
          </span>
        </span>
      </div>
    </div>
  );
}
