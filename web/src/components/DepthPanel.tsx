"use client";

/**
 * Pool depth, in place of an order book.
 *
 * A Rhea pool has no resting orders, so a book would have to be invented - and
 * an invented book on a trading screen is the most convincing lie an app can
 * tell. What a constant-product pool does have is an exact answer to "what
 * would $X fill at", computed from the reserves with Rhea's own formula. That
 * is what this shows: the price each size would really get, and how far that
 * is from the mid.
 *
 * Underneath, buy/sell pressure from the pool's recent swaps on GeckoTerminal.
 */

import { useMemo } from "react";
import type { PoolTrade } from "@/lib/gecko";
import type { Route } from "@/lib/queries";
import { depthLadder, type DepthRung } from "@/lib/rhea";
import { price as fmtPrice, usdCompact } from "@/lib/format";
import { CHARTS_AVAILABLE, NO_CHARTS_REASON } from "@/lib/near";
import { Card, SectionHeading, Skeleton } from "./ui";

export function DepthPanel({
  route,
  trades,
  tokenSymbol,
  onPickSize,
}: {
  route: Route | undefined;
  trades: PoolTrade[] | undefined;
  tokenSymbol: string;
  onPickSize?: (usd: number) => void;
}) {
  const ladder = useMemo(() => {
    if (!route) return null;
    try {
      return depthLadder(route.buy, route.sell, route.token.decimals);
    } catch {
      return null;
    }
  }, [route]);

  // Only rungs the pool can actually absorb: a $50k ladder rung on a $4k pool
  // is arithmetically true and practically meaningless, so it is dropped
  // rather than shown as a -90% fill.
  const usable = (rungs: DepthRung[] | undefined) =>
    (rungs ?? []).filter((r) => Number.isFinite(r.price) && Math.abs(r.impactPct) < 90);

  return (
    <Card className="p-0">
      <div className="px-3 pt-3">
        <SectionHeading
          right={
            <span className="text-[10px] text-secondary">
              live Rhea reserves
            </span>
          }
        >
          Pool depth
        </SectionHeading>
        <p className="mt-0.5 mb-2 text-[10px] leading-relaxed text-secondary">
          What each size would really fill at, and how far that is from the mid price. Computed
          from the pool reserves, not from an order book - a Rhea pool has none.
        </p>
      </div>

      {!ladder ? (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 border-b border-border px-3 pb-1 text-[10px] font-medium tracking-wide text-secondary uppercase">
            <span>Size</span>
            <span className="text-right">Fill price</span>
            <span className="text-right">Impact</span>
          </div>

          {/* Sells above, buys below, mid in between: the same vertical order a
              book would use, so the shape is familiar even though the data is
              not a book. */}
          <Side
            rungs={[...usable(ladder.sells)].reverse()}
            tone="loss"
            label={`sell ${tokenSymbol}`}
            onPickSize={onPickSize}
          />

          <div className="flex items-center justify-between border-y border-border bg-elevated px-3 py-1.5">
            <span className="text-[10px] font-medium tracking-wide text-secondary uppercase">
              mid
            </span>
            <span className="num text-[13px] font-semibold">{fmtPrice(ladder.mid)}</span>
          </div>

          <Side
            rungs={usable(ladder.buys)}
            tone="profit"
            label={`buy ${tokenSymbol}`}
            onPickSize={onPickSize}
          />

          {usable(ladder.buys).length === 0 && usable(ladder.sells).length === 0 && (
            <p className="px-3 py-3 text-[11px] leading-relaxed text-secondary">
              Every ladder size would move this pool more than 90%. It holds{" "}
              {usdCompact(route?.liquidityUsd)} of liquidity, so only very small trades are
              sensible here.
            </p>
          )}
        </>
      )}

      <Pressure trades={trades} tokenSymbol={tokenSymbol} />
    </Card>
  );
}

function Side({
  rungs,
  tone,
  label,
  onPickSize,
}: {
  rungs: DepthRung[];
  tone: "profit" | "loss";
  label: string;
  onPickSize?: (usd: number) => void;
}) {
  const colour = tone === "profit" ? "text-profit" : "text-loss";
  const fill = tone === "profit" ? "bg-profit/10" : "bg-loss/10";
  const worst = Math.max(1, ...rungs.map((r) => Math.abs(r.impactPct)));

  return (
    <div>
      {rungs.map((rung) => (
        <button
          key={`${tone}-${rung.usd}`}
          type="button"
          onClick={onPickSize ? () => onPickSize(rung.usd) : undefined}
          disabled={!onPickSize}
          title={`${label} ${usdCompact(rung.usd)} worth${onPickSize ? " — click to use this size" : ""}`}
          className="relative grid w-full grid-cols-[1fr_auto_auto] items-center gap-x-3 px-3 py-[5px] text-left transition-colors enabled:hover:bg-elevated"
        >
          {/* A bar whose width is the price impact, so the shape of the pool's
              depth is visible without reading the numbers. */}
          <span
            aria-hidden
            className={`absolute inset-y-0 right-0 ${fill}`}
            style={{ width: `${Math.min(100, (Math.abs(rung.impactPct) / worst) * 100)}%` }}
          />
          <span className="num relative text-[11px] text-secondary">
            {usdCompact(rung.usd)}
          </span>
          <span className="num relative text-right text-[11px]">{fmtPrice(rung.price)}</span>
          <span className={`num relative w-14 text-right text-[11px] ${colour}`}>
            {Number.isFinite(rung.impactPct) ? `${rung.impactPct.toFixed(2)}%` : "—"}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Buy/sell pressure from the pool's recent swaps.
 *
 * Measured in USD volume rather than trade count, because ten $5 trades and
 * one $5,000 trade are not the same pressure and a count would call them equal.
 */
function Pressure({
  trades,
  tokenSymbol,
}: {
  trades: PoolTrade[] | undefined;
  tokenSymbol: string;
}) {
  const totals = useMemo(() => {
    if (!trades?.length) return null;
    let buys = 0;
    let sells = 0;
    for (const t of trades) {
      if (!Number.isFinite(t.volumeUsd)) continue;
      if (t.side === "buy") buys += t.volumeUsd;
      else sells += t.volumeUsd;
    }
    const total = buys + sells;
    if (total === 0) return null;
    return { buys, sells, total, buyPct: (buys / total) * 100, count: trades.length };
  }, [trades]);

  return (
    <div className="border-t border-border px-3 py-3">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-medium tracking-wide text-secondary uppercase">
          Pressure
        </p>
        <p className="text-[10px] text-secondary">
          {totals
            ? `last ${totals.count} swaps`
            : CHARTS_AVAILABLE
              ? "no recent swaps"
              : "not available on testnet"}
        </p>
      </div>

      {!CHARTS_AVAILABLE ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-secondary">{NO_CHARTS_REASON}</p>
      ) : !totals ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-secondary">
          GeckoTerminal has not indexed any recent swaps on this pool. It is quiet, not broken.
        </p>
      ) : (
        <>
          <div className="mt-2 flex h-2 w-full overflow-hidden rounded-pill bg-elevated">
            <div className="bg-profit" style={{ width: `${totals.buyPct}%` }} />
            <div className="bg-loss" style={{ width: `${100 - totals.buyPct}%` }} />
          </div>
          <div className="mt-1.5 flex items-baseline justify-between text-[11px]">
            <span className="num text-profit">
              {usdCompact(totals.buys)} bought {tokenSymbol}
            </span>
            <span className="num text-loss">{usdCompact(totals.sells)} sold</span>
          </div>
        </>
      )}
    </div>
  );
}
