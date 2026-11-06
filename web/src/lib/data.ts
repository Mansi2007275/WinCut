"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits, parseAbiItem, type Address, type PublicClient } from "viem";
import { winCutHookAbi, winCutLauncherAbi, erc20Abi } from "@/config/abis";
import { addr, isDeployed, quoteIsCurrency0, type PoolKey } from "./chain";
import { changePct, priceFromSqrtX96 } from "./format";
import { getLogsChunked } from "./logs";

export type Coin = {
  address: Address;
  symbol: string;
  name: string;
  poolKey: PoolKey;
  poolId: `0x${string}`;
  creator: Address;
};

/// All coins launched through WinCutLauncher, read straight from chain.
export function useCoins() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["coins"],
    enabled: !!client && isDeployed,
    queryFn: async (): Promise<Coin[]> => {
      const c = client!;
      const count = await c.readContract({
        address: addr.launcher,
        abi: winCutLauncherAbi,
        functionName: "coinCount",
      });

      const idx = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
      const addresses = await Promise.all(
        idx.map((i) =>
          c.readContract({
            address: addr.launcher,
            abi: winCutLauncherAbi,
            functionName: "allCoins",
            args: [i],
          }),
        ),
      );

      return Promise.all(
        addresses.map(async (a) => {
          const [symbol, name, poolKey, poolId] = await Promise.all([
            c.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }),
            c.readContract({ address: a, abi: erc20Abi, functionName: "name" }),
            c.readContract({
              address: addr.launcher,
              abi: winCutLauncherAbi,
              functionName: "poolKeyFor",
              args: [a],
            }),
            c.readContract({
              address: addr.launcher,
              abi: winCutLauncherAbi,
              functionName: "poolIdFor",
              args: [a],
            }),
          ]);
          const launch = await c.readContract({
            address: addr.launcher,
            abi: winCutLauncherAbi,
            functionName: "launches",
            args: [poolId],
          });
          return {
            address: a,
            symbol,
            name,
            poolKey: poolKey as PoolKey,
            poolId,
            creator: launch[1],
          };
        }),
      );
    },
  });
}

/**
 * The hook's per-trade cap, in QUOTE units. 0 means no cap.
 *
 * Read from the contract rather than hard-coded: it is owner-settable, and a
 * stale constant here would either block valid trades or let the user sign a
 * transaction that reverts with TradeTooLarge() at the very last step.
 */
export function useMaxTradeSize() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["maxTradeSize"],
    enabled: !!client && isDeployed,
    staleTime: 60_000,
    queryFn: async (): Promise<bigint> =>
      client!.readContract({
        address: addr.hook,
        abi: winCutHookAbi,
        functionName: "maxTradeSize",
      }),
  });
}

export function usePosition(trader?: Address, poolId?: `0x${string}`) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["position", trader, poolId],
    enabled: !!client && !!trader && !!poolId,
    refetchInterval: 5_000,
    queryFn: async () => {
      const [amount, cost] = await client!.readContract({
        address: addr.hook,
        abi: winCutHookAbi,
        functionName: "positionOf",
        args: [trader!, poolId!],
      });
      return { amount, cost };
    },
  });
}

/// Claimable is read DIRECTLY from the hook: it is the source of truth for money.
export function useAccountState(account?: Address) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["accountState", account],
    enabled: !!client && !!account,
    refetchInterval: 5_000,
    queryFn: async () => {
      const [claimable, lossCredit] = await Promise.all([
        client!.readContract({
          address: addr.hook,
          abi: winCutHookAbi,
          functionName: "claimable",
          args: [account!],
        }),
        client!.readContract({
          address: addr.hook,
          abi: winCutHookAbi,
          functionName: "lossCredit",
          args: [account!],
        }),
      ]);
      return { claimable, lossCredit };
    },
  });
}

export function useCoinBalance(coin?: Address, account?: Address) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["coinBalance", coin, account],
    enabled: !!client && !!coin && !!account,
    refetchInterval: 5_000,
    queryFn: () =>
      client!.readContract({ address: coin!, abi: erc20Abi, functionName: "balanceOf", args: [account!] }),
  });
}

// ---------------------------------------------------------------- activity

export type Trade = {
  kind: "buy" | "sell";
  trader: Address;
  poolId: `0x${string}`;
  coins: bigint;
  /// cost for a buy, proceeds for a sell
  quoteAmount: bigint;
  pnl?: bigint;
  fee?: bigint;
  followed?: Address;
  referrer?: Address;
  block: bigint;
  tx: `0x${string}`;
};

const ZERO = "0x0000000000000000000000000000000000000000";

type BoughtArgs = {
  trader: Address; id: `0x${string}`; coins: bigint; cost: bigint; followed: Address; referrer: Address;
};
type SoldArgs = {
  trader: Address; id: `0x${string}`; coins: bigint; proceeds: bigint; pnl: bigint; fee: bigint;
};

// Parsed from signatures so viem can infer the arg types properly.
const boughtEvent = parseAbiItem(
  "event Bought(address indexed trader, bytes32 indexed id, uint128 coins, uint256 cost, address followed, address referrer)",
);
const soldEvent = parseAbiItem(
  "event Sold(address indexed trader, bytes32 indexed id, uint128 coins, uint256 proceeds, int256 pnl, uint256 fee)",
);

async function fetchTrades(client: PublicClient): Promise<Trade[]> {
  // Chunked, and never scanning before the hook was deployed. Arc's RPC
  // rejects wide ranges outright, so a single big getLogs fails.
  const latest = await client.getBlockNumber();
  const [bought, sold] = await Promise.all([
    getLogsChunked(client, { address: addr.hook, event: boughtEvent, latest }),
    getLogsChunked(client, { address: addr.hook, event: soldEvent, latest }),
  ]);

  const buys: Trade[] = bought.map((l) => {
    const a = (l as unknown as { args: BoughtArgs }).args;
    return {
      kind: "buy",
      trader: a.trader!,
      poolId: a.id!,
      coins: a.coins!,
      quoteAmount: a.cost!,
      followed: a.followed === ZERO ? undefined : a.followed,
      referrer: a.referrer === ZERO ? undefined : a.referrer,
      block: l.blockNumber!,
      tx: l.transactionHash!,
    };
  });

  const sells: Trade[] = sold.map((l) => {
    const a = (l as unknown as { args: SoldArgs }).args;
    return {
      kind: "sell",
      trader: a.trader!,
      poolId: a.id!,
      coins: a.coins!,
      quoteAmount: a.proceeds!,
      pnl: a.pnl!,
      fee: a.fee!,
      block: l.blockNumber!,
      tx: l.transactionHash!,
    };
  });

  return [...buys, ...sells].sort((x, y) => Number(y.block - x.block));
}

export function useTrades() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["trades"],
    enabled: !!client && isDeployed,
    // A full log scan. See the note in logs.ts: polling these every 10s is
    // what tripped Arc's rate limiter and emptied the screen.
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: () => fetchTrades(client as PublicClient),
  });
}

// ------------------------------------------------------------- leaderboard

export type LeaderRow = {
  trader: Address;
  ownPnl: bigint;
  followersPnl: bigint;
  followers: number;
  wins: number;
  trades: number;
  /// followersPnl / ownPnl. null when ownPnl is 0, so the UI shows a blank bar
  /// rather than a fake score.
  honesty: number | null;
  isDumper: boolean;
};

/**
 * Builds both leaderboards from hook events alone, no indexer.
 *
 * Own PnL comes from each trader's own Sold events. Followers' PnL is
 * attributed by matching a follower's Sold event to whoever they were copying,
 * which we learn from their preceding Bought event in the same pool.
 */
export function useLeaderboard() {
  const trades = useTrades();

  const rows: LeaderRow[] | undefined = trades.data && (() => {
    const chrono = [...trades.data!].sort((a, b) => Number(a.block - b.block));

    // Who was each (trader, pool) copying at the time they bought in?
    const copying = new Map<string, Address>();
    const ownPnl = new Map<Address, bigint>();
    const followersPnl = new Map<Address, bigint>();
    const followerSet = new Map<Address, Set<Address>>();
    const wins = new Map<Address, number>();
    const total = new Map<Address, number>();

    for (const t of chrono) {
      const key = `${t.trader}:${t.poolId}`;

      if (t.kind === "buy") {
        if (t.followed) {
          copying.set(key, t.followed);
          if (!followerSet.has(t.followed)) followerSet.set(t.followed, new Set());
          followerSet.get(t.followed)!.add(t.trader);
        }
        continue;
      }

      const pnl = t.pnl ?? 0n;
      ownPnl.set(t.trader, (ownPnl.get(t.trader) ?? 0n) + pnl);
      total.set(t.trader, (total.get(t.trader) ?? 0) + 1);
      if (pnl > 0n) wins.set(t.trader, (wins.get(t.trader) ?? 0) + 1);

      const leader = copying.get(key);
      if (leader && leader !== t.trader) {
        followersPnl.set(leader, (followersPnl.get(leader) ?? 0n) + pnl);
      }
    }

    const everyone = new Set<Address>([...ownPnl.keys(), ...followersPnl.keys()]);

    return [...everyone]
      .map((trader) => {
        const own = ownPnl.get(trader) ?? 0n;
        const foll = followersPnl.get(trader) ?? 0n;
        const hasFollowers = (followerSet.get(trader)?.size ?? 0) > 0;
        return {
          trader,
          ownPnl: own,
          followersPnl: foll,
          followers: followerSet.get(trader)?.size ?? 0,
          wins: wins.get(trader) ?? 0,
          trades: total.get(trader) ?? 0,
          honesty: own === 0n ? null : Number(foll) / Number(own),
          // A dumper profits while the people copying them lose.
          isDumper: hasFollowers && foll < 0n && own > 0n,
        };
      })
      .sort((a, b) => Number(b.ownPnl - a.ownPnl));
  })();

  return { ...trades, rows };
}

// ------------------------------------------------------------- chain head

/// The current block, used to render "3m ago" without fetching timestamps.
export function useHead() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["head"],
    enabled: !!client,
    refetchInterval: 5_000,
    queryFn: () => client!.getBlockNumber(),
  });
}

// ------------------------------------------------------- price from swaps

const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

export type PricePoint = { block: bigint; price: number; volumeQuote: bigint };

/**
 * Real price history for one pool.
 *
 * Read from the PoolManager's own Swap events, whose sqrtPriceX96 is the pool
 * price after each swap. This is the only source that reflects what the pool
 * actually did; the hook's Bought/Sold events carry a trader's average fill,
 * which is a different number and would draw a misleading chart.
 */
export function usePriceSeries(poolId?: `0x${string}`, quoteIsCurrency0 = true) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["priceSeries", poolId, quoteIsCurrency0],
    enabled: !!client && !!poolId && isDeployed,
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async (): Promise<PricePoint[]> => {
      const logs = await getLogsChunked(client as PublicClient, {
        address: addr.poolManager,
        event: swapEvent,
        eventArgs: { id: poolId! },
      });
      return logs
        .map((l) => {
          const a = (l as unknown as {
            args: { sqrtPriceX96: bigint; amount0: bigint; amount1: bigint };
          }).args;
          // amount0 is the quote side, signed from the pool's perspective.
          const q = quoteIsCurrency0 ? a.amount0 : a.amount1;
          return {
            block: l.blockNumber!,
            price: priceFromSqrtX96(a.sqrtPriceX96, quoteIsCurrency0),
            volumeQuote: q < 0n ? -q : q,
          };
        })
        .filter((p) => p.price > 0)
        .sort((x, y) => Number(x.block - y.block));
    },
  });
}

// ------------------------------------------------------------ coin stats

export type CoinStats = {
  price: number;
  /// Change across the whole recorded history, i.e. since launch.
  changePct: number | null;
  volumeQuote: bigint;
  swaps: number;
  holders: number;
  /// Block of the pool's first swap, which is the launch. Used to say how old
  /// a coin is without inventing a timestamp.
  launchBlock?: bigint;
  /// Price at launch and the highest price recorded, for the chart footer.
  launchPrice?: number;
  peakPrice?: number;
  /// price x total supply. The supply is fixed and fully seeded at launch, so
  /// this is a real figure rather than a circulating-supply guess.
  marketCap?: number;
};

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/**
 * Holder count, computed from the coin's own Transfer events.
 *
 * Replaying transfers is the only way to get a true holder count without an
 * indexer: there is no enumerable-holders view on an ERC-20. Addresses that
 * cannot sell are excluded, because counting the pool itself as a holder would
 * inflate every coin by one and make a brand new coin look like it has company.
 */
export function useCoinStats(coin?: Coin) {
  const client = usePublicClient();
  const series = usePriceSeries(coin?.poolId, coin ? quoteIsCurrency0(coin.poolKey) : true);

  const holders = useQuery({
    queryKey: ["holders", coin?.address],
    enabled: !!client && !!coin && isDeployed,
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async (): Promise<number> => {
      const logs = await getLogsChunked(client as PublicClient, {
        address: coin!.address,
        event: transferEvent,
      });
      const bal = new Map<string, bigint>();
      for (const l of logs) {
        const a = (l as unknown as { args: { from: Address; to: Address; value: bigint } }).args;
        const from = a.from.toLowerCase();
        const to = a.to.toLowerCase();
        if (from !== ZERO) bal.set(from, (bal.get(from) ?? 0n) - a.value);
        bal.set(to, (bal.get(to) ?? 0n) + a.value);
      }
      const excluded = new Set(
        [ZERO, addr.poolManager, addr.launcher, coin!.address].map((x) => x.toLowerCase()),
      );
      let n = 0;
      for (const [who, v] of bal) if (v > 0n && !excluded.has(who)) n += 1;
      return n;
    },
  });

  // Fixed at deployment and never minted again, so one read is enough.
  const supply = useQuery({
    queryKey: ["totalSupply", coin?.address],
    enabled: !!client && !!coin && isDeployed,
    staleTime: Infinity,
    queryFn: async (): Promise<bigint> =>
      client!.readContract({
        address: coin!.address,
        abi: erc20Abi,
        functionName: "totalSupply",
      }),
  });

  const price = series.data?.at(-1)?.price ?? 0;
  const stats: CoinStats | undefined = series.data && {
    price,
    changePct:
      series.data.length > 1
        ? changePct(series.data[0].price, series.data.at(-1)!.price)
        : null,
    volumeQuote: series.data.reduce((s, p) => s + p.volumeQuote, 0n),
    swaps: series.data.length,
    holders: holders.data ?? 0,
    launchBlock: series.data[0]?.block,
    launchPrice: series.data[0]?.price,
    peakPrice: series.data.length ? Math.max(...series.data.map((p) => p.price)) : undefined,
    marketCap:
      supply.data !== undefined
        ? price * Number(formatUnits(supply.data, 18))
        : undefined,
  };

  return {
    stats,
    series: series.data,
    isLoading: series.isLoading || holders.isLoading,
    error: series.error ?? holders.error,
  };
}

// --------------------------------------------------------- trader profile

export type TraderProfile = {
  trader: Address;
  ownPnl: bigint;
  followersPnl: bigint;
  followers: Address[];
  copying: Address[];
  wins: number;
  trades: number;
  feesPaid: bigint;
  honesty: number | null;
  isDumper: boolean;
  history: Trade[];
};

/// One trader's full record, derived from the same events as the leaderboard so
/// the two can never disagree.
export function useTrader(who?: Address) {
  const all = useTrades();

  const profile: TraderProfile | undefined =
    all.data && who
      ? (() => {
          const lower = who.toLowerCase();
          const chrono = [...all.data].sort((a, b) => Number(a.block - b.block));

          const copying = new Map<string, Address>();
          const followers = new Set<Address>();
          const copyingSet = new Set<Address>();
          let ownPnl = 0n;
          let followersPnl = 0n;
          let feesPaid = 0n;
          let wins = 0;
          let trades = 0;

          for (const t of chrono) {
            const key = `${t.trader}:${t.poolId}`;
            if (t.kind === "buy") {
              if (t.followed) {
                copying.set(key, t.followed);
                if (t.followed.toLowerCase() === lower) followers.add(t.trader);
                if (t.trader.toLowerCase() === lower) copyingSet.add(t.followed);
              }
              continue;
            }
            const pnl = t.pnl ?? 0n;
            if (t.trader.toLowerCase() === lower) {
              ownPnl += pnl;
              feesPaid += t.fee ?? 0n;
              trades += 1;
              if (pnl > 0n) wins += 1;
            }
            const leader = copying.get(key);
            if (leader && leader.toLowerCase() === lower && t.trader.toLowerCase() !== lower) {
              followersPnl += pnl;
            }
          }

          return {
            trader: who,
            ownPnl,
            followersPnl,
            followers: [...followers],
            copying: [...copyingSet],
            wins,
            trades,
            feesPaid,
            honesty: ownPnl === 0n ? null : Number(followersPnl) / Number(ownPnl),
            isDumper: followers.size > 0 && followersPnl < 0n && ownPnl > 0n,
            history: all.data
              .filter((t) => t.trader.toLowerCase() === lower)
              .sort((a, b) => Number(b.block - a.block)),
          };
        })()
      : undefined;

  return { ...all, profile };
}
