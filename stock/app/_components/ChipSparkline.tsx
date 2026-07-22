// 個股籌碼 sparkline + 估值分位帶(2026-07-22)
// 純 inline SVG,零 client JS、零 bundle 增量(比照 EquityLadderChart 既有做法,
// 不為了小圖表引入 lightweight-charts 之外的第二套繪圖庫)。
// L24:所有顏色寫完整字面 class / 字面 hex,不動態組裝。

export interface ChipPoint {
  as_of: string;
  value: number;
}

const W = 220;
const H = 44;
const PAD = 2;

function scaleX(i: number, n: number): number {
  if (n <= 1) return PAD;
  return PAD + (i * (W - PAD * 2)) / (n - 1);
}

/** 折線圖:用於單調遞增/遞減型序列(融資餘額、借券量、外資持股比) */
export function Sparkline({
  points,
  stroke = "#60a5fa",
}: {
  points: ChipPoint[];
  stroke?: string;
}) {
  if (points.length < 2) {
    return <div className="h-11 text-[10px] leading-[44px] text-zinc-600">資料不足</div>;
  }
  const vals = points.map((p) => p.value);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - PAD * 2);

  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${scaleX(i, points.length).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(" ");
  // 面積填色讓小圖更易讀
  const area = `${d} L${scaleX(points.length - 1, points.length).toFixed(1)},${H - PAD} L${PAD},${H - PAD} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-11 w-full"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={area} fill={stroke} fillOpacity={0.12} />
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** 長條圖 + 零軸:用於有正負的序列(三大法人淨買賣)。台股紅漲綠跌 */
export function SparkBars({ points }: { points: ChipPoint[] }) {
  if (points.length < 2) {
    return <div className="h-11 text-[10px] leading-[44px] text-zinc-600">資料不足</div>;
  }
  const vals = points.map((p) => p.value);
  const mag = Math.max(Math.abs(Math.min(...vals)), Math.abs(Math.max(...vals))) || 1;
  const mid = H / 2;
  const bw = Math.max(1, (W - PAD * 2) / points.length - 0.6);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-11 w-full"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line x1={PAD} y1={mid} x2={W - PAD} y2={mid} stroke="#3f3f46" strokeWidth={0.5} />
      {points.map((p, i) => {
        const h = (Math.abs(p.value) / mag) * (mid - PAD);
        const x = scaleX(i, points.length) - bw / 2;
        // 台股:買超紅、賣超綠
        return (
          <rect
            key={p.as_of}
            x={Math.max(0, x)}
            y={p.value >= 0 ? mid - h : mid}
            width={bw}
            height={Math.max(0.5, h)}
            fill={p.value >= 0 ? "#f87171" : "#4ade80"}
            fillOpacity={0.85}
          />
        );
      })}
    </svg>
  );
}

/**
 * 估值分位帶:一條軸標 p20/p50/p80,現值指針落在其中。
 * ⚠ 純歷史相對位置,不是買賣訊號(L38/L48 措辭紀律)。
 */
export function ValuationBar({
  now,
  p20,
  p50,
  p80,
}: {
  now: number;
  p20: number;
  p50: number;
  p80: number;
}) {
  // 軸範圍取 min/max 再外擴 12%,確保現值即使在區間外也畫得下
  const lo = Math.min(p20, now) ;
  const hi = Math.max(p80, now);
  const pad = (hi - lo) * 0.12 || 1;
  const a = lo - pad;
  const b = hi + pad;
  const pos = (v: number) => ((v - a) / (b - a)) * 100;

  return (
    <div className="relative h-7">
      {/* 底軸 */}
      <div className="absolute inset-x-0 top-3 h-1.5 rounded-full bg-surface-2" />
      {/* p20~p80 區間(中間 60% 的日子) */}
      <div
        className="absolute top-3 h-1.5 rounded-full bg-accent/30"
        style={{ left: `${pos(p20)}%`, width: `${pos(p80) - pos(p20)}%` }}
      />
      {/* 中位數 */}
      <div
        className="absolute top-2 h-3.5 w-px bg-zinc-500"
        style={{ left: `${pos(p50)}%` }}
      />
      {/* 現值指針 */}
      <div
        className="absolute top-1.5 h-4.5 w-0.5 -translate-x-1/2 rounded-full bg-zinc-100"
        style={{ left: `${pos(now)}%` }}
      />
      <div
        className="absolute top-0 -translate-x-1/2 text-[9px] text-zinc-300"
        style={{ left: `${pos(now)}%` }}
      >
        現
      </div>
    </div>
  );
}
