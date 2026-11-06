"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { Page } from "@/components/Shell";
import {
  AddressLink,
  Badge,
  Button,
  Card,
  Chip,
  Empty,
  ErrorBox,
  SkeletonRows,
  StatTile,
  TxLink,
} from "@/components/ui";
import { FaucetLink } from "@/components/NetworkGate";
import { useToast } from "@/components/Toast";
import { useCoins, useCoinStats, useHead, useLeaderboard, useTrades, type Coin } from "@/lib/data";
import { isDeployed } from "@/lib/chain";
import { useReferral } from "@/lib/referral";
import { buyCoin } from "@/lib/trade";
import { reason } from "@/components/TradePanel";
import { ago, coins as fmtCoins, price as fmtPrice, usd } from "@/lib/format";

export default function DiscoverPage() {
  return (
    <Suspense
      fallback={
        <Page>
          <SkeletonRows rows={4} height="h-28" />
        </Page>
      }
    >
      <Discover />
    </Suspense>
  );
}

function Discover() {
  const coinsQ = useCoins();
  const trades = useTrades();
  const head = useHead();
  const { rows } = useLeaderboard();

  const totalFees = useMemo(
    () => (trades.data ?? []).reduce((s, t) => s + (t.fee ?? 0n), 0n),
    [trades.data],
  );
  const freeExits = useMemo(
    () => (trades.data ?? []).filter((t) => t.kind === "sell" && (t.fee ?? 0n) === 0n).length,
    [trades.data],
  );
  const dumpers = (rows ?? []).filter((r) => r.isDumper).length;

  if (!isDeployed) {
    return (
      <Page>
        <Empty
          title="Waiting on a deployment"
          hint="Once the contracts are live on Arc testnet, every coin and trade on this screen is read straight from the chain."
        />
      </Page>
    );
  }

  if (coinsQ.isLoading) {
    return (
      <Page>
        <SkeletonRows rows={4} height="h-28" />
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

  return (
    <Page>
      {/* The pitch, stated once, with real numbers behind it. */}
      <Card tone="accent" className="p-4">
        <p className="font-display text-base uppercase leading-tight">
          Every trading app gets paid when you lose. We don&apos;t.
        </p>
        <p className="mt-1 text-xs leading-snug">
          10% of your <em>profit</em> only. A losing exit costs $0 and banks a credit against your
          next win.
        </p>
        {/* The full log scan takes a few seconds. Until it lands these are all
            zero, and rendering that reads as "WinCut has never charged a fee"
            rather than "still counting" -- the same confidently-wrong-number
            problem as the dropped log windows. Show a dash instead. */}
        <div className="mt-3 grid grid-cols-3 gap-2">
          <StatTile label="Fees charged" value={trades.isPending ? "…" : usd(totalFees)} />
          <StatTile
            label="Free exits"
            value={trades.isPending ? "…" : freeExits}
            sub="charged $0"
          />
          <StatTile
            label="Dumpers"
            value={trades.isPending ? "…" : dumpers}
            tone={dumpers ? "loss" : "text"}
          />
        </div>
      </Card>

      {!coinsQ.data?.length ? (
        <>
          <Empty
            title="No coins yet. Be the first."
            hint="Nothing here is seeded. This list only ever shows coins launched by real wallets on Arc testnet."
          />
          <Link href="/launch">
            <Button tone="accent" className="w-full py-4 text-lg">
              Launch the first coin
            </Button>
          </Link>
          <FaucetLink className="self-center" />
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg uppercase">Coins</h2>
            <span className="font-mono text-[10px] text-muted">
              {coinsQ.data.length} live · block {head.data?.toString() ?? "…"}
            </span>
          </div>
          {coinsQ.data.map((c, i) => (
            <CoinCard key={c.address} coin={c} index={i} head={head.data} />
          ))}
        </div>
      )}
    </Page>
  );
}

function CoinCard({ coin, index, head }: { coin: Coin; index: number; head?: bigint }) {
  const { stats, isLoading } = useCoinStats(coin);
  const trades = useTrades();
  const { follow, referrer } = useReferral();
  const { isConnected } = useAccount();
  const client = usePublicClient();
  const { data: wallet } = useWalletClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const latest = useMemo(
    () => (trades.data ?? []).find((t) => t.poolId === coin.poolId),
    [trades.data, coin.poolId],
  );

  async function quickBuy(dollars: string) {
    if (!wallet || !client) return;
    setBusy(dollars);
    const id = toast.push({
      kind: "pending",
      title: `Buying $${dollars} of ${coin.symbol}`,
      detail: "Approve in your wallet",
    });
    try {
      const { hash } = await buyCoin({
        wallet,
        client,
        poolKey: coin.poolKey,
        amountIn: BigInt(dollars) * 10n ** 18n,
        follow,
        referrer,
        onHash: (h) => toast.update(id, { detail: "Waiting for the block", hash: h }),
      });
      toast.update(id, {
        kind: "confirmed",
        title: `Bought ${coin.symbol}`,
        detail: "No fee on buys",
        hash,
      });
      trades.refetch();
    } catch (e) {
      toast.update(id, { kind: "failed", title: "Buy failed", detail: reason(e) });
    } finally {
      setBusy(null);
    }
  }

  const change = stats?.changePct;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.2), duration: 0.22 }}
    >
      <Card className="p-4">
        <Link href={`/coin/${coin.address}`} className="block">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-display text-lg uppercase leading-none">{coin.symbol}</p>
              <p className="truncate text-xs text-muted">{coin.name}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="money text-base leading-none">
                {isLoading ? "…" : fmtPrice(stats?.price ?? 0)}
              </p>
              {change !== null && change !== undefined && (
                <p className={`money text-xs ${change >= 0 ? "text-[#00a152]" : "text-[#d32f45]"}`}>
                  {change >= 0 ? "+" : ""}
                  {change.toFixed(1)}% since launch
                </p>
              )}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <StatTile label="Volume" value={usd(stats?.volumeQuote)} />
            <StatTile label="Holders" value={stats?.holders ?? "—"} />
            <StatTile label="Swaps" value={stats?.swaps ?? "—"} />
          </div>
        </Link>

        {/* The latest real trade in this pool. No placeholder when there is
            none: a brand new coin genuinely has no trades. */}
        <div className="mt-3 border-t-3 border-ink pt-2">
          {latest ? (
            <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-[10px] text-muted">
              <AddressLink address={latest.trader} tight />
              <span>
                {latest.kind === "buy" ? "bought" : "sold"} {fmtCoins(latest.coins)} for{" "}
                {usd(latest.quoteAmount)}
              </span>
              {latest.kind === "sell" && (
                <span className={(latest.pnl ?? 0n) >= 0n ? "text-[#00a152]" : "text-[#d32f45]"}>
                  {usd(latest.pnl, { sign: true })}
                  {(latest.fee ?? 0n) === 0n && " · fee $0"}
                </span>
              )}
              <span>{ago(latest.block, head)}</span>
              <TxLink hash={latest.tx} />
            </p>
          ) : (
            <p className="font-mono text-[10px] text-muted">
              {trades.isPending ? "Reading trades from chain…" : "No trades yet. Be the first."}
            </p>
          )}
        </div>

        {/* Quick buy. Buys are never charged, so one tap cannot cost a fee the
            user did not see first. */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="font-display text-[10px] uppercase text-muted">Quick buy</span>
          {["10", "50", "100"].map((v) => (
            <Chip
              key={v}
              onClick={isConnected ? () => void quickBuy(v) : undefined}
              active={busy === v}
            >
              {busy === v ? "…" : `$${v}`}
            </Chip>
          ))}
          <Link href={`/coin/${coin.address}`} className="ml-auto">
            <span className="nb-sm nb-press inline-block bg-ink px-3 py-2 font-display text-[10px] uppercase text-brand">
              Trade
            </span>
          </Link>
        </div>
        {!isConnected && (
          <p className="mt-2 font-mono text-[10px] text-muted">
            Connect a wallet to buy. Quick buy sends a real swap on Arc testnet.
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge>creator</Badge>
          <AddressLink address={coin.creator} tight className="text-[10px]" />
          {follow && <Badge tone="accent">copying {follow.slice(0, 6)}…</Badge>}
        </div>
      </Card>
    </motion.div>
  );
}
