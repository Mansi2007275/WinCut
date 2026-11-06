"use client";

import { motion } from "framer-motion";
import { useMemo } from "react";
import type { PricePoint } from "@/lib/data";
import { price as fmtPrice } from "@/lib/format";
import { Skeleton } from "./ui";

/**
 * Price history, drawn from the pool's own Swap events.
 *
 * Inline SVG rather than a charting library: the series is at most a few hundred
 * points, the whole mark is a path and a fill, and a 60KB dependency for that
 * would be the largest thing in the bundle.
 *
 * A one-point series is drawn as a flat line, not as an empty box — a coin that
 * has been launched but never traded does have a price, and showing nothing
 * implies the chart is broken.
 */
export function PriceChart({
  series,
  loading,
  height = 160,
}: {
  series?: PricePoint[];
  loading?: boolean;
  height?: number;
}) {
  const geom = useMemo(() => {
    if (!series || series.length === 0) return null;

    const W = 100;
    const H = 100;
    const pad = 6;

    const prices = series.map((p) => p.price);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    // A flat series would divide by zero; give it a band so the line centres.
    const span = hi - lo || hi || 1;
    const floor = hi === lo ? lo - span * 0.5 : lo;
    const ceil = hi === lo ? hi + span * 0.5 : hi;

    const x = (i: number) =>
      series.length === 1 ? W / 2 : pad + (i / (series.length - 1)) * (W - pad * 2);
    const y = (v: number) => H - pad - ((v - floor) / (ceil - floor)) * (H - pad * 2);

    const pts = series.map((p, i) => [x(i), y(p.price)] as const);
    const line =
      series.length === 1
        ? `M ${pad} ${pts[0][1]} L ${W - pad} ${pts[0][1]}`
        : pts.map(([px, py], i) => `${i === 0 ? "M" : "L"} ${px} ${py}`).join(" ");
    const area =
      series.length === 1
        ? `M ${pad} ${pts[0][1]} L ${W - pad} ${pts[0][1]} L ${W - pad} ${H} L ${pad} ${H} Z`
        : `${line} L ${pts.at(-1)![0]} ${H} L ${pts[0][0]} ${H} Z`;

    const first = prices[0];
    const last = prices[prices.length - 1];
    return { line, area, lo, hi, up: last >= first, last, W, H };
  }, [series]);

  if (loading) return <Skeleton className="nb w-full" />;

  if (!geom) {
    return (
      <div
        className="nb flex w-full items-center justify-center bg-white"
        style={{ height }}
      >
        <p className="font-display text-xs uppercase text-muted">No swaps yet</p>
      </div>
    );
  }

  const stroke = geom.up ? "#00a152" : "#d32f45";
  const fill = geom.up ? "#00E676" : "#FF3D57";

  return (
    <div className="nb relative w-full overflow-hidden bg-white" style={{ height }}>
      <svg
        viewBox={`0 0 ${geom.W} ${geom.H}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        role="img"
        aria-label={`Price history, latest ${fmtPrice(geom.last)}`}
      >
        <motion.path
          d={geom.area}
          fill={fill}
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.22 }}
          transition={{ duration: 0.4 }}
        />
        <motion.path
          d={geom.line}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.7, ease: "easeOut" }}
        />
      </svg>

      {/* Axis labels sit outside the SVG so they are never stretched by
          preserveAspectRatio="none". */}
      <span className="money absolute left-2 top-1.5 text-[10px] text-muted">
        {fmtPrice(geom.hi)}
      </span>
      <span className="money absolute bottom-1.5 left-2 text-[10px] text-muted">
        {fmtPrice(geom.lo)}
      </span>
      <span className="nb-sm money absolute right-2 top-1.5 bg-white px-1.5 py-0.5 text-[10px]">
        {fmtPrice(geom.last)}
      </span>
    </div>
  );
}
