"use client";

/**
 * One market in a list. Price comes from the live Rhea reserves so it matches
 * what the trade screen will quote; the 24h figures come from GeckoTerminal,
 * which is the only source that has them.
 *
 * A pool too thin to trade sensibly says so. Hiding it would be tidier and
 * less honest - the market is real, it is just small.
 */

import type { TokenConfig } from "@/lib/contract";
import type { PoolStats } from "@/lib/gecko";
import { useRoute } from "@/lib/queries";
import { isDeployed } from "@/lib/near";
import { price as fmtPrice, pct, usdCompact } from "@/lib/format";
import { Avatar, Badge, Skeleton } from "./ui";

export function MarketRow({
  token,
  stats,
}: {
  token: TokenConfig;
  stats: PoolStats | undefined;
}) {
  const route = useRoute(token);
  // Judged on the route's thinnest pool, which is the one a trade bottlenecks on.
  const thin = route.data !== undefined && route.data.liquidityUsd < 25_000;

  return (
    <div className="flex items-center gap-3 px-3 py-3">
      <Avatar address={token.symbol.toLowerCase()} size={32} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold">{token.symbol}</span>
          {isDeployed && !token.registered && <Badge tone="loss">not tradable</Badge>}
          {thin && <Badge tone="neutral">thin pool</Badge>}
        </div>
        <p className="mt-0.5 truncate text-[10px] text-secondary">
          {token.hops.length > 1 ? `USDC → wNEAR → ${token.symbol}` : "USDC → wNEAR"} ·{" "}
          {route.data ? `${usdCompact(route.data.liquidityUsd)} usable` : "…"}
        </p>
      </div>

      <div className="shrink-0 text-right">
        {route.data ? (
          <span className="num block text-[14px] font-semibold">{fmtPrice(route.data.mid)}</span>
        ) : (
          <Skeleton className="h-4 w-16" />
        )}
        <span className="block text-[10px]">
          {stats && Number.isFinite(stats.change24hPct) ? (
            <span className={`num ${stats.change24hPct >= 0 ? "text-profit" : "text-loss"}`}>
              {pct(stats.change24hPct)}
            </span>
          ) : (
            <span className="text-secondary">24h —</span>
          )}
          {stats && Number.isFinite(stats.volume24hUsd) && (
            <span className="num ml-1.5 text-secondary">
              {usdCompact(stats.volume24hUsd)} vol
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
