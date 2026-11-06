import type { AbiEvent, Address, PublicClient, Log } from "viem";
import deployed from "@/config/deployed.json";

/**
 * Chunked `getLogs`.
 *
 * Arc's RPC rejects wide ranges with "requested range too large", and an Anvil
 * fork forwards historical queries upstream, so it inherits that limit. A naive
 * `fromBlock: latest - 200_000` therefore fails outright — which silently broke
 * the leaderboard and the feed until a script hit it.
 *
 * Two things keep this cheap:
 *   1. we never look further back than the block the hook was deployed at,
 *      since it cannot have emitted anything before that;
 *   2. anything still too wide is split into windows and merged.
 */
const CHUNK = 5_000n;

/// Set by scripts/test-only/dev.sh at deploy time. Falls back to a recent window.
const deployedAtBlock = (() => {
  const v = (deployed as { deployedAtBlock?: number | string }).deployedAtBlock;
  if (v === undefined || v === null || v === "") return undefined;
  try {
    return BigInt(v);
  } catch {
    return undefined;
  }
})();

export async function getLogsChunked<T extends AbiEvent>(
  client: PublicClient,
  args: {
    address: Address;
    event: T;
    latest?: bigint;
    fallbackSpan?: bigint;
    /// Indexed-argument filter, e.g. { id: poolId }. Narrowing server-side is
    /// much cheaper than fetching every pool's swaps and filtering here.
    eventArgs?: Record<string, unknown>;
  },
): Promise<Log[]> {
  const latest = args.latest ?? (await client.getBlockNumber());
  const span = args.fallbackSpan ?? 20_000n;

  // Never scan before the hook existed.
  const floor = deployedAtBlock ?? (latest > span ? latest - span : 0n);
  const from = floor > latest ? 0n : floor;

  const out: Log[] = [];
  for (let start = from; start <= latest; start += CHUNK) {
    const end = start + CHUNK - 1n > latest ? latest : start + CHUNK - 1n;
    out.push(...(await getWindowWithRetry(client, args, start, end)));
  }
  return out;
}

/**
 * One window, retried with backoff.
 *
 * This used to be a bare `catch { continue; }`. That is the wrong trade for
 * money data: Arc's RPC answers -32005 "rate limit exceeded" under load, so a
 * refused window was dropped silently and the screen rendered a SMALLER
 * number -- the fee total flickering to $0.00 while the trade it came from
 * still existed on chain. Showing a wrong figure confidently is worse than
 * showing an error, so a window that still will not load after the retries
 * throws and the screen says it could not reach Arc.
 */
async function getWindowWithRetry<T extends AbiEvent>(
  client: PublicClient,
  args: { address: Address; event: T; eventArgs?: Record<string, unknown> },
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return (await client.getLogs({
        address: args.address,
        event: args.event,
        fromBlock,
        toBlock,
        ...(args.eventArgs ? { args: args.eventArgs as never } : {}),
      })) as Log[];
    } catch (e) {
      lastError = e;
      // 400ms, 800ms, 1.6s, 3.2s -- long enough for a per-second limiter.
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw lastError;
}

export { deployedAtBlock };
