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
  BOT_RISK, CONTRACT_ID, DRY_RUN, MIRROR_DECIMALS, MIRROR_POOL_ID, MIRROR_SYMBOL, MIRROR_TOKEN_ID,
  REF_CONTRACT, SLIPPAGE_BPS, USDC_DECIMALS, USDC_ID, type BotConfig,
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
};

type BotState = {
  /** Set by the grid bot so it can space its buys out on a clock. */
  lastBuyAt?: number;
  tradesToday: number;
  dayStartedAt: number;
};

const states = new Map<string, BotState>();

const stateFor = (accountId: string): BotState => {
  let s = states.get(accountId);
  if (!s || Date.now() - s.dayStartedAt > 24 * 60 * 60 * 1000) {
    s = { tradesToday: 0, dayStartedAt: Date.now() };
    states.set(accountId, s);
  }
  return s;
};

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

function grid(
  history: PriceHistory,
  holdingPnlPct: number | undefined,
  size: number,
  state: BotState,
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
  const since = state.lastBuyAt ? Date.now() - state.lastBuyAt : Infinity;
  if (since >= EVERY_MS) {
    return {
      action: "BUY",
      sizeUsdc: size,
      reason:
        state.lastBuyAt === undefined
          ? "first buy of the run - this one ignores the chart entirely and buys on a clock"
          : `${Math.round(since / 60_000)} minutes since the last buy - buying the next rung`,
    };
  }
  return {
    action: "HOLD",
    reason: `${Math.round((EVERY_MS - since) / 60_000)} minute(s) until the next rung${
      holdingPnlPct !== undefined ? `, position at ${holdingPnlPct.toFixed(2)}%` : ""
    }`,
  };
}

// ------------------------------------------------------------------ execution

export type BotPass = {
  bot: BotConfig;
  decision: BotDecision;
  balanceUsdc: number;
  positionTokens: number;
  pnlPct?: number;
  vetoed?: string;
  txHash?: string;
  error?: string;
};

export async function runBot(bot: BotConfig, history: PriceHistory, log: (s: string) => void): Promise<BotPass> {
  const state = stateFor(bot.accountId);

  const [rawBalance, positions] = await Promise.all([
    getBalance(CONTRACT_ID, bot.accountId),
    getPositions(CONTRACT_ID, bot.accountId),
  ]);
  const balanceUsdc = toUnits(rawBalance, USDC_DECIMALS);

  const held = positions.find((p) => p.token_id === MIRROR_TOKEN_ID && BigInt(p.amount) > 0n);
  const positionTokens = held ? toUnits(held.amount, held.decimals) : 0;
  const basis = held ? toUnits(held.cost_basis_usdc, USDC_DECIMALS) : 0;
  const price = history.last();
  const pnlPct =
    held && basis > 0 && price !== undefined ? ((positionTokens * price - basis) / basis) * 100 : undefined;

  const decision =
    bot.kind === "momentum"
      ? momentum(history, pnlPct, bot.sizeUsdc)
      : bot.kind === "reversion"
        ? reversion(history, pnlPct, bot.sizeUsdc)
        : grid(history, pnlPct, bot.sizeUsdc, state);

  const pass: BotPass = { bot, decision, balanceUsdc, positionTokens, pnlPct };

  // ---- the limits, after the strategy has spoken ----
  if (decision.action !== "HOLD") {
    if (state.tradesToday >= BOT_RISK.maxTradesPerDayEach) {
      pass.vetoed = `${state.tradesToday} trades today, at the ${BOT_RISK.maxTradesPerDayEach} cap`;
    } else if (decision.action === "BUY") {
      const size = decision.sizeUsdc ?? 0;
      const spendable = Math.max(0, balanceUsdc - BOT_RISK.reserveUsdc);
      const cap = balanceUsdc * BOT_RISK.maxShareOfBalancePerTrade;
      if (size < BOT_RISK.minTradeUsdc) pass.vetoed = `size ${size} is below the ${BOT_RISK.minTradeUsdc} minimum`;
      else if (size > cap) pass.vetoed = `size ${size} is over the ${(BOT_RISK.maxShareOfBalancePerTrade * 100).toFixed(0)}% per-trade cap of ${cap.toFixed(2)}`;
      else if (size > spendable)
        pass.vetoed = `only ${spendable.toFixed(2)} spendable once the ${BOT_RISK.reserveUsdc} reserve is kept back`;
    } else if (decision.action === "SELL" && !held) {
      pass.vetoed = `nothing held in ${MIRROR_SYMBOL} to sell`;
    }
  }

  if (decision.action === "HOLD") {
    log(`  ${bot.accountId.split(".")[0]}: HOLD - ${decision.reason}`);
    return pass;
  }
  if (pass.vetoed) {
    log(`  ${bot.accountId.split(".")[0]}: refused a ${decision.action} - ${pass.vetoed}`);
    return pass;
  }
  if (DRY_RUN) {
    log(`  ${bot.accountId.split(".")[0]}: would ${decision.action} - ${decision.reason} (dry run)`);
    return pass;
  }
  if (!bot.privateKey) {
    pass.vetoed = "no key configured";
    log(`  ${bot.accountId.split(".")[0]}: would ${decision.action} but has no key`);
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
        await getReturn(REF_CONTRACT, MIRROR_POOL_ID, USDC_ID, MIRROR_TOKEN_ID, usdcIn),
      );
      const hash = await wincutBuy(account, CONTRACT_ID, {
        token_id: MIRROR_TOKEN_ID,
        usdc_in: usdcIn.toString(),
        min_out: applySlippage(expected).toString(),
      });
      pass.txHash = hash;
      state.lastBuyAt = Date.now();
      state.tradesToday++;
      log(`  ${bot.accountId.split(".")[0]}: BUY ${decision.sizeUsdc!.toFixed(2)} - ${decision.reason}`);
      log(`     ${explorerTx(hash)}`);
    } else {
      const whole = BigInt(held!.amount);
      const amount = (whole * BigInt(Math.round((decision.sellFraction ?? 1) * 10_000))) / 10_000n;
      if (amount <= 0n) {
        pass.vetoed = "the sell resolved to zero tokens";
        return pass;
      }
      const expected = BigInt(
        await getReturn(REF_CONTRACT, MIRROR_POOL_ID, MIRROR_TOKEN_ID, USDC_ID, amount),
      );
      const hash = await wincutSell(account, CONTRACT_ID, {
        token_id: MIRROR_TOKEN_ID,
        amount: amount.toString(),
        min_out_usdc: applySlippage(expected).toString(),
      });
      pass.txHash = hash;
      state.tradesToday++;
      log(
        `  ${bot.accountId.split(".")[0]}: SELL ${toUnits(amount, MIRROR_DECIMALS).toFixed(6)} ` +
        `${MIRROR_SYMBOL} - ${decision.reason}`,
      );
      log(`     ${explorerTx(hash)}`);
    }
  } catch (e) {
    pass.error = (e as Error).message;
    log(`  ${bot.accountId.split(".")[0]}: ${decision.action} failed - ${pass.error}`);
  }

  return pass;
}
