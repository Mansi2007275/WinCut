"use client";

/**
 * The top strip of the trade screen.
 *
 * Price comes from the live Rhea reserves rather than from GeckoTerminal,
 * because that is the price the next trade will actually touch - the indexed
 * price can be a block or two behind. The 24h change and volume do come from
 * GeckoTerminal, since neither can be derived from a single reserve snapshot.
 * Each tile says where its number came from on hover.
 */

import Link from "next/link";
import type { PoolStats } from "@/lib/gecko";
import type { Activity, Route } from "@/lib/queries";
import type { TokenConfig } from "@/lib/contract";
import { price as fmtPrice, pct, usd, usdCompact } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import { useLossCredit } from "@/lib/queries";
import { explorerToken } from "@/lib/explorer";
import { CHARTS_AVAILABLE, isDeployed } from "@/lib/near";
import { midPriceIsSane } from "@/lib/rhea";
import { Skeleton } from "./ui";

/**
 * Whether this market is trading right now, in one glance.
 *
 * Counted over the last hour rather than the last day, because the question
 * the badge answers is "is anything happening", and a 24h count says yes all
 * afternoon about a market that went quiet at breakfast. Zero is shown as
 * zero: a badge that only ever appears when the news is good is decoration.
 */
function LiveBadge({ activity }: { activity?: Activity }) {
  if (!activity) return null;
  const n = activity.countLastHour;
  const live = n > 0;
  return (
    <span
      title={`${n} settled trade(s) and market-maker swap(s) in the last hour, from ${activity.source}`}
      className={`inline-flex items-center gap-1.5 rounded-pill border px-2 py-0.5 text-[10px] font-medium ${
        live ? "border-profit/30 bg-profit/10 text-profit" : "border-border bg-surface text-secondary"
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-pill ${live ? "animate-pulse bg-profit" : "bg-secondary"}`}
      />
      <span className="num">
        {live ? `Live · ${n} ${n === 1 ? "trade" : "trades"} in last hour` : "no trades in last hour"}
      </span>
    </span>
  );
}

export function StatsBar({
  token,
  route,
  stats,
  statsError,
  activity,
}: {
  token: TokenConfig;
  route: Route | undefined;
  stats: PoolStats | undefined;
  statsError: boolean;
  activity?: Activity;
}) {
  const { accountId } = useWallet();
  const credit = useLossCredit(accountId);

  const hops = token.hops.length;
  const change = stats?.change24hPct;

  // Two independent prices: the live pool reserves and GeckoTerminal's index.
  // They should differ only by a block or two of drift, so a real gap means
  // one of them is wrong and the screen should say so rather than pick one.
  const disagree =
    route !== undefined &&
    stats !== undefined &&
    !midPriceIsSane(route.mid, stats.priceUsd);

  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {/* pair + price */}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg leading-none font-semibold">{token.symbol}</h1>
            <span className="text-xs text-secondary">/ USDC</span>
            <LiveBadge activity={activity} />
            <a
              href={explorerToken(token.token_id)}
              target="_blank"
              rel="noreferrer"
              title={token.token_id}
              className="text-[10px] text-secondary underline underline-offset-2 hover:text-text"
            >
              contract ↗
            </a>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            {route ? (
              <span
                className="num text-2xl leading-none font-semibold"
                title="Mid price computed from the live Rhea pool reserves this trade would route through"
              >
                {fmtPrice(route.mid)}
              </span>
            ) : (
              <Skeleton className="h-7 w-28" />
            )}
            {change !== undefined && Number.isFinite(change) && (
              <span className={`num text-sm font-semibold ${change >= 0 ? "text-profit" : "text-loss"}`}>
                {pct(change)}
              </span>
            )}
          </div>
        </div>

        <Divider />

        <Stat
          label="24h volume"
          title={
            CHARTS_AVAILABLE
              ? "Traded volume on this Rhea pool over the last 24 hours, from GeckoTerminal"
              : "Everything settled through WinCut on this market in the last 24 hours, from the contract's own trade log, plus the market maker's swaps on Rhea. Not an indexer's estimate - the notionals the trades actually carried."
          }
          value={
            CHARTS_AVAILABLE
              ? statsError
                ? "unavailable"
                : stats
                  ? usdCompact(stats.volume24hUsd)
                  : undefined
              : activity
                ? usdCompact(activity.volume24hUsd)
                : undefined
          }
          sub={
            !CHARTS_AVAILABLE && activity
              ? `${activity.count} trade${activity.count === 1 ? "" : "s"}${activity.truncated ? ", at least" : ""}`
              : undefined
          }
        />

        <Stat
          label="Usable liquidity"
          title="The thinnest pool on the route, from the live reserves. That pool is what limits a trade, not the deep USDC/wNEAR one every route starts at."
          value={route ? usdCompact(route.liquidityUsd) : undefined}
          sub={
            route && hops > 1
              ? `thinnest of ${hops} hops · pool #${thinnestPool(route)}`
              : `pool #${token.hops[0]?.pool_id}`
          }
        />

        <Stat
          label="Pool fee"
          title="Rhea's own fee, compounded across the hops. WinCut never takes this."
          value={route ? `${route.poolFeePct.toFixed(3)}%` : undefined}
          sub="paid to Rhea LPs"
        />

        <Divider />

        {/* The product, stated on every trade screen. */}
        <div className="min-w-0">
          <p className="text-[10px] font-medium tracking-wide text-secondary uppercase">
            WinCut fee
          </p>
          <p className="mt-1 text-[13px] leading-tight font-semibold">
            <span className="text-profit">Buy 0%</span>
            <span className="mx-1.5 text-border">·</span>
            <span>Sell 10% of profit only</span>
          </p>
          <Link
            href="/how-it-works"
            className="text-[10px] text-accent underline-offset-2 hover:underline"
          >
            losing sells are free and bank a credit →
          </Link>
        </div>

        {accountId && credit.data !== undefined && credit.data > 0n && (
          <>
            <Divider />
            <div
              className="min-w-0"
              title="Banked losses. Spent before any profit fee is charged, across every token, with no expiry."
            >
              <p className="text-[10px] font-medium tracking-wide text-secondary uppercase">
                Your loss credit
              </p>
              <p className="num mt-1 text-[15px] leading-tight font-semibold text-accent">
                {usd(credit.data)}
              </p>
            </div>
          </>
        )}
      </div>

      {disagree && (
        <p className="rounded-btn border border-loss/30 bg-loss-dim px-3 py-2 text-[11px] leading-relaxed text-loss">
          The live pool price ({fmtPrice(route!.mid)}) and GeckoTerminal&apos;s indexed price (
          {fmtPrice(stats!.priceUsd)}) disagree by more than a quarter. Trust the pool - it is
          what the swap will actually touch - and treat the chart as stale.
        </p>
      )}

      {isDeployed && !token.registered && (
        <p className="rounded-btn border border-loss/30 bg-loss-dim px-3 py-2 text-[11px] text-loss">
          This token is listed but its storage deposits have not been paid yet, so trading is
          refused on chain. Run <code>register_token</code> for {token.token_id}.
        </p>
      )}
    </div>
  );
}

/** The pool id of the shallowest hop, which is the one that binds. */
function thinnestPool(route: Route): number | string {
  if (route.depths.length === 0) return "—";
  return route.depths.reduce((a, b) => (a.usd <= b.usd ? a : b)).poolId;
}

function Divider() {
  return <span aria-hidden className="hidden h-10 w-px bg-border sm:block" />;
}

function Stat({
  label,
  value,
  sub,
  title,
}: {
  label: string;
  value: string | undefined;
  sub?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <p className="text-[10px] font-medium tracking-wide text-secondary uppercase">{label}</p>
      {value === undefined ? (
        <Skeleton className="mt-1.5 h-4 w-16" />
      ) : (
        <p className="num mt-1 text-[15px] leading-tight font-semibold">{value}</p>
      )}
      {sub && <p className="mt-0.5 text-[10px] leading-tight text-secondary">{sub}</p>}
    </div>
  );
}
