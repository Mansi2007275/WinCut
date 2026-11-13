"use client";

import { Suspense, useMemo, useState } from "react";
import { use } from "react";
import Link from "next/link";

import { Page } from "@/components/Shell";
import { StatsBar } from "@/components/StatsBar";
import { PriceChart } from "@/components/PriceChart";
import { DepthPanel } from "@/components/DepthPanel";
import { OrderPanel } from "@/components/OrderPanel";
import { TradeTabs } from "@/components/TradeTabs";
import { Card, Loading } from "@/components/ui";
import { ContractNote } from "@/components/Gate";
import {
  useCandles,
  useLeaderboard,
  useMyTrades,
  usePoolStats,
  usePoolTrades,
  usePosition,
  useRoute,
  useTokens,
} from "@/lib/queries";
import { useWallet } from "@/lib/wallet";
import { useReferral } from "@/lib/referral";
import { quoteRoute } from "@/lib/rhea";
import type { TimeframeKey } from "@/lib/gecko";
import { toNumber } from "@/lib/format";
import { USDC_DECIMALS } from "@/lib/near";

export default function TradePage({ params }: { params: Promise<{ token: string }> }) {
  const { token: encoded } = use(params);
  const tokenId = decodeURIComponent(encoded);
  return (
    <Suspense fallback={<Page width="full"><Loading label="Loading market" /></Page>}>
      <TradeScreen tokenId={tokenId} />
    </Suspense>
  );
}

function TradeScreen({ tokenId }: { tokenId: string }) {
  const { accountId } = useWallet();
  const { follow, referrer } = useReferral();

  const tokens = useTokens();
  const token = tokens.data?.find((t) => t.token_id === tokenId);

  const [timeframe, setTimeframe] = useState<TimeframeKey>("15m");
  const [followed, setFollowed] = useState<string | null>(null);
  const [presetUsd, setPresetUsd] = useState<number | undefined>();

  // `?follow=` preselects the copied trader for this visit only - it is never
  // remembered, because copying is a decision per trade.
  const effectiveFollowed = followed ?? follow ?? null;

  const route = useRoute(token);
  const stats = usePoolStats(token?.chart_pool, token?.token_id);
  const candles = useCandles(token?.chart_pool, timeframe, stats.data?.side);
  const poolTrades = usePoolTrades(token?.chart_pool, stats.data?.side);
  const position = usePosition(accountId, token?.token_id);
  const myTrades = useMyTrades(accountId, 100);
  const board = useLeaderboard(25);

  const overlay = useMemo(() => {
    const amount = BigInt(position.data?.amount ?? 0);
    const basis = BigInt(position.data?.cost_basis_usdc ?? 0);
    const decimals = token?.decimals ?? 18;

    const entryPrice =
      amount > 0n ? toNumber(basis, USDC_DECIMALS) / toNumber(amount, decimals) : undefined;

    // Break-even is not the entry price. Getting the basis back out means
    // paying Rhea's pool fee on the way, so the price has to be that much
    // higher before a sale actually returns what was put in.
    let breakEvenPrice: number | undefined;
    if (amount > 0n && route.data) {
      const proceeds = quoteRoute(amount, route.data.sell);
      if (proceeds > 0n) {
        const realised = toNumber(proceeds, USDC_DECIMALS) / toNumber(amount, decimals);
        const slip = route.data.mid > 0 ? realised / route.data.mid : 1;
        breakEvenPrice = entryPrice !== undefined && slip > 0 ? entryPrice / slip : undefined;
      }
    }

    return {
      entryPrice,
      breakEvenPrice,
      trades: myTrades.data?.filter((t) => t.token_id === tokenId),
      tokenDecimals: decimals,
    };
  }, [position.data, token?.decimals, route.data, myTrades.data, tokenId]);

  if (tokens.isPending) {
    return (
      <Page width="full">
        <Loading label="Loading markets" />
      </Page>
    );
  }

  if (!token) {
    return (
      <Page width="lg">
        <Card className="p-4">
          <h1 className="text-sm font-semibold">That token is not listed on WinCut</h1>
          <p className="mt-1.5 text-[11px] leading-relaxed text-secondary">
            <code className="text-text">{tokenId}</code> has no route on the contract, so there is
            no way to trade it here. The listed markets are on{" "}
            <Link href="/trade" className="text-accent hover:underline">
              the markets page
            </Link>
            .
          </p>
        </Card>
      </Page>
    );
  }

  return (
    <Page width="full">
      <StatsBar
        token={token}
        route={route.data}
        stats={stats.data}
        statsError={stats.isError}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          <PriceChart
            candles={candles.data}
            loading={candles.isPending && !!stats.data}
            error={candles.isError ? (candles.error as Error).message : null}
            timeframe={timeframe}
            onTimeframe={setTimeframe}
            symbol={token.symbol}
            overlay={overlay}
            side={stats.data?.side}
          />
          <div className="hidden xl:block">
            <TradeTabs token={token} followed={effectiveFollowed} />
          </div>
        </div>

        <div className="min-w-0">
          <DepthPanel
            route={route.data}
            trades={poolTrades.data}
            tokenSymbol={token.symbol}
            onPickSize={setPresetUsd}
          />
        </div>

        <div className="min-w-0">
          <OrderPanel
            token={token}
            route={route.data}
            position={position.data}
            traders={board.data}
            followed={effectiveFollowed}
            onFollowedChange={setFollowed}
            referrer={referrer}
            presetUsd={presetUsd}
          />
          <div className="mt-3">
            <ContractNote />
          </div>
        </div>

        <div className="xl:hidden">
          <TradeTabs token={token} followed={effectiveFollowed} />
        </div>
      </div>
    </Page>
  );
}
