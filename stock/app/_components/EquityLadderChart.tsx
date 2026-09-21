"use client";

import { useEffect, useId, useRef, useState } from "react";
import { fmtMoney } from "./Format";

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

export function EquityLadderChart({ points, initialCapital }: {
  points: EquityPoint[];
  initialCapital: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const gradientId = useId();
  const [width, setWidth] = useState(800);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const series = [initialCapital, ...points.map((p) => Number(p.equity))];
  const last = series.length - 1;
  const selected = active == null ? last : Math.min(active, last);
  const event = selected > 0 ? points[selected - 1] : null;
  const height = width < 540 ? 300 : 360;
  const left = width < 540 ? 54 : 72;
  const right = width - 20;
  const top = 24;
  const bottom = height - 36;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = Math.max(max - min, Math.abs(max) * 0.05, 1);
  const low = min - range * 0.12;
  const high = max + range * 0.16;
  const x = (i: number) => left + (i / Math.max(last, 1)) * (right - left);
  const y = (value: number) => bottom - ((value - low) / (high - low)) * (bottom - top);
  let path = `M ${x(0)} ${y(initialCapital)}`;
  for (let i = 1; i <= last; i++) path += ` H ${x(i)} V ${y(series[i])}`;
  const tickCount = Math.max(2, Math.min(7, Math.floor((right - left) / 100)));
  const ticks = [...new Set(Array.from({ length: tickCount }, (_, i) =>
    Math.round(1 + (i / (tickCount - 1)) * Math.max(0, last - 1))))];
  const dateTicks = ticks.filter((i, index) => index === ticks.length - 1 ||
    points[i - 1]?.event_date !== points[ticks[index + 1] - 1]?.event_date);

  return (
    <div ref={container} className="overflow-hidden rounded-2xl border border-line bg-surface-1 p-4 sm:p-6">
      {points.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-500">尚無交易紀錄，無法繪製權益曲線。</p>
      ) : (<>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-zinc-300">已實現權益走勢</h2>
            <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-amber-400">{fmtMoney(series[selected])}<span className="ml-2 text-xs font-normal text-zinc-500">元</span></div>
          </div>
          <div className="text-xs text-zinc-500">本金 <span className="ml-1 tabular-nums text-zinc-300">{fmtMoney(initialCapital)}</span></div>
        </div>
        <div className="mt-2 min-h-10 text-xs leading-5 text-zinc-400" aria-live="polite">
          {active == null ? `${points[0].event_date} — ${points[last - 1].event_date}` : event ? (
            <span>{event.event_date} · {event.symbol} · {event.event_type === "BUY" ? "買進" : event.event_type === "SELL" ? "賣出" : "當沖"}<span className={`ml-3 tabular-nums ${Number(event.delta) < 0 ? "text-green-400" : "text-rose-400"}`}>{Number(event.delta) > 0 ? "+" : ""}{fmtMoney(event.delta)} 元</span></span>
          ) : "初始本金"}
        </div>
        <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}
          role="group" aria-label="已實現權益曲線，可用左右方向鍵查看各筆交易"
          tabIndex={0} className="rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-amber-400/50"
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const px = (e.clientX - rect.left) * width / rect.width;
            setActive(Math.max(0, Math.min(last, Math.round((px - left) / (right - left) * last))));
          }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const px = (e.clientX - rect.left) * width / rect.width;
            setActive(Math.max(0, Math.min(last, Math.round((px - left) / (right - left) * last))));
          }}
          onPointerLeave={(e) => { if (e.pointerType === "mouse") setActive(null); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              setActive(Math.max(0, Math.min(last, selected + (e.key === "ArrowLeft" ? -1 : 1))));
            } else if (e.key === "Escape") setActive(null);
          }} onBlur={() => setActive(null)}>
          <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f59e0b" stopOpacity="0.18" /><stop offset="100%" stopColor="#f59e0b" stopOpacity="0.01" /></linearGradient></defs>
          {Array.from({ length: 5 }, (_, i) => {
            const value = low + (high - low) * i / 4;
            return <g key={i}><line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="#ffffff" strokeOpacity="0.06" /><text x={left - 12} y={y(value) + 4} textAnchor="end" fill="#71717a" fontSize="11">{Math.abs(value) >= 10000 ? `${(value / 10000).toFixed(1)}萬` : fmtMoney(value)}</text></g>;
          })}
          <path d={`${path} V ${bottom} H ${left} Z`} fill={`url(#${gradientId})`} />
          <line x1={left} x2={right} y1={y(initialCapital)} y2={y(initialCapital)} stroke="#a1a1aa" strokeOpacity="0.4" strokeDasharray="4 6" />
          <path d={path} fill="none" stroke="#fbbf24" strokeWidth="2.5" strokeLinejoin="round" />
          {dateTicks.map((i) => <text key={i} x={x(i)} y={height - 10} textAnchor={i === last ? "end" : "middle"} fill="#71717a" fontSize="11">{points[i - 1]?.event_date.slice(5).replace("-", "/")}</text>)}
          {active != null && <line x1={x(selected)} x2={x(selected)} y1={top} y2={bottom} stroke="#fbbf24" strokeOpacity="0.35" strokeDasharray="3 5" />}
          <circle cx={x(selected)} cy={y(series[selected])} r="8" fill="#fbbf24" fillOpacity="0.12" />
          <circle cx={x(selected)} cy={y(series[selected])} r="4" fill="#fbbf24" stroke="#18181b" strokeWidth="2" />
        </svg>
        <div className="mt-3 flex flex-wrap justify-between gap-2 border-t border-line pt-3 text-[11px] text-zinc-500"><span className="flex items-center gap-2"><span className="h-0.5 w-4 bg-amber-400" />已實現權益<span className="ml-3 w-4 border-t border-dashed border-zinc-500" />初始本金</span><span>滑動或點選查看交易</span></div>
      </>)}
    </div>
  );
}
