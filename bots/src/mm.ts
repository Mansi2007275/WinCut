/**
 * The market maker.
 *
 * Its whole job is to make a pool's price mean something. Left alone, three
 * trader bots pushing each other around would walk the price to wherever their
 * last argument ended, and the chart would be a real record of nothing. The
 * maker ties it back to a number that exists outside this system: what the real
 * token is actually worth on mainnet right now.
 *
 * It swaps on Rhea directly rather than through WinCut, which is the honest
 * place for it. It is not a trader taking a view; it is the thing that makes a
 * view possible. Putting it on the leaderboard next to the traders would be
 * claiming it was competing with them.
 *
 * Three rules keep it from doing damage:
 *   - it does nothing at all unless that market's peg was read successfully
 *   - it only acts outside a band, so the traders own the price inside it
 *   - it closes a fraction of the gap, capped in absolute size, so one strange
 *     read cannot walk the pool anywhere interesting
 *
 * It runs per market, and a market it cannot read is skipped rather than
 * allowed to abort the others: four markets sharing one try/catch would mean
 * one unreachable mainnet pool froze every peg we have.
 */

import {
  getReturn, refSwap, refWithdraw, getDeposits, ftBalanceOf, signerFor, explorerTx,
} from "./chain.js";
import {
  DRY_RUN, MM_ACCOUNT_ID, MM_PRIVATE_KEY, PEG_BAND_PCT, PEG_CORRECTION, PEG_MAX_TRADE_USDC,
  REF_CONTRACT, SLIPPAGE_BPS, USDC_DECIMALS, USDC_ID, type MarketConfig,
} from "./config.js";
import { fmtPrice, readPegFor, readPoolFor, tradeToReachPrice } from "./peg.js";
import { storeSwap } from "./store.js";

const toRaw = (human: number, decimals: number): bigint => {
  const [w, f = ""] = human.toFixed(decimals).split(".");
  return BigInt(`${w}${f.padEnd(decimals, "0")}`);
};

const applySlippage = (amount: bigint): bigint => (amount * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;

export type MakerResult = {
  market: MarketConfig;
  peg: number;
  poolPrice: number;
  driftPct: number;
  acted: boolean;
  note: string;
  txHash?: string;
};

export async function runMaker(
  market: MarketConfig,
  log: (s: string) => void,
): Promise<MakerResult> {
  const peg = await readPegFor(market);
  const pool = await readPoolFor(market);
  const driftPct = ((pool.price - peg) / peg) * 100;

  const base: Omit<MakerResult, "acted" | "note"> = {
    market, peg, poolPrice: pool.price, driftPct,
  };

  if (Math.abs(driftPct) <= PEG_BAND_PCT) {
    return {
      ...base,
      acted: false,
      note: `inside the ±${PEG_BAND_PCT}% band - leaving the price to the traders`,
    };
  }

  const plan = tradeToReachPrice(pool.usdcReserve, pool.tokenReserve, peg);
  const wanted = Math.min(plan.usdcAmount * PEG_CORRECTION, PEG_MAX_TRADE_USDC);
  if (!(wanted > 0.01)) {
    return { ...base, acted: false, note: "the correction rounds to nothing" };
  }

  if (!MM_PRIVATE_KEY) {
    return {
      ...base,
      acted: false,
      note: `would ${plan.side} with ${wanted.toFixed(4)} quote units, but MM_PRIVATE_KEY is not set`,
    };
  }

  const account = signerFor(MM_ACCOUNT_ID, MM_PRIVATE_KEY);

  // Which way round the swap goes, and what the maker must already hold to do it.
  const buyingToken = plan.side === "buy-token";
  const tokenIn = buyingToken ? USDC_ID : market.tokenId;
  const tokenOut = buyingToken ? market.tokenId : USDC_ID;
  const decimalsIn = buyingToken ? USDC_DECIMALS : market.decimals;

  // For a sell the maker spends base units, so convert the planned quote amount.
  const amountInHuman = buyingToken ? wanted : wanted / pool.price;
  let amountIn = toRaw(amountInHuman, decimalsIn);
  if (amountIn <= 0n) {
    return {
      ...base,
      acted: false,
      note: `a ${driftPct.toFixed(2)}% correction rounds below one raw unit of ${tokenIn.split(".")[0]}`,
    };
  }

  const held = BigInt(await ftBalanceOf(tokenIn, MM_ACCOUNT_ID));
  if (held <= 0n) {
    return {
      ...base,
      acted: false,
      note: `needs ${tokenIn.split(".")[0]} to correct a ${driftPct.toFixed(2)}% drift and holds none - top it up`,
    };
  }
  if (amountIn > held) {
    // Correct as far as the inventory allows rather than failing outright: a
    // partial re-peg is better than a drifting pool and a crashed bot.
    amountIn = held;
    log(`  ${market.symbol}: inventory-limited, correcting with everything it holds instead`);
  }

  const expected = BigInt(await getReturn(REF_CONTRACT, market.poolId, tokenIn, tokenOut, amountIn));
  const minOut = applySlippage(expected);

  log(
    `  ${market.symbol}: ${plan.side} ${(Number(amountIn) / 10 ** decimalsIn).toFixed(6)} ` +
    `${tokenIn.split(".")[0]} -> at least ` +
    `${(Number(minOut) / 10 ** (buyingToken ? market.decimals : USDC_DECIMALS)).toFixed(6)}`,
  );

  if (DRY_RUN) {
    return {
      ...base,
      acted: false,
      note: `dry run - would ${plan.side} to close ${driftPct.toFixed(2)}% drift`,
    };
  }

  const txHash = await refSwap(account, REF_CONTRACT, tokenIn, amountIn, market.poolId, tokenOut, minOut);
  log(`  ${market.symbol}: swapped ${explorerTx(txHash)}`);

  // Notional in quote units, whichever way round the swap went, so the
  // activity panel can count volume the WinCut trade log never sees.
  const notional = buyingToken
    ? Number(amountIn) / 10 ** USDC_DECIMALS
    : Number(expected) / 10 ** USDC_DECIMALS;
  await storeSwap(market.poolId, {
    t: Date.now(),
    usdc: notional,
    side: buyingToken ? "buy" : "sell",
  });

  // Rhea credits the output to its own internal balance; pull it back so the
  // maker's inventory is visible on chain and usable next pass.
  try {
    const deposits = await getDeposits(REF_CONTRACT, MM_ACCOUNT_ID);
    for (const [token, amount] of Object.entries(deposits)) {
      const raw = BigInt(amount);
      if (raw > 0n) await refWithdraw(account, REF_CONTRACT, token, raw);
    }
  } catch (e) {
    // Not fatal: the balance stays inside Rhea and the next pass withdraws it.
    log(`  ${market.symbol}: could not withdraw from Rhea yet - ${(e as Error).message}`);
  }

  return {
    ...base,
    acted: true,
    note: `corrected a ${driftPct.toFixed(2)}% drift at ${fmtPrice(pool.price)}`,
    txHash,
  };
}
