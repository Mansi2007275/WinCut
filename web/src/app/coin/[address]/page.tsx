"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { isAddress, type Address } from "viem";
import { Page } from "@/components/Shell";
import {
  AddressLink,
  Badge,
  Card,
  Empty,
  ErrorBox,
  Row,
  SkeletonRows,
  StatTile,
  TxLink,
} from "@/components/ui";
import { PriceChart } from "@/components/PriceChart";
import { TradePanel, type TradeResult, reason } from "@/components/TradePanel";
import { Result } from "@/components/Result";
import { useCoins, useCoinStats, useHead, usePosition, useTrades } from "@/lib/data";
import { isDeployed } from "@/lib/chain";
import { useReferral } from "@/lib/referral";
import { useAccount } from "wagmi";
import { ago, coins as fmtCoins, price as fmtPrice, usd } from "@/lib/format";

export default function CoinPage() {
  return (
    <Suspense
      fallback={
        <Page>
          <SkeletonRows rows={3} height="h-32" />
        </Page>
      }
    >
      <CoinScreen />
    </Suspense>
  );
}

function CoinScreen() {
  const params = useParams<{ address: string }>();
  const raw = params?.address ?? "";
  const target = isAddress(raw) ? (raw as Address) : undefined;

  const coinsQ = useCoins();
  const { follow, referrer } = useReferral();
  const { address } = useAccount();
  const head = useHead();
  const [result, setResult] = useState<TradeResult | null>(null);

  const coin = useMemo(
    () => coinsQ.data?.find((c) => c.address.toLowerCase() === target?.toLowerCase()),
    [coinsQ.data, target],
  );

  const { stats, series, isLoading: statsLoading } = useCoinStats(coin);
  const position = usePosition(address, coin?.poolId);
  const trades = useTrades();

  const poolTrades = useMemo(
    () => (trades.data ?? []).filter((t) => t.poolId === coin?.poolId).slice(0, 15),
    [trades.data, coin?.poolId],
  );

  if (!target) {
    return (
      <Page>
        <ErrorBox title="Not a valid address" detail={raw} />
      </Page>
    );
  }

  if (!isDeployed) {
    return (
      <Page>
        <Empty title="Waiting on a deployment" />
      </Page>
    );
  }

  if (coinsQ.isLoading) {
    return (
      <Page>
        <SkeletonRows rows={3} height="h-32" />
      </Page>
    );
  }

  if (coinsQ.error) {
    return (
      <Page>
        <ErrorBox title="Cannot reach Arc" detail={reason(coinsQ.error)} />
      </Page>
    );
  }

  if (!coin) {
    return (
      <Page>
        <Empty
          title="Coin not found"
          hint="This address was not launched through the WinCut launcher on this chain."
        />
        <Link href="/" className="text-center font-display text-xs uppercase underline">
          Back to Discover
        </Link>
      </Page>
    );
  }

  if (result) {
    return (
      <Page>
        <Result result={result} onDone={() => setResult(null)} />
      </Page>
    );
  }

  const change = stats?.changePct;
  const pos = position.data;

  return (
    <Page>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl uppercase leading-none">{coin.symbol}</h1>
          <p className="truncate text-xs text-muted">{coin.name}</p>
          <p className="mt-1">
            <AddressLink address={coin.address} tight className="text-[10px]" />
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="money text-xl leading-none">{fmtPrice(stats?.price ?? 0)}</p>
          {change !== null && change !== undefined && (
            <p className={`money text-xs ${change >= 0 ? "text-[#00a152]" : "text-[#d32f45]"}`}>
              {change >= 0 ? "+" : ""}
              {change.toFixed(1)}% since launch
            </p>
          )}
        </div>
      </div>

      <PriceChart series={series} loading={statsLoading} />
      <p className="font-mono text-[10px] leading-snug text-muted">
        Drawn from the PoolManager&apos;s own Swap events — the pool price after each swap, not an
        average fill.
      </p>

      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Volume" value={usd(stats?.volumeQuote)} />
        <StatTile label="Holders" value={stats?.holders ?? "—"} />
        <StatTile label="Swaps" value={stats?.swaps ?? "—"} />
      </div>

      {pos && pos.amount > 0n && (
        <Card tone="info" className="p-4 text-white">
          <p className="mb-1 font-display text-xs uppercase">Your position</p>
          <Row label="Holding" value={`${fmtCoins(pos.amount)} ${coin.symbol}`} />
          <Row label="Cost basis" value={usd(pos.cost)} />
          <p className="mt-1 font-mono text-[10px] leading-snug">
            The hook tracks this on chain. Your fee on exit is 10% of whatever you make above this
            basis, and nothing at all if you are below it.
          </p>
        </Card>
      )}

      <TradePanel
        coin={coin}
        follow={follow}
        referrer={referrer}
        onResult={setResult}
      />

      {/* --------------------------- recent trades --------------------------- */}
      <div className="mt-2">
        <h2 className="mb-2 text-lg uppercase">Recent trades</h2>
        {trades.isLoading ? (
          <SkeletonRows rows={3} height="h-14" />
        ) : poolTrades.length === 0 ? (
          <Empty title="No trades yet. Be the first." />
        ) : (
          <div className="flex flex-col gap-2">
            {poolTrades.map((t) => {
              const win = (t.pnl ?? 0n) > 0n;
              return (
                <Card key={`${t.tx}-${t.kind}-${t.block}`} className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2">
                        <Badge tone={t.kind === "buy" ? "brand" : win ? "profit" : "white"}>
                          {t.kind}
                        </Badge>
                        <Link href={`/trader/${t.trader}`} className="font-mono text-[11px] underline">
                          {t.trader.slice(0, 6)}…{t.trader.slice(-4)}
                        </Link>
                      </p>
                      <p className="money mt-1 text-xs">
                        {fmtCoins(t.coins)} {coin.symbol} · {usd(t.quoteAmount)}
                      </p>
                      {t.followed && (
                        <p className="mt-0.5 font-mono text-[10px] text-muted">
                          copied <AddressLink address={t.followed} tight />
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      {t.kind === "sell" && (
                        <>
                          <p
                            className={`money text-sm ${
                              (t.pnl ?? 0n) >= 0n ? "text-[#00a152]" : "text-[#d32f45]"
                            }`}
                          >
                            {usd(t.pnl, { sign: true })}
                          </p>
                          <p className="money text-[10px] text-muted">
                            fee {usd(t.fee)}
                            {(t.fee ?? 0n) === 0n && " · free"}
                          </p>
                        </>
                      )}
                      <p className="font-mono text-[10px] text-muted">{ago(t.block, head.data)}</p>
                      <TxLink hash={t.tx} />
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </Page>
  );
}
