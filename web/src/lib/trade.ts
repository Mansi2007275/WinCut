import type { Address, PublicClient, TransactionReceipt } from "viem";
import type { WalletClient } from "viem";
import { universalRouterAbi } from "@/config/abis";
import { addr, QUOTE, buyDirection } from "./chain";
import { buildSwap, encodeAttribution, deadline } from "./swap";
import type { PoolKey } from "./chain";

/**
 * Buys a coin with QUOTE through the Universal Router.
 *
 * This lives in one place because two screens buy: the Discover list's one-tap
 * buttons and the coin page's trade panel. Duplicating the encoding would let
 * the two drift, and a drifted `hookData` means a trade that silently loses its
 * referrer or its copied trader.
 *
 * `amountOutMinimum` is 0 for buys. That is safe here and nowhere else: a buy
 * pays a fixed amount of QUOTE in, the hook charges nothing on the way in, and
 * the pool is the only thing that decides the coins out. Sells are the opposite
 * — their minOut must come from the quoter's POST-fee netOut — which is why
 * selling is not in this function.
 */
export async function buyCoin(args: {
  wallet: WalletClient;
  client: PublicClient;
  poolKey: PoolKey;
  amountIn: bigint;
  follow?: Address;
  referrer?: Address;
  onHash?: (h: `0x${string}`) => void;
}): Promise<{ hash: `0x${string}`; receipt: TransactionReceipt }> {
  const plan = buildSwap({
    key: args.poolKey,
    zeroForOne: buyDirection(args.poolKey),
    amountIn: args.amountIn,
    amountOutMinimum: 0n,
    hookData: encodeAttribution(args.follow, args.referrer),
    quoteIsNative: QUOTE.isNative,
  });

  const hash = await args.wallet.writeContract({
    address: addr.universalRouter,
    abi: universalRouterAbi,
    functionName: "execute",
    args: [plan.commands, plan.inputs, deadline()],
    value: plan.value,
    chain: args.wallet.chain,
    account: args.wallet.account!,
  });
  args.onHash?.(hash);

  const receipt = await args.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("transaction reverted");
  return { hash, receipt };
}
