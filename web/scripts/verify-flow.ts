/**
 * Headless end-to-end check of the FRONTEND swap path against the local Arc fork.
 *
 *   npx tsx scripts/verify-flow.ts
 *
 * This exercises the exact TypeScript encoder the UI uses (src/lib/swap.ts), so
 * if the encoding drifts from UniversalRouterLib.sol this fails here rather than
 * in front of judges. It proves, in order:
 *
 *   1. coins are readable from the launcher
 *   2. the quoter returns a gross figure for a buy
 *   3. a BUY built by the TS encoder lands and the hook ATTRIBUTES it
 *   4. quoteSell returns a real fee once there is a profit
 *   5. a SELL with minOut derived from netOut SUCCEEDS
 *   6. minOut derived from the GROSS quote would have been too high (the bug)
 *   7. the fee split lands as claimable balances
 */
import { createWalletClient, createPublicClient, http, defineChain, formatUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, encodePacked } from "viem";
import deployed from "../src/config/deployed.json";
import { winCutHookAbi, winCutLauncherAbi, winCutQuoterAbi, universalRouterAbi, erc20Abi, permit2Abi } from "../src/config/abis";
import { buildSwap, encodeAttribution, deadline, MAX_UINT160 } from "../src/lib/swap";

/**
 * Project-specific keys, deliberately NOT anvil's defaults.
 *
 * Every well-known test address carries an EIP-7702 delegation on Arc mainnet
 * (code 0xef0100... -> 0x8a67b5020ee254ef48e3b6a04927f39baf7e408a), a sweeper
 * that instantly forwards any native USDC it receives. A fork inherits that, so
 * using anvil's accounts makes sell proceeds silently vanish and every balance
 * assertion wrong. We fund fresh undelegated wallets instead.
 */
const SALT = "wincut.verify.v1";
const key = (i: number) => keccak256(encodePacked(["string", "uint256"], [SALT, BigInt(i)]));

const chain = defineChain({
  id: deployed.chainId,
  name: deployed.chainName,
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [deployed.rpcUrl] } },
});

const hook = deployed.contracts.winCutHook as Address;
const launcher = deployed.contracts.winCutLauncher as Address;
const quoter = deployed.contracts.winCutQuoter as Address;
const router = deployed.contracts.universalRouter as Address;
const permit2 = deployed.contracts.permit2 as Address;

const pub = createPublicClient({ chain, transport: http(deployed.rpcUrl) });

// Fresh accounts well past the seeded range, so this run is self-contained.
const trader = privateKeyToAccount(key(0));
const leader = privateKeyToAccount(key(1));
const referrer = privateKeyToAccount(key(2));
const pump = privateKeyToAccount(key(3));

const wTrader = createWalletClient({ account: trader, chain, transport: http(deployed.rpcUrl) });
const wPump = createWalletClient({ account: pump, chain, transport: http(deployed.rpcUrl) });

const usd = (v: bigint) => `$${Number(formatUnits(v, 18)).toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;

let failures = 0;
function check(ok: boolean, label: string, extra = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  console.log("=== WinCut frontend flow verification ===");
  console.log(`rpc ${deployed.rpcUrl}  chain ${await pub.getChainId()}`);
  console.log(`hook ${hook}`);
  console.log("");

  // Fund fresh undelegated wallets, and prove they are undelegated: a 7702
  // delegation would forward their proceeds away and silently falsify every
  // balance check below.
  for (const a of [trader, leader, referrer, pump]) {
    const code = await pub.getCode({ address: a.address });
    if (code && code !== "0x") {
      console.log(`  FAIL  ${a.address} carries code ${code.slice(0, 12)}… (EIP-7702 sweeper). Change SALT.`);
      process.exit(1);
    }
    await fetch(deployed.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "anvil_setBalance",
        params: [a.address, "0x" + (2_000_000n * 10n ** 18n).toString(16)],
      }),
    });
  }
  console.log("funded 4 clean, undelegated wallets");
  console.log("");

  // 1 ---------------------------------------------------------------
  console.log("[1] read coins from the launcher");
  const count = await pub.readContract({ address: launcher, abi: winCutLauncherAbi, functionName: "coinCount" });
  check(count > 0n, "coinCount > 0", `count=${count}`);
  if (count === 0n) throw new Error("no coins; run ./scripts/test-only/dev.sh");

  const coin = await pub.readContract({ address: launcher, abi: winCutLauncherAbi, functionName: "allCoins", args: [0n] });
  const poolKey = await pub.readContract({ address: launcher, abi: winCutLauncherAbi, functionName: "poolKeyFor", args: [coin] });
  const poolId = await pub.readContract({ address: launcher, abi: winCutLauncherAbi, functionName: "poolIdFor", args: [coin] });
  const symbol = await pub.readContract({ address: coin, abi: erc20Abi, functionName: "symbol" });
  console.log(`      coin ${symbol} ${coin}`);

  const quoteIs0 = poolKey.currency0.toLowerCase() === "0x0000000000000000000000000000000000000000";
  check(quoteIs0, "native USDC sorts to currency0");

  // 2 ---------------------------------------------------------------
  console.log("");
  console.log("[2] quoteBuy through WinCutQuoter");
  const buyIn = 2_000n * 10n ** 18n;
  const coinsOut = (await pub.readContract({
    address: quoter, abi: winCutQuoterAbi, functionName: "quoteBuy",
    args: [poolKey, quoteIs0, buyIn],
  })) as unknown as bigint;
  check(coinsOut > 0n, "quoteBuy returns coins", `${formatUnits(coinsOut, 18)} ${symbol}`);

  // 3 ---------------------------------------------------------------
  console.log("");
  console.log("[3] BUY via the TypeScript encoder, with attribution");
  const plan = buildSwap({
    key: poolKey,
    zeroForOne: quoteIs0,
    amountIn: buyIn,
    amountOutMinimum: 0n,
    hookData: encodeAttribution(leader.address, referrer.address),
    quoteIsNative: true,
  });
  const buyHash = await wTrader.writeContract({
    address: router, abi: universalRouterAbi, functionName: "execute",
    args: [plan.commands, plan.inputs, deadline()], value: plan.value,
  });
  const buyRc = await pub.waitForTransactionReceipt({ hash: buyHash });
  check(buyRc.status === "success", "buy transaction succeeded", buyHash);

  const [amount, cost] = await pub.readContract({
    address: hook, abi: winCutHookAbi, functionName: "positionOf", args: [trader.address, poolId],
  });
  check(amount > 0n, "hook recorded a position for the TRADER", `${formatUnits(amount, 18)} ${symbol}`);
  check(cost === buyIn, "cost basis equals what was paid", usd(cost));

  const followed = await pub.readContract({
    address: hook, abi: winCutHookAbi, functionName: "followedOf", args: [trader.address, poolId],
  });
  const ref = await pub.readContract({
    address: hook, abi: winCutHookAbi, functionName: "referrerOf", args: [trader.address],
  });
  check(followed.toLowerCase() === leader.address.toLowerCase(), "copied trader recorded from hookData");
  check(ref.toLowerCase() === referrer.address.toLowerCase(), "referrer recorded from hookData");

  // 4 ---------------------------------------------------------------
  console.log("");
  console.log("[4] move the price up, then quoteSell");
  const pumpPlan = buildSwap({
    key: poolKey, zeroForOne: quoteIs0, amountIn: 500_000n * 10n ** 18n,
    amountOutMinimum: 0n, hookData: "0x", quoteIsNative: true,
  });
  const ph = await wPump.writeContract({
    address: router, abi: universalRouterAbi, functionName: "execute",
    args: [pumpPlan.commands, pumpPlan.inputs, deadline()], value: pumpPlan.value,
  });
  await pub.waitForTransactionReceipt({ hash: ph });

  const [grossOut, fee, netOut, lossCredit, volumeFee] = (await pub.readContract({
    address: quoter, abi: winCutQuoterAbi, functionName: "quoteSell",
    args: [trader.address, poolKey, !quoteIs0, amount],
  })) as unknown as readonly [bigint, bigint, bigint, bigint, bigint];
  console.log(`      gross ${usd(grossOut)}  fee ${usd(fee)}  net ${usd(netOut)}`);
  console.log(`      a 0.5%-of-volume app would charge ${usd(volumeFee)}`);
  check(fee > 0n, "a real fee is quoted on a profitable sell");
  check(netOut === grossOut - fee, "netOut == gross - fee");
  check(lossCredit === 0n, "no stale loss credit for a fresh trader");

  // 6 (asserted before we spend the position) ------------------------
  const naiveMinOut = (grossOut * 9_950n) / 10_000n;
  const correctMinOut = (netOut * 9_950n) / 10_000n;
  console.log("");
  console.log("[5] the slippage trap, in numbers");
  console.log(`      minOut from NET   ${usd(correctMinOut)}  <- what the UI uses`);
  console.log(`      minOut from GROSS ${usd(naiveMinOut)}  <- the naive bug`);
  check(naiveMinOut > netOut, "a gross-derived minOut EXCEEDS the achievable net, so it would revert");

  // 5 ---------------------------------------------------------------
  console.log("");
  console.log("[6] SELL with minOut derived from netOut");
  await (async () => {
    const h1 = await wTrader.writeContract({
      address: coin, abi: erc20Abi, functionName: "approve", args: [permit2, 2n ** 256n - 1n],
    });
    await pub.waitForTransactionReceipt({ hash: h1 });
    const h2 = await wTrader.writeContract({
      address: permit2, abi: permit2Abi, functionName: "approve",
      args: [coin, router, MAX_UINT160, Math.floor(Date.now() / 1000) + 86_400],
    });
    await pub.waitForTransactionReceipt({ hash: h2 });
  })();

  const before = await pub.getBalance({ address: trader.address });
  const sellPlan = buildSwap({
    key: poolKey, zeroForOne: !quoteIs0, amountIn: amount,
    amountOutMinimum: correctMinOut, hookData: "0x", quoteIsNative: true,
  });
  const sellHash = await wTrader.writeContract({
    address: router, abi: universalRouterAbi, functionName: "execute",
    args: [sellPlan.commands, sellPlan.inputs, deadline()], value: 0n,
  });
  const sellRc = await pub.waitForTransactionReceipt({ hash: sellHash });
  check(sellRc.status === "success", "sell succeeded with a netOut-derived minOut", sellHash);

  const after = await pub.getBalance({ address: trader.address });
  check(after > before, "the trader received proceeds", usd(after - before));

  // 7 ---------------------------------------------------------------
  console.log("");
  console.log("[7] the fee split landed as claimable balances");
  const treasury = await pub.readContract({ address: hook, abi: winCutHookAbi, functionName: "treasury" });
  const [cLeader, cRef, cTreas] = await Promise.all([
    pub.readContract({ address: hook, abi: winCutHookAbi, functionName: "claimable", args: [leader.address] }),
    pub.readContract({ address: hook, abi: winCutHookAbi, functionName: "claimable", args: [referrer.address] }),
    pub.readContract({ address: hook, abi: winCutHookAbi, functionName: "claimable", args: [treasury] }),
  ]);
  console.log(`      copied trader ${usd(cLeader)}`);
  console.log(`      referrer      ${usd(cRef)}`);
  check(cLeader > 0n, "copied trader earned from the profitable exit");
  check(cRef > 0n, "referrer earned from the profitable exit");
  check(cTreas > 0n, "treasury earned");
  // 50 / 20 within rounding
  const total = cLeader + cRef;
  check(cLeader * 10n / total >= 7n, "copied trader's share is ~2.5x the referrer's (50 vs 20)");

  console.log("");
  console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verification threw:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
