/**
 * NEAR Intents 1Click: depositing USDC from another chain.
 *
 * The flow is deliberately plain. Ask for a quote, get back a deposit address
 * on the origin chain, the user sends USDC to it from whatever wallet holds
 * it, and a solver delivers native USDC on NEAR. WinCut signs nothing and
 * never touches the funds in between.
 *
 * ## Where the money lands
 *
 * Two destinations, and the difference matters:
 *
 *  - **the user's own NEAR account** (the default). A plain `ft_transfer`,
 *    the settlement every other integration uses. The USDC arrives in their
 *    wallet and they deposit it into WinCut with one more signature.
 *
 *  - **straight into the WinCut balance**, using 1Click's
 *    `customRecipientMsg` to make the settlement an `ft_transfer_call`
 *    carrying `{"deposit_for":"<account>"}`. One step instead of two.
 *    1Click marks that field HIGHLY EXPERIMENTAL and warns that funds are
 *    lost if the recipient cannot receive them, so it is opt-in, and offered
 *    only once the contract is deployed. The `deposit_for` form exists
 *    because 1Click settles from a solver account: crediting the sender
 *    would hand the user's money to the solver.
 */

import { CONTRACT_ID, USDC_ID, isDeployed } from "./near";

export type OneClickToken = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
  contractAddress?: string;
};

export type QuoteRequest = {
  originAsset: string;
  /** Raw units of the origin asset. */
  amount: string;
  /** Where a refund goes if the swap does not complete, on the origin chain. */
  refundTo: string;
  /** The user's NEAR account. */
  nearAccount: string;
  /** Opt in to settling straight into the WinCut balance. */
  intoWinCut: boolean;
  slippageBps?: number;
};

export type Quote = {
  depositAddress: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut: string;
  deadline: string;
  timeEstimate: number;
  /** Where the USDC will actually land. */
  recipient: string;
  intoWinCut: boolean;
};

export type SwapStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export type StatusResult = {
  status: SwapStatus;
  updatedAt?: string;
  originTxHashes: string[];
  destinationTxHashes: string[];
  amountOutFormatted?: string;
};

export class IntentsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IntentsError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/intents/${path}`, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new IntentsError(`1Click returned something that is not JSON (${res.status})`, res.status);
  }
  if (!res.ok) {
    const message =
      (body as { message?: string; error?: string })?.message ??
      (body as { error?: string })?.error ??
      `1Click returned ${res.status}`;
    throw new IntentsError(message, res.status);
  }
  return body as T;
}

/** Every USDC that 1Click can bridge from, other than NEAR's own. */
export async function supportedUsdcOrigins(signal?: AbortSignal): Promise<OneClickToken[]> {
  const raw = await call<OneClickToken[] | { tokens: OneClickToken[] }>("tokens", { signal });
  const all = Array.isArray(raw) ? raw : (raw.tokens ?? []);
  return all
    .filter((t) => t.symbol?.toUpperCase() === "USDC" && t.assetId !== `nep141:${USDC_ID}`)
    .sort((a, b) => a.blockchain.localeCompare(b.blockchain));
}

const CHAIN_LABELS: Record<string, string> = {
  eth: "Ethereum",
  arb: "Arbitrum",
  base: "Base",
  sol: "Solana",
  pol: "Polygon",
  bsc: "BNB Chain",
  op: "Optimism",
  avax: "Avalanche",
  gnosis: "Gnosis",
  aptos: "Aptos",
  sui: "Sui",
  stellar: "Stellar",
  monad: "Monad",
  tron: "Tron",
  zec: "Zcash",
  doge: "Dogecoin",
  btc: "Bitcoin",
  near: "NEAR",
};

export const chainLabel = (id: string) => CHAIN_LABELS[id] ?? id.toUpperCase();

/**
 * Asks 1Click what a bridged deposit would produce and reserves a deposit
 * address for it.
 *
 * The deadline is an hour out: long enough that a slow origin chain does not
 * strand the deposit, short enough that a forgotten address does not sit live
 * indefinitely. Past it, 1Click refunds to `refundTo`.
 */
export async function requestQuote(req: QuoteRequest, signal?: AbortSignal): Promise<Quote> {
  const intoWinCut = req.intoWinCut && isDeployed;
  const recipient = intoWinCut ? CONTRACT_ID : req.nearAccount;

  const body: Record<string, unknown> = {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: req.slippageBps ?? 100,
    originAsset: req.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: `nep141:${USDC_ID}`,
    amount: req.amount,
    refundTo: req.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    referral: "wincut",
  };

  if (intoWinCut) {
    // Turns the settlement into an `ft_transfer_call`, so WinCut's
    // `ft_on_transfer` runs and credits the user rather than the solver.
    body.customRecipientMsg = JSON.stringify({ deposit_for: req.nearAccount });
  }

  const res = await call<{
    quote: {
      depositAddress?: string;
      depositMemo?: string;
      amountIn: string;
      amountInFormatted: string;
      amountOut: string;
      amountOutFormatted: string;
      minAmountOut: string;
      deadline?: string;
      timeEstimate: number;
    };
  }>("quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  const q = res.quote;
  if (!q.depositAddress) {
    throw new IntentsError("1Click did not return a deposit address for this quote");
  }
  return {
    depositAddress: q.depositAddress,
    depositMemo: q.depositMemo,
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    amountOut: q.amountOut,
    amountOutFormatted: q.amountOutFormatted,
    minAmountOut: q.minAmountOut,
    deadline: q.deadline ?? "",
    timeEstimate: q.timeEstimate,
    recipient,
    intoWinCut,
  };
}

/** A dry quote: what it would produce, without reserving an address. */
export async function priceOnly(
  req: Omit<QuoteRequest, "refundTo" | "nearAccount"> & { nearAccount: string },
  signal?: AbortSignal,
): Promise<{ amountOutFormatted: string; timeEstimate: number }> {
  const res = await call<{
    quote: { amountOutFormatted: string; timeEstimate: number };
  }>("quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: req.slippageBps ?? 100,
      originAsset: req.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: `nep141:${USDC_ID}`,
      amount: req.amount,
      // A dry run reserves nothing, so these only have to be well formed.
      refundTo: req.nearAccount,
      refundType: "INTENTS",
      recipient: req.nearAccount,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
    signal,
  });
  return res.quote;
}

export async function swapStatus(
  depositAddress: string,
  depositMemo: string | undefined,
  signal?: AbortSignal,
): Promise<StatusResult> {
  const qs = new URLSearchParams({ depositAddress });
  if (depositMemo) qs.set("depositMemo", depositMemo);
  const res = await call<{
    status: SwapStatus;
    updatedAt?: string;
    swapDetails?: {
      originChainTxHashes?: { hash: string }[];
      destinationChainTxHashes?: { hash: string }[];
      amountOutFormatted?: string;
    };
  }>(`status?${qs}`, { signal });

  return {
    status: res.status,
    updatedAt: res.updatedAt,
    originTxHashes: (res.swapDetails?.originChainTxHashes ?? []).map((t) => t.hash),
    destinationTxHashes: (res.swapDetails?.destinationChainTxHashes ?? []).map((t) => t.hash),
    amountOutFormatted: res.swapDetails?.amountOutFormatted,
  };
}

/** Plain-English state, so the UI never shows a raw enum. */
export function describeStatus(status: SwapStatus, intoWinCut: boolean): {
  label: string;
  detail: string;
  tone: "pending" | "done" | "failed";
} {
  switch (status) {
    case "PENDING_DEPOSIT":
      return {
        label: "Waiting for your deposit",
        detail: "Send the USDC to the address above from the chain you chose.",
        tone: "pending",
      };
    case "KNOWN_DEPOSIT_TX":
      return {
        label: "Deposit seen",
        detail: "Waiting for it to confirm on the origin chain.",
        tone: "pending",
      };
    case "INCOMPLETE_DEPOSIT":
      return {
        label: "Not enough arrived",
        detail: "Less than the quoted amount was received. Send the rest, or wait for the refund.",
        tone: "pending",
      };
    case "PROCESSING":
      return {
        label: "Bridging",
        detail: "A solver is delivering USDC on NEAR. This usually takes under a minute.",
        tone: "pending",
      };
    case "SUCCESS":
      return {
        label: "Arrived",
        detail: intoWinCut
          ? "The USDC is in your WinCut balance and ready to trade."
          : "The USDC is in your NEAR wallet. Deposit it into WinCut to trade with it.",
        tone: "done",
      };
    case "REFUNDED":
      return {
        label: "Refunded",
        detail: "The swap did not complete and your USDC went back to the refund address.",
        tone: "failed",
      };
    case "FAILED":
      return {
        label: "Failed",
        detail: "1Click could not complete this swap. Any deposit is refunded automatically.",
        tone: "failed",
      };
  }
}
