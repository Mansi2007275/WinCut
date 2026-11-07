"use client";

import {
  AreaSeries,
  ColorType,
  createChart,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef } from "react";
import type { PricePoint } from "@/lib/data";
import { price as fmtPrice } from "@/lib/format";
import { Skeleton } from "./ui";

export type Timeframe = "1H" | "1D" | "1W" | "ALL";

export const TIMEFRAMES: Timeframe[] = ["1H", "1D", "1W", "ALL"];

const WINDOW_SECONDS: Record<Timeframe, number | null> = {
  "1H": 3600,
  "1D": 86_400,
  "1W": 604_800,
  ALL: null,
};

/// Trims the series to a timeframe using the points' own timestamps. A window
/// with nothing in it falls back to the whole series rather than drawing an
/// empty box, because "no trades in the last hour" is not "no price".
export function windowed(series: PricePoint[] | undefined, tf: Timeframe): PricePoint[] {
  if (!series?.length) return [];
  const span = WINDOW_SECONDS[tf];
  if (span === null) return series;
  const newest = series.at(-1)?.time;
  if (newest === undefined) return series;
  const cut = newest - span;
  const slice = series.filter((p) => (p.time ?? 0) >= cut);
  return slice.length >= 2 ? slice : series;
}

/**
 * Price history, drawn from the pool's own Swap events.
 *
 * Each point is the price a trade actually executed at, from the hook's own
 * Bought and Sold events. The PoolManager's post-swap mid-price would be the
 * better number, but its logs cover every pool on Arc and neither the index
 * nor the RPC will serve them, so that chart was simply blank. A last-traded
 * price series is what most exchanges plot, and the caption says which it is.
 *
 * A one-point series is still drawn: a coin that has been launched but never
 * traded does have a price, and an empty box implies the chart is broken.
 */
export function PriceChart({
  series,
  loading,
  height = 180,
  onHover,
}: {
  series?: PricePoint[];
  loading?: boolean;
  height?: number;
  /// Fired with the price under the crosshair, and with undefined when the
  /// pointer leaves, so the big price above can follow it.
  onHover?: (price: number | undefined) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const chart = useRef<IChartApi | null>(null);
  const area = useRef<ISeriesApi<"Area"> | null>(null);
  // Held in a ref so changing the handler never tears the chart down.
  const hover = useRef(onHover);
  hover.current = onHover;

  const data = useMemo(() => {
    if (!series?.length) return [];
    // lightweight-charts needs strictly increasing, unique times. Several
    // swaps can land in one block, so later ones are nudged a second on to
    // keep their order without pretending to know a finer timestamp.
    let last = -1;
    return series
      .filter((p) => p.time !== undefined)
      .map((p) => {
        const t = Math.max(p.time!, last + 1);
        last = t;
        return { time: t as UTCTimestamp, value: p.price };
      });
  }, [series]);

  const up = data.length < 2 || data[data.length - 1].value >= data[0].value;
  const stroke = up ? "#16C784" : "#EA3943";

  useEffect(() => {
    const el = box.current;
    if (!el) return;

    const c = createChart(el, {
      height,
      // autoSize rather than a hand-rolled ResizeObserver: calling
      // applyOptions({width}) from inside an observer on the same element
      // resizes the canvas, which refires the observer, which resizes again.
      // That feedback loop pinned the renderer hard enough that screenshotting
      // the page timed out.
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8A929C",
        fontFamily: "inherit",
        attributionLogo: true,
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { visible: false, fixLeftEdge: true, fixRightEdge: true },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        vertLine: { color: "#22272E", width: 1, style: LineStyle.Solid, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
    });
    chart.current = c;

    const s = c.addSeries(AreaSeries, {
      lineColor: stroke,
      topColor: `${stroke}44`,
      bottomColor: `${stroke}00`,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: stroke,
      crosshairMarkerBackgroundColor: "#0B0E11",
    });
    area.current = s;

    c.subscribeCrosshairMove((param) => {
      const point = param.seriesData.get(s) as { value?: number } | undefined;
      hover.current?.(point?.value);
    });

    return () => {
      c.remove();
      chart.current = null;
      area.current = null;
    };
    // The chart instance is created once per mount. Colour and data updates
    // are applied below rather than by rebuilding it, which would restart the
    // draw-in on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  useEffect(() => {
    if (!area.current) return;
    area.current.applyOptions({
      lineColor: stroke,
      topColor: `${stroke}44`,
      bottomColor: `${stroke}00`,
      crosshairMarkerBorderColor: stroke,
    });
    area.current.setData(data);
    chart.current?.timeScale().fitContent();
  }, [data, stroke]);

  const empty = !series?.length;

  // The container is ALWAYS rendered. Returning a skeleton instead of it while
  // the series loads left `box.current` null when the mount effect ran, so
  // createChart was never called and the chart never appeared once the data
  // arrived -- which is every time, because the data always arrives after the
  // first paint. The loading and empty states are drawn over the container
  // rather than in place of it.
  return (
    <div
      className="relative w-full overflow-hidden rounded-card border border-border bg-surface"
      style={{ height }}
      onPointerLeave={() => hover.current?.(undefined)}
      role="img"
      aria-label={`Price history, latest ${fmtPrice(series?.at(-1)?.price ?? 0)}`}
    >
      <div ref={box} className="absolute inset-0" />
      {empty && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-secondary">
          {loading ? <Skeleton className="h-full w-full" /> : "No swaps recorded yet"}
        </div>
      )}
    </div>
  );
}
