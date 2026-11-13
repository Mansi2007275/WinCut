"use client";

/**
 * The leaderboard, ranked by realised profit.
 *
 * Realised, not open: a paper gain on an untouched position is not a result,
 * and ranking by it would reward holding rather than trading. Everything here
 * comes from the contract's own per-trader stats, which are written in the
 * settlement callback.
 */

import Link from "next/link";

import { Page } from "@/components/Shell";
import { LeaderboardList, TradeList } from "@/components/TradeTabs";
import { Card, Empty, SectionHeading, SkeletonRows, StatTile } from "@/components/ui";
import { NeedsContract } from "@/components/Gate";
import { useConfig, useLeaderboard, useRecentTrades } from "@/lib/queries";
import { isDeployed } from "@/lib/near";
import { usd } from "@/lib/format";

export default function BoardPage() {
  const board = useLeaderboard(50);
  const trades = useRecentTrades(60);
  const config = useConfig();

  const totals = (() => {
    const list = trades.data ?? [];
    const sells = list.filter((t) => t.side === "Sell");
    const fees = sells.reduce((a, t) => a + BigInt(t.fee), 0n);
    const free = sells.filter((t) => BigInt(t.fee) === 0n).length;
    return { sells: sells.length, fees, free };
  })();

  return (
    <Page width="lg">
      <header>
        <h1 className="text-lg font-semibold">Traders</h1>
        <p className="mt-1 text-[11px] leading-relaxed text-secondary">
          Ranked by realised profit. Copy one from any trade screen and they earn 50% of the fee
          on your winning exits - and nothing on the rest.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          label="Trades settled"
          value={config.data ? String(config.data.total_trades) : "…"}
          sub="all time, on chain"
        />
        <StatTile
          label="Recent sells"
          value={trades.data ? String(totals.sells) : "…"}
          sub={`of the last ${trades.data?.length ?? 0} trades`}
        />
        <StatTile
          label="Charged nothing"
          tone="profit"
          value={trades.data ? String(totals.free) : "…"}
          sub="losing or sheltered sells"
        />
        <StatTile
          label="Fees on those"
          value={trades.data ? usd(totals.fees) : "…"}
          sub="10% of profit only"
        />
      </div>

      <section className="flex flex-col gap-2">
        <SectionHeading>Leaderboard</SectionHeading>
        {!isDeployed ? (
          <NeedsContract what="the leaderboard" />
        ) : board.isPending ? (
          <SkeletonRows rows={6} height="h-14" />
        ) : board.isError ? (
          <Card tone="loss" className="p-3">
            <p className="text-xs font-semibold text-loss">Could not read the contract</p>
            <p className="mt-1 text-[11px] break-words text-secondary">
              {(board.error as Error).message}
            </p>
          </Card>
        ) : !board.data?.length ? (
          <Empty
            title="Nobody has closed a position yet"
            hint="The board fills from realised results, so it stays empty until the first sell settles."
          />
        ) : (
          <Card className="px-3 py-1">
            <LeaderboardList rows={board.data} />
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <SectionHeading
          right={
            <Link href="/trade" className="text-[11px] text-accent hover:underline">
              markets →
            </Link>
          }
        >
          Everything WinCut has settled
        </SectionHeading>
        {!isDeployed ? (
          <NeedsContract what="settled trades" />
        ) : trades.isPending ? (
          <SkeletonRows rows={5} height="h-12" />
        ) : !trades.data?.length ? (
          <Empty
            title="No trades yet"
            hint="The contract keeps the last 500 on chain; older ones stay in the NEP-297 event log."
          />
        ) : (
          <Card className="px-3 py-1">
            <TradeList trades={trades.data} showWho />
          </Card>
        )}
      </section>
    </Page>
  );
}
