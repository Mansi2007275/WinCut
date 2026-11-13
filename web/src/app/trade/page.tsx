"use client";

/**
 * The market list: every token the contract has a verified Rhea route for,
 * with its live price from the pool reserves and its 24h figures from
 * GeckoTerminal.
 *
 * A token whose storage deposits have not been paid is shown but marked, not
 * hidden - the contract will refuse the trade and the user deserves to know
 * why before they click into it.
 */

import Link from "next/link";

import { Page } from "@/components/Shell";
import { Card, Empty, SkeletonRows } from "@/components/ui";
import { MarketRow } from "@/components/MarketRow";
import { useAllPoolStats, useTokens } from "@/lib/queries";

export default function MarketsPage() {
  const tokens = useTokens();
  const stats = useAllPoolStats(tokens.data);

  return (
    <Page width="lg">
      <header>
        <h1 className="text-lg font-semibold">Markets</h1>
        <p className="mt-1 text-[11px] leading-relaxed text-secondary">
          Every market routes through Rhea on NEAR mainnet. Buying costs no WinCut fee at all;
          selling costs 10% of your profit, and nothing if there is none.
        </p>
      </header>

      {tokens.isPending ? (
        <SkeletonRows rows={5} height="h-16" />
      ) : tokens.isError ? (
        <Card tone="loss" className="p-3">
          <p className="text-xs font-semibold text-loss">Could not read the contract</p>
          <p className="mt-1 text-[11px] break-words text-secondary">
            {(tokens.error as Error).message}
          </p>
        </Card>
      ) : !tokens.data?.length ? (
        <Empty
          title="No tokens listed yet"
          hint="Run list_token and register_token for each market. scripts/print-deploy-commands.mjs prints the exact calls with the verified pool ids."
        />
      ) : (
        <Card className="p-0">
          <ul className="flex flex-col divide-y divide-border">
            {tokens.data.map((token) => (
              <li key={token.token_id}>
                <Link
                  href={`/trade/${encodeURIComponent(token.token_id)}`}
                  className="block transition-colors hover:bg-elevated"
                >
                  <MarketRow token={token} stats={stats.data?.get(token.chart_pool)} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}
