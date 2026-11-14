"use client";

/**
 * Every read the UI makes, as one react-query hook each.
 *
 * Three sources feed this app and nothing else does:
 *
 *   - the WinCut contract, for balances, positions, credit, fees and traders
 *   - Rhea, for live pool reserves, quotes and depth
 *   - GeckoTerminal, for candles and 24h stats
 *
 * Poll intervals are set per source by how fast the underlying thing can
 * actually change, and `enabled` guards mean a screen with no wallet connected
 * and no contract deployed makes no requests at all rather than firing reads
 * that are certain to fail.
 */

import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import markets from "@/config/markets.json";
import * as contract from "./contract";
import type { TokenConfig } from "./contract";
import * as agentLib from "./agent";
import * as gecko from "./gecko";
import * as rhea from "./rhea";
import { toNumber } from "./format";
import {
  CONTRACT_ID,
  TOKEN_IDS,
  USDC_DECIMALS,
  USDC_ID,
  CHARTS_AVAILABLE,
  blockHeight,
  ftBalanceOf,
  ftDecimals,
  gasPrice,
  isDeployed,
  nativeBalance,
} from "./near";

/** How often each class of data is re-read. */
const POLL = {
  /** The chain tip, for the live block badge. */
  block: 3_000,
  /** Balances, positions, credit: change only when the user acts. */
  account: 6_000,
  /** Pool reserves move with every swap anyone makes. */
  pools: 8_000,
  /** The trade feed. */
  trades: 8_000,
  /** 24h stats from GeckoTerminal, which caches server-side anyway. */
  stats: 20_000,
  /** The leaderboard reads the whole trader map, so it is left slower. */
  board: 30_000,
} as const;

// ------------------------------------------------------------------ chain

export function useBlockHeight(): UseQueryResult<number> {
  return useQuery({
    queryKey: ["block"],
    queryFn: ({ signal }) => blockHeight(signal),
    refetchInterval: POLL.block,
    staleTime: POLL.block,
  });
}

/**
 * The ceiling on a trade's network fee, in yoctoNEAR.
 *
 * NEAR charges for gas actually burnt and refunds the rest, so this is an
 * upper bound - which is the honest thing to show before signing, and it is
 * labelled as one.
 */
export function useMaxNetworkFee(tgas: number) {
  return useQuery({
    queryKey: ["gas-price"],
    queryFn: ({ signal }) => gasPrice(signal),
    refetchInterval: 60_000,
    staleTime: 60_000,
    select: (price) => price * BigInt(tgas) * 1_000_000_000_000n,
  });
}

/** The signer's NEAR balance, for the "you have no gas" warning. */
export function useNearBalance(accountId: string | null) {
  return useQuery({
    queryKey: ["near-balance", accountId],
    queryFn: ({ signal }) => nativeBalance(accountId!, signal),
    enabled: !!accountId,
    refetchInterval: POLL.account,
  });
}

// --------------------------------------------------------------- contract

export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: ({ signal }) => contract.getConfig(signal),
    enabled: isDeployed,
    staleTime: 60_000,
  });
}

/**
 * The tradable tokens, in the order NEXT_PUBLIC_TOKENS lists them.
 *
 * The contract is the authority on symbol, decimals and route: the env var
 * only decides which tokens are offered and in what order. A token listed in
 * env but not on the contract is dropped, because there is no route to trade
 * it with.
 *
 * With no contract deployed it falls back to the routes in
 * `src/config/markets.json`, every one of which was verified against mainnet
 * by RPC call. Prices, depth and charts then still work and are still real -
 * only trading needs the contract, and `registered: false` makes every screen
 * say so.
 */
export function useTokens(): UseQueryResult<TokenConfig[]> {
  return useQuery({
    queryKey: ["tokens", isDeployed],
    queryFn: async ({ signal }) => {
      if (!isDeployed) return verifiedMarkets();
      const all = await contract.getTokens(signal);
      if (TOKEN_IDS.length === 0) return all;
      const order = new Map(TOKEN_IDS.map((id, i) => [id, i]));
      return all
        .filter((t) => order.has(t.token_id))
        .sort((a, b) => (order.get(a.token_id) ?? 0) - (order.get(b.token_id) ?? 0));
    },
    staleTime: 5 * 60_000,
    // Every endpoint has to refuse four times running before a screen is
    // allowed to conclude anything from the absence of this list. One 429 from
    // a shared free tier used to be enough.
    retry: 3,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
  });
}

/**
 * One market, looked up the way a deep link needs it.
 *
 * `useTokens` answers a different question - which markets this deployment
 * offers, in which order - and it filters by `NEXT_PUBLIC_TOKENS`. A URL is
 * not a menu: somebody following a link to a token that is listed on the
 * contract but absent from that env var should get the market, not a page
 * telling them it does not exist. So this falls back to asking the contract
 * about that one token directly.
 *
 * The three outcomes are kept distinct, because a screen that collapses them
 * tells the user something false:
 *
 *   `token` - it is listed, here it is.
 *   `missing` - the contract was reached and does not have it.
 *   `unreachable` - nothing could be read, so nothing is known either way.
 */
export function useMarket(tokenId: string | undefined) {
  const tokens = useTokens();
  const listed = useMemo(
    () => tokens.data?.find((t) => t.token_id === tokenId),
    [tokens.data, tokenId],
  );

  const direct = useQuery({
    queryKey: ["token", tokenId],
    queryFn: ({ signal }) => contract.getToken(tokenId!, signal),
    // Only when the list was read successfully and did not contain it.
    enabled: isDeployed && !!tokenId && tokens.isSuccess && !listed,
    staleTime: 5 * 60_000,
    retry: 3,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
  });

  const token = listed ?? direct.data ?? undefined;
  const pending = tokens.isPending || (tokens.isSuccess && !listed && direct.isPending);
  const unreachable = !token && !pending && (tokens.isError || direct.isError);

  return {
    token,
    pending,
    unreachable,
    /** Reached the contract, and it has no such token. */
    missing: !token && !pending && !unreachable,
    error: (tokens.error ?? direct.error) as Error | undefined,
    refetch: () => {
      void tokens.refetch();
      void direct.refetch();
    },
  };
}

/** The verified mainnet routes, as the contract would report them. */
function verifiedMarkets(): TokenConfig[] {
  return markets.tokens.map((t) => ({
    token_id: t.token_id,
    symbol: t.symbol,
    decimals: t.decimals,
    hops: t.hops,
    chart_pool: t.chart_pool,
    // Nothing is tradable without a contract, and saying so is the point.
    registered: false,
  }));
}

export function useToken(tokenId: string | undefined) {
  const tokens = useTokens();
  const token = useMemo(
    () => tokens.data?.find((t) => t.token_id === tokenId),
    [tokens.data, tokenId],
  );
  return { ...tokens, token };
}

export function useInternalBalance(accountId: string | null) {
  return useQuery({
    queryKey: ["balance", accountId],
    queryFn: ({ signal }) => contract.getBalance(accountId!, signal),
    enabled: isDeployed && !!accountId,
    refetchInterval: POLL.account,
    select: (v) => BigInt(v),
  });
}

/** The USDC sitting in the user's own wallet, outside WinCut. */
export function useWalletUsdc(accountId: string | null) {
  return useQuery({
    queryKey: ["wallet-usdc", accountId],
    queryFn: ({ signal }) => ftBalanceOf(USDC_ID, accountId!, signal),
    enabled: !!accountId,
    refetchInterval: POLL.account,
  });
}

export function useLossCredit(accountId: string | null) {
  return useQuery({
    queryKey: ["loss-credit", accountId],
    queryFn: ({ signal }) => contract.getLossCredit(accountId!, signal),
    enabled: isDeployed && !!accountId,
    refetchInterval: POLL.account,
    select: (v) => BigInt(v),
  });
}

export function useClaimable(accountId: string | null) {
  return useQuery({
    queryKey: ["claimable", accountId],
    queryFn: ({ signal }) => contract.getClaimable(accountId!, signal),
    enabled: isDeployed && !!accountId,
    refetchInterval: POLL.account,
    select: (v) => BigInt(v),
  });
}

export function usePosition(accountId: string | null, tokenId: string | undefined) {
  return useQuery({
    queryKey: ["position", accountId, tokenId],
    queryFn: ({ signal }) => contract.getPosition(accountId!, tokenId!, signal),
    enabled: isDeployed && !!accountId && !!tokenId,
    refetchInterval: POLL.account,
  });
}

export function usePositions(accountId: string | null) {
  return useQuery({
    queryKey: ["positions", accountId],
    queryFn: ({ signal }) => contract.getPositions(accountId!, signal),
    enabled: isDeployed && !!accountId,
    refetchInterval: POLL.account,
  });
}

export function useRecentTrades(limit = 50) {
  return useQuery({
    queryKey: ["trades", limit],
    queryFn: ({ signal }) => contract.getRecentTrades(0, limit, signal),
    enabled: isDeployed,
    refetchInterval: POLL.trades,
  });
}

export function useMyTrades(accountId: string | null, limit = 50) {
  return useQuery({
    queryKey: ["my-trades", accountId, limit],
    queryFn: ({ signal }) => contract.getTradesOf(accountId!, limit, signal),
    enabled: isDeployed && !!accountId,
    refetchInterval: POLL.trades,
  });
}

export function useCopyFeed(trader: string | null, limit = 50) {
  return useQuery({
    queryKey: ["copy-feed", trader, limit],
    queryFn: ({ signal }) => contract.getCopyFeed(trader!, limit, signal),
    enabled: isDeployed && !!trader,
    refetchInterval: POLL.trades,
  });
}

export function useLeaderboard(limit = 25) {
  return useQuery({
    queryKey: ["leaderboard", limit],
    queryFn: ({ signal }) => contract.getLeaderboard(limit, signal),
    enabled: isDeployed,
    refetchInterval: POLL.board,
  });
}

export function useTrader(accountId: string | undefined) {
  return useQuery({
    queryKey: ["trader", accountId],
    queryFn: ({ signal }) => contract.getTrader(accountId!, signal),
    enabled: isDeployed && !!accountId,
    refetchInterval: POLL.board,
  });
}

// ------------------------------------------------------------------- Rhea

export type Route = {
  token: TokenConfig;
  /** USDC -> token, for buying. */
  buy: rhea.PoolSide[];
  /** token -> USDC, for selling. */
  sell: rhea.PoolSide[];
  /** Mid price in USDC per whole token, straight from the reserves. */
  mid: number;
  /** Compounded pool fee across the hops, as a percentage. */
  poolFeePct: number;
  /** USD held by each pool on the route. */
  depths: rhea.HopDepth[];
  /** The thinnest pool on the route, which is what actually limits a trade. */
  liquidityUsd: number;
};

/**
 * The live pool reserves for a token's route, in both directions.
 *
 * This is the single most important read on the trade screen: the quote, the
 * price impact, the depth ladder and the on-chain mid price all come out of it,
 * so they are all consistent with each other and with one moment on chain.
 */
export function useRoute(token: TokenConfig | undefined): UseQueryResult<Route> {
  return useQuery({
    queryKey: ["route", token?.token_id, token?.hops.map((h) => h.pool_id).join("-")],
    queryFn: async ({ signal }) => {
      const pools = await rhea.loadRoute(token!.hops, signal);
      const buy = rhea.sides(token!.hops, pools, false);
      const sell = rhea.sides(token!.hops, pools, true);

      // Valuing each hop needs the decimals of every token on the route,
      // including intermediates like wNEAR that the app never lists.
      const known = new Map<string, number>([
        [USDC_ID, USDC_DECIMALS],
        [token!.token_id, token!.decimals],
      ]);
      const unknown = [...new Set(buy.flatMap((s) => [s.tokenIn, s.tokenOut]))].filter(
        (id) => !known.has(id),
      );
      await Promise.all(
        unknown.map(async (id) => {
          known.set(id, await ftDecimals(id, signal));
        }),
      );
      const decimalsOf = (id: string) => known.get(id) ?? NaN;

      const depths = rhea.routeDepths(buy, decimalsOf);
      return {
        token: token!,
        buy,
        sell,
        mid: rhea.midPrice(buy, USDC_DECIMALS, token!.decimals),
        poolFeePct: rhea.routeFeePct(buy),
        depths,
        liquidityUsd: rhea.routeLiquidityUsd(depths),
      } satisfies Route;
    },
    enabled: !!token,
    refetchInterval: POLL.pools,
  });
}

/**
 * Rhea's own quote for an amount, used to confirm the number the user is about
 * to sign. The local reserve maths drives the keystroke-by-keystroke estimate;
 * this is the authority, so it is debounced and only runs for real amounts.
 */
export function useOnChainQuote(route: rhea.PoolSide[] | undefined, amountIn: bigint) {
  return useQuery({
    queryKey: [
      "rhea-quote",
      route?.map((s) => s.poolId).join("-"),
      route?.[0]?.tokenIn,
      amountIn.toString(),
    ],
    queryFn: ({ signal }) => rhea.quoteRouteOnChain(amountIn, route!, signal),
    enabled: !!route && route.length > 0 && amountIn > 0n,
    staleTime: 6_000,
    refetchInterval: 12_000,
  });
}

// ------------------------------------------------- the testnet price series

/**
 * The series key for a token's chart on testnet: the pool whose price actually
 * moves it, which is the last hop of its route. On a one-hop token that is the
 * USDC pool; on a two-hop token it is the wNEAR pool that prices it.
 */
export function seriesPoolFor(token: TokenConfig | undefined): string | undefined {
  const last = token?.hops?.[token.hops.length - 1];
  return last ? String(last.pool_id) : undefined;
}

export type OnChainCandles = {
  candles: gecko.Candle[];
  points: number;
  pointsStoredAllTime: number;
  bySource: Record<string, number>;
  collectingSince: string | null;
};

/**
 * Candles that WinCut built itself from prices it read off the chain, for
 * testnet - where GeckoTerminal has nothing to give. Same shape the mainnet
 * path returns, so the chart does not care which one it got.
 */
export function useOnChainCandles(
  poolKey: string | undefined,
  timeframe: gecko.TimeframeKey,
  enabled: boolean,
) {
  return useQuery<OnChainCandles>({
    queryKey: ["onchain-candles", poolKey, timeframe],
    queryFn: async ({ signal }) => {
      const res = await fetch(
        `/api/candles?pool=${encodeURIComponent(poolKey!)}&tf=${timeframe}`,
        { signal, cache: "no-store" },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body?.detail ?? body?.error ?? `candles responded ${res.status}`);
      return {
        candles: body.candles ?? [],
        points: body.points ?? 0,
        pointsStoredAllTime: body.pointsStoredAllTime ?? 0,
        bySource: body.bySource ?? {},
        collectingSince: body.collectingSince ?? null,
      };
    },
    enabled: enabled && !!poolKey,
    refetchInterval: gecko.TIMEFRAMES[timeframe]?.pollMs ?? 30_000,
    retry: 1,
  });
}

// ---------------------------------------------------------- GeckoTerminal

export function usePoolStats(poolId: string | undefined, tokenId: string | undefined) {
  return useQuery({
    queryKey: ["pool-stats", poolId, tokenId],
    queryFn: ({ signal }) => gecko.poolStats(poolId!, tokenId!, signal),
    // Gated on CHARTS_AVAILABLE, not just on there being a pool id. A testnet
    // token may legitimately carry a chart_pool as a record of which pool its
    // series belongs to, and GeckoTerminal indexes mainnet only - so without
    // this the app would poll an indexer that cannot know about the pool, for
    // every viewer, forever. Gating here rather than blanking the config makes
    // the app structurally unable to show mainnet-indexed data on testnet.
    enabled: CHARTS_AVAILABLE && !!poolId && !!tokenId,
    refetchInterval: POLL.stats,
    retry: 1,
  });
}

/** Stats for every listed token at once, for the landing page and the board. */
export function useAllPoolStats(tokens: TokenConfig[] | undefined) {
  const pools = useMemo(
    () =>
      (tokens ?? [])
        .filter((t) => t.chart_pool)
        .map((t) => ({ poolId: t.chart_pool, tokenId: t.token_id })),
    [tokens],
  );
  return useQuery({
    queryKey: ["pool-stats-many", pools.map((p) => p.poolId).join(",")],
    queryFn: ({ signal }) => gecko.manyPoolStats(pools, signal),
    enabled: CHARTS_AVAILABLE && pools.length > 0,
    refetchInterval: POLL.stats,
    retry: 1,
  });
}

export function useCandles(
  poolId: string | undefined,
  timeframe: gecko.TimeframeKey,
  side: gecko.GtSide | undefined,
) {
  const tf = gecko.TIMEFRAMES[timeframe];
  return useQuery({
    queryKey: ["candles", poolId, timeframe, side],
    queryFn: ({ signal }) => gecko.candles(poolId!, tf, side!, 300, signal),
    enabled: CHARTS_AVAILABLE && !!poolId && !!side,
    refetchInterval: tf.pollMs,
    retry: 1,
  });
}

export function usePoolTrades(poolId: string | undefined, side: gecko.GtSide | undefined) {
  return useQuery({
    queryKey: ["pool-trades", poolId, side],
    queryFn: ({ signal }) => gecko.poolTrades(poolId!, side!, signal),
    enabled: CHARTS_AVAILABLE && !!poolId && !!side,
    refetchInterval: POLL.stats,
    retry: 1,
  });
}

// ------------------------------------------------------------------- fees

/**
 * The exact settlement for selling `amount` at `expectedProceeds`, from the
 * contract. Not recomputed in the browser: the fee shown has to be the fee the
 * contract will charge, and the only way to promise that is to ask it.
 */
export function useSellQuote(
  accountId: string | null,
  tokenId: string | undefined,
  amount: bigint,
  expectedProceeds: bigint,
) {
  return useQuery({
    queryKey: [
      "sell-quote",
      accountId,
      tokenId,
      amount.toString(),
      expectedProceeds.toString(),
    ],
    queryFn: ({ signal }) =>
      contract.quoteSellFee(
        accountId!,
        tokenId!,
        amount.toString(),
        expectedProceeds.toString(),
        signal,
      ),
    enabled: isDeployed && !!accountId && !!tokenId && amount > 0n && expectedProceeds > 0n,
    staleTime: 5_000,
  });
}

/** The landing page calculator: put in $X, take out $Y, see the fee. */
export function useFeeExample(
  costBasis: bigint,
  proceeds: bigint,
  lossCredit: bigint,
  hasTrader: boolean,
  hasReferrer: boolean,
) {
  return useQuery({
    queryKey: [
      "fee-example",
      costBasis.toString(),
      proceeds.toString(),
      lossCredit.toString(),
      hasTrader,
      hasReferrer,
    ],
    queryFn: ({ signal }) =>
      contract.quoteFeeFor(
        costBasis.toString(),
        proceeds.toString(),
        lossCredit.toString(),
        hasTrader,
        hasReferrer,
        signal,
      ),
    enabled: isDeployed && costBasis > 0n,
    staleTime: 60_000,
  });
}

// ------------------------------------------------------------ invalidation

/**
 * Re-reads everything a trade could have changed.
 *
 * A trade settles across several blocks - the swap, then the balance read,
 * then the settlement - so one refetch the instant the transaction returns
 * would read the state from before the callbacks ran. These fire a few seconds
 * apart to catch the settled state without making the user reload.
 */
export function useRefreshAfterTrade(accountId: string | null) {
  const qc = useQueryClient();
  return useCallback(() => {
    const keys = [
      ["balance", accountId],
      ["loss-credit", accountId],
      ["claimable", accountId],
      ["positions", accountId],
      ["my-trades", accountId],
      ["trades"],
      ["leaderboard"],
      ["route"],
      ["config"],
      ["trader", accountId],
    ];
    const invalidate = () => {
      for (const key of keys) {
        qc.invalidateQueries({ queryKey: key, exact: false });
      }
    };
    invalidate();
    const timers = [2_500, 6_000, 12_000].map((ms) => setTimeout(invalidate, ms));
    return () => timers.forEach(clearTimeout);
  }, [qc, accountId]);
}

// ------------------------------------------------------------------ the agent

/**
 * The agent's decision log.
 *
 * Polled on the same five-minute cadence the agent decides on, plus a little
 * slack, so a page left open stays current without asking far more often than
 * the thing it is watching can change.
 */
export function useAgentLog(enabled = true, limit = 40) {
  return useQuery<agentLib.AgentLog>({
    queryKey: ["agent-log", limit],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/agent/log?limit=${limit}`, { signal, cache: "no-store" });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body?.detail ?? body?.error ?? `agent log responded ${res.status}`);
      }
      return body as agentLib.AgentLog;
    },
    enabled: enabled && Boolean(agentLib.AGENT_ACCOUNT_ID),
    refetchInterval: 60_000,
    retry: 1,
  });
}

/**
 * 24h volume and pressure for one market, computed from what settled rather
 * than from an indexer. Used on testnet, where nothing indexes the pool but
 * WinCut knows exactly what traded through it.
 */
export type Activity = {
  volume24hUsd: number;
  buys: number;
  sells: number;
  buyPct: number | null;
  count: number;
  wincutCount: number;
  makerCount: number;
  makerVolume: number;
  sources: string[];
  truncated: boolean;
  source: string;
};

export function useActivity(tokenId: string | undefined, poolKey: string | undefined, enabled: boolean) {
  return useQuery<Activity>({
    queryKey: ["activity", tokenId, poolKey],
    queryFn: async ({ signal }) => {
      const qs = new URLSearchParams({ token: tokenId! });
      if (poolKey) qs.set("pool", poolKey);
      const res = await fetch(`/api/activity?${qs}`, { signal, cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.detail ?? body?.error ?? `activity responded ${res.status}`);
      return body as Activity;
    },
    enabled: enabled && !!tokenId && isDeployed,
    refetchInterval: POLL.stats,
    retry: 1,
  });
}

// ------------------------------------------------------------- the cut field

/**
 * Current banked loss credit for several accounts at once.
 *
 * The ring says how much credit each loss *banked*; only the contract knows
 * how much is still *held*, because a later win spends it. One query so the
 * dashboard makes a handful of parallel view calls rather than mounting a
 * hook per account, and so the whole panel has one loading state.
 */
export function useLossCredits(accountIds: string[]) {
  const key = [...accountIds].sort().join(",");
  return useQuery<Record<string, number>>({
    queryKey: ["loss-credits", key],
    queryFn: async ({ signal }) => {
      const entries = await Promise.all(
        accountIds.map(async (id) => {
          try {
            const raw = await contract.getLossCredit(id, signal);
            return [id, toNumber(raw, USDC_DECIMALS)] as const;
          } catch {
            // One unreadable account must not blank the panel.
            return [id, NaN] as const;
          }
        }),
      );
      return Object.fromEntries(entries);
    },
    enabled: isDeployed && accountIds.length > 0,
    refetchInterval: POLL.trades,
    retry: 1,
  });
}

/** What the contract holds against what it owes: the solvency row. */
export function useSolvency() {
  return useQuery({
    queryKey: ["solvency"],
    queryFn: async ({ signal }) => {
      const accounted = await contract.getUsdcAccounted(signal);
      return toNumber(accounted, USDC_DECIMALS);
    },
    enabled: isDeployed,
    refetchInterval: 30_000,
    retry: 1,
  });
}

/**
 * The whole trade ring, on the dashboard's own cadence.
 *
 * Separate from `useRecentTrades` because the two want different things: a
 * feed wants the newest few often, and the dashboard wants all 500 less
 * often. Sharing one hook would have meant re-reading the entire ring every
 * eight seconds for every viewer of a public page.
 */
export function useTradeRing(limit = 500) {
  return useQuery({
    queryKey: ["trade-ring", limit],
    queryFn: ({ signal }) => contract.getRecentTrades(0, limit, signal),
    enabled: isDeployed,
    refetchInterval: 15_000,
    retry: 1,
  });
}

/**
 * The USDC the contract actually holds, asked of the token rather than of the
 * contract. Paired with `useSolvency`, which asks the contract what it thinks
 * it owes: two independent reads, and the comparison is only worth anything
 * because they come from different places.
 */
export function useContractUsdcHeld() {
  return useQuery({
    queryKey: ["contract-usdc-held"],
    queryFn: async ({ signal }) => {
      const raw = await ftBalanceOf(USDC_ID, CONTRACT_ID, signal);
      return toNumber(raw, USDC_DECIMALS);
    },
    enabled: isDeployed,
    refetchInterval: 30_000,
    retry: 1,
  });
}
