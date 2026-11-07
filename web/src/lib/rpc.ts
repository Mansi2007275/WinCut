"use client";

import { useSyncExternalStore } from "react";
import type { Abi, Account, Address, PublicClient, WalletClient } from "viem";

/**
 * Arc's public RPC answers -32005 "rate limit exceeded" under very ordinary
 * load, and that refusal reaches the user as a lie.
 *
 * `wallet.writeContract` runs eth_estimateGas through the WALLET's configured
 * RPC, not through this app's transport. MetaMask points at Arc's default
 * endpoint, so when that endpoint throttles, viem wraps the JSON-RPC error in
 * a ContractFunctionExecutionError and the screen reads:
 *
 *     The contract function "execute" reverted with the following reason:
 *     Request is being rate limited.
 *
 * Nothing reverted. The contract was never called. Telling a trader their
 * swap was rejected by the contract when the network simply refused to answer
 * is the worst kind of wrong message, because the honest response -- wait a
 * moment -- looks nothing like the one that message implies.
 */

/* ------------------------------------------------------------ detection */

/// Walks the error's cause chain looking for a rate limit, because viem wraps
/// the original JSON-RPC error several layers deep.
export function isRateLimit(err: unknown): boolean {
  const seen = new Set<unknown>();
  let node: unknown = err;

  for (let depth = 0; depth < 8 && node && !seen.has(node); depth++) {
    seen.add(node);
    const e = node as {
      code?: unknown;
      status?: unknown;
      message?: unknown;
      details?: unknown;
      shortMessage?: unknown;
      cause?: unknown;
    };

    if (e.code === -32005 || e.status === 429) return true;

    const text = [e.message, e.details, e.shortMessage]
      .filter((v): v is string => typeof v === "string")
      .join(" ")
      .toLowerCase();
    if (text.includes("rate limit") || text.includes("rate limited")) return true;

    node = e.cause;
  }
  return false;
}

/// A wallet prompt the user dismissed. Never retried: repeating it would
/// reopen MetaMask on someone who just said no.
export function isUserRejection(err: unknown): boolean {
  let node: unknown = err;
  for (let depth = 0; depth < 8 && node; depth++) {
    const e = node as { code?: unknown; name?: unknown; cause?: unknown };
    if (e.code === 4001 || e.name === "UserRejectedRequestError") return true;
    node = e.cause;
  }
  return false;
}

/* ---------------------------------------------------------------- retry */

const BACKOFF_MS = [1_500, 3_000, 6_000];

/**
 * Retries `fn` only while the failure is a rate limit.
 *
 * A real revert and a user rejection both fail on the first attempt, which is
 * the point: the only thing worth waiting out is a network that is busy.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  onRetry?: (attempt: number, waitMs: number) => void,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (isUserRejection(e) || !isRateLimit(e) || attempt === BACKOFF_MS.length) throw e;
      const wait = BACKOFF_MS[attempt];
      onRetry?.(attempt + 1, wait);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

/* ------------------------------------------------------- the write path */

export type ExecuteArgs = {
  wallet: WalletClient;
  /// The app's public client. It uses arcTransport, which has the fallback
  /// endpoints; the wallet's own RPC does not.
  client: PublicClient;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
  account: Account | Address;
  onRetry?: (attempt: number, waitMs: number) => void;
};

/**
 * Simulate, estimate and send — with the estimate done on OUR transport.
 *
 * Passing an explicit `gas` is the whole trick: given one, MetaMask skips its
 * own eth_estimateGas, so the single call that was failing never happens on
 * the throttled endpoint. Simulating first also means a genuine revert is
 * caught here, where it can be reported as a revert, instead of surfacing
 * from inside the wallet.
 *
 * The 30% headroom covers the gas drift between simulating against the
 * current block and landing in a later one; the v4 swap path writes to
 * storage slots whose cost depends on whether they were already warm.
 */
export async function writeWithFallbackGas(
  a: ExecuteArgs,
): Promise<`0x${string}`> {
  return withRateLimitRetry(async () => {
    const simulated = await a.client.simulateContract({
      address: a.address,
      abi: a.abi,
      functionName: a.functionName,
      args: a.args as never,
      value: a.value,
      account: a.account,
    });

    const estimate = await a.client.estimateContractGas({
      address: a.address,
      abi: a.abi,
      functionName: a.functionName,
      args: a.args as never,
      value: a.value,
      account: a.account,
    });

    const gas = (estimate * 13n) / 10n + 1n;

    return a.wallet.writeContract({
      ...simulated.request,
      gas,
      chain: a.wallet.chain,
      account: a.wallet.account!,
    });
  }, a.onRetry);
}

/* ------------------------------------------- quiet the polling mid-trade */

/**
 * Set while a buy or sell sheet is open.
 *
 * The screen polls several reads every 5 seconds. During a trade that is the
 * same endpoint the gas estimate needs, and the poll traffic is what pushes
 * it over the limit at the exact moment it matters most. Holding the fast
 * polls for the duration of the sheet costs nothing: the numbers behind the
 * sheet are not what the user is looking at.
 */
let tradeOpen = false;
const listeners = new Set<() => void>();

export function setTradeOpen(open: boolean) {
  if (tradeOpen === open) return;
  tradeOpen = open;
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTradeOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => tradeOpen,
    () => false,
  );
}

/// The interval a fast-polling query should use right now. Held at 15s rather
/// than stopped outright so a balance still settles while a sheet is open.
export function useLivePollMs(normal = 5_000): number {
  return useTradeOpen() ? 15_000 : normal;
}
