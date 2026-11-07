import type { AbiEvent, Address, PublicClient, Log } from "viem";
import deployed from "@/config/deployed.json";
import { explorerLogsAvailable, fetchExplorerLogs } from "./explorerLogs";

/**
 * Chunked `getLogs`, with finished windows cached for the life of the page.
 *
 * Arc's RPC rejects wide ranges with "requested range too large", and an Anvil
 * fork forwards historical queries upstream, so it inherits that limit. A naive
 * `fromBlock: latest - 200_000` therefore fails outright — which silently broke
 * the leaderboard and the feed until a script hit it.
 *
 * Three things keep this cheap:
 *   1. we never look further back than the block the hook was deployed at,
 *      since it cannot have emitted anything before that;
 *   2. anything still too wide is split into windows and merged;
 *   3. a window that is entirely in the settled past is cached, because its
 *      logs can never change again.
 *
 * Point 3 is what makes the app survive. The span from the deploy block grows
 * by one block per block, forever: it was 2 windows at deploy and 10 a day
 * later, and four event types at ten windows each is forty `eth_getLogs` on
 * every single load. Arc's public RPC answers -32005 long before that
 * finishes, which showed up as the over-limit warning silently disappearing
 * and market cap stuck on a dash. With the cache, a refetch asks only about
 * the window the chain is currently in.
 */
const CHUNK = 5_000n;

/// Blocks near the head are left uncached: a reorg can still rewrite them, and
/// a cached-but-wrong window would be exactly the silent data loss this file
/// exists to prevent.
const REORG_SAFETY = 64n;

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

/// Keyed by contract, event, window and indexed-argument filter. Module-level
/// so it is shared by every query and every component on the page.
const settledWindows = new Map<string, Log[]>();

function windowKey<T extends AbiEvent>(
  args: { address: Address; event: T; eventArgs?: Record<string, unknown> },
  from: bigint,
  to: bigint,
): string {
  const name = (args.event as { name?: string }).name ?? "event";
  const filter = args.eventArgs ? JSON.stringify(args.eventArgs) : "";
  return `${args.address}|${name}|${filter}|${from}-${to}`;
}

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
  // The explorer's index answers a contract's whole history in one request,
  // where the RPC needs fifteen windows and refuses most of them. Try it
  // first and keep the window scan as the fallback: contracts whose logs run
  // to many pages (the PoolManager covers every pool on Arc) throw
  // ExplorerTooLarge rather than return a truncated history.
  if (explorerLogsAvailable) {
    try {
      return await fetchExplorerLogs({
        address: args.address,
        event: args.event,
        eventArgs: args.eventArgs,
      });
    } catch {
      // Fall through to the RPC path.
    }
  }

  const latest = args.latest ?? (await client.getBlockNumber());
  const span = args.fallbackSpan ?? 20_000n;

  // Never scan before the hook existed.
  const floor = deployedAtBlock ?? (latest > span ? latest - span : 0n);
  const from = floor > latest ? 0n : floor;
  const settledBelow = latest > REORG_SAFETY ? latest - REORG_SAFETY : 0n;

  const out: Log[] = [];
  for (let start = from; start <= latest; start += CHUNK) {
    const end = start + CHUNK - 1n > latest ? latest : start + CHUNK - 1n;
    const settled = end < settledBelow;
    const key = windowKey(args, start, end);

    if (settled) {
      const hit = settledWindows.get(key);
      if (hit) {
        out.push(...hit);
        continue;
      }
    }

    const logs = await getWindowWithRetry(client, args, start, end);
    if (settled) settledWindows.set(key, logs);
    out.push(...logs);
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
