/**
 * Reads and signs. One signer per bot, because each bot is its own account on
 * the leaderboard and its own holder of a restricted key.
 *
 * Views go out as plain JSON-RPC so a dry run needs no keys at all. The only
 * methods ever signed are `buy` and `sell` on WinCut and `ft_transfer_call` on
 * the two tokens - the market maker swaps on Rhea directly, which is what makes
 * it a market maker rather than another WinCut trader.
 */

import { Account, KeyPairSigner } from "near-api-js";

import { MAINNET_RPC_URL, RPC_URL, SWAP_GAS, TRADE_GAS } from "./config.js";

type SecretKey = `ed25519:${string}` | `secp256k1:${string}`;

export type Hop = { pool_id: number; token_in: string; token_out: string };
export type RheaPool = { token_account_ids: string[]; amounts: string[]; total_fee: number };

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainError";
  }
}

async function rpcView<T>(rpc: string, accountId: string, method: string, args: unknown): Promise<T> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const json = (await res.json()) as { error?: unknown; result?: { result?: number[]; error?: string } };
  if (json.error) throw new ChainError(`rpc: ${JSON.stringify(json.error).slice(0, 180)}`);
  if (json.result?.error) throw new ChainError(`${accountId}.${method}: ${json.result.error}`);
  if (!json.result?.result) throw new ChainError(`${accountId}.${method}: empty result`);
  return JSON.parse(Buffer.from(json.result.result).toString()) as T;
}

export const view = <T>(accountId: string, method: string, args: unknown = {}) =>
  rpcView<T>(RPC_URL, accountId, method, args);

export const viewMainnet = <T>(accountId: string, method: string, args: unknown = {}) =>
  rpcView<T>(MAINNET_RPC_URL, accountId, method, args);

export const getPool = (ref: string, poolId: number) => view<RheaPool>(ref, "get_pool", { pool_id: poolId });

export const getReturn = (ref: string, poolId: number, tokenIn: string, tokenOut: string, amountIn: bigint) =>
  view<string>(ref, "get_return", {
    pool_id: poolId,
    token_in: tokenIn,
    amount_in: amountIn.toString(),
    token_out: tokenOut,
  });

export const getBalance = (contract: string, accountId: string) =>
  view<string>(contract, "get_balance", { account_id: accountId });

export const getPositions = (contract: string, accountId: string) =>
  view<{ token_id: string; symbol: string; decimals: number; amount: string; cost_basis_usdc: string }[]>(
    contract,
    "get_positions",
    { account_id: accountId },
  );

export const ftBalanceOf = (token: string, accountId: string) =>
  view<string>(token, "ft_balance_of", { account_id: accountId });

// ------------------------------------------------------------------ signing

const signers = new Map<string, Account>();

export function signerFor(accountId: string, privateKey: string | undefined): Account {
  const cached = signers.get(accountId);
  if (cached) return cached;
  if (!privateKey) throw new ChainError(`${accountId} has no key configured, so it cannot sign`);
  const account = new Account(accountId, RPC_URL, KeyPairSigner.fromSecretKey(privateKey as SecretKey));
  signers.set(accountId, account);
  return account;
}

/** A WinCut trade. Zero deposit, which is what a function-call key permits. */
export async function wincutBuy(
  account: Account,
  contract: string,
  args: { token_id: string; usdc_in: string; min_out: string },
): Promise<string> {
  const out = await account.callFunctionRaw({
    contractId: contract,
    methodName: "buy",
    args: { ...args, followed: null, referrer: null },
    deposit: 0n,
    gas: TRADE_GAS,
  });
  const hash = out.transaction?.hash;
  if (!hash) throw new ChainError("buy returned no transaction hash");
  return String(hash);
}

export async function wincutSell(
  account: Account,
  contract: string,
  args: { token_id: string; amount: string; min_out_usdc: string },
): Promise<string> {
  const out = await account.callFunctionRaw({
    contractId: contract,
    methodName: "sell",
    args,
    deposit: 0n,
    gas: TRADE_GAS,
  });
  const hash = out.transaction?.hash;
  if (!hash) throw new ChainError("sell returned no transaction hash");
  return String(hash);
}

/**
 * A direct swap on Rhea, used only by the market maker.
 *
 * Needs one yoctoNEAR, which a function-call key cannot attach, so the maker
 * holds a full-access key on its own account. That account is funded with gas
 * and the pool's inventory and nothing else, so the worst a leak of it does is
 * move the peg on a testnet pool.
 */
export async function refSwap(
  account: Account,
  ref: string,
  tokenIn: string,
  amountIn: bigint,
  poolId: number,
  tokenOut: string,
  minOut: bigint,
): Promise<string> {
  const msg = JSON.stringify({
    force: 0,
    actions: [
      {
        pool_id: poolId,
        token_in: tokenIn,
        token_out: tokenOut,
        amount_in: amountIn.toString(),
        min_amount_out: minOut.toString(),
      },
    ],
  });
  const out = await account.callFunctionRaw({
    contractId: tokenIn,
    methodName: "ft_transfer_call",
    args: { receiver_id: ref, amount: amountIn.toString(), msg },
    deposit: 1n,
    gas: SWAP_GAS,
  });
  const hash = out.transaction?.hash;
  if (!hash) throw new ChainError("ft_transfer_call returned no transaction hash");
  return String(hash);
}

/** Pulls whatever the swap left sitting in Rhea's internal balance. */
export async function refWithdraw(
  account: Account,
  ref: string,
  tokenId: string,
  amount: bigint,
): Promise<string | null> {
  if (amount <= 0n) return null;
  const out = await account.callFunctionRaw({
    contractId: ref,
    methodName: "withdraw",
    args: { token_id: tokenId, amount: amount.toString() },
    deposit: 1n,
    gas: 100_000_000_000_000n,
  });
  return String(out.transaction?.hash ?? "");
}

export const getDeposits = (ref: string, accountId: string) =>
  view<Record<string, string>>(ref, "get_deposits", { account_id: accountId });

export const explorerTx = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
