/**
 * The three trader bots.
 *
 * They trade through WinCut, as users, with the same fees and the same
 * settlement path as anybody else - which is the point. Their trades are what
 * populate the trade log, the leaderboard, the 24h volume and the pressure
 * panel, and because every one is a real settled transaction, those panels are
 * reporting rather than decorating.
 *
 * They disagree on purpose. Momentum chases a move, reversion fades it, and the
 * grid ignores both and buys on a clock. Three copies of one strategy would
 * push the price one way and hold it there; three that disagree are a market.
 * None of them is tuned to be profitable - a bot's job here is to be a
 * counterparty, and a bot that refused to take the other side of a trade would
 * be useless for that.
 *
 * Every limit is checked in code, after the strategy has had its say, for the
 * same reason the agent works that way.
 */

import type { Account } from "near-api-js";

import { getBalance, getPositions, getReturn, signerFor, wincutBuy, wincutSell, explorerTx } from "./chain.js";
import {
  BOT_RISK, BOT_SIZE, CONTRACT_ID, DRY_RUN, REF_CONTRACT, SLIPPAGE_BPS, USDC_DECIMALS, USDC_ID,
  type BotConfig, type MarketConfig,
} from "./config.js";

const toRaw = (human: number, decimals: number): bigint => {
  const [w, f = ""] = human.toFixed(decimals).split(".");
  return BigInt(`${w}${f.padEnd(decimals, "0")}`);
};

const toUnits = (raw: string | bigint, decimals: number): number => Number(raw) / 10 ** decimals;

const applySlippage = (amount: bigint): bigint => (amount * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;

/**
 * The price history the strategies read.
 *
 * Kept by the loop from its own pool reads rather than fetched from the web
 * app, so the bots do not depend on the site being up, and so a strategy is
 * always reasoning about prices this process actually observed.
 */
export class PriceHistory {
  private points: { t: number; p: number }[] = [];

  push(price: number): void {
    this.points.push({ t: Date.now(), p: price });
    if (this.points.length > 400) this.points.shift();
  }

  get length(): number {
    return this.points.length;
  }

  last(): number | undefined {
    return this.points[this.points.length - 1]?.p;
  }

  /** Mean of the last n prices, or undefined when there are not yet n. */
  mean(n: number): number | undefined {
    if (this.points.length < n) return undefined;
    const slice = this.points.slice(-n);
    return slice.reduce((s, x) => s + x.p, 0) / slice.length;
  }

  /** Percent change across the last n prices. */
  change(n: number): number | undefined {
    if (this.points.length < n) return undefined;
    const slice = this.points.slice(-n);
    const first = slice[0]!.p;
    const last = slice[slice.length - 1]!.p;
    return first > 0 ? ((last - first) / first) * 100 : undefined;
  }

  /** How many of the last n steps moved up. */
  upSteps(n: number): number | undefined {
    if (this.points.length < n + 1) return undefined;
    const slice = this.points.slice(-(n + 1));
    let up = 0;
    for (let i = 1; i < slice.length; i++) if (slice[i]!.p > slice[i - 1]!.p) up++;
    return up;
  }
}

export type BotDecision = {
  action: "BUY" | "SELL" | "HOLD";
  sizeUsdc?: number;
  sellFraction?: number;
  reason: string;
  /**
   * True when the trade came from the clock rather than from the strategy.
   *
   * It is carried through to the log and the site because the two are not the
   * same kind of thing: one is a bot acting on what it read, the other is a bot
   * trading because the market had gone quiet. Presenting a timed trade as a
   * strategy decision would credit the strategy with an opinion it never had.
   */
  liquidity?: boolean;
};

/**
 * What belongs to the bot, and what belongs to the bot in one market.
 *
 * The daily cap and the silence floor are properties of the bot: a bot that has
 * traded forty times today has traded forty times today, whichever market it
 * did it in, and a bot that just traded MLONK is not a quiet bot. The grid's
 * clock and its alternation are properties of a bot *in a market* - the grid
 * selling half its MNEAR rung tells you nothing about where it is in its
 * MDRAGON cycle.
 *
 * Getting that split wrong is not cosmetic. Sharing one clock across four
 * markets would have the grid trade once and then sit out the other three.
 */
type BotState = {
  /** When this bot is next allowed to trade purely to keep a market moving. */
  nextLiquidityAt?: number;
  /** Last trade in any market, for reporting how long the quiet ran. */
  lastTradeAt?: number;
  tradesToday: number;
  dayStartedAt: number;
};

type MarketState = {
  /** This bot's last trade in this market, which is the grid's clock. */
  lastTradeAt?: number;
  /** Which way it went, so the grid can alternate. */
  lastSide?: "BUY" | "SELL";
};

/**
 * How long a bot may go without trading before it trades anyway.
 *
 * The market this package exists to create has a bootstrapping problem: the
 * strategies only act when the price moves, and the price only moves when they
 * act. Left alone the whole thing settles into three bots agreeing that nothing
 * is happening - which is the flat chart we were trying to avoid, now with more
 * moving parts. So each bot has a floor on its own silence.
 *
 * Randomised, and kept per bot, so the three do not arrive together and turn
 * the market into synchronised bursts.
 */
const LIQUIDITY_MIN_MS = 90_000;
const LIQUIDITY_MAX_MS = 180_000;

const nextLiquidityWindow = (): number =>
  Date.now() + LIQUIDITY_MIN_MS + Math.random() * (LIQUIDITY_MAX_MS - LIQUIDITY_MIN_MS);

const round2 = (n: number): number => Math.floor(n * 100) / 100;

/**
 * The size this pass would like to trade, before any cap touches it.
 *
 * Drawn rather than fixed. A bot whose every trade is the same number leaves a
 * signature on the chart that no amount of real settlement makes look like a
 * market, and the configured `bot.sizeUsdc` stays meaningful as the ceiling of
 * the range. Every limit downstream is unchanged: this only decides what gets
 * asked for, never what is allowed.
 */
const drawSize = (bot: BotConfig): number => {
  const hi = Math.min(bot.sizeUsdc, BOT_SIZE.maxUsdc);
  const lo = Math.min(BOT_SIZE.minUsdc, hi);
  return round2(lo + Math.random() * (hi - lo));
};

const states = new Map<string, BotState>();
const marketStates = new Map<string, MarketState>();

const stateFor = (accountId: string): BotState => {
  let s = states.get(accountId);
  if (!s || Date.now() - s.dayStartedAt > 24 * 60 * 60 * 1000) {
    s = { tradesToday: 0, dayStartedAt: Date.now(), nextLiquidityAt: nextLiquidityWindow() };
    states.set(accountId, s);
  }
  return s;
};

const marketStateFor = (accountId: string, poolId: number): MarketState => {
  const k = `${accountId}|${poolId}`;
  let m = marketStates.get(k);
  if (!m) {
    m = {};
    marketStates.set(k, m);
  }
  return m;
};

/**
 * The largest buy this balance allows, which is not the size the strategy asked
 * for.
 *
 * The old code compared the two and refused when the ask was bigger. That reads
 * as caution and is not: the limits exist to cap exposure, and a trade at the
 * cap respects them exactly as well as one below it. Refusing instead meant the
 * grid bot, whose configured size was 8 against a 7.50 cap, spent the entire
 * run announcing a trade it was never going to make. A limit should shape the
 * trade, not cancel it.
 */
function buyCeiling(balanceUsdc: number, quoteReserve?: number): number {
  const cap = balanceUsdc * BOT_RISK.maxShareOfBalancePerTrade;
  const spendable = Math.max(0, balanceUsdc - BOT_RISK.reserveUsdc);
  const depthCap =
    quoteReserve !== undefined && quoteReserve > 0
      ? quoteReserve * BOT_RISK.maxShareOfPoolDepth
      : Infinity;
  return round2(Math.min(cap, spendable, depthCap));
}

// ------------------------------------------------------------- the strategies

function momentum(history: PriceHistory, holdingPnlPct: number | undefined, size: number): BotDecision {
  const up = history.upSteps(2);
  const change = history.change(3);
  if (up === undefined || change === undefined) {
    return { action: "HOLD", reason: `only ${history.length} observation(s) - not enough to see a move yet` };
  }
  if (holdingPnlPct !== undefined && up === 0) {
    return {
      action: "SELL",
      sellFraction: 1,
      reason: `the move stalled - neither of the last two ticks was up, and the position is at ${holdingPnlPct.toFixed(2)}%`,
    };
  }
  if (up === 2 && change > 0.15) {
    return {
      action: "BUY",
      sizeUsdc: size,
      reason: `two up ticks running and ${change.toFixed(2)}% over the last three - buying into it`,
    };
  }
  return { action: "HOLD", reason: `${up} of the last two ticks up, ${change.toFixed(2)}% over three - not a move yet` };
}

function reversion(history: PriceHistory, holdingPnlPct: number | undefined, size: number): BotDecision {
  const mean = history.mean(10);
  const last = history.last();
  if (mean === undefined || last === undefined) {
    return { action: "HOLD", reason: `needs 10 observations to have an average, has ${history.length}` };
  }
  const gapPct = ((last - mean) / mean) * 100;
  if (gapPct < -0.5) {
    return {
      action: "BUY",
      sizeUsdc: size,
      reason: `${gapPct.toFixed(2)}% below its 10-tick average - fading the drop`,
    };
  }
  if (gapPct > 0.5 && holdingPnlPct !== undefined) {
    return {
      action: "SELL",
      sellFraction: 1,
      reason: `${gapPct.toFixed(2)}% above its 10-tick average - fading the rise, position at ${holdingPnlPct.toFixed(2)}%`,
    };
  }
  return { action: "HOLD", reason: `${gapPct.toFixed(2)}% from its average, inside the ±0.5% band it acts on` };
}

/**
 * The grid. It ignores the chart and trades on a clock - but it alternates.
 *
 * A grid that only ever buys is not a grid, it is a drain: it spends its quote
 * balance down until every further rung is refused for want of funds, which is
 * exactly what happened on its first run. Selling part of the position back on
 * the other leg is what makes the pattern sustainable, and it has the useful
 * side effect of putting both sides of a trade into the market.
 */
function grid(
  holdingPnlPct: number | undefined,
  size: number,
  state: MarketState,
  positionTokens: number,
): BotDecision {
  const TAKE_PROFIT_PCT = 3;
  const EVERY_MS = 10 * 60_000;

  if (holdingPnlPct !== undefined && holdingPnlPct >= TAKE_PROFIT_PCT) {
    return {
      action: "SELL",
      sellFraction: 1,
      reason: `the clock does not matter here - the position is at +${holdingPnlPct.toFixed(2)}%, past its +${TAKE_PROFIT_PCT}% target`,
    };
  }

  const since = state.lastTradeAt ? Date.now() - state.lastTradeAt : Infinity;
  if (since < EVERY_MS) {
    return {
      action: "HOLD",
      reason: `${Math.round((EVERY_MS - since) / 60_000)} minute(s) until the next rung${
        holdingPnlPct !== undefined ? `, position at ${holdingPnlPct.toFixed(2)}%` : ""
      }`,
    };
  }

  // Alternate: sell half a rung back if the last one was a buy and there is
  // something to sell, otherwise buy the next rung.
  if (state.lastSide === "BUY" && positionTokens > 0) {
    return {
      action: "SELL",
      sellFraction: 0.5,
      reason: `${Math.round(since / 60_000)} minutes on from the last rung - selling half of it back, which is the grid's other leg`,
    };
  }

  return {
    action: "BUY",
    sizeUsdc: size,
    reason:
      state.lastTradeAt === undefined
        ? "first rung of the run - this one ignores the chart entirely and trades on a clock"
        : `${Math.round(since / 60_000)} minutes on from the last rung - buying the next one`,
  };
}

/**
 * The trade a bot makes when its strategy has had nothing to say for too long.
 *
 * Deliberately small, randomised in side and size, and inside exactly the same
 * limits as every other trade: the clock decides *that* it trades, never *how
 * much*. It is labelled as what it is everywhere it surfaces, because a timed
 * trade is evidence about the market's liquidity and nothing at all about the
 * strategy's judgement.
 */
function liquidityTrade(
  bot: BotConfig,
  state: BotState,
  balanceUsdc: number,
  positionTokens: number,
  quoteReserve?: number,
): BotDecision | undefined {
  if (Date.now() < (state.nextLiquidityAt ?? Infinity)) return undefined;

  const quiet = Math.round((Date.now() - (state.lastTradeAt ?? state.dayStartedAt)) / 60_000);
  const ceiling = Math.min(drawSize(bot), buyCeiling(balanceUsdc, quoteReserve));
  const canBuy = ceiling >= BOT_RISK.minTradeUsdc;
  const canSell = positionTokens > 0;
  if (!canBuy && !canSell) return undefined;

  const note =
    `liquidity trade: the strategy saw nothing to act on for ${quiet} minute(s), so this is a timed ` +
    `trade to keep the market moving - not a view on the price`;

  if (canBuy && (!canSell || Math.random() < 0.5)) {
    const size = Math.max(
      BOT_RISK.minTradeUsdc,
      round2(BOT_RISK.minTradeUsdc + Math.random() * (ceiling - BOT_RISK.minTradeUsdc)),
    );
    return { action: "BUY", sizeUsdc: size, liquidity: true, reason: note };
  }
  return { action: "SELL", sellFraction: 0.2 + Math.random() * 0.3, liquidity: true, reason: note };
}

/**
 * Records that a trade happened, which does three jobs at once: it is the grid
 * bot's clock, it is how the grid knows which way to go next, and it pushes the
 * liquidity deadline out. A strategy trade satisfies the liquidity floor just
 * as well as a timed one - the floor is about the market being quiet, not about
 * where the trade came from.
 */
function noteTrade(state: BotState, market: MarketState, side: "BUY" | "SELL"): void {
  const now = Date.now();
  state.lastTradeAt = now;
  state.nextLiquidityAt = nextLiquidityWindow();
  market.lastTradeAt = now;
  market.lastSide = side;
}

// ------------------------------------------------------------------ execution

export type BotPass = {
  bot: BotConfig;
  market: MarketConfig;
  decision: BotDecision;
  balanceUsdc: number;
  positionTokens: number;
  pnlPct?: number;
  vetoed?: string;
  txHash?: string;
  error?: string;
  /** True when the clock, not the strategy, is why this pass traded. */
  liquidity?: boolean;
};

export async function runBot(
  bot: BotConfig,
  market: MarketConfig,
  history: PriceHistory,
  log: (s: string) => void,
  /** The pool's quote-side reserve, so size can be capped against the market. */
  quoteReserve?: number,
): Promise<BotPass> {
  const state = stateFor(bot.accountId);
  const mstate = marketStateFor(bot.accountId, market.poolId);

  const [rawBalance, positions] = await Promise.all([
    getBalance(CONTRACT_ID, bot.accountId),
    getPositions(CONTRACT_ID, bot.accountId),
  ]);
  const balanceUsdc = toUnits(rawBalance, USDC_DECIMALS);

  const held = positions.find((p) => p.token_id === market.tokenId && BigInt(p.amount) > 0n);
  const positionTokens = held ? toUnits(held.amount, held.decimals) : 0;
  const basis = held ? toUnits(held.cost_basis_usdc, USDC_DECIMALS) : 0;
  const price = history.last();
  const pnlPct =
    held && basis > 0 && price !== undefined ? ((positionTokens * price - basis) / basis) * 100 : undefined;

  const want = drawSize(bot);
  let decision =
    bot.kind === "momentum"
      ? momentum(history, pnlPct, want)
      : bot.kind === "reversion"
        ? reversion(history, pnlPct, want)
        : grid(pnlPct, want, mstate, positionTokens);

  // The strategy had nothing to say. If it has had nothing to say for long
  // enough, trade anyway - and say that that is why.
  if (decision.action === "HOLD") {
    const timed = liquidityTrade(bot, state, balanceUsdc, positionTokens, quoteReserve);
    if (timed) {
      log(`  ${bot.accountId.split(".")[0]} ${market.symbol}: strategy held - ${decision.reason}`);
      decision = timed;
    }
  }

  const pass: BotPass = {
    bot, market, decision, balanceUsdc, positionTokens, pnlPct, liquidity: decision.liquidity,
  };

  // ---- the limits, after the strategy has spoken ----
  if (decision.action !== "HOLD") {
    if (state.tradesToday >= BOT_RISK.maxTradesPerDayEach) {
      pass.vetoed = `${state.tradesToday} trades today, at the ${BOT_RISK.maxTradesPerDayEach} cap`;
    } else if (decision.action === "BUY") {
      const asked = decision.sizeUsdc ?? 0;
      const ceiling = buyCeiling(balanceUsdc, quoteReserve);
      const size = Math.min(asked, ceiling);
      if (size < BOT_RISK.minTradeUsdc) {
        // The only honest refusal left: there is not enough to trade with.
        pass.vetoed =
          `${balanceUsdc.toFixed(2)} tUSDC and ${
            quoteReserve === undefined ? "unknown" : quoteReserve.toFixed(0)
          } tUSDC of depth leave at most ${ceiling.toFixed(2)} tradable, below the ` +
          `${BOT_RISK.minTradeUsdc} minimum`;
      } else if (size < asked) {
        decision = { ...decision, sizeUsdc: size };
        pass.decision = decision;
        log(
          `  ${bot.accountId.split(".")[0]} ${market.symbol}: trimming the buy from ` +
          `${asked.toFixed(2)} to ${size.toFixed(2)} to stay inside its limits`,
        );
      }
    } else if (decision.action === "SELL" && !held) {
      pass.vetoed = `nothing held in ${market.symbol} to sell`;
    }
  }

  if (decision.action === "HOLD") {
    log(`  ${bot.accountId.split(".")[0]} ${market.symbol}: HOLD - ${decision.reason}`);
    return pass;
  }
  if (pass.vetoed) {
    log(`  ${bot.accountId.split(".")[0]} ${market.symbol}: refused a ${decision.action} - ${pass.vetoed}`);
    return pass;
  }
  if (DRY_RUN) {
    log(`  ${bot.accountId.split(".")[0]} ${market.symbol}: would ${decision.action} - ${decision.reason} (dry run)`);
    return pass;
  }
  if (!bot.privateKey) {
    pass.vetoed = "no key configured";
    log(`  ${bot.accountId.split(".")[0]} ${market.symbol}: would ${decision.action} but has no key`);
    return pass;
  }

  let account: Account;
  try {
    account = signerFor(bot.accountId, bot.privateKey);
  } catch (e) {
    pass.error = (e as Error).message;
    return pass;
  }

  try {
    if (decision.action === "BUY") {
      const usdcIn = toRaw(decision.sizeUsdc!, USDC_DECIMALS);
      const expected = BigInt(
        await getReturn(REF_CONTRACT, market.poolId, USDC_ID, market.tokenId, usdcIn),
      );
      const hash = await wincutBuy(account, CONTRACT_ID, {
        token_id: market.tokenId,
        usdc_in: usdcIn.toString(),
        min_out: applySlippage(expected).toString(),
      });
      pass.txHash = hash;
      state.tradesToday++;
      noteTrade(state, mstate, "BUY");
      log(
        `  ${bot.accountId.split(".")[0]}: BUY ${decision.sizeUsdc!.toFixed(2)} ${market.symbol}` +
        `${decision.liquidity ? " [liquidity]" : ""} - ${decision.reason}`,
      );
      log(`     ${explorerTx(hash)}`);
    } else {
      const whole = BigInt(held!.amount);
      const amount = (whole * BigInt(Math.round((decision.sellFraction ?? 1) * 10_000))) / 10_000n;
      if (amount <= 0n) {
        pass.vetoed = "the sell resolved to zero tokens";
        return pass;
      }
      const expected = BigInt(
        await getReturn(REF_CONTRACT, market.poolId, market.tokenId, USDC_ID, amount),
      );
      const hash = await wincutSell(account, CONTRACT_ID, {
        token_id: market.tokenId,
        amount: amount.toString(),
        min_out_usdc: applySlippage(expected).toString(),
      });
      pass.txHash = hash;
      state.tradesToday++;
      noteTrade(state, mstate, "SELL");
      log(
        `  ${bot.accountId.split(".")[0]}: SELL ` +
        `${toUnits(amount, market.decimals).toLocaleString("en-US", { maximumFractionDigits: 6 })} ` +
        `${market.symbol}${decision.liquidity ? " [liquidity]" : ""} - ${decision.reason}`,
      );
      log(`     ${explorerTx(hash)}`);
    }
  } catch (e) {
    pass.error = (e as Error).message;
    log(`  ${bot.accountId.split(".")[0]}: ${decision.action} failed - ${pass.error}`);
  }

  return pass;
}
