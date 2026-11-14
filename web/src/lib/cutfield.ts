/**
 * The numbers behind /dashboard, derived from the on-chain trade ring.
 *
 * Nothing here is an estimate and nothing is stored. The contract keeps its
 * last 500 settled trades, each carrying the side, the USDC that moved, the
 * realised P&L and the fee actually charged - which is enough to recompute
 * every figure on the page from primary data in the browser. The ring is the
 * only source; where a figure cannot come from it, it comes from a named view
 * call instead and the panel says which.
 *
 * Two of the page's headline numbers are counterfactual, and they are kept
 * separate from the measured ones for that reason:
 *
 *   `feesCharged` is measured - the sum of the `fee` field, which is what the
 *   contract really took.
 *
 *   `feesNotCharged` is what a conventional 1%-in-1%-out venue would have
 *   taken on these same trades. It is a comparison, not a WinCut number, and
 *   the UI labels it as one. Using WinCut's own 10%-of-profit rule for the
 *   comparison would be meaningless, because on a losing exit that rule also
 *   says zero: the saving only exists relative to a venue that charges on
 *   volume.
 */

import type { LeaderboardRow, SignedUsdc, Trade } from "./contract";
import { signedNumber, toNumber } from "./format";
import { USDC_DECIMALS } from "./near";

/** The fee rate a conventional venue charges per side, as a fraction. */
export const CONVENTIONAL_FEE_PER_SIDE = 0.01;

export type SettledTrade = {
  id: number;
  user: string;
  tokenId: string;
  symbol: string;
  side: "Buy" | "Sell";
  /** USDC in on a buy, USDC out on a sell. */
  usdc: number;
  /** Realised P&L, signed. Null on a buy, which realises nothing. */
  pnl: number | null;
  fee: number;
  followed: string | null;
  /** Milliseconds since the epoch. */
  at: number;
  /** A sell that realised a loss: the fee is zero and a credit was banked. */
  losingExit: boolean;
  /** A sell that realised a profit, whether or not a fee survived the credit. */
  winningExit: boolean;
};

export type CutFieldTotals = {
  trades: number;
  buys: number;
  sells: number;
  tradesToday: number;
  volumeUsd: number;
  /** Net realised P&L across every settled sell. Can be, and is, negative. */
  realisedPnl: number;
  /** Only the winning side of it, for the "profit to users" reading. */
  profitRealised: number;
  lossRealised: number;
  feesCharged: number;
  /** What 1%-in-1%-out would have taken on the losing exits alone. */
  feesNotChargedOnLosses: number;
  /** And on everything in the ring, both sides. */
  feesNotChargedTotal: number;
  losingExits: number;
  winningExits: number;
  /** Losing exits that were nonetheless charged a fee. Must be zero. */
  losingExitsCharged: number;
  creditBankedFromRing: number;
  activeTraders: number;
  firstAt: number | undefined;
  lastAt: number | undefined;
};

/** The three-way split of a fee, as the contract's config declares it. */
export type FeeSplit = {
  traderPct: number;
  referrerPct: number;
  protocolPct: number;
  /** Measured fee, split by those percentages. All three are zero when it is. */
  toTrader: number;
  toReferrer: number;
  toProtocol: number;
  total: number;
};

const num = (raw: string | undefined) => toNumber(raw, USDC_DECIMALS);
const signed = (v: SignedUsdc | null | undefined) => (v ? signedNumber(v) : null);

/** One ring entry, decoded once so no component re-parses raw integers. */
export function settle(trade: Trade, symbols: Map<string, string>): SettledTrade {
  const pnl = signed(trade.pnl);
  const isSell = trade.side === "Sell";
  return {
    id: trade.id,
    user: trade.user,
    tokenId: trade.token_id,
    symbol: symbols.get(trade.token_id) ?? trade.token_id.split(".")[0]!.toUpperCase(),
    side: trade.side,
    usdc: num(trade.usdc),
    pnl,
    fee: num(trade.fee),
    followed: trade.followed,
    at: Number(BigInt(trade.timestamp) / 1_000_000n),
    losingExit: isSell && pnl !== null && pnl < 0,
    winningExit: isSell && pnl !== null && pnl >= 0,
  };
}

export function decodeRing(trades: Trade[] | undefined, symbols: Map<string, string>): SettledTrade[] {
  return (trades ?? []).map((t) => settle(t, symbols)).sort((a, b) => a.at - b.at);
}

export function totals(ring: SettledTrade[]): CutFieldTotals {
  const dayAgo = Date.now() - 86_400_000;
  const traders = new Set<string>();
  let buys = 0, sells = 0, tradesToday = 0, volumeUsd = 0;
  let realisedPnl = 0, profitRealised = 0, lossRealised = 0;
  let feesCharged = 0, feesNotChargedOnLosses = 0;
  let losingExits = 0, winningExits = 0, losingExitsCharged = 0, creditBankedFromRing = 0;

  for (const t of ring) {
    traders.add(t.user);
    volumeUsd += t.usdc;
    feesCharged += t.fee;
    if (t.at >= dayAgo) tradesToday++;
    if (t.side === "Buy") { buys++; continue; }
    sells++;
    if (t.pnl !== null) realisedPnl += t.pnl;
    if (t.losingExit) {
      losingExits++;
      lossRealised += -(t.pnl ?? 0);
      creditBankedFromRing += -(t.pnl ?? 0);
      feesNotChargedOnLosses += t.usdc * CONVENTIONAL_FEE_PER_SIDE;
      if (t.fee > 0) losingExitsCharged++;
    } else if (t.winningExit) {
      winningExits++;
      profitRealised += t.pnl ?? 0;
    }
  }

  return {
    trades: ring.length,
    buys,
    sells,
    tradesToday,
    volumeUsd,
    realisedPnl,
    profitRealised,
    lossRealised,
    feesCharged,
    feesNotChargedOnLosses,
    feesNotChargedTotal: volumeUsd * CONVENTIONAL_FEE_PER_SIDE,
    losingExits,
    winningExits,
    losingExitsCharged,
    creditBankedFromRing,
    activeTraders: traders.size,
    firstAt: ring[0]?.at,
    lastAt: ring[ring.length - 1]?.at,
  };
}

export function feeSplit(
  feesCharged: number,
  config: { trader_share_pct: number; referrer_share_pct: number; protocol_share_pct: number } | undefined,
): FeeSplit {
  const traderPct = config?.trader_share_pct ?? 50;
  const referrerPct = config?.referrer_share_pct ?? 20;
  const protocolPct = config?.protocol_share_pct ?? 30;
  return {
    traderPct,
    referrerPct,
    protocolPct,
    toTrader: (feesCharged * traderPct) / 100,
    toReferrer: (feesCharged * referrerPct) / 100,
    toProtocol: (feesCharged * protocolPct) / 100,
    total: feesCharged,
  };
}

/**
 * The accounts whose banked credit is worth asking the contract about.
 *
 * The ring already says how much credit each loss banked, but banked is not
 * the same as still held: a later win spends it. Only `get_loss_credit` knows
 * the current figure, so the page asks - for the handful of accounts that
 * actually appear in the ring, not for every account that ever existed.
 */
export function tradersInRing(ring: SettledTrade[], limit = 24): string[] {
  const seen = new Map<string, number>();
  for (const t of ring) seen.set(t.user, (seen.get(t.user) ?? 0) + 1);
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

/** Leaderboard rows, decoded, most volume first. */
export type BoardRow = {
  accountId: string;
  realisedPnl: number;
  volume: number;
  earnings: number;
  trades: number;
  wins: number;
  losses: number;
  followers: number;
};

export function boardRows(rows: LeaderboardRow[] | undefined): BoardRow[] {
  return (rows ?? [])
    .map((r) => ({
      accountId: r.account_id,
      realisedPnl: signedNumber(r.realised_pnl),
      volume: num(r.volume_usdc),
      earnings: num(r.earnings_usdc),
      trades: r.trades,
      wins: r.wins,
      losses: r.losses,
      followers: r.followers,
    }))
    .sort((a, b) => b.volume - a.volume);
}
