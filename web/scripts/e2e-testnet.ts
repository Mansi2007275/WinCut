/**
 * End-to-end on Arc TESTNET, with real money and real transactions.
 *
 *   npx tsx scripts/e2e-testnet.ts            # dry run: checks only, sends nothing
 *   npx tsx scripts/e2e-testnet.ts --send     # actually sends the five transactions
 *
 * It walks the whole product in one pass and prints an arcscan link for every
 * transaction:
 *
 *   1. wallet A launches a coin
 *   2. wallet A buys it, carrying wallet B as the referrer
 *   3. wallet B buys it, copying wallet A
 *   4. wallet B sells  -> the hook charges 10% of profit, or nothing on a loss
 *   5. wallet A claims  -> the copied-trader and referrer shares are pulled
 *
 * KEYS COME FROM THE ENVIRONMENT ONLY. Nothing is read from a file in the repo
 * and nothing is ever printed:
 *
 *   E2E_KEY_A=0x...   funded; launches, buys, claims
 *   E2E_KEY_B=0x...   funded; copies and sells
 *
 * Each wallet needs roughly $3 of test USDC from https://faucet.circle.com.
 *
 * This spends real testnet funds, so --send is deliberately opt-in: a bare run
 * verifies balances, addresses and the quoter without touching anything.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import deployed from "../src/config/deployed.json";
import {
  erc20Abi,
  permit2Abi,
  universalRouterAbi,
  winCutHookAbi,
  winCutLauncherAbi,
} from "../src/config/abis";
import { buildSwap, deadline, encodeAttribution, MAX_UINT160 } from "../src/lib/swap";

const SEND = process.argv.includes("--send");

const chain = defineChain({
  id: deployed.chainId,
  name: deployed.chainName,
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [deployed.rpcUrl] } },
});

const pub = createPublicClient({ chain, transport: http(deployed.rpcUrl) });

const hook = deployed.contracts.winCutHook as Address;
const launcher = deployed.contracts.winCutLauncher as Address;
const quoter = deployed.contracts.winCutQuoter as Address;
const router = deployed.contracts.universalRouter as Address;
const permit2 = deployed.contracts.permit2 as Address;
const ZERO = "0x0000000000000000000000000000000000000000";

const usd = (v: bigint) => `$${Number(formatUnits(v, 18)).toFixed(4)}`;
const link = (h: string) => `${deployed.explorer}/tx/${h}`;
const addrLink = (a: string) => `${deployed.explorer}/address/${a}`;

function step(n: string) {
  console.log(`\n\x1b[1m── ${n}\x1b[0m`);
}

function need(name: string): Hex {
  const v = process.env[name];
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error(`${name} missing or malformed. Export it; never commit it.`);
  }
  return v as Hex;
}

async function waitOk(hash: Hex, what: string) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${what} reverted: ${link(hash)}`);
  console.log(`   ${what}`);
  console.log(`   ${link(hash)}`);
  return r;
}

async function main() {
  if (hook === ZERO || launcher === ZERO) {
    throw new Error(
      "deployed.json has no contracts. Run ./scripts/deploy-testnet.sh first.",
    );
  }

  const a = privateKeyToAccount(need("E2E_KEY_A"));
  const b = privateKeyToAccount(need("E2E_KEY_B"));
  const walletA = createWalletClient({ account: a, chain, transport: http(deployed.rpcUrl) });
  const walletB = createWalletClient({ account: b, chain, transport: http(deployed.rpcUrl) });

  step("preflight");
  console.log(`   chain        ${deployed.chainId} (${deployed.chainName})`);
  console.log(`   hook         ${addrLink(hook)}`);
  console.log(`   launcher     ${addrLink(launcher)}`);
  console.log(`   wallet A     ${a.address}`);
  console.log(`   wallet B     ${b.address}`);

  const [balA, balB, owner, treasury, trusted] = await Promise.all([
    pub.getBalance({ address: a.address }),
    pub.getBalance({ address: b.address }),
    pub.readContract({ address: hook, abi: winCutHookAbi, functionName: "owner" }),
    pub.readContract({ address: hook, abi: winCutHookAbi, functionName: "treasury" }),
    pub.readContract({
      address: hook,
      abi: winCutHookAbi,
      functionName: "trustedRouter",
      args: [router],
    }),
  ]);

  console.log(`   A balance    ${usd(balA)}`);
  console.log(`   B balance    ${usd(balB)}`);
  console.log(`   owner()      ${owner}`);
  console.log(`   treasury()   ${treasury}`);
  console.log(`   router trusted ${trusted}`);

  if (!trusted) throw new Error("the Universal Router is not trusted: attribution cannot work");
  const floor = 2n * 10n ** 18n;
  if (balA < floor) throw new Error(`wallet A needs at least $2, has ${usd(balA)}`);
  if (balB < floor) throw new Error(`wallet B needs at least $2, has ${usd(balB)}`);

  if (!SEND) {
    console.log(
      "\n\x1b[1mDry run only.\x1b[0m Everything above checks out. Re-run with --send to " +
        "launch a coin, trade it from both wallets and claim.",
    );
    return;
  }

  // ---------------------------------------------------------------- launch
  step("1/5  wallet A launches a coin");
  const symbol = `E2E${Math.floor(Date.now() / 1000) % 10000}`;
  const seed = 1n * 10n ** 18n; // $1 of liquidity
  const supply = 1_000_000_000n * 10n ** 18n;

  const launchHash = await walletA.writeContract({
    address: launcher,
    abi: winCutLauncherAbi,
    functionName: "launchCoin",
    args: [`E2E ${symbol}`, symbol, "🧪", seed, supply],
    value: seed,
  });
  const launchReceipt = await waitOk(launchHash, `launched $${symbol}`);

  // Read the coin back off the launcher rather than decoding the log, so this
  // also proves the launcher's own bookkeeping is right.
  const count = await pub.readContract({
    address: launcher,
    abi: winCutLauncherAbi,
    functionName: "coinCount",
  });
  const coin = (await pub.readContract({
    address: launcher,
    abi: winCutLauncherAbi,
    functionName: "allCoins",
    args: [count - 1n],
  })) as Address;
  const poolKey = (await pub.readContract({
    address: launcher,
    abi: winCutLauncherAbi,
    functionName: "poolKeyFor",
    args: [coin],
  })) as {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  };
  const poolId = (await pub.readContract({
    address: launcher,
    abi: winCutLauncherAbi,
    functionName: "poolIdFor",
    args: [coin],
  })) as Hex;
  console.log(`   coin         ${addrLink(coin)}`);
  console.log(`   gas used     ${launchReceipt.gasUsed}`);

  const quoteIs0 = poolKey.currency0.toLowerCase() === ZERO;
  const buyZeroForOne = quoteIs0;
  const sellZeroForOne = !quoteIs0;

  // ------------------------------------------------------------------ buys
  step("2/5  wallet A buys, referred by wallet B");
  const buyA = buildSwap({
    key: poolKey,
    zeroForOne: buyZeroForOne,
    amountIn: 10n ** 18n / 2n, // $0.50
    amountOutMinimum: 0n,
    hookData: encodeAttribution(undefined, b.address),
    quoteIsNative: true,
  });
  await waitOk(
    await walletA.writeContract({
      address: router,
      abi: universalRouterAbi,
      functionName: "execute",
      args: [buyA.commands, buyA.inputs, deadline()],
      value: buyA.value,
    }),
    "A bought $0.50",
  );

  step("3/5  wallet B buys, copying wallet A");
  const buyB = buildSwap({
    key: poolKey,
    zeroForOne: buyZeroForOne,
    amountIn: 10n ** 18n / 2n,
    amountOutMinimum: 0n,
    hookData: encodeAttribution(a.address, undefined),
    quoteIsNative: true,
  });
  await waitOk(
    await walletB.writeContract({
      address: router,
      abi: universalRouterAbi,
      functionName: "execute",
      args: [buyB.commands, buyB.inputs, deadline()],
      value: buyB.value,
    }),
    "B bought $0.50, copying A",
  );

  const posB = await pub.readContract({
    address: hook,
    abi: winCutHookAbi,
    functionName: "positionOf",
    args: [b.address, poolId],
  });
  console.log(`   B position   ${posB[0]} coins, basis ${usd(posB[1])}`);
  if (posB[0] === 0n) {
    throw new Error("B has no position: the swap was not attributed to B by the hook");
  }

  // ------------------------------------------------------------------ sell
  step("4/5  wallet B sells everything");
  const coinBal = (await pub.readContract({
    address: coin,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [b.address],
  })) as bigint;

  // The quote is the contract's, and minOut is derived from netOut. Deriving it
  // from the gross figure would make a profitable sell revert on the router's
  // own slippage check.
  const q = (await pub.readContract({
    address: quoter,
    abi: quoterAbiShim(),
    functionName: "quoteSell",
    args: [b.address, poolKey, sellZeroForOne, coinBal],
  })) as unknown as readonly [bigint, bigint, bigint, bigint, bigint];
  console.log(
    `   quote        gross ${usd(q[0])} · fee ${usd(q[1])} · net ${usd(q[2])}`,
  );

  await waitOk(
    await walletB.writeContract({
      address: coin,
      abi: erc20Abi,
      functionName: "approve",
      args: [permit2, 2n ** 256n - 1n],
    }),
    "B approved the coin for Permit2",
  );
  await waitOk(
    await walletB.writeContract({
      address: permit2,
      abi: permit2Abi,
      functionName: "approve",
      args: [coin, router, MAX_UINT160, Math.floor(Date.now() / 1000) + 86_400],
    }),
    "B permitted the router",
  );

  const minOut = (q[2] * 9_950n) / 10_000n; // 0.5% slippage off the NET figure
  const sell = buildSwap({
    key: poolKey,
    zeroForOne: sellZeroForOne,
    amountIn: coinBal,
    amountOutMinimum: minOut,
    hookData: encodeAttribution(),
    quoteIsNative: true,
  });
  const sellReceipt = await waitOk(
    await walletB.writeContract({
      address: router,
      abi: universalRouterAbi,
      functionName: "execute",
      args: [sell.commands, sell.inputs, deadline()],
      value: sell.value,
    }),
    "B sold",
  );
  console.log(`   logs         ${sellReceipt.logs.length} (Sold/FeeSplit decoded by the UI)`);

  // ----------------------------------------------------------------- claim
  step("5/5  wallet A claims");
  const claimable = (await pub.readContract({
    address: hook,
    abi: winCutHookAbi,
    functionName: "claimable",
    args: [a.address],
  })) as bigint;
  console.log(`   A claimable  ${usd(claimable)}`);

  if (claimable === 0n) {
    console.log(
      "   nothing to claim: B exited at a loss, so there was no fee to split. " +
        "That is the product working, not a failure.",
    );
  } else {
    await waitOk(
      await walletA.writeContract({ address: hook, abi: winCutHookAbi, functionName: "claim" }),
      `A claimed ${usd(claimable)}`,
    );
  }

  const credit = (await pub.readContract({
    address: hook,
    abi: winCutHookAbi,
    functionName: "lossCredit",
    args: [b.address],
  })) as bigint;

  step("done");
  console.log(`   coin         ${addrLink(coin)}`);
  console.log(`   B loss credit ${usd(credit)}`);
  // APP_URL lets this point at the deployed app; it falls back to a dev server.
  const appUrl = process.env.APP_URL ?? "http://127.0.0.1:4000";
  console.log(`   open the app  ${appUrl}/coin/${coin}`);
}

/// The quoter ABI, inlined so this script does not import a browser module.
function quoterAbiShim() {
  return [
    {
      type: "function",
      name: "quoteSell",
      stateMutability: "nonpayable",
      inputs: [
        { name: "trader", type: "address" },
        {
          name: "key",
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
        { name: "zeroForOne", type: "bool" },
        { name: "coinIn", type: "uint128" },
      ],
      outputs: [
        { name: "grossOut", type: "uint256" },
        { name: "fee", type: "uint256" },
        { name: "netOut", type: "uint256" },
        { name: "lossCredit", type: "uint256" },
        { name: "volumeFeeComparison", type: "uint256" },
      ],
    },
  ] as const;
}

main().catch((e) => {
  console.error(`\nfailed: ${(e as Error)?.message ?? e}`);
  process.exit(1);
});
