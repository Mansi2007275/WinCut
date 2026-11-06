"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Address, type PublicClient } from "viem";
import { winCutHookAbi, winCutLauncherAbi, erc20Abi } from "@/config/abis";
import { addr, type PoolKey } from "./chain";

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
    enabled: !!client,
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

// Parsed from signatures so viem can infer the arg types properly.
const boughtEvent = parseAbiItem(
  "event Bought(address indexed trader, bytes32 indexed id, uint128 coins, uint256 cost, address followed, address referrer)",
);
const soldEvent = parseAbiItem(
  "event Sold(address indexed trader, bytes32 indexed id, uint128 coins, uint256 proceeds, int256 pnl, uint256 fee)",
);

async function fetchTrades(client: PublicClient): Promise<Trade[]> {
  const latest = await client.getBlockNumber();
  // Anvil forks keep only recent history locally; a bounded window is also
  // what keeps this fast enough to run without a separate indexer.
  const span = 200_000n;
  const fromBlock = latest > span ? latest - span : 0n;

  const [bought, sold] = await Promise.all([
    client.getLogs({ address: addr.hook, event: boughtEvent, fromBlock, toBlock: latest }),
    client.getLogs({ address: addr.hook, event: soldEvent, fromBlock, toBlock: latest }),
  ]);

  const buys: Trade[] = bought.map((l) => {
    const a = l.args;
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
    const a = l.args;
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
    enabled: !!client,
    refetchInterval: 10_000,
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
