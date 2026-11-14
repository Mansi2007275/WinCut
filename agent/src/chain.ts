/**
 * Reads from NEAR, and the one place that signs.
 *
 * Views go out as plain JSON-RPC so the agent can read the chain with no key
 * at all - which is what makes a dry run a genuine rehearsal rather than a
 * simulation. Only `callBuy` and `callSell` need the key, and they are the only
 * two methods the key is permitted to call.
 */

import { Account, KeyPairSigner } from "near-api-js";

import { RpcPool, type ViewOptions } from "./rpc.js";

import {
  AGENT_ACCOUNT_ID, AGENT_PRIVATE_KEY, CONTRACT_ID, NETWORK, RPC_URL, RPC_URLS,
  TRADE_GAS, VIEW_CACHE_MS,
} from "./config.js";

export type Hop = { pool_id: number; token_in: string; token_out: string };

/**
 * near-api-js types a secret key as this template literal but does not export
 * the alias from its root entry point, so it is restated here rather than
 * reached for through a deep import that the package does not publish.
 */
type SecretKey = `ed25519:${string}` | `secp256k1:${string}`;

export type TokenConfig = {
  token_id: string;
  symbol: string;
  decimals: number;
  hops: Hop[];
  registered: boolean;
  chart_pool: string;
};

export type PositionView = {
  token_id: string;
  symbol: string;
  decimals: number;
  amount: string;
  cost_basis_usdc: string;
};

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainError";
  }
}

const stamp = () => new Date().toISOString().slice(11, 19);
const warn = (s: string) => console.log(`[${stamp()}] ${s}`);

/** One pool, shared by every read the agent makes. */
export const rpc = new RpcPool("agent", RPC_URLS, warn);

export const view = <T>(
  accountId: string,
  method: string,
  args: unknown = {},
  opts: ViewOptions = {},
): Promise<T> => rpc.view<T>(accountId, method, args, opts);

/** For reads whose answer only changes when somebody trades. */
export const viewCached = <T>(accountId: string, method: string, args: unknown = {}) =>
  view<T>(accountId, method, args, { cacheMs: VIEW_CACHE_MS });

export const rpcReport = (): string[] => [rpc.describe()];

export const getTokens = () => view<TokenConfig[]>(CONTRACT_ID, "get_tokens");

export const getBalance = (accountId = AGENT_ACCOUNT_ID) =>
  view<string>(CONTRACT_ID, "get_balance", { account_id: accountId });

export const getPositions = (accountId = AGENT_ACCOUNT_ID) =>
  view<PositionView[]>(CONTRACT_ID, "get_positions", { account_id: accountId });

export const getLossCredit = (accountId = AGENT_ACCOUNT_ID) =>
  view<string>(CONTRACT_ID, "get_loss_credit", { account_id: accountId });

export const getTradesOf = (accountId = AGENT_ACCOUNT_ID, limit = 100) =>
  view<{ timestamp_ns: string; kind?: string }[]>(CONTRACT_ID, "get_trades_of", {
    account_id: accountId,
    limit,
  });

export type RheaPool = { token_account_ids: string[]; amounts: string[]; total_fee: number };

/**
 * Pool reserves, cached.
 *
 * A pass walks every market's route for a mid price and then walks the winning
 * route again to quote the trade, so the same pools are read twice within a
 * second or two. The quote itself is never cached - `getReturn` goes through
 * the uncached `view` - but the reserves behind a mid price are the same number
 * either time.
 */
export const getPool = (refContract: string, poolId: number) =>
  viewCached<RheaPool>(refContract, "get_pool", { pool_id: poolId });

// ------------------------------------------------------------------ signing

let cached: Account | undefined;

function account(): Account {
  if (cached) return cached;
  if (!AGENT_PRIVATE_KEY) {
    throw new ChainError(
      "AGENT_PRIVATE_KEY is not set, so the agent cannot sign. Run with DRY_RUN=1 to decide without trading.",
    );
  }
  const signer = KeyPairSigner.fromSecretKey(AGENT_PRIVATE_KEY as SecretKey);
  cached = new Account(AGENT_ACCOUNT_ID, RPC_URL, signer);
  return cached;
}

/**
 * Both calls attach zero deposit, which is what lets a function-call key make
 * them at all - such a key cannot attach NEAR, and neither method is payable.
 * A buy spends the agent's balance already held inside WinCut.
 */
async function trade(methodName: "buy" | "sell", args: Record<string, unknown>): Promise<string> {
  const outcome = await account().callFunctionRaw({
    contractId: CONTRACT_ID,
    methodName,
    args,
    deposit: 0n,
    gas: TRADE_GAS,
  });
  const hash = outcome.transaction?.hash;
  if (!hash) throw new ChainError(`${methodName} returned no transaction hash`);
  return String(hash);
}

export const callBuy = (args: {
  token_id: string;
  usdc_in: string;
  min_out: string;
  followed?: string | null;
  referrer?: string | null;
}): Promise<string> =>
  trade("buy", {
    token_id: args.token_id,
    usdc_in: args.usdc_in,
    min_out: args.min_out,
    followed: args.followed ?? null,
    referrer: args.referrer ?? null,
  });

export const callSell = (args: {
  token_id: string;
  amount: string;
  min_out_usdc: string;
}): Promise<string> => trade("sell", args);

export const explorerTx = (hash: string) =>
  NETWORK === "mainnet"
    ? `https://nearblocks.io/txns/${hash}`
    : `https://testnet.nearblocks.io/txns/${hash}`;

/**
 * A real quote, hop by hop, from the same pools the trade will cross.
 *
 * `min_out` has to come from somewhere defensible. Deriving it from the mid
 * price would ignore the price impact of the agent's own size, so the slippage
 * guard would be measuring the wrong thing: it would reject fills that were
 * always going to happen and accept ones that moved the pool further than
 * intended. `get_return` is what the exchange itself will compute.
 */
export async function quoteRoute(
  refContract: string,
  hops: Hop[],
  amountIn: bigint,
): Promise<bigint> {
  let amount = amountIn;
  for (const hop of hops) {
    const out = await view<string>(refContract, "get_return", {
      pool_id: hop.pool_id,
      token_in: hop.token_in,
      amount_in: amount.toString(),
      token_out: hop.token_out,
    });
    amount = BigInt(out);
    if (amount <= 0n) throw new ChainError(`pool #${hop.pool_id} quoted zero out`);
  }
  return amount;
}

/** Same route, walked backwards, to price a sell in quote units. */
export const reverseHops = (hops: Hop[]): Hop[] =>
  [...hops].reverse().map((h) => ({ pool_id: h.pool_id, token_in: h.token_out, token_out: h.token_in }));
