/**
 * The loop that runs the market.
 *
 * One process, four actors on their own clocks, across every mirror market that
 * has a pool: the maker checks each peg every minute, and the three traders act
 * on their own intervals so they do not all arrive at the same price. Between
 * them the pools get real swaps, WinCut gets real settled trades, and the price
 * series gets real prices - which is the entire reason this package exists.
 *
 * Price history is kept here, per market, from this process's own pool reads and
 * handed to the strategies. That keeps the bots independent of the web app
 * being up, and means a strategy is always reasoning about prices this process
 * observed rather than something it was told.
 *
 * Each bot rotates through the markets rather than trading all of them every
 * pass. Trading four markets at once would quadruple a bot's exposure without
 * changing any of its limits, and would make its daily cap mean something
 * different from what it says.
 */

import {
  BOTS, DRY_RUN, LIVE_MARKETS, MARKETS, MM_ACCOUNT_ID, MM_EVERY_MS, MM_PRIVATE_KEY,
  RUN_ONCE, TICK_MS, VIEW_CACHE_MS, describeConfig, type MarketConfig,
} from "./config.js";
import { fmtPrice, readNearUsd, readPoolFor } from "./peg.js";
import { runMaker } from "./mm.js";
import { PriceHistory, runBot } from "./traders.js";
import { storePoint, storeConfigured } from "./store.js";
import { rpcReport } from "./chain.js";

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...parts: unknown[]) => console.log(`[${stamp()}]`, ...parts);

/** One price history per market, because a strategy must not mix two series. */
const histories = new Map<number, PriceHistory>();

/**
 * The quote-side depth each pool last reported.
 *
 * Kept from the same read that feeds the price series, so capping a trade
 * against the pool costs no extra RPC call. A market whose depth has not been
 * read yet caps on balance alone, which is the old behaviour rather than a
 * guess at a number we do not have.
 */
const depths = new Map<number, number>();

const historyFor = (market: MarketConfig): PriceHistory => {
  let h = histories.get(market.poolId);
  if (!h) {
    h = new PriceHistory();
    histories.set(market.poolId, h);
  }
  return h;
};

/** Reads every live pool, records the prices, and keeps the series fed. */
async function tick(): Promise<void> {
  for (const market of LIVE_MARKETS()) {
    try {
      const pool = await readPoolFor(market);
      historyFor(market).push(pool.price);
      depths.set(market.poolId, pool.usdcReserve);
      // The same series the chart reads. Written as a `trade` point only when
      // the bots have actually traded; a plain observation is a sample, which
      // is what it is.
      await storePoint(market.poolId, pool.price, "sample");
    } catch (e) {
      log(`${market.symbol}: pool read failed - ${(e as Error).message}`);
    }
  }
}

async function makerPass(): Promise<void> {
  for (const market of LIVE_MARKETS()) {
    try {
      const r = await runMaker(market, (s) => console.log(`[${stamp()}] ${s}`));
      log(
        `maker ${market.symbol}: real $${fmtPrice(r.peg)} · pool ${fmtPrice(r.poolPrice)} · ` +
        `drift ${r.driftPct >= 0 ? "+" : ""}${r.driftPct.toFixed(3)}% · ${r.note}`,
      );
    } catch (e) {
      // One unreachable mainnet pool must not freeze the other three pegs.
      log(`maker ${market.symbol}: ${(e as Error).message}`);
    }
  }
}

/** Which market each bot trades next, so they move through them in turn. */
const rotation = new Map<string, number>();

function nextMarket(accountId: string, live: MarketConfig[]): MarketConfig {
  const i = rotation.get(accountId) ?? Math.floor(Math.random() * live.length);
  rotation.set(accountId, (i + 1) % live.length);
  return live[i % live.length]!;
}

async function tradersPass(due: typeof BOTS): Promise<void> {
  const live = LIVE_MARKETS();
  if (!live.length) return;

  for (const bot of due) {
    const market = nextMarket(bot.accountId, live);
    const history = historyFor(market);
    if (history.last() === undefined) {
      log(`  ${bot.accountId.split(".")[0]} ${market.symbol}: no price observed yet - holding`);
      continue;
    }
    try {
      const pass = await runBot(
        bot, market, history, (s) => console.log(`[${stamp()}] ${s}`), depths.get(market.poolId),
      );
      if (pass.txHash) {
        // Re-read so the recorded point is the price the trade left behind
        // rather than the one it was decided on. Worth one extra call: a trade
        // point that reports the pre-trade price is the one point in the series
        // that is actively wrong, and it is the point a chart draws a candle
        // from. Everything else that could be re-read here is left to the next
        // tick, which is at most 20 seconds away.
        try {
          const after = await readPoolFor(market, true);
          history.push(after.price);
          depths.set(market.poolId, after.usdcReserve);
          await storePoint(market.poolId, after.price, "trade");
        } catch {
          await storePoint(market.poolId, history.last()!, "trade");
        }
      }
    } catch (e) {
      log(`  ${bot.accountId.split(".")[0]} ${market.symbol}: pass failed - ${(e as Error).message}`);
    }
  }
}

/**
 * What this process is about to ask the network for, per minute.
 *
 * Printed because the number was invisible until an endpoint started refusing
 * calls, and because it is the figure that changes when a market is added. It
 * counts calls before the cache, then states what the cache is expected to
 * remove, so both numbers are in front of you rather than one flattering one.
 */
function estimateLoad(markets: number): string {
  const ticksPerMin = 60_000 / TICK_MS;
  const makerPassesPerMin = 60_000 / MM_EVERY_MS;
  const botPassesPerMin = BOTS.reduce((s, b) => s + 60_000 / b.everyMs, 0);

  // One get_pool per market per tick.
  const tickCalls = ticksPerMin * markets;
  // Per market: our pool, the mainnet NEAR pool, and the token's mainnet pool.
  const makerCalls = makerPassesPerMin * markets * 3;
  // Per pass: balance, positions, and one quote.
  const botCalls = botPassesPerMin * 3;
  const total = tickCalls + makerCalls + botCalls;

  return (
    `expecting about ${Math.round(total)} rpc call(s)/min before caching ` +
    `(${Math.round(tickCalls)} sampling ${markets} market(s) every ${TICK_MS / 1000}s, ` +
    `${Math.round(makerCalls)} maker every ${MM_EVERY_MS / 1000}s, ` +
    `${Math.round(botCalls)} from ${BOTS.length} bots) · ` +
    `a ${VIEW_CACHE_MS / 1000}s cache should remove most of the repeats`
  );
}

async function main(): Promise<void> {
  log("WinCut bots starting");
  console.log(describeConfig());

  const live = LIVE_MARKETS();
  if (!live.length) {
    console.error(
      "\nNo market has a pool id, so there is nothing to make a market in.\n" +
      "Create the tokens and the pools first - bots/README.md has the commands.",
    );
    process.exit(1);
  }
  const pending = MARKETS.filter((m) => !m.poolId);
  if (pending.length) {
    log(`${pending.map((m) => m.symbol).join(", ")} have no pool yet and are skipped`);
  }
  if (!storeConfigured) {
    log("no Upstash credentials: the bots will trade but the chart will not keep their prices");
  }
  if (!MM_PRIVATE_KEY) {
    log(`no MM_PRIVATE_KEY: every peg will drift, because ${MM_ACCOUNT_ID} cannot act`);
  }
  const keyless = BOTS.filter((b) => !b.privateKey);
  if (keyless.length) {
    log(`${keyless.length} of ${BOTS.length} bots have no key and will only print what they would do`);
  }
  if (DRY_RUN) log("DRY RUN - real data, real decisions, nothing signed");
  log(estimateLoad(live.length));

  try {
    log(`mainnet NEAR is $${(await readNearUsd()).toFixed(4)} - every peg is read against it`);
  } catch (e) {
    log(`could not read the NEAR price: ${(e as Error).message}`);
  }

  await tick();
  for (const m of live) {
    const p = historyFor(m).last();
    log(`${m.symbol.padEnd(8)} opens at ${p === undefined ? "unreadable" : fmtPrice(p)} (mirrors ${m.mirrors})`);
  }

  if (RUN_ONCE) {
    await makerPass();
    // One pass should exercise every market, not just the next in rotation.
    for (let i = 0; i < live.length; i++) await tradersPass(BOTS);
    log("single pass done");
    return;
  }

  // Each actor keeps its own next-due time, so a slow RPC call delays one bot
  // rather than shifting the whole schedule.
  let makerDue = Date.now();
  let reportDue = Date.now() + 5 * 60_000;
  const botDue = new Map(BOTS.map((b) => [b.accountId, Date.now() + Math.random() * b.everyMs]));
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

    if (Date.now() >= reportDue) {
      for (const line of rpcReport()) log(line);
      reportDue = Date.now() + 5 * 60_000;
    }

    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

main().catch((e) => {
  console.error("bots stopped:", (e as Error).message);
  process.exit(1);
});
