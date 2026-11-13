/**
 * Rhea (Ref Finance) pool reads, quotes and depth.
 *
 * Two ways of pricing live here and they are used for different things:
 *
 * - `quoteRoute` works straight off the pool reserves with Rhea's own
 *   constant-product formula. It is exact for a simple pool, needs no network
 *   round trip, and is what drives "you receive", the price impact and the
 *   whole depth ladder - a ladder of ten sizes would otherwise be ten RPC
 *   calls per keystroke.
 * - `quoteRouteOnChain` asks Rhea itself through `get_return`. It is the
 *   authority, and the order panel uses it to confirm the number the user is
 *   about to sign for.
 *
 * Both are real on-chain data. Neither is a guess.
 */

import { REF_CONTRACT, USDC_DECIMALS, view } from "./near";
import type { Hop } from "./contract";

export const FEE_DIVISOR = 10_000n;

export type Pool = {
  pool_kind: string;
  token_account_ids: string[];
  amounts: string[];
  total_fee: number;
  shares_total_supply: string;
};

export type PoolSide = {
  poolId: number;
  kind: string;
  feeBps: number;
  tokenIn: string;
  tokenOut: string;
  reserveIn: bigint;
  reserveOut: bigint;
};

export const getPool = (poolId: number, signal?: AbortSignal) =>
  view<Pool>(REF_CONTRACT, "get_pool", { pool_id: poolId }, signal);

/** Fetches every pool a route touches, once, in parallel. */
export async function loadRoute(hops: Hop[], signal?: AbortSignal): Promise<Pool[]> {
  return Promise.all(hops.map((h) => getPool(h.pool_id, signal)));
}

/**
 * Orients a fetched pool for one direction of travel. Rhea stores a pool's two
 * tokens in whichever order they were registered, so which reserve is "in"
 * depends on the hop, not the pool.
 */
export function orient(hop: Hop, pool: Pool, reverse: boolean): PoolSide {
  const tokenIn = reverse ? hop.token_out : hop.token_in;
  const tokenOut = reverse ? hop.token_in : hop.token_out;
  const i = pool.token_account_ids.indexOf(tokenIn);
  const o = pool.token_account_ids.indexOf(tokenOut);
  if (i < 0 || o < 0) {
    throw new Error(`pool ${hop.pool_id} does not hold ${tokenIn} and ${tokenOut}`);
  }
  return {
    poolId: hop.pool_id,
    kind: pool.pool_kind,
    feeBps: pool.total_fee,
    tokenIn,
    tokenOut,
    reserveIn: BigInt(pool.amounts[i]),
    reserveOut: BigInt(pool.amounts[o]),
  };
}

/** Walks the hops in travel order: forwards to buy, backwards to sell. */
export function sides(hops: Hop[], pools: Pool[], reverse: boolean): PoolSide[] {
  const pairs = hops.map((hop, idx) => ({ hop, pool: pools[idx] }));
  const ordered = reverse ? [...pairs].reverse() : pairs;
  return ordered.map(({ hop, pool }) => orient(hop, pool, reverse));
}

/**
 * Rhea's simple-pool swap, to the unit.
 *
 * Lifted from ref-exchange's `simple_pool.rs`: the input is discounted by the
 * pool fee first, then the constant-product formula runs on the discounted
 * amount. BigInt throughout, because the intermediate product of two 24-decimal
 * reserves is far past what a double can hold without losing cents.
 */
export function swapOut(amountIn: bigint, side: PoolSide): bigint {
  if (amountIn <= 0n || side.reserveIn <= 0n || side.reserveOut <= 0n) return 0n;
  const withFee = amountIn * (FEE_DIVISOR - BigInt(side.feeBps));
  return (withFee * side.reserveOut) / (FEE_DIVISOR * side.reserveIn + withFee);
}

/** The whole route, hop by hop, each hop's output feeding the next. */
export function quoteRoute(amountIn: bigint, route: PoolSide[]): bigint {
  let amount = amountIn;
  for (const side of route) {
    amount = swapOut(amount, side);
    if (amount === 0n) return 0n;
  }
  return amount;
}

/**
 * The mid price of the route: what one whole unit of the output token costs in
 * whole units of the input token, with no fee and no size.
 *
 * The reserve ratios multiply to *output raw units per input raw unit*, so the
 * price is its reciprocal, and the decimals are corrected once at the end
 * rather than per hop. Getting that reciprocal the wrong way round is silent
 * and convincing - it produced $28.45 for a token that trades at $0.035 - so
 * `midPriceIsSane` exists to catch it against an independent source.
 */
export function midPrice(route: PoolSide[], decimalsIn: number, decimalsOut: number): number {
  let outPerIn = 1;
  for (const side of route) {
    if (side.reserveIn === 0n || side.reserveOut === 0n) return NaN;
    outPerIn *= Number(side.reserveOut) / Number(side.reserveIn);
  }
  if (!Number.isFinite(outPerIn) || outPerIn === 0) return NaN;
  return 10 ** (decimalsOut - decimalsIn) / outPerIn;
}

/**
 * Whether a reserve-derived price agrees with an independently indexed one.
 *
 * Used to compare the Rhea mid against GeckoTerminal's. They will not match
 * exactly - one is a live snapshot, the other is indexed and a block or two
 * behind - but an order-of-magnitude gap means the maths is wrong, not the
 * market.
 */
export function midPriceIsSane(mid: number, reference: number, tolerance = 0.25): boolean {
  if (!Number.isFinite(mid) || !Number.isFinite(reference) || reference === 0) return true;
  return Math.abs(mid - reference) / reference <= tolerance;
}

/** Realised price of a fill, in USDC per whole token. */
export function fillPrice(
  usdcRaw: bigint,
  tokenRaw: bigint,
  tokenDecimals: number,
): number {
  if (tokenRaw === 0n) return NaN;
  const usdc = Number(usdcRaw) / 10 ** USDC_DECIMALS;
  const tok = Number(tokenRaw) / 10 ** tokenDecimals;
  return usdc / tok;
}

/** How much worse than the mid price a given fill is, in percent. */
export function priceImpactPct(effective: number, mid: number): number {
  if (!Number.isFinite(effective) || !Number.isFinite(mid) || mid === 0) return NaN;
  return ((effective - mid) / mid) * 100;
}

export type DepthRung = {
  /** Notional size of the order in USDC. */
  usd: number;
  /** USDC per whole token this size would actually fill at. */
  price: number;
  /** Difference from the mid price, in percent. Negative when selling. */
  impactPct: number;
  /** Raw units on the other side of the trade. */
  out: bigint;
};

/**
 * The pool-depth ladder, which replaces an order book.
 *
 * A Rhea pool has no resting orders to show, so the honest equivalent is: here
 * is what $100, $1,000 and $10,000 would actually fill at, right now, from the
 * live reserves. The buy side spends USDC; the sell side is sized in USDC of
 * notional and converted to tokens at the mid price first.
 */
export function depthLadder(
  buyRoute: PoolSide[],
  sellRoute: PoolSide[],
  tokenDecimals: number,
  sizes: number[] = [100, 500, 1_000, 5_000, 10_000, 50_000],
): { buys: DepthRung[]; sells: DepthRung[]; mid: number } {
  const mid = midPrice(buyRoute, USDC_DECIMALS, tokenDecimals);

  const buys = sizes.map((usd) => {
    const amountIn = BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
    const out = quoteRoute(amountIn, buyRoute);
    const price = fillPrice(amountIn, out, tokenDecimals);
    return { usd, price, impactPct: priceImpactPct(price, mid), out };
  });

  const sells = sizes.map((usd) => {
    // Size the sell in tokens worth `usd` at the mid price, so both sides of
    // the ladder line up on the same notional.
    const tokenAmount = BigInt(Math.round((usd / mid) * 10 ** tokenDecimals));
    const out = quoteRoute(tokenAmount, sellRoute);
    const price = fillPrice(out, tokenAmount, tokenDecimals);
    return { usd, price, impactPct: priceImpactPct(price, mid), out };
  });

  return { buys, sells, mid };
}

/**
 * Rhea's own quote, hop by hop. The authority on what a swap will return, and
 * what the order panel confirms against before the user signs.
 */
export async function quoteRouteOnChain(
  amountIn: bigint,
  route: PoolSide[],
  signal?: AbortSignal,
): Promise<bigint> {
  let amount = amountIn;
  for (const side of route) {
    const out = await view<string>(
      REF_CONTRACT,
      "get_return",
      {
        pool_id: side.poolId,
        token_in: side.tokenIn,
        amount_in: amount.toString(),
        token_out: side.tokenOut,
      },
      signal,
    );
    amount = BigInt(out ?? 0);
    if (amount === 0n) return 0n;
  }
  return amount;
}

export type HopDepth = {
  poolId: number;
  tokenIn: string;
  tokenOut: string;
  /** Total USD in the pool: a simple pool holds equal value on both sides. */
  usd: number;
};

/**
 * USD depth of each pool on a route.
 *
 * Walks forward from USDC, carrying the USD price of each token to the next
 * hop, so a pool that holds no USDC can still be valued. Every figure comes
 * from the reserves themselves - no external price is consulted.
 */
export function routeDepths(
  route: PoolSide[],
  decimalsOf: (tokenId: string) => number,
): HopDepth[] {
  // USDC is the anchor and is worth a dollar by definition here.
  let priceIn = 1;
  const depths: HopDepth[] = [];
  for (const side of route) {
    const dIn = decimalsOf(side.tokenIn);
    const dOut = decimalsOf(side.tokenOut);
    if (!Number.isFinite(dIn) || !Number.isFinite(dOut)) break;
    const reserveInWhole = Number(side.reserveIn) / 10 ** dIn;
    depths.push({
      poolId: side.poolId,
      tokenIn: side.tokenIn,
      tokenOut: side.tokenOut,
      usd: reserveInWhole * priceIn * 2,
    });
    const wholeOutPerWholeIn =
      (Number(side.reserveOut) / Number(side.reserveIn)) * 10 ** (dIn - dOut);
    if (!Number.isFinite(wholeOutPerWholeIn) || wholeOutPerWholeIn === 0) break;
    priceIn /= wholeOutPerWholeIn;
  }
  return depths;
}

/**
 * How much liquidity a route really has: its thinnest pool, not its first.
 *
 * Reporting the first hop would say $1.88M for every market, because they all
 * start at the deep USDC/wNEAR pool. What actually limits a trade is the
 * shallowest pool it passes through - for BRRR that is about $4k, and a
 * trader needs to be told the $4k number, not the $1.88M one.
 */
export function routeLiquidityUsd(depths: HopDepth[]): number {
  if (depths.length === 0) return NaN;
  return Math.min(...depths.map((d) => d.usd));
}

/** `min_amount_out` for a given slippage tolerance, in basis points. */
export function withSlippage(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(5_000, Math.round(slippageBps))));
  return (amount * (10_000n - bps)) / 10_000n;
}

/** The pool fee a route charges, summed across hops, as a percentage. */
export function routeFeePct(route: PoolSide[]): number {
  // Fees compound across hops rather than add, so the survival rate is what
  // multiplies: two 0.3% pools cost 0.5991%, not 0.6%.
  const survives = route.reduce((acc, s) => acc * (1 - s.feeBps / 10_000), 1);
  return (1 - survives) * 100;
}
