// SVG 雷達圖,純 server-render(無 client 互動)
// axes 給 M9.3 19 個 factor(7 fund + 5 mom + 2 rev + 5 chip)
// 每軸 0..1(true=1 / false=0 / null=不評,標灰色)
//
// 設計:
//   - 黑底 / 淺色軸線 / 藍色雷達面(填透明 + 邊框)
//   - null 軸標灰色,告訴 user 該 factor 沒資料
//   - viewBox 比例固定,size 由 caller 用 className 控制
//   - component 本身不寫死 axes 數,由 caller 控(buildFactorAxes 在 page 寫死 19)

export interface FactorAxis {
  key: string;
  label: string;
  // 1 = pass / 0 = fail / null = no data
  value: 0 | 1 | null;
  // 維度分組(用於 axis label 著色,順序也影響軸排列)
  group: "fund" | "mom" | "rev" | "chip";
}

const GROUP_COLOR: Record<FactorAxis["group"], string> = {
  fund: "#60a5fa", // blue-400
  mom: "#fbbf24", // amber-400
  rev: "#a78bfa", // violet-400
  chip: "#34d399", // emerald-400
};

interface Props {
  axes: FactorAxis[];
  size?: number;
}

export function FactorRadar({ axes, size = 320 }: Props) {
  if (axes.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-500">
        無因子資料
      </div>
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const r = (size * 0.36); // 中心到最外環半徑
  const n = axes.length;

  // 每軸方向(從正上方順時鐘)
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;

  // 同心圓基準(3 層:0.33 / 0.66 / 1.0)
  const ringRatios = [0.33, 0.66, 1.0];

  // 各 axis tip(滿值點)
  const axisTip = (i: number) => ({
    x: cx + Math.cos(angle(i)) * r,
    y: cy + Math.sin(angle(i)) * r,
  });

  // axis label 位置(比 tip 多 8% 外圍)
  const axisLabelPos = (i: number) => ({
    x: cx + Math.cos(angle(i)) * (r * 1.18),
    y: cy + Math.sin(angle(i)) * (r * 1.18),
  });

  // 資料 polygon 頂點(value 為 null 視為 0.5 半圈灰)
  const dataPoints = axes
    .map((a, i) => {
      const v = a.value == null ? 0.0 : a.value;
      return {
        x: cx + Math.cos(angle(i)) * (r * v),
        y: cy + Math.sin(angle(i)) * (r * v),
      };
    });

  const polygonPoints = dataPoints.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");

  return (
    <svg
      viewBox={`0 0 ${size} ${size + 30}`}
      className="w-full h-auto"
      role="img"
      aria-label="因子雷達圖"
    >
      {/* 同心圓背景 */}
      {ringRatios.map((rr, idx) => (
        <circle
          key={idx}
          cx={cx}
          cy={cy}
          r={r * rr}
          fill="none"
          stroke="#3f3f46"
          strokeWidth="0.5"
          strokeDasharray={idx < ringRatios.length - 1 ? "2 3" : "0"}
        />
      ))}

      {/* 軸線 */}
      {axes.map((_, i) => {
        const tip = axisTip(i);
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={tip.x}
            y2={tip.y}
            stroke="#52525b"
            strokeWidth="0.5"
          />
        );
      })}

      {/* 資料 polygon */}
      <polygon
        points={polygonPoints}
        fill="rgba(59, 130, 246, 0.18)"
        stroke="#3b82f6"
        strokeWidth="1.5"
      />

      {/* 資料點(value=1 實心 / 0 空心 / null 灰)*/}
      {axes.map((a, i) => {
        const p = dataPoints[i];
        const isPass = a.value === 1;
        const isNull = a.value === null;
        return (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={3}
            fill={isPass ? GROUP_COLOR[a.group] : isNull ? "#52525b" : "#27272a"}
            stroke={GROUP_COLOR[a.group]}
            strokeWidth="1"
          />
        );
      })}

      {/* axis labels */}
      {axes.map((a, i) => {
        const lp = axisLabelPos(i);
        // 依角度決定 text-anchor 對齊
        const ang = angle(i);
        const cos = Math.cos(ang);
        const anchor =
          Math.abs(cos) < 0.2 ? "middle" : cos > 0 ? "start" : "end";
        const dy = Math.sin(ang) > 0.5 ? "0.8em" : Math.sin(ang) < -0.5 ? "-0.2em" : "0.3em";
        return (
          <text
            key={i}
            x={lp.x}
            y={lp.y}
            textAnchor={anchor}
            dy={dy}
            fontSize="10"
            fontFamily="-apple-system, sans-serif"
            fill={a.value === null ? "#71717a" : GROUP_COLOR[a.group]}
          >
            {a.label}
          </text>
        );
      })}
    </svg>
  );
}
