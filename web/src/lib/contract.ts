/**
 * Typed wrappers over the WinCut contract's view methods.
 *
 * Every number the UI shows about a balance, a position, a fee or a trader
 * comes through here. The shapes mirror the Rust types exactly - raw integer
 * strings, decimals carried alongside - so nothing is converted twice.
 */

import { CONTRACT_ID, isDeployed, view } from "./near";

export type Hop = { pool_id: number; token_in: string; token_out: string };

export type TokenConfig = {
  token_id: string;
  symbol: string;
  decimals: number;
  hops: Hop[];
  registered: boolean;
  /** GeckoTerminal pool id, e.g. `refv1-4512`. */
  chart_pool: string;
};

export type Position = {
  amount: string;
  cost_basis_usdc: string;
  followed: string | null;
  referrer: string | null;
  opened_at: number;
};

export type PositionView = Position & {
  token_id: string;
  symbol: string;
  decimals: number;
};

export type SignedUsdc = { negative: boolean; abs: string };

export type Trade = {
  id: number;
  user: string;
  token_id: string;
  side: "Buy" | "Sell";
  amount: string;
  usdc: string;
  pnl: SignedUsdc | null;
  fee: string;
  followed: string | null;
  timestamp: number;
};

export type SellOutcome = {
  basis_part: string;
  pnl: SignedUsdc;
  loss_credit_before: string;
  credit_used: string;
  credit_banked: string;
  loss_credit_after: string;
  taxable_profit: string;
  fee: string;
  to_trader: string;
  to_referrer: string;
  to_protocol: string;
  user_receives: string;
};

export type LeaderboardRow = {
  account_id: string;
  realised_pnl: SignedUsdc;
  volume_usdc: string;
  followers: number;
  earnings_usdc: string;
  trades: number;
  wins: number;
  losses: number;
};

export type ContractConfig = {
  owner_id: string;
  usdc_id: string;
  ref_id: string;
  fee_bps_of_profit: number;
  trader_share_pct: number;
  referrer_share_pct: number;
  protocol_share_pct: number;
  paused: boolean;
  swap_in_flight: boolean;
  total_trades: number;
  trade_ring_capacity: number;
  shortfall_usdc: string;
};

/** Thrown when the app is running without NEXT_PUBLIC_CONTRACT_ID set. */
export class NotDeployedError extends Error {
  constructor() {
    super("WinCut is not deployed: set NEXT_PUBLIC_CONTRACT_ID");
    this.name = "NotDeployedError";
  }
}

function call<T>(method: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
  if (!isDeployed) return Promise.reject(new NotDeployedError());
  return view<T>(CONTRACT_ID, method, args, signal);
}

export const getConfig = (signal?: AbortSignal) => call<ContractConfig>("get_config", {}, signal);

export const getTokens = (signal?: AbortSignal) => call<TokenConfig[]>("get_tokens", {}, signal);

export const getToken = (tokenId: string, signal?: AbortSignal) =>
  call<TokenConfig | null>("get_token", { token_id: tokenId }, signal);

export const getBalance = (accountId: string, signal?: AbortSignal) =>
  call<string>("get_balance", { account_id: accountId }, signal);

export const getPosition = (accountId: string, tokenId: string, signal?: AbortSignal) =>
  call<Position | null>("get_position", { account_id: accountId, token_id: tokenId }, signal);

export const getPositions = (accountId: string, signal?: AbortSignal) =>
  call<PositionView[]>("get_positions", { account_id: accountId }, signal);

export const getLossCredit = (accountId: string, signal?: AbortSignal) =>
  call<string>("get_loss_credit", { account_id: accountId }, signal);

export const getClaimable = (accountId: string, signal?: AbortSignal) =>
  call<string>("get_claimable", { account_id: accountId }, signal);

export const getRecentTrades = (from = 0, limit = 50, signal?: AbortSignal) =>
  call<Trade[]>("get_recent_trades", { from, limit }, signal);

export const getTradesOf = (accountId: string, limit = 50, signal?: AbortSignal) =>
  call<Trade[]>("get_trades_of", { account_id: accountId, limit }, signal);

export const getCopyFeed = (trader: string, limit = 50, signal?: AbortSignal) =>
  call<Trade[]>("get_copy_feed", { trader, limit }, signal);

export const getLeaderboard = (limit = 25, signal?: AbortSignal) =>
  call<LeaderboardRow[]>("get_leaderboard", { limit }, signal);

export const getTrader = (accountId: string, signal?: AbortSignal) =>
  call<LeaderboardRow>("get_trader", { account_id: accountId }, signal);

/**
 * The exact settlement for selling `amount` if it fetched `expectedProceeds`.
 *
 * This runs the same pure function the settlement callback runs, so what the
 * order panel shows as "fee if you sell now" is the fee that gets charged -
 * the only difference being slippage between this quote and the fill.
 */
export const quoteSellFee = (
  accountId: string,
  tokenId: string,
  amount: string,
  expectedProceeds: string,
  signal?: AbortSignal,
) =>
  call<SellOutcome>(
    "quote_sell_fee",
    {
      account_id: accountId,
      token_id: tokenId,
      amount,
      expected_proceeds: expectedProceeds,
    },
    signal,
  );

/** The same maths with no position needed, for the landing page calculator. */
export const quoteFeeFor = (
  costBasis: string,
  proceeds: string,
  lossCredit: string,
  hasTrader: boolean,
  hasReferrer: boolean,
  signal?: AbortSignal,
) =>
  call<SellOutcome>(
    "quote_fee_for",
    {
      cost_basis: costBasis,
      proceeds,
      loss_credit: lossCredit,
      has_trader: hasTrader,
      has_referrer: hasReferrer,
    },
    signal,
  );

export const getUsdcAccounted = (signal?: AbortSignal) =>
  call<string>("get_usdc_accounted", {}, signal);
