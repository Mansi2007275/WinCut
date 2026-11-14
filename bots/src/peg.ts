/**
 * What the real tokens are worth, and what our pools think the mirrors are.
 *
 * Every peg is read from mainnet Rhea over plain RPC. It is deliberately the
 * same kind of source the app itself uses rather than a price API: one fewer
 * service that can start returning a stale number without saying so.
 *
 * Prices come from pool *reserves*, not from `get_return`. Asking what one NEAR
 * would fetch answers a different question - the price after your own trade -
 * and pegging to that would bake our own slippage into the target. Reserves
 * give the mid, which is the number we actually mean.
 *
 * Most memecoins on Rhea are quoted against wNEAR rather than a stablecoin, so
 * their dollar price is two reads multiplied together: how many of the token
 * one NEAR buys, and what a NEAR is worth. `viaWnear` on the market says which
 * shape it is and nothing downstream has to care.
 *
 * If a peg cannot be read, the market maker does nothing for that market. A
 * maker that keeps trading against its last known price is a maker that walks
 * the pool somewhere nobody asked it to go.
 */

import { getPool, viewMainnet } from "./chain.js";
import {
  LIVE_MARKETS, MARKETS, PEG, REF_CONTRACT, USDC_DECIMALS, USDC_ID, type MarketConfig,
} from "./config.js";

type RawPool = { token_account_ids: string[]; amounts: string[]; total_fee: number };

const mainnetPool = (poolId: number): Promise<RawPool> =>
  viewMainnet<RawPool>(PEG.mainnetRef, "get_pool", { pool_id: poolId });

/** Human-scale reserves of one pool, keyed by the two token accounts. */
function reserves(pool: RawPool, a: string, aDec: number, b: string, bDec: number) {
  const iA = pool.token_account_ids.indexOf(a);
  const iB = pool.token_account_ids.indexOf(b);
  if (iA < 0 || iB < 0) {
    throw new Error(`pool holds ${pool.token_account_ids.join(" / ")}, not ${a} and ${b}`);
  }
  const rA = Number(pool.amounts[iA]!) / 10 ** aDec;
  const rB = Number(pool.amounts[iB]!) / 10 ** bDec;
  if (!(rA > 0) || !(rB > 0)) throw new Error("that pool has an empty side");
  return { rA, rB };
}

/** USD per NEAR, from mainnet Rhea's deepest wNEAR/USDC pool. */
export async function readNearUsd(): Promise<number> {
  const pool = await mainnetPool(PEG.poolId);
  const { rA, rB } = reserves(pool, PEG.usdc, PEG.usdcDecimals, PEG.wnear, PEG.wnearDecimals);
  const price = rA / rB;
  if (!(price > 0) || !Number.isFinite(price)) throw new Error("the NEAR peg came back unusable");
  return price;
}

/** USD per whole unit of the real token this market mirrors. */
export async function readPegFor(market: MarketConfig): Promise<number> {
  const nearUsd = await readNearUsd();
  if (!market.peg.viaWnear) return nearUsd;

  const pool = await mainnetPool(market.peg.poolId);
  const { rA, rB } = reserves(
    pool, market.peg.token, market.peg.decimals, PEG.wnear, PEG.wnearDecimals,
  );
  // rA tokens sit against rB wNEAR, so one NEAR is worth rA/rB tokens.
  const tokensPerNear = rA / rB;
  const price = nearUsd / tokensPerNear;
  if (!(price > 0) || !Number.isFinite(price)) {
    throw new Error(`${market.mirrors} priced out as ${price}`);
  }
  return price;
}

/** The original single-market entry point, kept for `MNEAR`-only callers. */
export const readPeg = (): Promise<number> => readPegFor(MARKETS[0]!);

export type PoolState = {
  /** Quote units per whole mirror token, from the reserves. */
  price: number;
  /** Quote-side reserve, human scale. */
  usdcReserve: number;
  /** Base-side reserve, human scale. */
  tokenReserve: number;
  usdcRaw: bigint;
  tokenRaw: bigint;
  feePct: number;
};

export async function readPoolFor(market: MarketConfig): Promise<PoolState> {
  if (!market.poolId) {
    throw new Error(`${market.symbol} has no pool yet - create it first, see bots/README.md`);
  }
  const pool = await getPool(REF_CONTRACT, market.poolId);
  const iU = pool.token_account_ids.indexOf(USDC_ID);
  const iT = pool.token_account_ids.indexOf(market.tokenId);
  if (iU < 0 || iT < 0) {
    throw new Error(
      `pool #${market.poolId} holds ${pool.token_account_ids.join(" / ")}, not ${USDC_ID} and ${market.tokenId}`,
    );
  }
  const usdcRaw = BigInt(pool.amounts[iU]!);
  const tokenRaw = BigInt(pool.amounts[iT]!);
  if (usdcRaw <= 0n || tokenRaw <= 0n) throw new Error(`pool #${market.poolId} has an empty side`);

  const usdcReserve = Number(usdcRaw) / 10 ** USDC_DECIMALS;
  const tokenReserve = Number(tokenRaw) / 10 ** market.decimals;
  return {
    price: usdcReserve / tokenReserve,
    usdcReserve,
    tokenReserve,
    usdcRaw,
    tokenRaw,
    feePct: pool.total_fee / 100,
  };
}

export const readPool = (): Promise<PoolState> => readPoolFor(MARKETS[0]!);

/**
 * The trade that moves a constant-product pool to a target price.
 *
 * For reserves x (quote) and y (base), price p = x/y and k = x·y are both
 * known, so the reserves at any target price follow directly:
 * x' = √(k·p'), and the trade is the difference. Solving it rather than
 * nudging and re-reading means one transaction instead of a loop, and no risk
 * of a loop that never converges because each nudge pays another fee.
 *
 * Returns the quote amount to add (positive) or remove (negative), ignoring
 * fees - the fee makes the correction land slightly short of the target, which
 * is the right direction to err.
 */
export function tradeToReachPrice(
  usdcReserve: number,
  tokenReserve: number,
  targetPrice: number,
): { side: "buy-token" | "sell-token"; usdcAmount: number } {
  const k = usdcReserve * tokenReserve;
  const targetUsdc = Math.sqrt(k * targetPrice);
  const delta = targetUsdc - usdcReserve;
  return delta >= 0
    ? { side: "buy-token", usdcAmount: delta }
    : { side: "sell-token", usdcAmount: -delta };
}

/**
 * Enough significant figures to be readable at any scale.
 *
 * A memecoin mirror trades near 0.0000000056, and `toFixed(4)` prints that as
 * 0.0000 - which is not a rounding problem but a reporting one: it says the
 * price is zero. Significant digits say what the price is at every scale.
 */
export const fmtPrice = (p: number, sig = 6): string =>
  !Number.isFinite(p) ? "n/a" : p >= 0.001 ? p.toFixed(6) : p.toPrecision(sig);

/** `npm run peg` - prints every live market against its real counterpart. */
async function main(): Promise<void> {
  const quote = USDC_ID.split(".")[0] ?? USDC_ID;
  const live = LIVE_MARKETS();
  if (!live.length) {
    console.log("no market has a pool yet - nothing to compare");
    return;
  }
  for (const m of live) {
    console.log(`\n${m.symbol}  (mirrors ${m.mirrors}, our pool #${m.poolId})`);
    let peg: number;
    try {
      peg = await readPegFor(m);
    } catch (e) {
      console.log(`  peg        : ${(e as Error).message}`);
      continue;
    }
    console.log(`  real price : $${fmtPrice(peg)}`);
    try {
      const pool = await readPoolFor(m);
      const driftPct = ((pool.price - peg) / peg) * 100;
      console.log(`  our pool   : ${fmtPrice(pool.price)} ${quote} per token`);
      console.log(`  drift      : ${driftPct >= 0 ? "+" : ""}${driftPct.toFixed(3)}%`);
      console.log(
        `  depth      : ${pool.usdcReserve.toFixed(2)} quote / ` +
        `${pool.tokenReserve.toLocaleString("en-US", { maximumFractionDigits: 4 })} base, fee ${pool.feePct}%`,
      );
      const t = tradeToReachPrice(pool.usdcReserve, pool.tokenReserve, peg);
      console.log(`  to re-peg  : ${t.side} with ${t.usdcAmount.toFixed(4)} quote units`);
    } catch (e) {
      console.log(`  our pool   : ${(e as Error).message}`);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith("peg.ts")) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
