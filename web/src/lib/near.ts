/**
 * The one place that talks to NEAR.
 *
 * Reads go out as plain JSON-RPC `query` calls rather than through
 * near-api-js, because a view call is one POST and the app makes a lot of them
 * - a trading screen polls price, pool reserves, a position and a fee quote on
 * a few-second loop. Keeping it to fetch means those collapse into the browser
 * and Next.js caches rather than a connection object held open.
 */

export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? "mainnet") as "mainnet" | "testnet";

export const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
export const REF_CONTRACT = process.env.NEXT_PUBLIC_REF_CONTRACT ?? "v2.ref-finance.near";
export const USDC_ID =
  process.env.NEXT_PUBLIC_USDC_ID ??
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDC_DECIMALS = 6;
export const WNEAR_ID = "wrap.near";

/** Token ids the app offers, in display order. */
export const TOKEN_IDS = (process.env.NEXT_PUBLIC_TOKENS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * True once a contract address is configured. Every screen checks it and says
 * plainly that nothing is deployed yet, rather than firing reads at an empty
 * account id and showing a broken error.
 */
export const isDeployed = CONTRACT_ID.length > 0;

/**
 * Read endpoints, tried in order. One refusing - a rate limit, a node behind,
 * a transient 502 - moves to the next rather than surfacing as a dead screen.
 * FastNEAR's free tier throttles a browser doing real polling, which is why
 * there are three.
 */
const RPC_ENDPOINTS: string[] = Array.from(
  new Set(
    [
      process.env.NEXT_PUBLIC_RPC_URL,
      NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com",
      NETWORK === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org",
      NETWORK === "mainnet" ? "https://near.lava.build" : undefined,
    ].filter((u): u is string => Boolean(u)),
  ),
);

export class NearRpcError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NearRpcError";
  }
}

let nextEndpoint = 0;

async function rpc<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
  const errors: string[] = [];
  // Start where the last success left off, so a dead first endpoint is not
  // re-tried on every single call.
  for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
    const idx = (nextEndpoint + i) % RPC_ENDPOINTS.length;
    const url = RPC_ENDPOINTS[idx];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "wincut", method, params }),
        signal,
        cache: "no-store",
      });
      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      if (json.error) {
        const detail =
          json.error.cause?.name ?? json.error.data ?? json.error.message ?? "unknown";
        // A contract-level panic is a real answer, not a bad endpoint: moving
        // on would hide it behind three identical failures.
        if (json.error.cause?.name === "CONTRACT_EXECUTION_ERROR") {
          throw new NearRpcError(
            typeof json.error.cause.info?.vm_error === "string"
              ? json.error.cause.info.vm_error
              : JSON.stringify(json.error.cause.info ?? detail),
          );
        }
        errors.push(`${url}: ${JSON.stringify(detail).slice(0, 180)}`);
        continue;
      }
      nextEndpoint = idx;
      return json.result as T;
    } catch (e) {
      if (e instanceof NearRpcError) throw e;
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  throw new NearRpcError(`every NEAR endpoint refused: ${errors.join(" | ")}`);
}

type CallFunctionResult = { result: number[]; logs: string[]; block_height: number };

/**
 * Calls a view method and parses the JSON it returns.
 *
 * A panic inside the contract arrives as a `CONTRACT_EXECUTION_ERROR` and is
 * rethrown with the contract's own message, so `not enough USDC in your WinCut
 * balance` reaches the UI verbatim instead of becoming "request failed".
 */
export async function view<T>(
  accountId: string,
  method: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const res = await rpc<CallFunctionResult>(
    "query",
    {
      request_type: "call_function",
      finality: "optimistic",
      account_id: accountId,
      method_name: method,
      args_base64: toBase64(JSON.stringify(args)),
    },
    signal,
  );
  const text = new TextDecoder().decode(new Uint8Array(res.result));
  return (text.length ? JSON.parse(text) : null) as T;
}

/** The tip of the chain, for the live block badge. */
export async function blockHeight(signal?: AbortSignal): Promise<number> {
  const res = await rpc<{ sync_info: { latest_block_height: number } }>("status", [], signal);
  return res.sync_info.latest_block_height;
}

/** NEAR balance of an account, in yoctoNEAR, for the gas warning. */
export async function nativeBalance(accountId: string, signal?: AbortSignal): Promise<bigint> {
  try {
    const res = await rpc<{ amount: string }>(
      "query",
      { request_type: "view_account", finality: "optimistic", account_id: accountId },
      signal,
    );
    return BigInt(res.amount);
  } catch {
    return 0n;
  }
}

/**
 * The current gas price in yoctoNEAR per gas unit.
 *
 * Used to turn an attached-gas figure into a real NEAR number for the order
 * panel. Read from the chain rather than hardcoded, because NEAR raises the
 * price under congestion and a stale constant would understate the cost.
 */
export async function gasPrice(signal?: AbortSignal): Promise<bigint> {
  const res = await rpc<{ gas_price: string }>("gas_price", [null], signal);
  return BigInt(res.gas_price);
}

/** A token's decimals, read from its own NEP-148 metadata. */
export async function ftDecimals(tokenId: string, signal?: AbortSignal): Promise<number> {
  const meta = await view<{ decimals: number }>(tokenId, "ft_metadata", {}, signal);
  return meta.decimals;
}

/** NEP-141 wallet balance, as opposed to the internal WinCut balance. */
export async function ftBalanceOf(
  tokenId: string,
  accountId: string,
  signal?: AbortSignal,
): Promise<bigint> {
  const raw = await view<string>(tokenId, "ft_balance_of", { account_id: accountId }, signal);
  return BigInt(raw ?? 0);
}

/**
 * Whether an account has paid NEP-145 storage on a token. Without it a token
 * transfer to that account bounces, so the UI has to be able to say so before
 * the user signs rather than after.
 */
export async function isRegisteredOn(
  tokenId: string,
  accountId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const res = await view<{ total: string; available: string } | null>(
      tokenId,
      "storage_balance_of",
      { account_id: accountId },
      signal,
    );
    return res !== null && BigInt(res.total) > 0n;
  } catch {
    return false;
  }
}

function toBase64(s: string): string {
  if (typeof window === "undefined") return Buffer.from(s, "utf8").toString("base64");
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

export const rpcEndpoints = RPC_ENDPOINTS;
