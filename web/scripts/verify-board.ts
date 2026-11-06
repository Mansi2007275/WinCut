/**
 * Verifies what the Leaderboard screen will actually render.
 *
 *   npx tsx scripts/verify-board.ts
 *
 * It replays the exact aggregation in src/lib/data.ts (useLeaderboard) against
 * real hook events, so the board can be checked without a browser. Exits
 * non-zero unless there is at least one honest row AND one dumper row, since a
 * board with no red row has nothing to demonstrate.
 */
import { createPublicClient, http, defineChain, formatUnits, parseAbiItem, type Address } from "viem";
import deployed from "../src/config/deployed.json";

const chain = defineChain({
  id: deployed.chainId,
  name: deployed.chainName,
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [deployed.rpcUrl] } },
});

const hook = deployed.contracts.winCutHook as Address;
const pub = createPublicClient({ chain, transport: http(deployed.rpcUrl) });

const boughtEvent = parseAbiItem(
  "event Bought(address indexed trader, bytes32 indexed id, uint128 coins, uint256 cost, address followed, address referrer)",
);
const soldEvent = parseAbiItem(
  "event Sold(address indexed trader, bytes32 indexed id, uint128 coins, uint256 proceeds, int256 pnl, uint256 fee)",
);

const ZERO = "0x0000000000000000000000000000000000000000";
const usd = (v: bigint) => {
  const n = Number(formatUnits(v < 0n ? -v : v, 18));
  return `${v < 0n ? "-" : "+"}$${n.toFixed(2)}`;
};
const handle = (a: string) => {
  const names = ["ace","bolt","cobra","delta","ember","flux","gizmo","halo","iris","jolt","kilo","lumen","mako","nova","onyx","pulse","quartz","rune","sable","tango","umbra","vertex","wisp","xeno"];
  const n = parseInt(a.slice(2, 8), 16);
  return `@${names[n % names.length]}${(n % 900) + 100}`;
};

async function main() {
  const latest = await pub.getBlockNumber();
  const floor = (deployed as { deployedAtBlock?: number }).deployedAtBlock;
  const from = floor !== undefined ? BigInt(floor) : latest > 20_000n ? latest - 20_000n : 0n;

  // Chunked: Arc's RPC rejects wide ranges, and a fork inherits that limit.
  const chunk = 5_000n;
  async function grab<E extends typeof boughtEvent | typeof soldEvent>(event: E) {
    const out: unknown[] = [];
    for (let s = from; s <= latest; s += chunk) {
      const e = s + chunk - 1n > latest ? latest : s + chunk - 1n;
      try {
        const batch = await pub.getLogs({ address: hook, event, fromBlock: s, toBlock: e });
        for (const item of batch) out.push(item);
      } catch {
        continue;
      }
    }
    return out;
  }

  const bought = (await grab(boughtEvent)) as {
    args: { trader: Address; id: `0x${string}`; followed?: Address }; blockNumber: bigint;
  }[];
  const sold = (await grab(soldEvent)) as {
    args: { trader: Address; id: `0x${string}`; pnl: bigint }; blockNumber: bigint;
  }[];

  console.log("=== Leaderboard, as the UI will compute it ===");
  console.log(`events: ${bought.length} Bought, ${sold.length} Sold\n`);

  type T = { kind: "buy" | "sell"; trader: Address; poolId: string; pnl: bigint; followed?: Address; block: bigint };
  const trades: T[] = [
    ...bought.map((l) => ({
      kind: "buy" as const, trader: l.args.trader!, poolId: l.args.id!, pnl: 0n,
      followed: l.args.followed === ZERO ? undefined : l.args.followed, block: l.blockNumber!,
    })),
    ...sold.map((l) => ({
      kind: "sell" as const, trader: l.args.trader!, poolId: l.args.id!, pnl: l.args.pnl!, block: l.blockNumber!,
    })),
  ].sort((a, b) => Number(a.block - b.block));

  const copying = new Map<string, Address>();
  const ownPnl = new Map<Address, bigint>();
  const followersPnl = new Map<Address, bigint>();
  const followerSet = new Map<Address, Set<Address>>();
  const wins = new Map<Address, number>();
  const total = new Map<Address, number>();

  for (const t of trades) {
    const k = `${t.trader}:${t.poolId}`;
    if (t.kind === "buy") {
      if (t.followed) {
        copying.set(k, t.followed);
        if (!followerSet.has(t.followed)) followerSet.set(t.followed, new Set());
        followerSet.get(t.followed)!.add(t.trader);
      }
      continue;
    }
    ownPnl.set(t.trader, (ownPnl.get(t.trader) ?? 0n) + t.pnl);
    total.set(t.trader, (total.get(t.trader) ?? 0) + 1);
    if (t.pnl > 0n) wins.set(t.trader, (wins.get(t.trader) ?? 0) + 1);
    const leader = copying.get(k);
    if (leader && leader !== t.trader) {
      followersPnl.set(leader, (followersPnl.get(leader) ?? 0n) + t.pnl);
    }
  }

  const rows = [...new Set([...ownPnl.keys(), ...followersPnl.keys()])]
    .map((trader) => {
      const own = ownPnl.get(trader) ?? 0n;
      const foll = followersPnl.get(trader) ?? 0n;
      const nf = followerSet.get(trader)?.size ?? 0;
      return {
        trader, own, foll, followers: nf,
        wins: wins.get(trader) ?? 0, trades: total.get(trader) ?? 0,
        honesty: own === 0n ? null : Number(foll) / Number(own),
        isDumper: nf > 0 && foll < 0n && own > 0n,
      };
    })
    .sort((a, b) => Number(b.own - a.own));

  console.log("  trader         own PnL      followers PnL   flwrs  win%   honesty  flag");
  console.log("  " + "─".repeat(76));
  for (const r of rows) {
    const flag = r.isDumper ? "DUMPER" : r.followers > 0 && r.foll > 0n ? "Honest" : "";
    const wr = r.trades ? `${Math.round((r.wins / r.trades) * 100)}%` : "—";
    console.log(
      `  ${handle(r.trader).padEnd(13)} ${usd(r.own).padStart(11)}  ${usd(r.foll).padStart(14)}` +
      `   ${String(r.followers).padStart(4)}  ${wr.padStart(5)}  ${(r.honesty === null ? "—" : r.honesty.toFixed(2)).padStart(7)}  ${flag}`,
    );
  }

  const dumpers = rows.filter((r) => r.isDumper);
  const honest = rows.filter((r) => r.followers > 0 && r.foll > 0n);

  console.log("");
  console.log(`  honest rows (followers in profit) : ${honest.length}`);
  console.log(`  DUMPER rows (followers in loss)   : ${dumpers.length}`);

  if (dumpers.length === 0 || honest.length === 0) {
    console.log("\nFAIL: the board needs at least one honest row AND one dumper row.");
    console.log("Run: npx tsx scripts/activity-bot.ts --minutes 3 --interval 1");
    process.exit(1);
  }
  console.log("\nPASS: the Followers' profit board has a story to tell.");
}

main().catch((e) => {
  console.error("failed:", (e as Error)?.message ?? e);
  process.exit(1);
});
