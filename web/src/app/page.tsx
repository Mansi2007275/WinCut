"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { useAccount, useBalance, usePublicClient, useWalletClient } from "wagmi";
import { Page } from "@/components/Shell";
import {
  AddressLink,
  Avatar,
  Badge,
  Button,
  Card,
  Chip,
  ColumnHeader,
  Empty,
  ErrorBox,
  Money,
  SectionHeading,
  SkeletonRows,
  Tabs,
  TxLink,
  useFlash,
} from "@/components/ui";
import { FaucetLink } from "@/components/NetworkGate";
import { useToast } from "@/components/Toast";
import { useCoins, useCoinStats, useHead, useLeaderboard, useTrades, type Coin } from "@/lib/data";
import { isDeployed, QUOTE } from "@/lib/chain";
import { useReferral } from "@/lib/referral";
import { useWatchlist } from "@/lib/watchlist";
import { useInView } from "@/lib/useInView";
import { buyCoin } from "@/lib/trade";
import { reason } from "@/components/TradePanel";
import { ago, coins as fmtCoins, price as fmtPrice, short, usd } from "@/lib/format";

type TabId = "trending" | "new" | "traders" | "watchlist";

const TABS = [
  { id: "trending" as const, label: "Trending" },
  { id: "new" as const, label: "New" },
  { id: "traders" as const, label: "Top traders" },
  { id: "watchlist" as const, label: "Watchlist" },
];

export default function DiscoverPage() {
  return (
    <Suspense
      fallback={
        <Page>
          <SkeletonRows rows={4} height="h-24" />
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
  const { address, isConnected } = useAccount();
  const { data: bal } = useBalance({ address });
  const { has: watched } = useWatchlist();

  const [tab, setTab] = useState<TabId>("trending");
  const [query, setQuery] = useState("");

  // Memoised so the ordering/filtering memos below do not re-run every render
  // on a fresh array identity.
  const coins = useMemo(() => coinsQ.data ?? [], [coinsQ.data]);

  /**
   * Ordering is derived, never stored.
   *
   * "Trending" is by swap count in the pool, which is the only activity signal
   * the chain actually gives us. "New" is latest launch first, which is the
   * launcher's own array order reversed.
   */
  const ordered = useMemo(() => {
    const swapsOf = (c: Coin) =>
      (trades.data ?? []).filter((t) => t.poolId === c.poolId).length;
    if (tab === "new") return [...coins].reverse();
    if (tab === "watchlist") return coins.filter((c) => watched(c.address));
    if (tab === "trending") return [...coins].sort((a, b) => swapsOf(b) - swapsOf(a));
    return coins;
  }, [coins, tab, trades.data, watched]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(
      (c) =>
        c.symbol.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.address.toLowerCase().includes(q) ||
        c.creator.toLowerCase().includes(q),
    );
  }, [ordered, query]);

  const traderRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = rows ?? [];
    return q ? all.filter((r) => r.trader.toLowerCase().includes(q)) : all;
  }, [rows, query]);

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

  if (coinsQ.error) {
    return (
      <Page>
        <ErrorBox title="Cannot reach Arc" detail={reason(coinsQ.error)} />
      </Page>
    );
  }

  return (
    <Page>
      {/* Balance. The one number the user needs before they can do anything. */}
      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-secondary">Cash · {QUOTE.symbol} on Arc Testnet</p>
            <p className="num mt-1 text-[28px] leading-none font-semibold">
              {isConnected ? <Money value={bal?.value} /> : "—"}
            </p>
          </div>
          <FaucetLink className="shrink-0 pt-1 text-xs" />
        </div>
      </Card>

      <label className="relative block">
        <span className="sr-only">Search coins or traders</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-secondary"
        >
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search coins or traders"
          className="tap w-full rounded-btn border border-border bg-surface pr-3 pl-9 text-sm outline-none placeholder:text-secondary focus:border-accent/60"
        />
      </label>

      <Tabs options={TABS} value={tab} onChange={setTab} />

      {tab === "traders" ? (
        <TopTraders rows={traderRows} loading={trades.isPending} />
      ) : coinsQ.isLoading ? (
        <SkeletonRows rows={3} height="h-24" />
      ) : !filtered.length ? (
        <EmptyForTab tab={tab} query={query} hasAnyCoin={coins.length > 0} />
      ) : (
        <div className="flex flex-col gap-2">
          <ColumnHeader>
            <span>Coin</span>
            <span className="flex gap-6">
              <span>Price</span>
              <span>Since launch</span>
            </span>
          </ColumnHeader>
          {filtered.map((c, i) => (
            <CoinRow key={c.address} coin={c} index={i} head={head.data} />
          ))}
        </div>
      )}

      <LiveActivity head={head.data} />
    </Page>
  );
}

function EmptyForTab({
  tab,
  query,
  hasAnyCoin,
}: {
  tab: TabId;
  query: string;
  hasAnyCoin: boolean;
}) {
  if (query.trim()) {
    return <Empty title="Nothing matches that" hint="Search by symbol, name, or any address." />;
  }
  if (tab === "watchlist") {
    return (
      <Empty
        title="Nothing starred yet"
        hint="Tap the star on a coin page to keep it here. The list lives in this browser only — there is nothing on chain that records a watchlist."
      />
    );
  }
  if (!hasAnyCoin) {
    return (
      <>
        <Empty
          title="No coins yet. Be the first."
          hint="Nothing here is seeded. This list only ever shows coins launched by real wallets on Arc testnet."
        />
        <Link href="/launch" className="mt-2 block">
          <Button className="w-full py-3.5 text-base">Launch the first coin</Button>
        </Link>
      </>
    );
  }
  return <Empty title="Nothing here yet" />;
}

/* ------------------------------------------------------------- coin rows */

function CoinRow({ coin, index, head }: { coin: Coin; index: number; head?: bigint }) {
  // Rows only fetch once they are near the viewport. Seven coins each doing a
  // full Swap and Transfer scan is over a hundred eth_getLogs at once, which
  // Arc's RPC refuses outright.
  const { ref, seen } = useInView<HTMLDivElement>();
  const { stats, isLoading, error: statsError } = useCoinStats(coin, seen);
  const trades = useTrades();
  const { follow, referrer } = useReferral();
  const { isConnected } = useAccount();
  const client = usePublicClient();
  const { data: wallet } = useWalletClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const flash = useFlash(stats?.price);

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
      ref={ref}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.15), duration: 0.2 }}
    >
      <Card className="overflow-hidden">
        <Link href={`/coin/${coin.address}`} className="block p-3 transition-colors hover:bg-elevated/40">
          <div className="flex items-center gap-3">
            <Avatar address={coin.address} size={36} />
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-tight font-semibold">{coin.symbol}</p>
              <p className="num mt-0.5 truncate text-[11px] text-secondary">
                {statsError ? (
                  <span className="text-loss">Could not reach Arc</span>
                ) : (
                  <>
                    Vol {usd(stats?.volumeQuote)} · {stats?.holders ?? "—"} holder
                    {stats?.holders === 1 ? "" : "s"}
                  </>
                )}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className={`num text-sm leading-tight font-semibold ${flash}`}>
                {statsError ? "—" : isLoading ? "…" : fmtPrice(stats?.price ?? 0)}
              </p>
              {change !== null && change !== undefined && (
                <p
                  className={`num mt-0.5 text-[11px] font-medium ${
                    change >= 0 ? "text-profit" : "text-loss"
                  }`}
                >
                  {change >= 0 ? "+" : ""}
                  {change.toFixed(1)}%
                </p>
              )}
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone="profit">Fee only on profit</Badge>
            <span className="text-[11px] text-secondary">Uniswap v4 pool · WinCut hook</span>
          </div>

          <p className="num mt-1.5 text-[11px] text-secondary">
            Launched by {short(coin.creator)}
            {stats?.launchBlock !== undefined && head !== undefined && (
              <> · {ago(stats.launchBlock, head)}</>
            )}
          </p>
        </Link>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
          <span className="text-[11px] text-secondary">Quick buy</span>
          {["10", "50", "100"].map((v) => (
            <Chip
              key={v}
              onClick={isConnected ? () => void quickBuy(v) : undefined}
              active={busy === v}
              className="px-3 text-xs"
            >
              {busy === v ? "…" : `$${v}`}
            </Chip>
          ))}
          <Link href={`/coin/${coin.address}`} className="ml-auto">
            <span className="tap flex items-center rounded-btn bg-accent px-3 text-xs font-semibold text-white">
              Trade
            </span>
          </Link>
        </div>

        {!isConnected && (
          <p className="border-t border-border px-3 py-2 text-[11px] text-secondary">
            Connect a wallet to buy. Quick buy sends a real swap on Arc testnet.
          </p>
        )}

        {follow && (
          <p className="border-t border-border px-3 py-2">
            <Badge tone="accent">copying {short(follow)}</Badge>
          </p>
        )}
      </Card>
    </motion.div>
  );
}

/* ----------------------------------------------------------- top traders */

function TopTraders({
  rows,
  loading,
}: {
  rows: ReturnType<typeof useLeaderboard>["rows"];
  loading: boolean;
}) {
  if (loading) return <SkeletonRows rows={3} height="h-16" />;
  if (!rows?.length) {
    return (
      <Empty
        title="No traders yet"
        hint="A wallet appears here after its first exit through the WinCut hook."
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <ColumnHeader>
        <span>Trader</span>
        <span>Followers&apos; profit</span>
      </ColumnHeader>
      {rows.slice(0, 10).map((r, i) => (
        <Link key={r.trader} href={`/trader/${r.trader}`}>
          <Card className="flex items-center gap-3 p-3 transition-colors hover:bg-elevated/40">
            <span className="num w-4 shrink-0 text-xs text-secondary">{i + 1}</span>
            <Avatar address={r.trader} size={32} />
            <div className="min-w-0 flex-1">
              <p className="num truncate text-sm font-semibold">{short(r.trader)}</p>
              <p className="num mt-0.5 text-[11px] text-secondary">
                own {usd(r.ownPnl, { sign: true })} · {r.followers} follower
                {r.followers === 1 ? "" : "s"}
              </p>
            </div>
            <span
              className={`num shrink-0 text-sm font-semibold ${
                r.followersPnl >= 0n ? "text-profit" : "text-loss"
              }`}
            >
              {usd(r.followersPnl, { sign: true })}
            </span>
          </Card>
        </Link>
      ))}
    </div>
  );
}

/* --------------------------------------------------------- live activity */

function LiveActivity({ head }: { head?: bigint }) {
  const trades = useTrades();
  const coinsQ = useCoins();
  const recent = (trades.data ?? []).slice(0, 8);

  // A Trade carries the poolId, which is what the hook indexes by. The Copy
  // link needs the coin page, so map it back through the launcher's list.
  const coinOfPool = (poolId: string) =>
    (coinsQ.data ?? []).find((c) => c.poolId === poolId)?.address;

  return (
    <section className="flex flex-col gap-2">
      <SectionHeading
        right={
          <span className="flex items-center gap-1.5 text-[11px] text-secondary">
            <span className="h-1.5 w-1.5 rounded-pill bg-profit" />
            On chain
          </span>
        }
      >
        Live activity
      </SectionHeading>

      {trades.isPending ? (
        <SkeletonRows rows={3} height="h-14" />
      ) : !recent.length ? (
        <Empty
          title="No trades yet"
          hint="Every row here is a real swap through the WinCut hook. Nothing is seeded."
        />
      ) : (
        <Card className="divide-y divide-border">
          <AnimatePresence initial={false}>
            {recent.map((t) => (
              <motion.div
                key={t.tx + t.trader}
                layout
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="flex items-center gap-3 p-3"
              >
                <Avatar address={t.trader} size={30} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px]">
                    <AddressLink address={t.trader} tight />{" "}
                    <span className={t.kind === "sell" ? "text-loss" : "text-profit"}>
                      {t.kind === "sell" ? "sold" : "bought"}
                    </span>{" "}
                    <span className="text-secondary">{fmtCoins(t.coins)}</span>
                    {t.followed && (
                      <span className="text-secondary">, copying {short(t.followed)}</span>
                    )}
                  </p>
                  <p className="num mt-0.5 text-[11px] text-secondary">
                    {usd(t.quoteAmount)}
                    {t.kind === "sell" && <> · fee {usd(t.fee ?? 0n)}</>} · {ago(t.block, head)} ·{" "}
                    <TxLink hash={t.tx}>explorer ↗</TxLink>
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {t.kind === "sell" && (
                    <p
                      className={`num text-sm font-semibold ${
                        (t.pnl ?? 0n) >= 0n ? "text-profit" : "text-loss"
                      }`}
                    >
                      {usd(t.pnl, { sign: true })}
                    </p>
                  )}
                  {coinOfPool(t.poolId) && (
                    <Link
                      href={`/coin/${coinOfPool(t.poolId)}?follow=${t.trader}`}
                      className="mt-1 block"
                    >
                      <span className="inline-flex items-center rounded-btn border border-border bg-elevated px-2.5 py-1.5 text-[11px] font-semibold">
                        Copy
                      </span>
                    </Link>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </Card>
      )}
    </section>
  );
}
