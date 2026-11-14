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

import {
  MAINNET_RPC_URLS, RPC_URL, RPC_URLS, SWAP_GAS, TRADE_GAS, VIEW_CACHE_MS,
} from "./config.js";
import { RpcPool, type ViewOptions } from "./rpc.js";

type SecretKey = `ed25519:${string}` | `secp256k1:${string}`;

export type Hop = { pool_id: number; token_in: string; token_out: string };
export type RheaPool = { token_account_ids: string[]; amounts: string[]; total_fee: number };

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainError";
  }
}

const stamp = () => new Date().toISOString().slice(11, 19);
const warn = (s: string) => console.log(`[${stamp()}] ${s}`);

/**
 * One pool for testnet and one for mainnet, shared by everything in the
 * process - which is the point. The maker and the sampling tick both want the
 * same pool reserves, and now the second one to ask gets the first one's
 * answer.
 */
export const testnet = new RpcPool("testnet", RPC_URLS, warn);
export const mainnet = new RpcPool("mainnet", MAINNET_RPC_URLS, warn);

export const view = <T>(
  accountId: string,
  method: string,
  args: unknown = {},
  opts: ViewOptions = {},
) => testnet.view<T>(accountId, method, args, opts);

export const viewMainnet = <T>(
  accountId: string,
  method: string,
  args: unknown = {},
  opts: ViewOptions = {},
) => mainnet.view<T>(accountId, method, args, opts);

/** The cached variants, for reads whose answer only changes when someone trades. */
export const viewCached = <T>(accountId: string, method: string, args: unknown = {}) =>
  view<T>(accountId, method, args, { cacheMs: VIEW_CACHE_MS });

export const viewMainnetCached = <T>(accountId: string, method: string, args: unknown = {}) =>
  viewMainnet<T>(accountId, method, args, { cacheMs: VIEW_CACHE_MS });

export const rpcReport = (): string[] => [testnet.describe(), mainnet.describe()];

/** Reserves. Cached, and `fresh` when a caller needs the post-trade state. */
export const getPool = (ref: string, poolId: number, fresh = false) =>
  view<RheaPool>(ref, "get_pool", { pool_id: poolId }, { cacheMs: VIEW_CACHE_MS, fresh });

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

/**
 * Signing deliberately does not fail over.
 *
 * Views are idempotent, so trying a second endpoint costs nothing. A signed
 * transaction is not: an endpoint that times out may still have broadcast it,
 * and resending the same trade elsewhere risks buying twice. One endpoint, and
 * a failed send stays failed and gets logged.
 */
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
