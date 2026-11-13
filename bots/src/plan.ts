/**
 * Prints the exact raw amounts for the setup commands, from the live peg.
 *
 * The alternative is a README with numbers baked into it, which go stale the
 * moment NEAR moves - and a pool seeded at a stale ratio starts life mispriced,
 * so the market maker's first act is to correct a gap that should never have
 * existed. Reading the peg at the moment of seeding is the only way the pool
 * opens at the right price.
 *
 * Run it immediately before the add_liquidity command, and paste its numbers in.
 */

import { readPeg } from "./peg.js";
import {
  MIRROR_DECIMALS, MIRROR_SYMBOL, MIRROR_TOKEN_ID, USDC_DECIMALS, USDC_ID,
} from "./config.js";

/** How the 2121.72 tUSDC gets split. Edit here, not in the README. */
const PLAN = {
  poolQuote: 1000,
  makerQuote: 200,
  agentBalance: 200,
  perBot: 150,
  bots: 3,
  /** Base-token inventory the maker keeps, as a share of what the pool holds. */
  makerBaseShare: 0.21,
  mintSupply: 1_000_000,
} as const;

const raw = (human: number, decimals: number): string => {
  const [w, f = ""] = human.toFixed(decimals).split(".");
  return `${w}${f.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
};

async function main(): Promise<void> {
  const peg = await readPeg();
  const poolBase = PLAN.poolQuote / peg;
  const makerBase = poolBase * PLAN.makerBaseShare;
  const quote = USDC_ID.split(".")[0] ?? USDC_ID;

  const total =
    PLAN.poolQuote + PLAN.makerQuote + PLAN.agentBalance + PLAN.perBot * PLAN.bots;

  console.log(`mainnet NEAR right now : $${peg.toFixed(4)}`);
  console.log(`so 1 ${MIRROR_SYMBOL} opens at  : ${peg.toFixed(6)} ${quote}`);
  console.log("");
  console.log(`MINT  (${MIRROR_TOKEN_ID})`);
  console.log(`  total_supply        : ${raw(PLAN.mintSupply, MIRROR_DECIMALS)}   (${PLAN.mintSupply.toLocaleString()} ${MIRROR_SYMBOL})`);
  console.log("");
  console.log("POOL  seed at the peg");
  console.log(`  ${quote.padEnd(19)} : ${raw(PLAN.poolQuote, USDC_DECIMALS)}   (${PLAN.poolQuote} ${quote})`);
  console.log(`  ${MIRROR_SYMBOL.padEnd(19)} : ${raw(poolBase, MIRROR_DECIMALS)}   (${poolBase.toFixed(6)} ${MIRROR_SYMBOL})`);
  console.log(`  add_liquidity amounts: ["${raw(PLAN.poolQuote, USDC_DECIMALS)}","${raw(poolBase, MIRROR_DECIMALS)}"]`);
  console.log(`  (that ordering assumes tokens: ["${USDC_ID}","${MIRROR_TOKEN_ID}"] - check get_pool and swap if reversed)`);
  console.log("");
  console.log("MAKER inventory, so it can correct both directions");
  console.log(`  ${quote.padEnd(19)} : ${raw(PLAN.makerQuote, USDC_DECIMALS)}   (${PLAN.makerQuote} ${quote})`);
  console.log(`  ${MIRROR_SYMBOL.padEnd(19)} : ${raw(makerBase, MIRROR_DECIMALS)}   (${makerBase.toFixed(6)} ${MIRROR_SYMBOL})`);
  console.log("");
  console.log("WINCUT balances to fund");
  console.log(`  agent               : ${raw(PLAN.agentBalance, USDC_DECIMALS)}   (${PLAN.agentBalance} ${quote}, so its 20% cap is ${(PLAN.agentBalance * 0.2).toFixed(0)} - about ${((PLAN.agentBalance * 0.2) / PLAN.poolQuote * 100).toFixed(1)}% of pool depth)`);
  for (let i = 1; i <= PLAN.bots; i++) {
    console.log(`  bot ${i}               : ${raw(PLAN.perBot, USDC_DECIMALS)}   (${PLAN.perBot} ${quote})`);
  }
  console.log("");
  console.log(`TOTAL ${quote} this plan spends : ${total}`);
  console.log(`  you hold 2121.72, so ${(2121.72 - total).toFixed(2)} stays with your own test account`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
