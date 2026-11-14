/**
 * Reads from NEAR, and the one place that signs.
 *
 * Views go out as plain JSON-RPC so the agent can read the chain with no key
 * at all - which is what makes a dry run a genuine rehearsal rather than a
 * simulation. Only `callBuy` and `callSell` need the key, and they are the only
 * two methods the key is permitted to call.
 */

import { Account, KeyPairSigner, actions, baseEncode } from "near-api-js";

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

/**
 * One row of the contract's trade ring, named the way the contract names it.
 *
 * The timestamp field is `timestamp`, nanoseconds since the epoch. The agent
 * used to read `timestamp_ns`, which is not a field this contract has ever
 * returned - so every trade parsed as undated, every trade was counted as
 * outside the 24-hour window, and the page said "0 trades in 24h" while the
 * chain held dozens. A wrong field name is a silent zero, which is the worst
 * shape a bug can take in a counter that exists to stop the agent trading.
 */
export type Trade = {
  id: number;
  user: string;
  token_id: string;
  side: "Buy" | "Sell";
  amount: string;
  usdc: string;
  fee: string;
  /** Nanoseconds since the epoch. */
  timestamp: string | number;
};

/**
 * The agent's own trades, newest first, read fresh.
 *
 * Never cached: this is the number the daily limit is enforced against, and a
 * stale count is a limit that lets one more trade through than it should.
 */
export const getTradesOf = (accountId = AGENT_ACCOUNT_ID, limit = 200) =>
  view<Trade[]>(CONTRACT_ID, "get_trades_of", { account_id: accountId, limit }, { fresh: true });

/** The whole ring, for when `get_trades_of` is unavailable. */
export const getRecentTrades = (limit = 300) =>
  view<Trade[]>(CONTRACT_ID, "get_recent_trades", { from: 0, limit }, { fresh: true });

/**
 * Every trade this account made, from whichever view answers.
 *
 * `get_trades_of` is the contract filtering its own ring; `get_recent_trades`
 * is the same ring unfiltered, filtered here instead. Having the second is
 * what lets the caller treat a failure as a failure: the count used to be
 * wrapped in a catch that returned an empty array, so an unreachable endpoint
 * and an account that had never traded produced the same answer, and the agent
 * would happily trade against a limit it had just failed to read.
 */
export async function getMyTrades(accountId = AGENT_ACCOUNT_ID): Promise<Trade[]> {
  try {
    return await getTradesOf(accountId);
  } catch (first) {
    try {
      return (await getRecentTrades()).filter((t) => t.user === accountId);
    } catch {
      throw new ChainError(
        `could not read this account's trades: ${(first as Error).message}`,
      );
    }
  }
}

/** Open positions, read fresh, as the chain has them. */
export const getOpenPositions = async (accountId = AGENT_ACCOUNT_ID): Promise<PositionView[]> =>
  (await view<PositionView[]>(CONTRACT_ID, "get_positions", { account_id: accountId }, { fresh: true }))
    .filter((p) => {
      try {
        return BigInt(p.amount) > 0n;
      } catch {
        return false;
      }
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
 * What a signed trade came back as.
 *
 * `hash` is present whenever the transaction was signed, which is before it
 * was sent - so it survives a broadcast that fails. That is the whole point.
 * The old code asked near-api-js to sign and send in one step and only learned
 * the hash from a successful reply, so an RPC that executed the transaction
 * and then failed to describe it left the agent with an error and no way to
 * find out what had actually happened. It recorded "transaction failed:
 * Internal server error" against trades that were already on chain.
 */
export type SendResult = { hash?: string; error?: string };

/**
 * Both calls attach zero deposit, which is what lets a function-call key make
 * them at all - such a key cannot attach NEAR, and neither method is payable.
 * A buy spends the agent's balance already held inside WinCut.
 *
 * Signing and broadcasting are separate steps here. The transaction hash is
 * the hash of the signed transaction's body, so it can be computed locally the
 * moment the key has signed, and `confirmTx` can then ask the chain what
 * became of it no matter how the broadcast went.
 */
async function trade(methodName: "buy" | "sell", args: Record<string, unknown>): Promise<SendResult> {
  const acct = account();
  const signer = acct.getSigner();
  if (!signer) throw new ChainError("the account has no signer");

  const tx = await acct.createTransaction({
    receiverId: CONTRACT_ID,
    actions: [actions.functionCall(methodName, args, TRADE_GAS, 0n)],
    publicKey: await signer.getPublicKey(),
  });

  // The library's own hash, from the library's own signing step, rather than
  // a second implementation of sha256-over-the-encoded-transaction that could
  // drift from it. If this hash were wrong the agent would look up a
  // transaction nobody has, decide it never landed, and reintroduce the exact
  // bug this is here to fix.
  const { txHash, signedTransaction } = await signer.signTransaction(tx);
  const hash = baseEncode(txHash);

  try {
    await acct.provider.sendTransaction(signedTransaction);
    return { hash };
  } catch (e) {
    // Not a verdict. The transaction may well have executed; `confirmTx` is
    // what decides, and it is given the hash either way.
    return { hash, error: (e as Error).message };
  }
}

export const callBuy = (args: {
  token_id: string;
  usdc_in: string;
  min_out: string;
  followed?: string | null;
  referrer?: string | null;
}): Promise<SendResult> =>
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
}): Promise<SendResult> => trade("sell", args);

// -------------------------------------------------------- what the chain says

export type TxVerdict = {
  status: "success" | "failure" | "unknown";
  /** Present on a failure: what the chain said went wrong. */
  detail?: string;
};

/** The transaction is not there - yet, or at all. */
const MISSING = /UNKNOWN_TRANSACTION|does not exist|not found|DB Not Found/i;

/**
 * What the chain made of one transaction.
 *
 * `tx_status` first, `EXPERIMENTAL_tx_status` second: the second is what older
 * nodes serve, and between two providers the agent should not have to care
 * which it drew. A transaction that has not been indexed yet answers the same
 * way as one that never existed, so the caller polls - see `confirmTx`.
 *
 * The verdict is the transaction's own final status, not the receipt's: a
 * contract panic surfaces as `Failure` there, which is exactly the case that
 * must not be recorded as a success.
 */
async function askTxStatus(hash: string, senderId: string): Promise<TxVerdict> {
  const read = (result: unknown): TxVerdict => {
    const r = result as { status?: Record<string, unknown>; final_execution_status?: string } | undefined;
    const status = r?.status;
    if (status && ("SuccessValue" in status || "SuccessReceiptId" in status)) return { status: "success" };
    if (status && "Failure" in status) {
      return { status: "failure", detail: JSON.stringify(status.Failure).slice(0, 300) };
    }
    return { status: "unknown" };
  };

  for (const method of ["tx_status", "EXPERIMENTAL_tx_status"]) {
    try {
      return await rpc.call<TxVerdict>(
        method,
        { tx_hash: hash, sender_account_id: senderId, wait_until: "EXECUTED_OPTIMISTIC" },
        read,
        { label: `${method} ${hash}` },
      );
    } catch (e) {
      const msg = (e as Error).message;
      // A transaction the node has never heard of is an answer, not an outage.
      if (MISSING.test(msg)) return { status: "unknown" };
      // Anything else: try the other method, then give up as unknown.
    }
  }
  return { status: "unknown" };
}

/**
 * The same question, asked until the chain has had time to answer it.
 *
 * A transaction sent a moment ago may genuinely not be queryable yet, and
 * "not indexed" is indistinguishable from "never happened" in the reply. So an
 * unknown is retried a few times before it is believed; a success or a failure
 * is final the first time it is seen.
 */
export async function confirmTx(
  hash: string,
  senderId: string = AGENT_ACCOUNT_ID,
  { attempts = 5, waitMs = 3_000 }: { attempts?: number; waitMs?: number } = {},
): Promise<TxVerdict> {
  for (let i = 0; i < attempts; i++) {
    const verdict = await askTxStatus(hash, senderId);
    if (verdict.status !== "unknown") return verdict;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, waitMs));
  }
  return { status: "unknown" };
}

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
