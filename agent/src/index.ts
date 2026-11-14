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
  callBuy, callSell, confirmTx, explorerTx, getBalance, getMyTrades, getOpenPositions,
  getTokens, quoteRoute, reverseHops, rpcReport, type PositionView, type SendResult,
  type TokenConfig,
} from "./chain.js";
import { readMarket, type MarketView } from "./market.js";
import { decide, describeLlmFailure } from "./brain.js";
import {
  countRecentTrades, forcedExit, positionState, toUnits, vet,
  type PositionState, type Proposal,
} from "./risk.js";
import { settleTrade, type Settlement } from "./settle.js";
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

/**
 * What the agent saw, for the log and for the page.
 *
 * Every open position appears, including ones that could not be priced: the
 * page prints this list as "what it was holding", and a position missing from
 * it because its pool would not quote is a position the page denies exists.
 * An unpriced one shows its entry and a zero mid rather than being dropped.
 */
function summariseInputs(
  balanceUsdc: number,
  states: PositionState[],
  markets: MarketView[],
  tradesLast24h: number,
  openPositions: PositionView[],
): DecisionInputs {
  const priced = new Map(states.map((s) => [s.position.token_id, s]));
  return {
    balanceUsdc,
    openPositions: openPositions.map((p) => {
      const s = priced.get(p.token_id);
      return {
        symbol: p.symbol,
        amount: toUnits(p.amount, p.decimals),
        entry: s?.entry ?? 0,
        mid: s?.mid ?? 0,
        pnlPct: s?.unrealisedPct ?? 0,
      };
    }),
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

/**
 * Place the trade, then ask the chain what became of it.
 *
 * Everything before the signature can fail locally and is reported as an
 * error here - a quote that will not price, a sell that resolves to zero. Once
 * the key has signed, the answer stops being ours to decide: `settleTrade`
 * takes the hash and the chain's verdict, and a broadcast that errored is no
 * longer enough on its own to call a trade failed.
 */
async function execute(
  proposal: Proposal,
  token: TokenConfig,
  states: PositionState[],
): Promise<Settlement> {
  let send: (() => Promise<SendResult>) | undefined;

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
      send = () =>
        callBuy({
          token_id: token.token_id,
          usdc_in: usdcIn.toString(),
          min_out: minOut.toString(),
        });
    } else {
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
      send = () =>
        callSell({
          token_id: token.token_id,
          amount: amount.toString(),
          min_out_usdc: minOut.toString(),
        });
    }
  } catch (e) {
    // Nothing was signed, so there is nothing to look up.
    return { error: (e as Error).message };
  }

  return settleTrade(send, (hash) => confirmTx(hash));
}

/**
 * Re-read the account after a confirmed trade.
 *
 * Best effort on purpose: the trade is already on chain and already recorded,
 * so a read that fails here must not turn a settled trade into an error. It
 * only means the entry keeps the pre-trade numbers, which is why the failure
 * is said out loud.
 */
async function refreshAfterTrade(entry: DecisionEntry, markets: MarketView[]): Promise<void> {
  try {
    const [rawBalance, positions, trades] = await Promise.all([
      getBalance(), getOpenPositions(), getMyTrades(),
    ]);
    const states = positions
      .map((p: PositionView) =>
        positionState(p, markets.find((m) => m.token.token_id === p.token_id)?.mid ?? 0),
      )
      .filter((s: PositionState) => s.mid > 0);
    entry.inputs = summariseInputs(
      toUnits(rawBalance, USDC_DECIMALS), states, markets, countRecentTrades(trades), positions,
    );
    log(
      `  now ${positions.length} position(s) · ` +
      `${entry.inputs.tradesLast24h}/${RISK.maxTradesPerDay} trades in 24h, from chain`,
    );
  } catch (e) {
    log(`  traded, but could not re-read the account afterwards: ${(e as Error).message}`);
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

  // The account, as the chain has it. Positions and the daily trade count are
  // read here every pass and nowhere else: neither is remembered between
  // passes, so a restart, a crash or a trade made by something other than this
  // process cannot leave the agent trading against a stale picture of itself.
  //
  // `getMyTrades` throws rather than returning an empty list when it cannot
  // read. It used to be wrapped in a catch that swallowed the failure, which
  // made an unreachable endpoint indistinguishable from an account that had
  // never traded - and the difference between those two is the whole daily
  // limit.
  const [rawBalance, positions, myTrades] = await Promise.all([
    getBalance(),
    getOpenPositions(),
    getMyTrades(),
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

  // A position the agent could not price this pass has no state - no entry, no
  // unrealised percentage, nothing to reason about. It is still a position,
  // so it still counts against the position cap and still closes its market to
  // new buys; `states` is what the model reads, `positions` is what the limits
  // are checked against, and conflating the two is how the page came to say
  // "1 position" while the chain held more.
  const states = positions
    .map((p: PositionView) => {
      const m = markets.find((x) => x.token.token_id === p.token_id);
      return positionState(p, m?.mid ?? 0);
    })
    .filter((s: PositionState) => s.mid > 0);

  const unpriced = positions.length - states.length;
  if (unpriced > 0) {
    log(`  ${unpriced} open position(s) could not be priced this pass - still counted as open`);
  }

  const inputs = summariseInputs(balanceUsdc, states, markets, tradesLast24h, positions);

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

  let llmStatus: string | undefined;

  if (forced) {
    proposal = forced;
    decidedBy = "forced-exit";
    log(`forced exit: ${forced.reason}`);
  } else {
    const thought = await decide(markets, states, balanceUsdc, tradesLast24h);
    // One line, once a pass, naming the real reason - rather than a parenthesis
    // about the vendor's billing stapled to every trade the fallback decides.
    if (thought.llmFailure) {
      llmStatus = describeLlmFailure(thought.llmFailure);
      log(`  ${llmStatus}`);
    }
    const knownTokens = new Set(tradable.map((t) => t.token_id));
    // The depth each route actually has, from the same reads that priced it.
    const depthUsdc = new Map(markets.map((m) => [m.token.token_id, m.liquidity]));
    const verdict = vet(thought.proposal, {
      balanceUsdc, states, tradesLast24h, knownTokens, depthUsdc, openPositions: positions,
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
    llmStatus,
    dryRun: DRY_RUN,
  };

  if (proposal.action !== "HOLD") {
    const token = tradable.find((t) => t.token_id === proposal.tokenId)!;
    const result = await execute(proposal, token, states);
    if (result.txHash) {
      entry.txHash = result.txHash;
      entry.note = result.note;
      log(`  done: ${explorerTx(result.txHash)}`);
      if (result.note) log(`  ${result.note}`);
      // The position and the count the log carries are the ones from before
      // the trade. Re-reading them costs two calls and makes the newest entry
      // on the page describe the account as it is now rather than as it was a
      // few seconds before it traded.
      await refreshAfterTrade(entry, markets);
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
