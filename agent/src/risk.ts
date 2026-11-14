/**
 * The limits, enforced.
 *
 * `brain.ts` produces a proposal. Nothing here trusts it. Every rule in
 * `RISK` is re-checked against numbers read from the chain, and a proposal
 * that breaks one is downgraded to HOLD with the reason recorded - it is never
 * silently clamped, because "it traded, just smaller than it said" is harder to
 * audit after the fact than "it refused, and here is why".
 *
 * Two of the rules are not vetoes but obligations: a position past the stop
 * loss or the take profit must be sold, whatever the model thinks. Those are
 * checked before the model is asked at all, so a stop loss cannot be argued
 * with.
 */

import { RISK, USDC_DECIMALS } from "./config.js";
import type { PositionView } from "./chain.js";

export type Action = "BUY" | "SELL" | "HOLD";

export type Proposal = {
  action: Action;
  tokenId?: string;
  /** Quote units, human scale, for a BUY. */
  sizeUsdc?: number;
  /** Fraction of the held position to sell, 0..1. */
  sellFraction?: number;
  reason: string;
};

export type PositionState = {
  position: PositionView;
  /** Quote units per whole token, now. */
  mid: number;
  entry: number;
  unrealisedPct: number;
  valueUsdc: number;
};

export const toUnits = (raw: string, decimals: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n / 10 ** decimals : NaN;
};

export function positionState(position: PositionView, mid: number): PositionState {
  const amount = toUnits(position.amount, position.decimals);
  const basis = toUnits(position.cost_basis_usdc, USDC_DECIMALS);
  const entry = amount > 0 ? basis / amount : 0;
  const valueUsdc = amount * mid;
  const unrealisedPct = basis > 0 ? ((valueUsdc - basis) / basis) * 100 : 0;
  return { position, mid, entry, unrealisedPct, valueUsdc };
}

/**
 * A stop loss or take profit that has been hit. Checked before the model runs,
 * so the model never gets the chance to talk the agent out of an exit.
 */
export function forcedExit(states: PositionState[]): Proposal | null {
  for (const s of states) {
    if (s.unrealisedPct <= RISK.stopLossPct) {
      return {
        action: "SELL",
        tokenId: s.position.token_id,
        sellFraction: 1,
        reason:
          `Stop loss: ${s.position.symbol} is at ${s.unrealisedPct.toFixed(2)}%, ` +
          `past the ${RISK.stopLossPct}% limit. Selling the whole position.`,
      };
    }
    if (s.unrealisedPct >= RISK.takeProfitPct) {
      return {
        action: "SELL",
        tokenId: s.position.token_id,
        sellFraction: 1,
        reason:
          `Take profit: ${s.position.symbol} is at +${s.unrealisedPct.toFixed(2)}%, ` +
          `past the +${RISK.takeProfitPct}% target. Selling the whole position.`,
      };
    }
  }
  return null;
}

export type Veto = { ok: false; reason: string };
export type Pass = { ok: true; proposal: Proposal };

/** Re-checks a proposal against the live account. */
export function vet(
  proposal: Proposal,
  ctx: {
    balanceUsdc: number;
    states: PositionState[];
    tradesLast24h: number;
    knownTokens: Set<string>;
    /** Quote-side depth per market, for the pool cap. Missing means uncapped. */
    depthUsdc?: Map<string, number>;
  },
): Pass | Veto {
  if (proposal.action === "HOLD") return { ok: true, proposal };

  if (ctx.tradesLast24h >= RISK.maxTradesPerDay) {
    return {
      ok: false,
      reason:
        `Daily trade limit reached: ${ctx.tradesLast24h} of ${RISK.maxTradesPerDay} in the ` +
        `last 24 hours. Holding until the window rolls forward.`,
    };
  }

  if (!proposal.tokenId || !ctx.knownTokens.has(proposal.tokenId)) {
    return {
      ok: false,
      reason: `Proposed ${proposal.action} on "${proposal.tokenId ?? "nothing"}", which is not a listed market.`,
    };
  }

  if (proposal.action === "SELL") {
    const held = ctx.states.find((s) => s.position.token_id === proposal.tokenId);
    if (!held) {
      return { ok: false, reason: `Proposed selling ${proposal.tokenId}, which the agent does not hold.` };
    }
    const fraction = proposal.sellFraction ?? 1;
    if (!(fraction > 0 && fraction <= 1)) {
      return { ok: false, reason: `Sell fraction ${fraction} is outside 0..1.` };
    }
    return { ok: true, proposal: { ...proposal, sellFraction: fraction } };
  }

  // BUY
  const open = ctx.states.filter((s) => toUnits(s.position.amount, s.position.decimals) > 0);
  const alreadyHeld = open.some((s) => s.position.token_id === proposal.tokenId);
  if (!alreadyHeld && open.length >= RISK.maxOpenPositions) {
    return {
      ok: false,
      reason:
        `Already holding ${open.length} positions, the limit is ${RISK.maxOpenPositions}. ` +
        `A new idea has to wait for an exit.`,
    };
  }

  const size = proposal.sizeUsdc ?? 0;
  if (!(size >= RISK.minTradeUsdc)) {
    return { ok: false, reason: `Proposed size ${size} is below the ${RISK.minTradeUsdc} minimum.` };
  }

  const cap = ctx.balanceUsdc * RISK.maxShareOfBalancePerTrade;
  if (size > cap + 1e-9) {
    return {
      ok: false,
      reason:
        `Proposed ${size.toFixed(2)} but the per-trade cap is ${cap.toFixed(2)} ` +
        `(${RISK.maxShareOfBalancePerTrade * 100}% of a ${ctx.balanceUsdc.toFixed(2)} balance).`,
    };
  }

  if (size > ctx.balanceUsdc) {
    return { ok: false, reason: `Proposed ${size.toFixed(2)} against a balance of ${ctx.balanceUsdc.toFixed(2)}.` };
  }

  // The pool cap is the one limit here that trims instead of refusing, and the
  // asymmetry is deliberate. Every other limit describes a state that changes:
  // the balance cap is satisfied by proposing less next pass, the position
  // limit by an exit, the daily cap by waiting. A pool's depth is not going to
  // change because we refused, so refusing on it would mean an agent that
  // never trades a thin market while filling its log with explanations. It is
  // trimmed, and the trim is written into the reason so the public log says the
  // size was ours and not the model's.
  const depth = ctx.depthUsdc?.get(proposal.tokenId);
  if (depth !== undefined && depth > 0) {
    const depthCap = depth * RISK.maxShareOfPoolDepth;
    if (depthCap < RISK.minTradeUsdc) {
      return {
        ok: false,
        reason:
          `${proposal.tokenId} has only ${depth.toFixed(0)} tUSDC of depth, so the ` +
          `${RISK.maxShareOfPoolDepth * 100}% pool cap is ${depthCap.toFixed(2)} - below the ` +
          `${RISK.minTradeUsdc} minimum. The market is too thin to trade without moving it.`,
      };
    }
    if (size > depthCap + 1e-9) {
      return {
        ok: true,
        proposal: {
          ...proposal,
          sizeUsdc: Math.floor(depthCap * 100) / 100,
          reason:
            `${proposal.reason} (trimmed from ${size.toFixed(2)} to ${depthCap.toFixed(2)} tUSDC: ` +
            `the pool holds ${depth.toFixed(0)} tUSDC and one trade may take ` +
            `${RISK.maxShareOfPoolDepth * 100}% of it)`,
        },
      };
    }
  }

  return { ok: true, proposal };
}

/** Trades in the rolling 24h window, from the contract's own trade log. */
export function countRecentTrades(trades: { timestamp_ns: string }[]): number {
  const cutoff = BigInt(Date.now() - 24 * 60 * 60 * 1000) * 1_000_000n;
  return trades.filter((t) => {
    try {
      return BigInt(t.timestamp_ns) >= cutoff;
    } catch {
      return false;
    }
  }).length;
}
