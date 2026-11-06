/**
 * WinCut live activity bot.
 *
 *   npx tsx scripts/test-only/activity-bot.ts                 # run until Ctrl-C
 *   npx tsx scripts/test-only/activity-bot.ts --minutes 10    # run for 10 minutes
 *   npx tsx scripts/test-only/activity-bot.ts --interval 4    # ~4s between actions
 *   npx tsx scripts/test-only/activity-bot.ts --warmup        # one fast pass, then stop
 *
 * Purpose: make the demo LIVE. Every trade is a real swap through Arc's real
 * Universal Router, so the leaderboard moves, the feed fills and honesty scores
 * shift while judges are watching. Nothing is faked or seeded.
 *
 * The personas are chosen so the data tells the product's story on its own:
 *
 *   LEADER     buys early, exits green. Followers who copied him also exit
 *              green, so his followers-PnL is positive and he earns.
 *   DUMPER     buys early, lets followers pile in, then exits INTO their buys.
 *              His own PnL is positive, his followers' is negative, and under
 *              WinCut he earns nothing from them. This is the red row.
 *   FOLLOWER   copies a leader or dumper, with hookData attributing both the
 *              copied trader and the referrer.
 *   NOISE      trades unattributed, moving the price so wins and losses are
 *              real rather than arranged.
 *
 * Safety: derives its own undelegated keys. Arc mainnet carries EIP-7702
 * sweepers on every well-known test address, and a fork inherits them, so
 * anvil's default accounts would silently lose their proceeds.
 */
import {
  createPublicClient, createWalletClient, http, defineChain, formatUnits,
  keccak256, encodePacked, type Address, type PublicClient, type WalletClient, type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import deployed from "../../src/config/deployed.json";
import { winCutHookAbi, winCutLauncherAbi, winCutQuoterAbi, universalRouterAbi, erc20Abi, permit2Abi } from "../../src/config/abis";
import { buildSwap, encodeAttribution, deadline, MAX_UINT160 } from "../../src/lib/swap";

// ----------------------------------------------------------------- config

const args = process.argv.slice(2);
const flag = (name: string, def?: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};
const MINUTES = flag("minutes");
const INTERVAL = (flag("interval", 5) ?? 5) * 1000;
const WARMUP_ONLY = args.includes("--warmup");

const SALT = "wincut.bot.v1";
const key = (i: number) => keccak256(encodePacked(["string", "uint256"], [SALT, BigInt(i)]));

const chain = defineChain({
  id: deployed.chainId,
  name: deployed.chainName,
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [deployed.rpcUrl] } },
});

const A = {
  hook: deployed.contracts.winCutHook as Address,
  launcher: deployed.contracts.winCutLauncher as Address,
  quoter: deployed.contracts.winCutQuoter as Address,
  router: deployed.contracts.universalRouter as Address,
  permit2: deployed.contracts.permit2 as Address,
};

const pub = createPublicClient({ chain, transport: http(deployed.rpcUrl) }) as PublicClient;

const USD = 10n ** 18n;
const usd = (v: bigint) => `$${Number(formatUnits(v, 18)).toFixed(2)}`;

// ------------------------------------------------------------------ actors

type Role = "leader" | "dumper" | "follower" | "noise";

type Actor = {
  i: number;
  role: Role;
  account: Account;
  wallet: WalletClient;
  /// who this actor copies, for followers
  copies?: Address;
  label: string;
};

const ROLES: Role[] = [
  "leader", "leader", "dumper", "dumper",
  "follower", "follower", "follower", "follower", "follower", "follower",
  "noise", "noise", "noise",
];

type Coin = {
  address: Address;
  symbol: string;
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  poolId: `0x${string}`;
  quoteIs0: boolean;
};

let actors: Actor[] = [];
let coins: Coin[] = [];
let stopping = false;
let actions = 0;
let errors = 0;

// --------------------------------------------------------------- utilities

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

async function rpc(method: string, params: unknown[]) {
  await fetch(deployed.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

function reason(e: unknown): string {
  const m = e as { shortMessage?: string; message?: string };
  const s = m?.shortMessage ?? m?.message ?? String(e);
  return s.split("\n")[0].slice(0, 110);
}

// ------------------------------------------------------------------- setup

async function setup() {
  console.log("=== WinCut activity bot ===");
  console.log(`rpc    ${deployed.rpcUrl}  chain ${await pub.getChainId()}`);
  console.log(`hook   ${A.hook}`);

  const count = await pub.readContract({ address: A.launcher, abi: winCutLauncherAbi, functionName: "coinCount" });
  if (count === 0n) {
    console.error("no coins launched. Run ./scripts/test-only/dev.sh first.");
    process.exit(1);
  }

  for (let i = 0; i < Number(count); i++) {
    const address = await pub.readContract({
      address: A.launcher, abi: winCutLauncherAbi, functionName: "allCoins", args: [BigInt(i)],
    });
    const [symbol, poolKey, poolId] = await Promise.all([
      pub.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      pub.readContract({ address: A.launcher, abi: winCutLauncherAbi, functionName: "poolKeyFor", args: [address] }),
      pub.readContract({ address: A.launcher, abi: winCutLauncherAbi, functionName: "poolIdFor", args: [address] }),
    ]);
    coins.push({
      address, symbol,
      poolKey: poolKey as Coin["poolKey"],
      poolId,
      quoteIs0: (poolKey as Coin["poolKey"]).currency0 === "0x0000000000000000000000000000000000000000",
    });
  }
  console.log(`coins  ${coins.map((c) => c.symbol).join(", ")}`);

  // Build and fund the actors.
  const isLocal = deployed.rpcUrl.includes("127.0.0.1") || deployed.rpcUrl.includes("localhost");
  for (let i = 0; i < ROLES.length; i++) {
    const account = privateKeyToAccount(key(i));
    const code = await pub.getCode({ address: account.address });
    if (code && code !== "0x") {
      console.error(`actor ${i} ${account.address} carries code (EIP-7702 sweeper). Change SALT.`);
      process.exit(1);
    }
    if (isLocal) {
      await rpc("anvil_setBalance", [account.address, "0x" + (500_000n * USD).toString(16)]);
    } else {
      const bal = await pub.getBalance({ address: account.address });
      if (bal < 5n * USD) {
        console.error(`actor ${i} ${account.address} needs funding on a non-local chain (has ${usd(bal)})`);
        process.exit(1);
      }
    }
    actors.push({
      i, role: ROLES[i], account,
      wallet: createWalletClient({ account, chain, transport: http(deployed.rpcUrl) }),
      label: `${ROLES[i]}#${i}`,
    });
  }

  // Followers copy a leader or a dumper, deterministically split so both
  // an honest row and a red row exist.
  const leaders = actors.filter((a) => a.role === "leader");
  const dumpers = actors.filter((a) => a.role === "dumper");
  actors.filter((a) => a.role === "follower").forEach((f, n) => {
    f.copies = (n % 2 === 0 ? leaders[n % leaders.length] : dumpers[n % dumpers.length]).account.address;
  });

  console.log(`actors ${actors.length} funded and undelegated`);
  console.log("");
}

// ------------------------------------------------------------------ trading

const referrerOf = (a: Actor) => actors[(a.i + 1) % actors.length].account.address;

async function buy(actor: Actor, coin: Coin, amountUsd: number) {
  const amountIn = BigInt(Math.floor(amountUsd * 1e6)) * 10n ** 12n;
  const hookData =
    actor.role === "follower" && actor.copies
      ? encodeAttribution(actor.copies, referrerOf(actor))
      : actor.role === "noise"
        ? "0x"
        : encodeAttribution(undefined, referrerOf(actor));

  const plan = buildSwap({
    key: coin.poolKey, zeroForOne: coin.quoteIs0,
    amountIn, amountOutMinimum: 0n, hookData, quoteIsNative: true,
  });

  const hash = await actor.wallet.writeContract({
    address: A.router, abi: universalRouterAbi, functionName: "execute",
    args: [plan.commands, plan.inputs, deadline()], value: plan.value,
    account: actor.account, chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return amountIn;
}

const approved = new Set<string>();

async function sell(actor: Actor, coin: Coin, fraction: number) {
  const bal = await pub.readContract({
    address: coin.address, abi: erc20Abi, functionName: "balanceOf", args: [actor.account.address],
  });
  if (bal === 0n) return null;

  const amountIn = (bal * BigInt(Math.max(1, Math.floor(fraction * 100)))) / 100n;
  if (amountIn === 0n) return null;

  const ak = `${actor.i}:${coin.address}`;
  if (!approved.has(ak)) {
    const h1 = await actor.wallet.writeContract({
      address: coin.address, abi: erc20Abi, functionName: "approve",
      args: [A.permit2, 2n ** 256n - 1n], account: actor.account, chain,
    });
    await pub.waitForTransactionReceipt({ hash: h1 });
    const h2 = await actor.wallet.writeContract({
      address: A.permit2, abi: permit2Abi, functionName: "approve",
      args: [coin.address, A.router, MAX_UINT160, Math.floor(Date.now() / 1000) + 86_400],
      account: actor.account, chain,
    });
    await pub.waitForTransactionReceipt({ hash: h2 });
    approved.add(ak);
  }

  // minOut from the quoter's NET figure, exactly as the UI does. Deriving it
  // from the gross quote would revert on every profitable sell.
  let minOut = 0n;
  let quotedFee = 0n;
  try {
    const q = (await pub.readContract({
      address: A.quoter, abi: winCutQuoterAbi, functionName: "quoteSell",
      args: [actor.account.address, coin.poolKey, !coin.quoteIs0, amountIn],
    })) as unknown as readonly [bigint, bigint, bigint, bigint, bigint];
    quotedFee = q[1];
    minOut = (q[2] * 9_700n) / 10_000n; // 3% tolerance, the bot moves price itself
  } catch { /* fall back to 0, the pool may be mid-move */ }

  const plan = buildSwap({
    key: coin.poolKey, zeroForOne: !coin.quoteIs0,
    amountIn, amountOutMinimum: minOut, hookData: "0x", quoteIsNative: true,
  });

  const hash = await actor.wallet.writeContract({
    address: A.router, abi: universalRouterAbi, functionName: "execute",
    args: [plan.commands, plan.inputs, deadline()], value: 0n,
    account: actor.account, chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return { fee: quotedFee };
}

// ----------------------------------------------------------------- scenario

/**
 * One full story on one coin: leader or dumper enters, followers copy, price
 * moves, everyone exits. Run repeatedly on random coins, it produces a
 * continuously evolving leaderboard.
 */
async function runStory() {
  const coin = pick(coins);
  const useDumper = Math.random() < 0.45;
  const protagonist = pick(actors.filter((a) => a.role === (useDumper ? "dumper" : "leader")));
  const followers = actors.filter((a) => a.role === "follower" && a.copies === protagonist.account.address);
  const noise = actors.filter((a) => a.role === "noise");

  console.log(`\n── ${coin.symbol}: ${useDumper ? "DUMP" : "HONEST"} story, ${protagonist.label}, ${followers.length} follower(s)`);

  // 1. protagonist enters
  await act(`${protagonist.label} buys`, async () => {
    const a = await buy(protagonist, coin, between(600, 1600));
    return usd(a);
  });

  // 2. followers pile in
  for (const f of followers) {
    await act(`  ${f.label} copies ${useDumper ? "dumper" : "leader"}`, async () => {
      const a = await buy(f, coin, between(150, 500));
      return usd(a);
    });
  }

  if (useDumper) {
    // 3a. a modest lift so the dumper is genuinely in profit when he exits.
    //     Without this he exits flat, his own PnL is ~0, and the honesty score
    //     has no story to tell. The whole point of the red row is that he made
    //     money WHILE his followers lost it.
    await act(`  price ticks up (dumper now in profit)`, async () => {
      const a = await buy(pick(noise), coin, between(6_000, 12_000));
      return usd(a);
    });

    // the dumper exits into that lift, leaving followers holding the bag
    await act(`  ${protagonist.label} DUMPS on followers`, async () => {
      const r = await sell(protagonist, coin, 1);
      return r ? `fee ${usd(r.fee)}` : "nothing to sell";
    });
    // and the noise exits too, so price falls below the followers' entries
    await act(`  noise exits, price collapses`, async () => {
      const r = await sell(pick(noise), coin, 1);
      return r ? "ok" : "flat";
    });

    // followers exit into the hole, at a real loss
    for (const f of followers) {
      await act(`  ${f.label} exits after the dump`, async () => {
        const r = await sell(f, coin, 1);
        return r ? `fee ${usd(r.fee)}` : "nothing to sell";
      });
    }
  } else {
    // 3b. honest story: price lifts, everyone exits green
    await act(`  noise lifts the price`, async () => {
      const a = await buy(pick(noise), coin, between(20_000, 45_000));
      return usd(a);
    });
    for (const f of followers) {
      await act(`  ${f.label} exits green`, async () => {
        const r = await sell(f, coin, 1);
        return r ? `fee ${usd(r.fee)}` : "nothing to sell";
      });
    }
    await act(`  ${protagonist.label} exits`, async () => {
      const r = await sell(protagonist, coin, 1);
      return r ? `fee ${usd(r.fee)}` : "nothing to sell";
    });
  }

  // 4. clear the noise trader's bag so the price can fall again, which is what
  //    banks loss credits on the next story
  for (const n of noise) {
    await act(`  ${n.label} unwinds`, async () => {
      const r = await sell(n, coin, between(0.5, 1));
      return r ? "ok" : "flat";
    });
  }
}

async function act(label: string, fn: () => Promise<string | null>) {
  if (stopping) return;
  const t = new Date().toISOString().slice(11, 19);
  try {
    const out = await fn();
    actions += 1;
    console.log(`  ${t}  ${label.padEnd(42)} ${out ?? ""}`);
  } catch (e) {
    errors += 1;
    console.log(`  ${t}  ${label.padEnd(42)} skipped: ${reason(e)}`);
  }
  await sleep(INTERVAL);
}

// -------------------------------------------------------------------- stats

async function printBoard() {
  const treasury = await pub.readContract({ address: A.hook, abi: winCutHookAbi, functionName: "treasury" });
  console.log("\n── state " + "─".repeat(50));
  for (const a of actors.filter((x) => x.role !== "noise" && x.role !== "follower")) {
    const [c, l] = await Promise.all([
      pub.readContract({ address: A.hook, abi: winCutHookAbi, functionName: "claimable", args: [a.account.address] }),
      pub.readContract({ address: A.hook, abi: winCutHookAbi, functionName: "lossCredit", args: [a.account.address] }),
    ]);
    console.log(`  ${a.label.padEnd(12)} claimable ${usd(c).padStart(12)}   loss credit ${usd(l).padStart(12)}`);
  }
  const t = await pub.readContract({ address: A.hook, abi: winCutHookAbi, functionName: "claimable", args: [treasury] });
  console.log(`  ${"treasury".padEnd(12)} claimable ${usd(t).padStart(12)}`);
  console.log(`  actions ${actions}, skipped ${errors}`);
  console.log("─".repeat(59));
}

// --------------------------------------------------------------------- main

async function main() {
  await setup();

  const deadlineAt = MINUTES ? Date.now() + MINUTES * 60_000 : undefined;
  process.on("SIGINT", () => {
    console.log("\nstopping after the current action…");
    stopping = true;
  });

  if (WARMUP_ONLY) {
    console.log("warmup: two stories, then exit\n");
    await runStory();
    await runStory();
    await printBoard();
    return;
  }

  console.log(`running${MINUTES ? ` for ${MINUTES} min` : " until Ctrl-C"}, ~${INTERVAL / 1000}s between actions\n`);
  let n = 0;
  while (!stopping && (!deadlineAt || Date.now() < deadlineAt)) {
    await runStory();
    if (++n % 2 === 0) await printBoard();
  }
  await printBoard();
  console.log("bot stopped.");
}

main().catch((e) => {
  console.error("bot crashed:", reason(e));
  process.exit(1);
});
