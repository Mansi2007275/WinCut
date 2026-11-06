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

/// Set by scripts/dev.sh at deploy time. Falls back to a recent window.
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
  args: { address: Address; event: T; latest?: bigint; fallbackSpan?: bigint },
): Promise<Log[]> {
  const latest = args.latest ?? (await client.getBlockNumber());
  const span = args.fallbackSpan ?? 20_000n;

  // Never scan before the hook existed.
  const floor = deployedAtBlock ?? (latest > span ? latest - span : 0n);
  const from = floor > latest ? 0n : floor;

  const out: Log[] = [];
  for (let start = from; start <= latest; start += CHUNK) {
    const end = start + CHUNK - 1n > latest ? latest : start + CHUNK - 1n;
    try {
      const logs = await client.getLogs({
        address: args.address,
        event: args.event,
        fromBlock: start,
        toBlock: end,
      });
      out.push(...logs);
    } catch {
      // A single bad window must not lose the rest of the history.
      continue;
    }
  }
  return out;
}

export { deployedAtBlock };
