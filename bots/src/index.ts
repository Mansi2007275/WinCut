/**
 * The loop that runs the market.
 *
 * One process, four actors on their own clocks: the maker checks the peg every
 * minute, and the three traders act on their own intervals so they do not all
 * arrive at the same price. Between them the pool gets real swaps, WinCut gets
 * real settled trades, and the price series gets real prices - which is the
 * entire reason this package exists.
 *
 * Price history is kept here, from this process's own pool reads, and handed to
 * the strategies. That keeps the bots independent of the web app being up, and
 * means a strategy is always reasoning about prices this process observed
 * rather than something it was told.
 */

import {
  BOTS, DRY_RUN, MIRROR_POOL_ID, MIRROR_SYMBOL, MM_ACCOUNT_ID, MM_EVERY_MS, MM_PRIVATE_KEY,
  RUN_ONCE, USDC_DECIMALS, describeConfig,
} from "./config.js";
import { readPeg, readPool } from "./peg.js";
import { runMaker } from "./mm.js";
import { PriceHistory, runBot } from "./traders.js";
import { storePoint, storeConfigured } from "./store.js";

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...parts: unknown[]) => console.log(`[${stamp()}]`, ...parts);

const history = new PriceHistory();

/** Reads the pool, records the price, and keeps the series fed. */
async function tick(): Promise<number | undefined> {
  try {
    const pool = await readPool();
    history.push(pool.price);
    // The same series the chart reads. Written as a `trade` point only when the
    // bots have actually traded; a plain observation is a sample, which is what
    // it is.
    await storePoint(MIRROR_POOL_ID, pool.price, "sample");
    return pool.price;
  } catch (e) {
    log(`pool read failed: ${(e as Error).message}`);
    return undefined;
  }
}

async function makerPass(): Promise<void> {
  try {
    const r = await runMaker((s) => console.log(`[${stamp()}] ${s}`));
    log(
      `maker: peg $${r.peg.toFixed(4)} · pool ${r.poolPrice.toFixed(4)} · ` +
      `drift ${r.driftPct >= 0 ? "+" : ""}${r.driftPct.toFixed(3)}% · ${r.note}`,
    );
  } catch (e) {
    log(`maker: ${(e as Error).message}`);
  }
}

async function tradersPass(due: typeof BOTS): Promise<void> {
  const price = history.last();
  if (price === undefined) {
    log("traders: no price observed yet - holding");
    return;
  }
  for (const bot of due) {
    try {
      const pass = await runBot(bot, history, (s) => console.log(`[${stamp()}] ${s}`));
      if (pass.txHash) await storePoint(MIRROR_POOL_ID, history.last() ?? price, "trade");
    } catch (e) {
      log(`  ${bot.accountId.split(".")[0]}: pass failed - ${(e as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  log(`WinCut bots starting on ${MIRROR_SYMBOL}`);
  console.log(describeConfig());

  if (!MIRROR_POOL_ID) {
    console.error(
      "\nMIRROR_POOL_ID is not set, so there is no pool to make a market in.\n" +
      "Create the token and the pool first - bots/README.md has the commands.",
    );
    process.exit(1);
  }
  if (!storeConfigured) {
    log("no Upstash credentials: the bots will trade but the chart will not keep their prices");
  }
  if (!MM_PRIVATE_KEY) {
    log(`no MM_PRIVATE_KEY: the peg will drift, because ${MM_ACCOUNT_ID} cannot act`);
  }
  const keyless = BOTS.filter((b) => !b.privateKey);
  if (keyless.length) {
    log(`${keyless.length} of ${BOTS.length} bots have no key and will only print what they would do`);
  }
  if (DRY_RUN) log("DRY RUN - real data, real decisions, nothing signed");

  try {
    const peg = await readPeg();
    log(`mainnet NEAR is $${peg.toFixed(4)} - that is what ${MIRROR_SYMBOL} tracks`);
  } catch (e) {
    log(`could not read the peg: ${(e as Error).message}`);
  }

  const price = await tick();
  if (price !== undefined) log(`pool opens at ${price.toFixed(6)} per ${MIRROR_SYMBOL}`);

  if (RUN_ONCE) {
    await makerPass();
    await tradersPass(BOTS);
    log("single pass done");
    return;
  }

  // Each actor keeps its own next-due time, so a slow RPC call delays one bot
  // rather than shifting the whole schedule.
  let makerDue = Date.now();
  const botDue = new Map(BOTS.map((b) => [b.accountId, Date.now() + Math.random() * b.everyMs]));
  const TICK_MS = 20_000;

  for (;;) {
    await tick();

    const now = Date.now();
    if (now >= makerDue) {
      await makerPass();
      makerDue = now + MM_EVERY_MS;
    }

    const due = BOTS.filter((b) => now >= (botDue.get(b.accountId) ?? 0));
    if (due.length) {
      await tradersPass(due);
      for (const b of due) botDue.set(b.accountId, Date.now() + b.everyMs);
    }

    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

main().catch((e) => {
  console.error("bots stopped:", (e as Error).message);
  process.exit(1);
});
