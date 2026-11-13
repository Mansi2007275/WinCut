"use client";

/**
 * The price chart: real OHLCV candles from GeckoTerminal, with the user's own
 * position drawn on top.
 *
 * Three things are overlaid, and each one answers a question the user actually
 * has while looking at a price:
 *
 *   - entry line - what they paid, so "am I up?" is a glance, not a calculation
 *   - break-even line - the price a sale would come back flat at once Rhea's
 *     pool fee is paid, which is a different and more useful number than entry
 *   - markers - where their own buys and sells happened
 *
 * The candles come from GeckoTerminal's pool OHLCV. The entry, break-even and
 * markers come from the WinCut contract. Nothing here is synthesised.
 */

import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type IPriceLine,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Candle, GtSide, TimeframeKey } from "@/lib/gecko";
import { TIMEFRAME_KEYS } from "@/lib/gecko";
import type { Trade } from "@/lib/contract";
import { price as fmtPrice, pct, toNumber, usdCompact } from "@/lib/format";
import { CHARTS_AVAILABLE, USDC_DECIMALS } from "@/lib/near";
import { Card, Segmented, Skeleton } from "./ui";

/** Matches globals.css. Kept in sync by hand because the chart is a canvas. */
const COLOR = {
  bg: "transparent",
  text: "#8a929c",
  grid: "#1b2027",
  border: "#22272e",
  up: "#16c784",
  down: "#ea3943",
  accent: "#3b82f6",
  volumeUp: "rgba(22, 199, 132, 0.28)",
  volumeDown: "rgba(234, 57, 67, 0.28)",
} as const;

export type ChartOverlay = {
  /** USDC per whole token the user paid. */
  entryPrice?: number;
  /** Price a sale would break even at, pool fee included. */
  breakEvenPrice?: number;
  /** The user's own trades in this token, for markers. */
  trades?: Trade[];
  tokenDecimals: number;
};

type Hover = { candle: Candle; changePct: number } | null;

export function PriceChart({
  candles,
  loading,
  error,
  timeframe,
  onTimeframe,
  symbol,
  overlay,
  side,
  collectingSince = null,
  points = 0,
}: {
  candles: Candle[] | undefined;
  loading: boolean;
  error: string | null;
  timeframe: TimeframeKey;
  onTimeframe: (tf: TimeframeKey) => void;
  symbol: string;
  overlay: ChartOverlay;
  side: GtSide | undefined;
  /** Testnet only: when WinCut started reading this pool, ISO. */
  collectingSince?: string | null;
  /** Testnet only: how many on-chain price points are behind these candles. */
  points?: number;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const [hover, setHover] = useState<Hover>(null);
  /** Set once the user pans or zooms, so a poll never yanks the view back. */
  const userMoved = useRef(false);

  // --- create the chart once -------------------------------------------------
  useEffect(() => {
    const el = holder.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { color: COLOR.bg },
        textColor: COLOR.text,
        fontFamily: "var(--font-inter), ui-sans-serif, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: COLOR.grid, style: LineStyle.Solid },
        horzLines: { color: COLOR.grid, style: LineStyle.Solid },
      },
      rightPriceScale: { borderColor: COLOR.border, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: {
        borderColor: COLOR.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      crosshair: {
        mode: 1,
        vertLine: { color: COLOR.text, width: 1, style: LineStyle.Dotted, labelBackgroundColor: "#1b2027" },
        horzLine: { color: COLOR.text, width: 1, style: LineStyle.Dotted, labelBackgroundColor: "#1b2027" },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      autoSize: true,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: COLOR.up,
      downColor: COLOR.down,
      borderUpColor: COLOR.up,
      borderDownColor: COLOR.down,
      wickUpColor: COLOR.up,
      wickDownColor: COLOR.down,
      priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
    });

    // Volume shares the pane but gets its own invisible scale, pinned to the
    // bottom quarter so it never fights the price for vertical room.
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
      visible: false,
    });

    chartRef.current = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;
    markersRef.current = createSeriesMarkers(candleSeries, []);

    chart.subscribeCrosshairMove((param) => {
      const data = param.seriesData.get(candleSeries) as Candle | undefined;
      if (!data || param.time === undefined) {
        setHover(null);
        return;
      }
      setHover({
        candle: data,
        changePct: data.open ? ((data.close - data.open) / data.open) * 100 : 0,
      });
    });

    const timeScale = chart.timeScale();
    const onRangeChange = () => {
      userMoved.current = true;
    };
    timeScale.subscribeVisibleLogicalRangeChange(onRangeChange);

    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      markersRef.current = null;
      linesRef.current = [];
    };
  }, []);

  // Switching timeframe is a deliberate reset, so the view may snap again.
  useEffect(() => {
    userMoved.current = false;
  }, [timeframe]);

  // --- feed it data ---------------------------------------------------------
  useEffect(() => {
    const series = candleRef.current;
    const volume = volumeRef.current;
    if (!series || !volume || !candles?.length) return;

    series.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    volume.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? COLOR.volumeUp : COLOR.volumeDown,
      })),
    );

    // Pick a price precision from the data: a memecoin at 1e-9 and wNEAR at
    // $2.40 cannot share one setting, and two decimals would flatten the
    // memecoin into a straight line.
    const last = candles[candles.length - 1].close;
    const digits = last >= 1 ? 4 : last >= 0.001 ? 6 : 12;
    series.applyOptions({
      priceFormat: { type: "price", precision: digits, minMove: 10 ** -digits },
    });

    if (!userMoved.current) chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // --- the user's own position, drawn over the top --------------------------
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;

    for (const line of linesRef.current) series.removePriceLine(line);
    linesRef.current = [];

    const add = (value: number | undefined, title: string, color: string, style: LineStyle) => {
      if (value === undefined || !Number.isFinite(value) || value <= 0) return;
      linesRef.current.push(
        series.createPriceLine({
          price: value,
          color,
          lineWidth: 1,
          lineStyle: style,
          axisLabelVisible: true,
          title,
        }),
      );
    };

    add(overlay.entryPrice, "your entry", COLOR.accent, LineStyle.Dashed);
    add(overlay.breakEvenPrice, "break even", COLOR.text, LineStyle.Dotted);
  }, [overlay.entryPrice, overlay.breakEvenPrice]);

  useEffect(() => {
    const plugin = markersRef.current;
    if (!plugin) return;
    const trades = overlay.trades ?? [];
    plugin.setMarkers(
      trades
        .map((t) => {
          const seconds = Math.floor(Number(BigInt(t.timestamp) / 1_000_000_000n));
          const buy = t.side === "Buy";
          const usdc = toNumber(t.usdc, USDC_DECIMALS);
          return {
            time: seconds as UTCTimestamp,
            position: buy ? ("belowBar" as const) : ("aboveBar" as const),
            color: buy ? COLOR.accent : t.pnl?.negative ? COLOR.down : COLOR.up,
            shape: buy ? ("arrowUp" as const) : ("arrowDown" as const),
            text: `${buy ? "buy" : "sell"} ${usdCompact(usdc)}`,
            size: 1,
          };
        })
        .sort((a, b) => (a.time as number) - (b.time as number)),
    );
  }, [overlay.trades]);

  const header = useMemo(() => {
    const shown = hover?.candle ?? (candles?.length ? candles[candles.length - 1] : undefined);
    if (!shown) return null;
    const change = shown.open ? ((shown.close - shown.open) / shown.open) * 100 : 0;
    return { candle: shown, change };
  }, [hover, candles]);

  return (
    <Card className="flex flex-col overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold">{symbol}</span>
          <span className="text-[10px] tracking-wide text-secondary uppercase">USD</span>
        </div>

        {header ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <OHLC label="O" value={header.candle.open} />
            <OHLC label="H" value={header.candle.high} />
            <OHLC label="L" value={header.candle.low} />
            <OHLC label="C" value={header.candle.close} />
            <span className={header.change >= 0 ? "num text-profit" : "num text-loss"}>
              {pct(header.change)}
            </span>
            <span className="num text-secondary">
              vol {usdCompact(header.candle.volume)}
            </span>
          </div>
        ) : (
          <Skeleton className="h-3 w-56" />
        )}

        <div className="ml-auto">
          <Segmented
            options={TIMEFRAME_KEYS.map((k) => ({ id: k, label: k }))}
            value={timeframe}
            onChange={onTimeframe}
          />
        </div>
      </div>

      {/*
        Testnet builds its own series, one point at a time, so early on there
        is genuinely not much of a chart. Saying so beats drawing three candles
        and letting them pass for a market.
      */}
      {!CHARTS_AVAILABLE && (candles?.length ?? 0) < 5 && !error && (
        <div className="border-b border-border bg-elevated/40 px-3 py-2">
          <p className="text-[11px] leading-relaxed text-secondary">
            {collectingSince ? (
              <>
                Collecting on-chain data since{" "}
                <span className="num text-primary">
                  {new Date(collectingSince).toLocaleString()}
                </span>
                {points > 0 && <> · {points} price points so far</>}. Candles fill in as the pool
                is sampled and as WinCut trades move the price.
              </>
            ) : (
              <>
                Not collecting yet. This chart is built from prices WinCut reads off the testnet
                pool itself, because GeckoTerminal indexes mainnet only.
              </>
            )}
          </p>
        </div>
      )}

      <div className="relative">
        <div ref={holder} className="h-[340px] w-full sm:h-[420px]" />

        {(loading || error || (!candles?.length && (side || !CHARTS_AVAILABLE))) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg/70">
            {error ? (
              <div className="pointer-events-auto max-w-xs px-4 text-center">
                <p className="text-xs font-semibold text-loss">No candles right now</p>
                <p className="mt-1 text-[11px] leading-relaxed text-secondary">{error}</p>
                <p className="mt-1 text-[11px] text-secondary">
                  Price, depth and your position below are read from Rhea and WinCut directly, so
                  they are unaffected.
                </p>
              </div>
            ) : loading ? (
              <p className="text-xs text-secondary">Loading candles…</p>
            ) : CHARTS_AVAILABLE ? (
              <p className="max-w-xs px-4 text-center text-[11px] leading-relaxed text-secondary">
                GeckoTerminal has no candles indexed for this pool yet. It is a real pool with real
                liquidity - it just has not traded enough to produce a chart.
              </p>
            ) : (
              <p className="max-w-xs px-4 text-center text-[11px] leading-relaxed text-secondary">
                No price points stored for this pool yet. WinCut builds this chart by reading the
                testnet pool itself, so the first candle appears once sampling has run.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-[10px] text-secondary">
        {overlay.entryPrice !== undefined && Number.isFinite(overlay.entryPrice) && (
          <Legend color={COLOR.accent} dashed>
            your entry {fmtPrice(overlay.entryPrice)}
          </Legend>
        )}
        {overlay.breakEvenPrice !== undefined && Number.isFinite(overlay.breakEvenPrice) && (
          <Legend color={COLOR.text} dashed>
            break even {fmtPrice(overlay.breakEvenPrice)}
          </Legend>
        )}
        {(overlay.trades?.length ?? 0) > 0 && (
          <Legend color={COLOR.up}>{overlay.trades!.length} of your trades marked</Legend>
        )}
        <span className="ml-auto">
          {CHARTS_AVAILABLE
            ? "candles: GeckoTerminal · overlays: WinCut contract"
            : "Rhea testnet pool price · on-chain · overlays: WinCut contract"}
        </span>
      </div>
    </Card>
  );
}

function OHLC({ label, value }: { label: string; value: number }) {
  return (
    <span className="text-secondary">
      {label} <span className="num text-text">{fmtPrice(value)}</span>
    </span>
  );
}

function Legend({
  color,
  dashed,
  children,
}: {
  color: string;
  dashed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block h-0 w-4"
        style={{ borderTop: `1px ${dashed ? "dashed" : "solid"} ${color}` }}
      />
      <span className="num">{children}</span>
    </span>
  );
}
