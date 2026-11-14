/**
 * Everything the agent reads from its environment, and the limits it cannot
 * talk its way out of.
 *
 * The risk limits are deliberately here rather than in the prompt. A limit
 * written into a prompt is a request: the model can misread it, round it,
 * ignore it under pressure from its own reasoning, or be talked out of it by
 * whatever it just read from the chain. A limit written here is arithmetic the
 * model never touches - its answer is a proposal, and `risk.ts` is what decides
 * whether that proposal becomes a transaction.
 */

export type Network = "testnet" | "mainnet";

const env = (k: string, fallback?: string): string => {
  const v = process.env[k]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${k} is required - see agent/README.md`);
};

const optional = (k: string): string | undefined => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};

export const NETWORK = (optional("NEAR_NETWORK") ?? "testnet") as Network;

export const RPC_URL =
  optional("NEAR_RPC_URL") ??
  (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");

/** The WinCut contract the agent trades through. */
export const CONTRACT_ID = env(
  "WINCUT_CONTRACT_ID",
  NETWORK === "testnet" ? "wincut-mansi.testnet" : "",
);

/** The agent's own account. Conventionally a sub-account of the contract's. */
export const AGENT_ACCOUNT_ID = env(
  "AGENT_ACCOUNT_ID",
  NETWORK === "testnet" ? `agent.${CONTRACT_ID}` : "",
);

/**
 * The function-call key. It can call `buy` and `sell` on the WinCut contract
 * and nothing else - not `withdraw`, not `claim`, not a transfer. See the
 * README for the command that creates it.
 */
export const AGENT_PRIVATE_KEY = optional("AGENT_PRIVATE_KEY");

/** When true the agent decides and logs but never signs. */
export const DRY_RUN = process.env.DRY_RUN === "1" || process.argv.includes("--dry");

/** One pass and exit, rather than looping. */
export const RUN_ONCE = process.argv.includes("--once");

export const LOOP_MS = Number(optional("AGENT_LOOP_MS") ?? 5 * 60_000);

// ------------------------------------------------------------------- the LLM

/** NEAR AI Cloud, or anything else that speaks the OpenAI chat completions API. */
export const LLM_BASE_URL = optional("NEAR_AI_BASE_URL") ?? "https://api.near.ai/v1";
export const LLM_MODEL = optional("NEAR_AI_MODEL") ?? "deepseek-v3";
export const LLM_API_KEY = optional("NEAR_AI_API_KEY");

// ------------------------------------------------------------------- storage

export const UPSTASH_URL = optional("UPSTASH_REDIS_REST_URL");
export const UPSTASH_TOKEN = optional("UPSTASH_REDIS_REST_TOKEN");

/**
 * The market the agent treats as its main one, put first so it is what the
 * model reads about before anything else.
 *
 * On testnet this is the pool WinCut actually operates and keeps traded, so it
 * is the only market with enough history to read a trend from. The others stay
 * listed and are still considered - they are simply not where anything is
 * happening, and ordering them behind it stops six trendless markets crowding
 * out the one that has a trend.
 */
export const PRIMARY_MARKET_TOKEN_ID =
  optional("PRIMARY_MARKET_TOKEN_ID") ??
  (NETWORK === "testnet" ? "mnear.tkn.primitives.testnet" : "");

/**
 * Candle width the agent reasons over. Short by default: the series is only as
 * old as the market WinCut runs, and a 15-minute candle needs four times as
 * long to say anything as a 5-minute one.
 */
export const TIMEFRAME = optional("AGENT_TIMEFRAME") ?? "5m";

/**
 * The markets the agent is allowed to trade, as token ids.
 *
 * The contract still lists six older testnet tokens from before WinCut ran its
 * own market: wNEAR, LNC, PEM, pNEAR, MEV, SHIT1. Their pools are dead, so
 * their "prices" are whatever the last person to touch them left behind - and
 * five of the six report an identical momentum because they share one route
 * hop, which is the giveaway that nothing in them is a price at all. The web
 * app stops showing them by listing the four mirrors in NEXT_PUBLIC_TOKENS,
 * but that is a display filter and the agent never saw it: it was reading all
 * ten and could have put real balance into a market with no counterparty.
 *
 * Empty means every registered market, which is the right default on mainnet
 * where the listed markets are real ones.
 */
export const AGENT_MARKETS: string[] = (
  optional("AGENT_MARKETS") ??
  (NETWORK === "testnet"
    ? [
        "mnear.tkn.primitives.testnet",
        "mdragon.tkn.primitives.testnet",
        "mshitzu.tkn.primitives.testnet",
        "mlonk.tkn.primitives.testnet",
      ].join(",")
    : "")
)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

/**
 * A price at whatever scale it happens to be.
 *
 * `toFixed(6)` printed MDRAGON as 0.000000, which is not a rounding problem but
 * a reporting one: it says the price is zero. The web app already counts the
 * zeros instead; the agent's own log had been left behind.
 */
export const fmtPrice = (p: number | undefined): string =>
  p === undefined || !Number.isFinite(p) ? "n/a" : p >= 0.001 ? p.toFixed(6) : p.toPrecision(6);

/** Where the web app reads candles from, for the agent's own market view. */
export const WEB_BASE_URL = optional("WINCUT_WEB_URL") ?? "https://wincut.vercel.app";

// --------------------------------------------------------------------- risk

/**
 * Hard limits. Every one of these is checked in code after the model answers.
 * None of them is negotiable by the model, and exceeding one turns a trade
 * into a HOLD with the reason recorded.
 */
export const RISK = {
  /** Share of the agent's WinCut balance a single buy may spend. */
  maxShareOfBalancePerTrade: 0.2,
  /**
   * Share of the market's pool depth a single buy may take.
   *
   * A cap measured against the market instead of against the wallet. 20% of a
   * 200 tUSDC balance is 40 tUSDC, which is a sober size next to the 1,000
   * tUSDC MNEAR pool and 8% of the depth of a 400 tUSDC memecoin pool. One
   * such buy moved MLONK 20% off its peg; the market maker spent the next
   * several minutes undoing it, and the chart kept a spike that recorded
   * nothing except the agent trading against itself through a pool too thin to
   * absorb it. A limit on how much of its own money the agent risks says
   * nothing about how much of the market it displaces, and the second question
   * is the one a thin pool asks.
   *
   * 1.5% of the quote reserve moves a constant-product price by roughly 3%.
   */
  maxShareOfPoolDepth: 0.015,
  /** Positions open at once. A fourth idea has to wait for an exit. */
  maxOpenPositions: 3,
  /** Unrealised loss that forces a sell, regardless of what the model thinks. */
  stopLossPct: -8,
  /** Unrealised gain that takes the win, likewise. */
  takeProfitPct: 12,
  /** Trades in a rolling 24 hours. */
  maxTradesPerDay: 12,
  /** Never put up a position smaller than this; dust is not a trade. */
  minTradeUsdc: 1,
} as const;

/**
 * Thresholds the deterministic fallback acts on, as percentages.
 *
 * These are small on purpose, and the reason is the market rather than a
 * preference. WinCut's testnet market is pegged: the market maker holds it
 * within ±0.6% of real mainnet NEAR, so a move of 1.5% - a sensible entry on a
 * volatile pool - is one the price is structurally prevented from making. A
 * threshold the market cannot reach is not caution, it is an agent that never
 * trades while appearing to have a strategy.
 *
 * Raise them for a market with no peg holding it in.
 */
export const FALLBACK = {
  enterPct: Number(optional("FALLBACK_ENTER_PCT") ?? 0.35),
  exitPct: Number(optional("FALLBACK_EXIT_PCT") ?? -0.35),
} as const;

export const USDC_DECIMALS = 6;

/** Gas for a trade. The contract itself requires at least 170 Tgas. */
export const TRADE_GAS = 250_000_000_000_000n;

/** Slippage the agent accepts on its own market orders. */
export const SLIPPAGE_BPS = 100;

export function describeConfig(): string {
  return [
    `network   ${NETWORK}`,
    `contract  ${CONTRACT_ID}`,
    `agent     ${AGENT_ACCOUNT_ID}`,
    `rpc       ${RPC_URL}`,
    `brain     ${LLM_API_KEY ? `${LLM_MODEL} via ${LLM_BASE_URL}` : "deterministic fallback (no NEAR_AI_API_KEY)"}`,
    `storage   ${UPSTASH_URL ? "upstash" : "in-memory only (no UPSTASH_REDIS_REST_URL)"}`,
    `mode      ${DRY_RUN ? "DRY RUN - decides and logs, never signs" : "live"}`,
  ].join("\n");
}

/** Rhea/Ref Finance classic AMM, which holds the pools WinCut routes through. */
export const REF_CONTRACT =
  optional("REF_CONTRACT") ?? (NETWORK === "mainnet" ? "v2.ref-finance.near" : "ref-finance-101.testnet");

/** The quote token: native USDC on mainnet, thUSDC on testnet. */
export const USDC_ID =
  optional("USDC_ID") ??
  (NETWORK === "mainnet"
    ? "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
    : "thusdc.testnet");
