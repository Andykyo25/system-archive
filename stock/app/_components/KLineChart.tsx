"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type LineData,
  type WhitespaceData,
  type Time,
} from "lightweight-charts";

export interface OHLCV {
  time: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// 布林軌道(標準 20/2,資訊呈現,非買賣訊號):中軌=MA20、上下軌=±2σ(樣本標準差,對齊
// SQL 持股燈的 stddev_samp)。用圖上 raw close 算,與 K 線視覺一致;前 19 根不足窗留白。
function bollingerBands(
  data: OHLCV[],
  period = 20,
  mult = 2,
): {
  upper: (LineData<Time> | WhitespaceData<Time>)[];
  middle: (LineData<Time> | WhitespaceData<Time>)[];
  lower: (LineData<Time> | WhitespaceData<Time>)[];
} {
  const upper: (LineData<Time> | WhitespaceData<Time>)[] = [];
  const middle: (LineData<Time> | WhitespaceData<Time>)[] = [];
  const lower: (LineData<Time> | WhitespaceData<Time>)[] = [];
  for (let i = 0; i < data.length; i++) {
    const time = data[i].time as unknown as Time;
    if (i < period - 1) {
      upper.push({ time });
      middle.push({ time });
      lower.push({ time });
      continue;
    }
    const win = data.slice(i - period + 1, i + 1).map((d) => d.close);
    const ma = win.reduce((a, b) => a + b, 0) / period;
    const variance =
      win.reduce((a, b) => a + (b - ma) ** 2, 0) / (period - 1); // 樣本(n-1)
    const sd = Math.sqrt(variance);
    upper.push({ time, value: ma + mult * sd });
    middle.push({ time, value: ma });
    lower.push({ time, value: ma - mult * sd });
  }
  return { upper, middle, lower };
}

export function KLineChart({ data }: { data: OHLCV[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (data.length === 0) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#64748b",
        fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui",
      },
      grid: {
        vertLines: { color: "rgba(148, 163, 184, 0.08)" },
        horzLines: { color: "rgba(148, 163, 184, 0.08)" },
      },
      timeScale: {
        timeVisible: false,
        borderColor: "rgba(148, 163, 184, 0.16)",
        rightOffset: 3,
      },
      rightPriceScale: {
        borderColor: "rgba(148, 163, 184, 0.16)",
        scaleMargins: { top: 0.08, bottom: 0.25 },
      },
      crosshair: {
        mode: 1, // Magnet
      },
      width: containerRef.current.clientWidth,
      height: 430,
    });
    chartRef.current = chart;

    // 台股配色:紅 = 漲、綠 = 跌
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#ef4444", // red-500
      downColor: "#22c55e", // green-500
      borderUpColor: "#ef4444",
      borderDownColor: "#22c55e",
      wickUpColor: "#ef4444",
      wickDownColor: "#22c55e",
    });
    candle.setData(
      data.map((d) => ({
        time: d.time,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
      })),
    );

    // 布林軌道(20,2)疊在 K 線上 — 資訊呈現,非買賣訊號(走 B)
    const boll = bollingerBands(data);
    const bbUpper = chart.addSeries(LineSeries, {
      color: "#a78bfa", // violet-400
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    bbUpper.setData(boll.upper);
    const bbMid = chart.addSeries(LineSeries, {
      color: "#71717a", // zinc-500
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    bbMid.setData(boll.middle);
    const bbLower = chart.addSeries(LineSeries, {
      color: "#a78bfa",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    bbLower.setData(boll.lower);

    // 成交量副圖(底下 30%)
    const volumes = data
      .filter((d) => d.volume != null && d.volume > 0)
      .map((d) => ({
        time: d.time,
        value: d.volume!,
        color: d.close >= d.open ? "#7f1d1d" : "#14532d", // 紅/綠 8 折
      }));
    if (volumes.length > 0) {
      const vol = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
      });
      vol.priceScale().applyOptions({
        scaleMargins: { top: 0.7, bottom: 0 },
      });
      vol.setData(volumes);
    }

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [data]);

  if (data.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-surface-1 p-8 text-center text-sm text-zinc-500">
        沒有 K 線資料
      </div>
    );
  }
  return (
    <div>
      <div ref={containerRef} className="w-full overflow-hidden rounded-2xl" />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-2 text-[10px] text-slate-600">
        <span className="inline-flex items-center gap-1.5"><i className="h-px w-4 bg-violet-400" />布林通道 (20, 2)</span>
        <span className="inline-flex items-center gap-1.5"><i className="h-px w-4 border-t border-dashed border-slate-500" />MA20</span>
        <span>紅漲、綠跌 · 成交量置於下方</span>
      </div>
    </div>
  );
}
