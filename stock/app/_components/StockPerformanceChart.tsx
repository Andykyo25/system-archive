"use client";

import { useId, useMemo, useState } from "react";

export interface ClosePoint {
  time: string;
  close: number;
}

const PERIODS = [
  { key: "20", label: "20 日", count: 20 },
  { key: "60", label: "60 日", count: 60 },
  { key: "all", label: "全部", count: Number.POSITIVE_INFINITY },
] as const;

const W = 760;
const H = 250;
const PAD = { top: 24, right: 18, bottom: 34, left: 48 };

export function StockPerformanceChart({ data }: { data: ClosePoint[] }) {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["key"]>("60");
  const rawId = useId();
  const gradientId = `performance-${rawId.replace(/:/g, "")}`;

  const chart = useMemo(() => {
    const selected = PERIODS.find((item) => item.key === period) ?? PERIODS[1];
    const sliced = Number.isFinite(selected.count) ? data.slice(-selected.count) : data;
    if (sliced.length < 2) return null;

    const base = sliced[0].close;
    if (!Number.isFinite(base) || base === 0) return null;
    const points = sliced.map((item) => ({
      ...item,
      value: ((item.close / base) - 1) * 100,
    }));
    const values = points.map((item) => item.value);
    let min = Math.min(...values, 0);
    let max = Math.max(...values, 0);
    const span = max - min || 1;
    min -= span * 0.14;
    max += span * 0.14;

    const x = (index: number) =>
      PAD.left + (index * (W - PAD.left - PAD.right)) / (points.length - 1);
    const y = (value: number) =>
      PAD.top + ((max - value) * (H - PAD.top - PAD.bottom)) / (max - min);
    const path = points
      .map((item, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(item.value).toFixed(1)}`)
      .join(" ");
    const area = `${path} L${x(points.length - 1).toFixed(1)},${H - PAD.bottom} L${x(0).toFixed(1)},${H - PAD.bottom} Z`;
    const last = points[points.length - 1];

    return { points, min, max, x, y, path, area, last };
  }, [data, period]);

  if (!chart) {
    return <div className="grid h-64 place-items-center text-sm text-slate-500">日線資料不足，無法繪製區間績效</div>;
  }

  const positive = chart.last.value >= 0;
  const stroke = positive ? "#f87171" : "#4ade80";
  const zeroY = chart.y(0);
  const gridValues = [chart.max, (chart.max + chart.min) / 2, chart.min];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className={`text-2xl font-semibold tracking-tight tabular-nums ${positive ? "text-up" : "text-down"}`}>
            {chart.last.value >= 0 ? "+" : ""}{chart.last.value.toFixed(2)}%
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">以區間第一個收盤價為基準</p>
        </div>
        <div className="flex rounded-xl border border-line bg-surface-sunken p-1" aria-label="績效圖表期間">
          {PERIODS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setPeriod(item.key)}
              aria-pressed={period === item.key}
              className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                period === item.key ? "bg-sky-400/12 text-sky-200" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label={`區間收盤績效 ${chart.last.value.toFixed(2)}%`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {gridValues.map((value) => (
          <g key={value.toFixed(4)}>
            <line
              x1={PAD.left}
              y1={chart.y(value)}
              x2={W - PAD.right}
              y2={chart.y(value)}
              stroke="rgba(148,163,184,0.11)"
              strokeDasharray="3 5"
            />
            <text x={PAD.left - 8} y={chart.y(value) + 4} textAnchor="end" fontSize="10" fill="#64748b">
              {value.toFixed(1)}%
            </text>
          </g>
        ))}
        {zeroY >= PAD.top && zeroY <= H - PAD.bottom && (
          <line
            x1={PAD.left}
            y1={zeroY}
            x2={W - PAD.right}
            y2={zeroY}
            stroke="rgba(226,232,240,0.24)"
          />
        )}
        <path d={chart.area} fill={`url(#${gradientId})`} />
        <path d={chart.path} fill="none" stroke={stroke} strokeWidth="2.25" vectorEffect="non-scaling-stroke" />
        <circle
          cx={chart.x(chart.points.length - 1)}
          cy={chart.y(chart.last.value)}
          r="4"
          fill="#070b12"
          stroke={stroke}
          strokeWidth="2.5"
        />
        <text x={PAD.left} y={H - 10} fontSize="10" fill="#64748b">{chart.points[0].time}</text>
        <text x={W - PAD.right} y={H - 10} textAnchor="end" fontSize="10" fill="#64748b">
          {chart.last.time}
        </text>
      </svg>
    </div>
  );
}
