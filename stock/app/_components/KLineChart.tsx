"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
} from "lightweight-charts";

export interface OHLCV {
  time: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export function KLineChart({ data }: { data: OHLCV[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (data.length === 0) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#09090b" }, // zinc-950
        textColor: "#a1a1aa", // zinc-400
      },
      grid: {
        vertLines: { color: "#27272a" }, // zinc-800
        horzLines: { color: "#27272a" },
      },
      timeScale: {
        timeVisible: false,
        borderColor: "#3f3f46", // zinc-700
      },
      rightPriceScale: {
        borderColor: "#3f3f46",
      },
      crosshair: {
        mode: 1, // Magnet
      },
      width: containerRef.current.clientWidth,
      height: 400,
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
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-500">
        沒有 K 線資料
      </div>
    );
  }
  return <div ref={containerRef} className="w-full" />;
}
