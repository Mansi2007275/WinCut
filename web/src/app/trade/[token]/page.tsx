"use client";

import { Suspense, useMemo, useState } from "react";
import { use } from "react";
import Link from "next/link";

import { Page } from "@/components/Shell";
import { StatsBar } from "@/components/StatsBar";
import { PriceChart } from "@/components/PriceChart";
import { MIRROR_MARKET_NOTE, MIRROR_MARKET_WHY, isMirrorMarket } from "@/lib/bots";
import { useActivity } from "@/lib/queries";
import { DepthPanel } from "@/components/DepthPanel";
import { OrderPanel } from "@/components/OrderPanel";
import { TradeTabs } from "@/components/TradeTabs";
import { Badge, Card, Loading } from "@/components/ui";
import { ContractNote } from "@/components/Gate";
import {
  useCandles,
  useLeaderboard,
  useOnChainCandles,
  seriesPoolFor,
  useMyTrades,
  usePoolStats,
  usePoolTrades,
  usePosition,
  useMarket,
  useRoute,
} from "@/lib/queries";
import { useWallet } from "@/lib/wallet";
import { useReferral } from "@/lib/referral";
import { quoteRoute } from "@/lib/rhea";
import type { TimeframeKey } from "@/lib/gecko";
import { toNumber } from "@/lib/format";
import { CHARTS_AVAILABLE, USDC_DECIMALS } from "@/lib/near";

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

  const market = useMarket(tokenId);
  const token = market.token;

  const [timeframe, setTimeframe] = useState<TimeframeKey>("15m");
  const [followed, setFollowed] = useState<string | null>(null);
  const [presetUsd, setPresetUsd] = useState<number | undefined>();

  // `?follow=` preselects the copied trader for this visit only - it is never
  // remembered, because copying is a decision per trade.
  const effectiveFollowed = followed ?? follow ?? null;

  const route = useRoute(token);
  const stats = usePoolStats(token?.chart_pool, token?.token_id);

  // Mainnet gets its candles from GeckoTerminal. Testnet has no indexer, so
  // WinCut serves candles it folded from prices it read off the chain itself.
  const seriesPool = seriesPoolFor(token);
  const gtCandles = useCandles(token?.chart_pool, timeframe, stats.data?.side);
  const onChain = useOnChainCandles(seriesPool, timeframe, !CHARTS_AVAILABLE);
  const activity = useActivity(token?.token_id, seriesPool, !CHARTS_AVAILABLE);
  const candles = CHARTS_AVAILABLE ? gtCandles : onChain;
  const candleData = CHARTS_AVAILABLE ? gtCandles.data : onChain.data?.candles;

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

  if (market.pending) {
    return (
      <Page width="full">
        <Loading label="Loading market" />
      </Page>
    );
  }

  // Not the same page as "not listed", and it must not look like one. The
  // contract could not be reached, so whether this token exists is unknown -
  // and a page that guesses "it does not" while an endpoint is rate-limiting
  // is telling the user something it has no evidence for.
  if (market.unreachable) {
    return (
      <Page width="lg">
        <Card className="p-4">
          <h1 className="text-sm font-semibold">Could not reach a NEAR endpoint</h1>
          <p className="mt-1.5 text-[11px] leading-relaxed text-secondary">
            Every read endpoint refused, so WinCut cannot tell you whether{" "}
            <code className="text-text">{tokenId}</code> is listed. This is usually a rate limit
            on a free endpoint and clears within a minute — it is not a statement about the
            market.
          </p>
          {market.error && (
            <p className="mt-1.5 break-words text-[10px] leading-relaxed text-secondary">
              {market.error.message}
            </p>
          )}
          <button
            onClick={market.refetch}
            className="tap mt-3 rounded-btn border border-border px-3 py-1.5 text-[12px] font-medium hover:bg-elevated"
          >
            Try again
          </button>
        </Card>
      </Page>
    );
  }

  if (!token) {
    return (
      <Page width="lg">
        <Card className="p-4">
          <h1 className="text-sm font-semibold">That token is not listed on WinCut</h1>
          <p className="mt-1.5 text-[11px] leading-relaxed text-secondary">
            The contract was read and has no route for{" "}
            <code className="text-text">{tokenId}</code>, so there is no way to trade it here. The
            listed markets are on{" "}
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
        activity={activity.data}
      />

      {isMirrorMarket(token.token_id) && (
        <Card className="border-accent/30 p-3">
          <div className="flex items-start gap-2">
            <Badge tone="accent">WinCut-operated market</Badge>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-secondary">{MIRROR_MARKET_NOTE}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-secondary">{MIRROR_MARKET_WHY}</p>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          <PriceChart
            candles={candleData}
            loading={candles.isPending && (CHARTS_AVAILABLE ? !!stats.data : !!seriesPool)}
            error={candles.isError ? (candles.error as Error).message : null}
            timeframe={timeframe}
            onTimeframe={setTimeframe}
            symbol={token.symbol}
            overlay={overlay}
            side={CHARTS_AVAILABLE ? stats.data?.side : "base"}
            collectingSince={onChain.data?.collectingSince ?? null}
            points={onChain.data?.points ?? 0}
          />
          <div className="hidden xl:block">
            <TradeTabs token={token} followed={effectiveFollowed} />
          </div>
        </div>

        <div className="min-w-0">
          <DepthPanel
            activity={activity.data}
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
