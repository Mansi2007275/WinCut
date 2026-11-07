"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { isAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { Page } from "@/components/Shell";
import {
  AddressLink,
  Avatar,
  Badge,
  Button,
  Card,
  Chip,
  Empty,
  ErrorBox,
  Row,
  SectionHeading,
  SkeletonRows,
  StatTile,
  TxLink,
  useFlash,
} from "@/components/ui";
import { PriceChart, TIMEFRAMES, windowed, type Timeframe } from "@/components/PriceChart";
import { TradeSheet } from "@/components/TradeSheet";
import { type TradeResult, reason } from "@/components/TradePanel";
import { Result } from "@/components/Result";
import { useCoins, useCoinStats, useHead, usePosition, useTrades } from "@/lib/data";
import { deployed, explorerAddr, isDeployed, QUOTE } from "@/lib/chain";
import { useReferral } from "@/lib/referral";
import { useWatchlist } from "@/lib/watchlist";
import { ago, coins as fmtCoins, price as fmtPrice, short, usd } from "@/lib/format";

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
  const { has: watched, toggle: toggleWatch } = useWatchlist();

  const [result, setResult] = useState<TradeResult | null>(null);
  const [sheet, setSheet] = useState<"buy" | "sell" | null>(null);
  const [tf, setTf] = useState<Timeframe>("ALL");
  /// The price under the crosshair, if the pointer is on the chart.
  const [hovered, setHovered] = useState<number | undefined>();

  const coin = useMemo(
    () => coinsQ.data?.find((c) => c.address.toLowerCase() === target?.toLowerCase()),
    [coinsQ.data, target],
  );

  const { stats, series, isLoading: statsLoading } = useCoinStats(coin);
  const position = usePosition(address, coin?.poolId);
  const trades = useTrades();

  const shown = useMemo(() => windowed(series, tf), [series, tf]);

  const poolTrades = useMemo(
    () => (trades.data ?? []).filter((t) => t.poolId === coin?.poolId).slice(0, 15),
    [trades.data, coin?.poolId],
  );

  const livePrice = stats?.price ?? 0;
  const flash = useFlash(livePrice);

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
        <Link href="/" className="text-center text-sm text-accent underline-offset-2">
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
      {/* -------------------------------------------------------- header */}
      <div className="flex items-center gap-3">
        <Link
          href="/"
          aria-label="Back to Discover"
          className="tap flex w-10 shrink-0 items-center justify-center rounded-pill border border-border bg-surface text-secondary transition-colors hover:text-text"
        >
          ‹
        </Link>
        <Avatar address={coin.address} size={34} />
        <div className="min-w-0 flex-1">
          <p className="text-base leading-tight font-semibold">{coin.symbol}</p>
          <p className="num truncate text-[11px] text-secondary">
            <AddressLink address={coin.address} tight />
          </p>
        </div>
        <button
          onClick={() => toggleWatch(coin.address)}
          aria-label={watched(coin.address) ? "Remove from watchlist" : "Add to watchlist"}
          aria-pressed={watched(coin.address)}
          className={`tap flex w-10 shrink-0 items-center justify-center rounded-btn border border-border bg-surface transition-colors ${
            watched(coin.address) ? "text-accent" : "text-secondary hover:text-text"
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
            <path
              d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 9.7l5.4-.8L12 4Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
              fill={watched(coin.address) ? "currentColor" : "none"}
            />
          </svg>
        </button>
      </div>

      {/* --------------------------------------------------- price + chart */}
      <div>
        <p className={`num text-[32px] leading-none font-semibold ${flash}`}>
          {fmtPrice(hovered ?? livePrice)}
        </p>
        <p className="mt-1.5 flex items-center gap-2 text-xs">
          {change !== null && change !== undefined && (
            <span className={`num font-medium ${change >= 0 ? "text-profit" : "text-loss"}`}>
              {change >= 0 ? "+" : ""}
              {change.toFixed(1)}% since launch
            </span>
          )}
          {hovered !== undefined && <span className="text-secondary">at crosshair</span>}
        </p>
      </div>

      <PriceChart series={shown} loading={statsLoading} onHover={setHovered} />

      <div className="flex items-center justify-between gap-2">
        <p className="num text-[11px] text-secondary">
          Launch {fmtPrice(stats?.launchPrice ?? 0)} · Peak {fmtPrice(stats?.peakPrice ?? 0)}
        </p>
        <div className="flex gap-1">
          {TIMEFRAMES.map((t) => (
            <Chip
              key={t}
              active={tf === t}
              onClick={() => setTf(t)}
              className="min-h-0 px-2.5 py-1 text-[11px]"
            >
              {t}
            </Chip>
          ))}
        </div>
      </div>

      <p className="text-[11px] leading-snug text-secondary">
        Each point is the price a real trade executed at, read from the hook&apos;s own Bought and
        Sold events — last traded price, not a pool mid-price.
      </p>

      {/* -------------------------------------------------------- stats */}
      <div className="grid grid-cols-2 gap-2">
        <StatTile label="Volume" value={usd(stats?.volumeQuote)} />
        <StatTile label="Holders" value={stats?.holders ?? "—"} />
        <StatTile label="Swaps" value={stats?.swaps ?? "—"} />
        <StatTile
          label="Market cap"
          value={
            stats?.marketCap === undefined
              ? "—"
              : `$${stats.marketCap.toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}`
          }
          sub="price × fixed supply"
        />
      </div>

      {/* --------------------------------------------------- your position */}
      {pos && pos.amount > 0n && (
        <Card tone="accent" className="p-4">
          <p className="mb-1 text-sm font-semibold text-accent">Your position</p>
          <Row label="Holding" value={`${fmtCoins(pos.amount)} ${coin.symbol}`} />
          <Row label="Cost basis" value={usd(pos.cost)} />
          <p className="mt-1.5 text-[11px] leading-snug text-secondary">
            The hook tracks this on chain. Your fee on exit is 10% of whatever you make above this
            basis, and nothing at all if you are below it.
          </p>
        </Card>
      )}

      {/* ---------------------------------------------------- the v4 pool */}
      <Card className="p-4">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <p className="text-sm font-semibold">Pool</p>
          <p className="text-[11px] text-secondary">Uniswap v4 · {deployed.chainName}</p>
        </div>
        <Row
          label="Pair"
          value={
            <span className="text-accent">
              {coin.symbol} / {QUOTE.symbol} ({QUOTE.isNative ? "native" : "ERC-20"})
            </span>
          }
        />
        <Row
          label="Fee tier · tick spacing"
          value={`${(deployed.pool.fee / 10_000).toFixed(2)}% · ${deployed.pool.tickSpacing}`}
        />
        <Row
          label="Hook"
          value={
            <a
              href={explorerAddr(coin.poolKey.hooks)}
              target="_blank"
              rel="noreferrer"
              className="num text-accent underline-offset-2 hover:underline"
            >
              {short(coin.poolKey.hooks)} ↗
            </a>
          }
        />
        <Row label="Seed liquidity" value={<span className="text-profit">Locked forever</span>} />
        <p className="mt-2 text-[11px] leading-snug text-secondary">
          The hook&apos;s permission bits are fixed in its address and end in{" "}
          <span className="num text-text">0x2044</span>.{" "}
          <Link href="/how-it-works" className="text-accent underline-offset-2 hover:underline">
            What that means
          </Link>
        </p>
      </Card>

      {/* ------------------------------------------------- recent trades */}
      <section className="flex flex-col gap-2 pb-20">
        <SectionHeading>Recent trades</SectionHeading>
        {trades.isPending ? (
          <SkeletonRows rows={3} height="h-14" />
        ) : poolTrades.length === 0 ? (
          <Empty title="No trades yet. Be the first." />
        ) : (
          <Card className="divide-y divide-border">
            {poolTrades.map((t) => (
              <div
                key={`${t.tx}-${t.kind}-${t.block}`}
                className="flex items-center gap-3 p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[13px]">
                    <span
                      className={`font-semibold ${t.kind === "sell" ? "text-loss" : "text-profit"}`}
                    >
                      {t.kind === "sell" ? "Sell" : "Buy"}
                    </span>
                    <Link
                      href={`/trader/${t.trader}`}
                      className="num truncate text-secondary underline-offset-2 hover:text-text"
                    >
                      {short(t.trader)}
                    </Link>
                  </p>
                  <p className="num mt-0.5 text-[11px] text-secondary">
                    {fmtCoins(t.coins)} {coin.symbol} · {ago(t.block, head.data)} ·{" "}
                    <TxLink hash={t.tx}>explorer ↗</TxLink>
                  </p>
                  {t.followed && (
                    <p className="mt-0.5 text-[11px] text-secondary">
                      copied <AddressLink address={t.followed} tight />
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="num text-sm font-semibold">{usd(t.quoteAmount)}</p>
                  {t.kind === "sell" && (
                    <p
                      className={`num text-[11px] ${
                        (t.pnl ?? 0n) >= 0n ? "text-profit" : "text-loss"
                      }`}
                    >
                      {usd(t.pnl, { sign: true })}
                      {(t.fee ?? 0n) === 0n ? " · fee $0" : ` · fee ${usd(t.fee)}`}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </Card>
        )}
      </section>

      {/* ------------------------------------------------ sticky actions */}
      <div
        className="fixed inset-x-0 bottom-[72px] z-30 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur"
        style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto flex max-w-md gap-2">
          <Button tone="profit" className="flex-1 py-3.5 text-base" onClick={() => setSheet("buy")}>
            Buy
          </Button>
          <Button
            tone="elevated"
            className="flex-1 py-3.5 text-base"
            onClick={() => setSheet("sell")}
          >
            Sell
          </Button>
        </div>
      </div>

      {coin && (
        <TradeSheet
          open={sheet !== null}
          side={sheet ?? "buy"}
          coin={coin}
          follow={follow}
          referrer={referrer}
          onClose={() => setSheet(null)}
          onResult={(r) => {
            setSheet(null);
            setResult(r);
          }}
        />
      )}

      {follow && (
        <div className="fixed inset-x-0 bottom-[132px] z-30 px-4">
          <div className="mx-auto max-w-md">
            <Badge tone="accent">Copying {short(follow)} — they earn only if you profit</Badge>
          </div>
        </div>
      )}
    </Page>
  );
}
