import { decodeEventLog, toEventSelector, type AbiEvent, type Address, type Log } from "viem";
import deployed from "@/config/deployed.json";

/**
 * Logs from the chain's Blockscout index instead of eth_getLogs.
 *
 * Arc's public RPC refuses the scans this app needs. Measured from the
 * browser: twelve concurrent eth_getLogs returned twelve "rate limit
 * exceeded", and the scan is now fifteen 5,000-block windows per event type
 * because the span from the deploy block grows with every block. dRPC is no
 * help -- its free plan rejects eth_getLogs outright.
 *
 * Blockscout indexes the same chain and answers the whole history in one
 * request: the hook's entire log set is 48 entries with no second page, and
 * it carries block_timestamp, which also removes the per-block getBlock calls
 * the chart needed. Five rapid requests returned five 200s.
 *
 * This is still the chain's own data, read from a public index of it rather
 * than from a node directly. Where the index cannot answer cheaply -- the
 * PoolManager, whose logs cover every pool on Arc and run to many pages --
 * the caller falls back to the RPC path.
 */

const EXPLORER = (deployed as { explorer?: string }).explorer ?? "";

/// Only Blockscout exposes this shape. If the configured explorer is
/// something else, the caller must use the RPC path.
export const explorerLogsAvailable = /explorer\./.test(EXPLORER);

/// Stop paging rather than hammer the index. If a contract needs more than
/// this, it is the wrong source for it and we say so instead of returning a
/// partial history -- a short log list silently produces a smaller fee total,
/// which is the exact failure this codebase keeps designing against.
const MAX_PAGES = 4;

type RawLog = {
  address: { hash: string };
  block_number: number;
  block_timestamp?: string;
  data: `0x${string}`;
  index: number;
  topics: (`0x${string}` | null)[];
  transaction_hash: `0x${string}`;
};

export class ExplorerTooLarge extends Error {
  constructor(address: string) {
    super(`${address} has more log pages than this path will fetch`);
    this.name = "ExplorerTooLarge";
  }
}

/**
 * Every log a contract has emitted, decoded against one event.
 *
 * @throws ExplorerTooLarge when the contract's history exceeds MAX_PAGES, so
 *         the caller can fall back rather than render a truncated history.
 */
export async function fetchExplorerLogs<T extends AbiEvent>(args: {
  address: Address;
  event: T;
  /// Indexed-argument filter, applied to the topics after fetching. Only
  /// equality on an indexed field, which is all the callers use.
  eventArgs?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Log[]> {
  const topic0 = toEventSelector(args.event);
  const collected: RawLog[] = [];

  let next: Record<string, string | number> | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${EXPLORER}/api/v2/addresses/${args.address}/logs`);
    if (next) for (const [k, v] of Object.entries(next)) url.searchParams.set(k, String(v));

    const res = await fetch(url, { signal: args.signal });
    if (!res.ok) throw new Error(`explorer ${res.status}`);
    const body = (await res.json()) as {
      items?: RawLog[];
      next_page_params?: Record<string, string | number> | null;
    };

    collected.push(...(body.items ?? []));
    next = body.next_page_params ?? null;
    if (!next) break;
    if (page === MAX_PAGES - 1) throw new ExplorerTooLarge(args.address);
  }

  const wanted = matcherFor(args.event, args.eventArgs);

  const out: Log[] = [];
  for (const raw of collected) {
    if (raw.topics?.[0] !== topic0) continue;
    const topics = raw.topics.filter((t): t is `0x${string}` => t !== null);
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: [args.event],
        data: raw.data,
        topics: topics as [`0x${string}`, ...`0x${string}`[]],
      });
    } catch {
      // A log that will not decode against this event is not ours.
      continue;
    }
    const argsOut = (decoded.args ?? {}) as Record<string, unknown>;
    if (!wanted(argsOut)) continue;

    out.push({
      address: raw.address.hash.toLowerCase() as Address,
      topics,
      data: raw.data,
      blockNumber: BigInt(raw.block_number),
      transactionHash: raw.transaction_hash,
      logIndex: raw.index,
      blockHash: null,
      transactionIndex: null,
      removed: false,
      // Callers read `.args`; this mirrors what viem's getLogs returns when
      // it is given an `event`.
      args: argsOut,
      eventName: decoded.eventName,
      // Not part of viem's Log, but the chart wants it and the index already
      // knows it, which saves a getBlock per point.
      blockTimestamp: raw.block_timestamp
        ? Math.floor(new Date(raw.block_timestamp).getTime() / 1000)
        : undefined,
    } as unknown as Log);
  }

  // Oldest first, matching the RPC path's ordering.
  out.sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)));
  return out;
}

/// Equality match on indexed args, case-insensitive for addresses and hex.
function matcherFor<T extends AbiEvent>(event: T, eventArgs?: Record<string, unknown>) {
  if (!eventArgs || Object.keys(eventArgs).length === 0) return () => true;
  const pairs = Object.entries(eventArgs);
  return (args: Record<string, unknown>) =>
    pairs.every(([k, v]) => {
      const got = args[k];
      if (typeof got === "string" && typeof v === "string") {
        return got.toLowerCase() === v.toLowerCase();
      }
      return got === v;
    });
}
