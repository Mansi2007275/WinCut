/**
 * What NEAR is really worth, and what our pool thinks MNEAR is worth.
 *
 * The peg is read from mainnet Rhea's deepest wNEAR/USDC pool over plain RPC.
 * It is deliberately the same kind of source the app itself uses rather than a
 * price API: one fewer service that can start returning a stale number without
 * saying so.
 *
 * If the peg cannot be read, the market maker does nothing. A maker that keeps
 * trading against its last known price is a maker that walks the pool somewhere
 * nobody asked it to go.
 */

import { getPool, viewMainnet } from "./chain.js";
import {
  MIRROR_DECIMALS, MIRROR_POOL_ID, MIRROR_TOKEN_ID, PEG, REF_CONTRACT, USDC_DECIMALS, USDC_ID,
} from "./config.js";

/** USD per NEAR, from mainnet. */
export async function readPeg(): Promise<number> {
  const out = await viewMainnet<string>(PEG.mainnetRef, "get_return", {
    pool_id: PEG.poolId,
    token_in: PEG.wnear,
    amount_in: (10n ** BigInt(PEG.wnearDecimals)).toString(),
    token_out: PEG.usdc,
  });
  const price = Number(out) / 10 ** PEG.usdcDecimals;
  if (!(price > 0) || !Number.isFinite(price)) throw new Error(`mainnet peg came back as ${out}`);
  return price;
}

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

export async function readPool(): Promise<PoolState> {
  if (!MIRROR_POOL_ID) {
    throw new Error("MIRROR_POOL_ID is not set - create the pool first, see bots/README.md");
  }
  const pool = await getPool(REF_CONTRACT, MIRROR_POOL_ID);
  const iU = pool.token_account_ids.indexOf(USDC_ID);
  const iT = pool.token_account_ids.indexOf(MIRROR_TOKEN_ID);
  if (iU < 0 || iT < 0) {
    throw new Error(
      `pool #${MIRROR_POOL_ID} holds ${pool.token_account_ids.join(" / ")}, not ${USDC_ID} and ${MIRROR_TOKEN_ID}`,
    );
  }
  const usdcRaw = BigInt(pool.amounts[iU]!);
  const tokenRaw = BigInt(pool.amounts[iT]!);
  if (usdcRaw <= 0n || tokenRaw <= 0n) throw new Error(`pool #${MIRROR_POOL_ID} has an empty side`);

  const usdcReserve = Number(usdcRaw) / 10 ** USDC_DECIMALS;
  const tokenReserve = Number(tokenRaw) / 10 ** MIRROR_DECIMALS;
  return {
    price: usdcReserve / tokenReserve,
    usdcReserve,
    tokenReserve,
    usdcRaw,
    tokenRaw,
    feePct: pool.total_fee / 100,
  };
}

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

/** `npm run peg` - prints the peg and the pool side by side. */
async function main(): Promise<void> {
  const peg = await readPeg();
  console.log(`mainnet NEAR : $${peg.toFixed(4)}  (${PEG.mainnetRef} pool #${PEG.poolId})`);
  try {
    const pool = await readPool();
    const driftPct = ((pool.price - peg) / peg) * 100;
    console.log(`our pool     : ${pool.price.toFixed(4)} ${USDC_ID.split(".")[0]} per token`);
    console.log(`drift        : ${driftPct >= 0 ? "+" : ""}${driftPct.toFixed(3)}%`);
    console.log(`depth        : ${pool.usdcReserve.toFixed(2)} quote / ${pool.tokenReserve.toFixed(4)} base, fee ${pool.feePct}%`);
    const t = tradeToReachPrice(pool.usdcReserve, pool.tokenReserve, peg);
    console.log(`to re-peg    : ${t.side} with ${t.usdcAmount.toFixed(4)} quote units`);
  } catch (e) {
    console.log(`our pool     : ${(e as Error).message}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("peg.ts")) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
