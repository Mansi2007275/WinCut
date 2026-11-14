/**
 * Prints the exact raw amounts for the setup commands, from the live pegs.
 *
 * The alternative is a README with numbers baked into it, which go stale the
 * moment the real token moves - and a pool seeded at a stale ratio starts life
 * mispriced, so the market maker's first act is to correct a gap that should
 * never have existed. Reading the peg at the moment of seeding is the only way
 * a pool opens at the right price.
 *
 * Run it immediately before each `add_liquidity` and paste its numbers in. For
 * the memecoin mirrors that matters more than it did for MNEAR: BLACKDRAGON can
 * move several percent in the time it takes to run four commands, and a pool
 * seeded 5% off opens with the maker already fighting it.
 */

import { readPegFor } from "./peg.js";
import { MARKETS, USDC_DECIMALS, USDC_ID, type MarketConfig } from "./config.js";

/**
 * How much capital each market gets. Edit here, not in the README.
 *
 * The mint supply is a round number rather than a multiple of the seed, because
 * it has to be fixed *before* the peg is read - the token exists before the
 * pool does. Each is comfortably more than the pool and the maker need, so a
 * price move between minting and seeding cannot leave us short, and the surplus
 * simply stays with the owner.
 */
const PLAN: Record<string, { poolQuote: number; makerQuote: number; mintSupply: number }> = {
  MNEAR:   { poolQuote: 1000, makerQuote: 200, mintSupply: 1_000_000 },
  MDRAGON: { poolQuote: 400,  makerQuote: 60,  mintSupply: 500_000_000_000 },
  MSHITZU: { poolQuote: 400,  makerQuote: 60,  mintSupply: 2_000_000 },
  MLONK:   { poolQuote: 400,  makerQuote: 60,  mintSupply: 20_000_000_000 },
};

/** Base-token inventory the maker keeps, as a share of what the pool holds. */
const MAKER_BASE_SHARE = 0.2;

/**
 * A human amount as raw integer units, without going through a float.
 *
 * `toFixed` on 7.1e10 with 6 decimals is still exact, but the memecoin seeds
 * run to eleven significant digits and a float would start deciding the last
 * one. Splitting the decimal string keeps every digit the caller asked for.
 */
const raw = (human: number, decimals: number): string => {
  const fixed = human.toFixed(decimals);
  const [w, f = ""] = fixed.split(".");
  const out = `${w}${f.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return out;
};

const num = (n: number): string =>
  n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toPrecision(8);

const fmt = (p: number): string => (p >= 0.001 ? p.toFixed(6) : p.toPrecision(6));

async function one(market: MarketConfig): Promise<void> {
  const plan = PLAN[market.symbol];
  const quote = USDC_ID.split(".")[0] ?? USDC_ID;
  if (!plan) {
    console.log(`\n${market.symbol}: no plan entry - add one in plan.ts`);
    return;
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`${market.symbol}  mirrors ${market.mirrors}  (${market.decimals} decimals)`);
  console.log(`  our pool  : ${market.poolId ? `#${market.poolId}` : "NOT CREATED YET"}`);

  let peg: number;
  try {
    peg = await readPegFor(market);
  } catch (e) {
    console.log(`  peg       : UNREADABLE - ${(e as Error).message}`);
    console.log("  do not seed this pool until the peg reads.");
    return;
  }

  const poolBase = plan.poolQuote / peg;
  const makerBase = poolBase * MAKER_BASE_SHARE;

  console.log(`  ${market.mirrors} right now : $${fmt(peg)}`);
  console.log(`  so 1 ${market.symbol} opens at ${fmt(peg)} ${quote}`);
  console.log("");
  console.log(`  MINT  ${market.tokenId}`);
  console.log(`    total_supply : ${raw(plan.mintSupply, market.decimals)}`);
  console.log(`                   (${num(plan.mintSupply)} ${market.symbol})`);
  console.log("");
  console.log(`  POOL  seed at the peg`);
  console.log(`    ${quote.padEnd(12)} : ${raw(plan.poolQuote, USDC_DECIMALS)}   (${plan.poolQuote} ${quote})`);
  console.log(`    ${market.symbol.padEnd(12)} : ${raw(poolBase, market.decimals)}   (${num(poolBase)} ${market.symbol})`);
  console.log(
    `    add_liquidity amounts: ["${raw(plan.poolQuote, USDC_DECIMALS)}","${raw(poolBase, market.decimals)}"]`,
  );
  console.log(`    (assumes tokens: ["${USDC_ID}","${market.tokenId}"] - check get_pool and swap if reversed)`);
  console.log("");
  console.log(`  MAKER inventory, so it can correct both directions`);
  console.log(`    ${quote.padEnd(12)} : ${raw(plan.makerQuote, USDC_DECIMALS)}   (${plan.makerQuote} ${quote})`);
  console.log(`    ${market.symbol.padEnd(12)} : ${raw(makerBase, market.decimals)}   (${num(makerBase)} ${market.symbol})`);
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-")).map((a) => a.toUpperCase());
  const markets = wanted.length ? MARKETS.filter((m) => wanted.includes(m.symbol)) : MARKETS;
  if (!markets.length) {
    console.error(`no market matched ${wanted.join(", ")}. Known: ${MARKETS.map((m) => m.symbol).join(", ")}`);
    process.exit(1);
  }

  for (const m of markets) await one(m);

  const quote = USDC_ID.split(".")[0] ?? USDC_ID;
  const total = markets.reduce((s, m) => s + (PLAN[m.symbol]?.poolQuote ?? 0) + (PLAN[m.symbol]?.makerQuote ?? 0), 0);
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${quote} this plan spends across ${markets.length} market(s): ${total}`);
  console.log("(pools already seeded do not need their share again - check the pool line above)");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
