/**
 * The autonomous trader, as the web app sees it.
 *
 * The agent is an ordinary WinCut account: it deposits, it buys, it sells, it
 * accrues followers and earnings, and every number on its page comes from the
 * contract exactly as a human trader's does. What makes it worth marking is
 * not special accounting - it is that nobody is choosing its trades, so a
 * viewer deciding whether to copy it deserves to be told.
 *
 * The decision log is the other half. A page that showed only the trades would
 * flatter the agent by hiding the hours it held, which are most of them, so the
 * log carries every pass including the ones where nothing happened.
 */

export type AgentAction = "BUY" | "SELL" | "HOLD";

export type AgentDecision = {
  /** Milliseconds since the epoch. */
  t: number;
  action: AgentAction;
  tokenId?: string;
  symbol?: string;
  sizeUsdc?: number;
  sellFraction?: number;
  reason: string;
  /** Which decider answered: the model, the fallback, or a hard rule. */
  decidedBy: "llm" | "fallback" | "risk" | "forced-exit";
  /** Present when the risk layer overruled a proposal. */
  vetoed?: { action: AgentAction; reason: string };
  inputs: {
    balanceUsdc: number;
    openPositions: { symbol: string; amount: number; entry: number; mid: number; pnlPct: number }[];
    markets: {
      symbol: string;
      tokenId: string;
      mid: number;
      liquidity: number;
      changePct?: number;
      momentumPct?: number;
      candles: number;
      notes: string[];
    }[];
    tradesLast24h: number;
  };
  txHash?: string;
  error?: string;
  dryRun: boolean;
};

export type AgentLog = {
  agent: string | null;
  configured: boolean;
  decisions: AgentDecision[];
  /** Why the log is empty, when it is empty for a reason worth stating. */
  detail?: string;
};

/**
 * The agent's account id, or undefined when no agent is running. Public on
 * purpose: it is an account id, which is public on chain anyway, and the
 * browser needs it to know which trader page to mark.
 */
export const AGENT_ACCOUNT_ID = process.env.NEXT_PUBLIC_AGENT_ACCOUNT_ID?.trim() || undefined;

export const isAgent = (accountId: string | undefined): boolean =>
  Boolean(accountId && AGENT_ACCOUNT_ID && accountId === AGENT_ACCOUNT_ID);

/**
 * What the agent's key can and cannot do, stated on its page.
 *
 * This is checkable rather than reassuring: the permission is on the access key
 * itself, so anyone can ask the chain to confirm it, and the page says how.
 */
export const KEY_LIMITS =
  "This agent cannot withdraw funds. Its key can only call buy/sell on WinCut.";

export const KEY_LIMITS_DETAIL =
  "The agent signs with a NEAR function-call access key restricted to this contract and to the two methods buy and sell. A function-call key cannot attach a deposit and cannot transfer NEAR, and withdraw and claim are not among its permitted methods, so the runtime rejects them before any WinCut code runs.";

/** Human label for which decider produced an entry. */
export function decidedByLabel(by: AgentDecision["decidedBy"]): string {
  switch (by) {
    case "llm":
      return "model";
    case "fallback":
      return "momentum fallback";
    case "risk":
      return "risk limit";
    case "forced-exit":
      return "hard exit";
  }
}

export function decidedByTone(by: AgentDecision["decidedBy"]): "neutral" | "accent" | "loss" {
  if (by === "risk") return "loss";
  if (by === "forced-exit") return "loss";
  if (by === "llm") return "accent";
  return "neutral";
}
