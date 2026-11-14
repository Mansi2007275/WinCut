/**
 * The loop.
 *
 * Every five minutes: read the chain, check whether any position has hit a hard
 * exit, ask for a decision, re-check that decision against the limits, execute
 * it if it survives, and write down what happened either way.
 *
 * Nothing in this file invents a number, and nothing in it writes a log entry
 * it has not actually done. A HOLD is recorded as a HOLD. A refusal by the risk
 * layer is recorded as a refusal, with the proposal it overruled. A trade is
 * recorded only after the chain returns a transaction hash, and a trade that
 * reverts is recorded with its error. That is the whole point of the log: the
 * public page is only worth reading if it cannot flatter the agent.
 */

import {
  AGENT_ACCOUNT_ID, AGENT_MARKETS, CONTRACT_ID, DRY_RUN, LOOP_MS, NETWORK,
  PRIMARY_MARKET_TOKEN_ID, REF_CONTRACT, RISK, RUN_ONCE, SLIPPAGE_BPS, TIMEFRAME,
  USDC_DECIMALS, VIEW_CACHE_MS, describeConfig, fmtPrice,
} from "./config.js";
import {
  callBuy, callSell, explorerTx, getBalance, getPositions, getTokens, getTradesOf,
  quoteRoute, reverseHops, rpcReport, type TokenConfig,
} from "./chain.js";
import { readMarket, type MarketView } from "./market.js";
import { decide } from "./brain.js";
import {
  countRecentTrades, forcedExit, positionState, toUnits, vet,
  type PositionState, type Proposal,
} from "./risk.js";
import { record, storeConfigured, type DecisionEntry, type DecisionInputs } from "./store.js";

const log = (...parts: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...parts);

const toRaw = (human: number, decimals: number): bigint => {
  // Via a fixed-point string so a float never decides the last digit of an
  // amount that is about to be spent.
  const [whole, frac = ""] = human.toFixed(decimals).split(".");
  return BigInt(`${whole}${frac.padEnd(decimals, "0")}`);
};

const applySlippage = (amount: bigint): bigint =>
  (amount * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;

function summariseInputs(
  balanceUsdc: number,
  states: PositionState[],
  markets: MarketView[],
  tradesLast24h: number,
): DecisionInputs {
  return {
    balanceUsdc,
    openPositions: states.map((s) => ({
      symbol: s.position.symbol,
      amount: toUnits(s.position.amount, s.position.decimals),
      entry: s.entry,
      mid: s.mid,
      pnlPct: s.unrealisedPct,
    })),
    markets: markets.map((m) => ({
      symbol: m.token.symbol,
      tokenId: m.token.token_id,
      mid: m.mid,
      liquidity: m.liquidity,
      changePct: m.changePct,
      momentumPct: m.momentumPct,
      candles: m.candles.length,
      notes: m.notes,
    })),
    tradesLast24h,
  };
}

async function execute(
  proposal: Proposal,
  token: TokenConfig,
  states: PositionState[],
): Promise<{ txHash?: string; error?: string }> {
  try {
    if (proposal.action === "BUY") {
      const usdcIn = toRaw(proposal.sizeUsdc!, USDC_DECIMALS);
      const expected = await quoteRoute(REF_CONTRACT, token.hops, usdcIn);
      const minOut = applySlippage(expected);
      log(
        `  buy ${proposal.sizeUsdc!.toFixed(2)} tUSDC of ${token.symbol}, ` +
        `expecting ${toUnits(expected.toString(), token.decimals).toFixed(6)}, ` +
        `min ${toUnits(minOut.toString(), token.decimals).toFixed(6)}`,
      );
      if (DRY_RUN) return {};
      const hash = await callBuy({
        token_id: token.token_id,
        usdc_in: usdcIn.toString(),
        min_out: minOut.toString(),
      });
      return { txHash: hash };
    }

    // SELL
    const held = states.find((s) => s.position.token_id === proposal.tokenId)!;
    const whole = BigInt(held.position.amount);
    const amount = (whole * BigInt(Math.round((proposal.sellFraction ?? 1) * 10_000))) / 10_000n;
    if (amount <= 0n) return { error: "sell resolved to zero tokens" };
    const expected = await quoteRoute(REF_CONTRACT, reverseHops(token.hops), amount);
    const minOut = applySlippage(expected);
    log(
      `  sell ${toUnits(amount.toString(), token.decimals).toFixed(6)} ${token.symbol}, ` +
      `expecting ${toUnits(expected.toString(), USDC_DECIMALS).toFixed(2)} tUSDC, ` +
      `min ${toUnits(minOut.toString(), USDC_DECIMALS).toFixed(2)}`,
    );
    if (DRY_RUN) return {};
    const hash = await callSell({
      token_id: token.token_id,
      amount: amount.toString(),
      min_out_usdc: minOut.toString(),
    });
    return { txHash: hash };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function pass(): Promise<void> {
  const tokens = await getTokens();
  // The primary market first. The model reads these in order, and a market with
  // real history should not be buried behind six that have none.
  const allowed = AGENT_MARKETS.length ? new Set(AGENT_MARKETS) : undefined;
  const tradable = tokens
    .filter((t) => t.registered && (!allowed || allowed.has(t.token_id)))
    .sort((a, b) =>
      a.token_id === PRIMARY_MARKET_TOKEN_ID ? -1 : b.token_id === PRIMARY_MARKET_TOKEN_ID ? 1 : 0,
    );
  if (!tradable.length) {
    log(
      allowed
        ? `none of the ${AGENT_MARKETS.length} allowed market(s) is registered on the contract`
        : "no registered markets on the contract - nothing to decide",
    );
    return;
  }
  if (allowed && tokens.length > tradable.length) {
    log(`${tokens.length - tradable.length} listed market(s) skipped - not in AGENT_MARKETS`);
  }

  const [rawBalance, positions, myTrades] = await Promise.all([
    getBalance(),
    getPositions(),
    getTradesOf().catch(() => [] as { timestamp_ns: string }[]),
  ]);
  const balanceUsdc = toUnits(rawBalance, USDC_DECIMALS);
  const tradesLast24h = countRecentTrades(myTrades);

  const markets: MarketView[] = [];
  for (const token of tradable) {
    try {
      markets.push(await readMarket(token, REF_CONTRACT));
    } catch (e) {
      // One unreadable pool must not blind the agent to the other five.
      log(`  skipping ${token.symbol}: ${(e as Error).message}`);
    }
  }
  if (!markets.length) {
    log("every market failed to read - holding without a decision");
    return;
  }

  const states = positions
    .filter((p) => BigInt(p.amount) > 0n)
    .map((p) => {
      const m = markets.find((x) => x.token.token_id === p.token_id);
      return positionState(p, m?.mid ?? 0);
    })
    .filter((s) => s.mid > 0);

  const inputs = summariseInputs(balanceUsdc, states, markets, tradesLast24h);

  log(
    `balance ${balanceUsdc.toFixed(2)} tUSDC · ${states.length} position(s) · ` +
    `${tradesLast24h}/${RISK.maxTradesPerDay} trades today · ${markets.length} market(s) read ` +
    `· ${TIMEFRAME} candles`,
  );
  for (const m of markets) {
    log(
      `  ${m.token.symbol.padEnd(8)} ${fmtPrice(m.mid).padStart(12)}  ` +
      `momentum ${m.momentumPct === undefined ? "n/a" : `${m.momentumPct.toFixed(2)}%`}  ` +
      `${m.candles.length} candle(s)${m.notes.length ? `  [${m.notes.join("; ")}]` : ""}`,
    );
  }

  // A hard exit is not a decision the model gets to weigh in on.
  const forced = forcedExit(states);
  let proposal: Proposal;
  let decidedBy: DecisionEntry["decidedBy"];
  let vetoed: DecisionEntry["vetoed"];

  if (forced) {
    proposal = forced;
    decidedBy = "forced-exit";
    log(`forced exit: ${forced.reason}`);
  } else {
    const thought = await decide(markets, states, balanceUsdc, tradesLast24h);
    if (thought.llmError) log(`  model unavailable, using the fallback: ${thought.llmError}`);
    const knownTokens = new Set(tradable.map((t) => t.token_id));
    // The depth each route actually has, from the same reads that priced it.
    const depthUsdc = new Map(markets.map((m) => [m.token.token_id, m.liquidity]));
    const verdict = vet(thought.proposal, {
      balanceUsdc, states, tradesLast24h, knownTokens, depthUsdc,
    });
    if (verdict.ok) {
      proposal = verdict.proposal;
      decidedBy = thought.decidedBy;
    } else {
      vetoed = { action: thought.proposal.action, reason: thought.proposal.reason };
      proposal = { action: "HOLD", reason: verdict.reason };
      decidedBy = "risk";
      log(`risk layer refused a ${thought.proposal.action}: ${verdict.reason}`);
    }
  }

  log(`${proposal.action}${proposal.tokenId ? ` ${proposal.tokenId}` : ""} - ${proposal.reason}`);

  const entry: DecisionEntry = {
    t: Date.now(),
    action: proposal.action,
    tokenId: proposal.tokenId,
    symbol: tradable.find((t) => t.token_id === proposal.tokenId)?.symbol,
    sizeUsdc: proposal.sizeUsdc,
    sellFraction: proposal.sellFraction,
    reason: proposal.reason,
    decidedBy,
    vetoed,
    inputs,
    dryRun: DRY_RUN,
  };

  if (proposal.action !== "HOLD") {
    const token = tradable.find((t) => t.token_id === proposal.tokenId)!;
    const result = await execute(proposal, token, states);
    if (result.txHash) {
      entry.txHash = result.txHash;
      log(`  sent: ${explorerTx(result.txHash)}`);
    } else if (result.error) {
      entry.error = result.error;
      log(`  failed: ${result.error}`);
    } else if (DRY_RUN) {
      log("  dry run - not signed");
    }
  }

  await record(entry);
}

/**
 * What a pass costs the network, per minute.
 *
 * Printed because the figure was invisible until an endpoint began refusing
 * calls, and because it is what changes when a market is listed. Counted before
 * the cache, with the cache stated separately, so neither number flatters the
 * other.
 */
function estimateLoad(markets: number): string {
  const passesPerMin = 60_000 / LOOP_MS;
  // Per pass: tokens, balance, positions, own trades, then one get_pool per
  // market route hop, plus a quote if it trades.
  const perPass = 4 + markets + 1;
  const total = passesPerMin * perPass;
  return (
    `expecting about ${total.toFixed(1)} rpc call(s)/min before caching ` +
    `(${perPass} per pass over ${markets} market(s), one pass every ${LOOP_MS / 1000}s) · ` +
    `a ${VIEW_CACHE_MS / 1000}s cache collapses the repeats inside a pass`
  );
}

async function main(): Promise<void> {
  log(`WinCut agent starting on ${NETWORK}`);
  console.log(describeConfig());
  if (!storeConfigured) {
    log("no Upstash credentials: decisions print here but are not kept, and the web page will have nothing to show");
  }
  if (DRY_RUN) {
    log("DRY RUN - every decision is real, taken from live chain data; none of them is signed");
  }
  log(estimateLoad(AGENT_MARKETS.length || 4));

  let reportDue = Date.now() + 15 * 60_000;

  for (;;) {
    try {
      await pass();
    } catch (e) {
      // A failed pass is a skipped pass, never a crashed agent - but it is
      // still a pass that did not happen, so it is said out loud and the RPC
      // counters come with it, since an exhausted endpoint is the likeliest
      // reason a pass failed at all.
      log(`pass failed: ${(e as Error).message}`);
      for (const line of rpcReport()) log(line);
    }
    if (Date.now() >= reportDue) {
      for (const line of rpcReport()) log(line);
      reportDue = Date.now() + 15 * 60_000;
    }
    if (RUN_ONCE) break;
    await new Promise((r) => setTimeout(r, LOOP_MS));
  }
}

main().catch((e) => {
  console.error(`${AGENT_ACCOUNT_ID} on ${CONTRACT_ID} could not start:`, (e as Error).message);
  process.exit(1);
});
