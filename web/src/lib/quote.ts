import type { Address, PublicClient } from "viem";
import { winCutQuoterAbi } from "@/config/abis";
import { addr, type PoolKey } from "./chain";

/**
 * Typed access to WinCutQuoter.
 *
 * The quoter's functions are `nonpayable` in Solidity, because they unlock the
 * PoolManager to simulate the swap and then revert. They are nonetheless always
 * invoked with `eth_call`, which is exactly what viem's `readContract` does.
 *
 * viem refuses to infer a return type for a nonpayable function, so the result
 * comes back as `never`. Rather than scatter `as never` casts through the app,
 * the cast lives here once, documented, with honest types on the way out. The
 * Solidity ABI stays accurate — we do not relabel these as `view` just to
 * please the type checker.
 */

export type SellQuote = {
  /// what the pool pays out before the hook takes anything
  grossOut: bigint;
  /// 10% of realised profit, after loss credits. Straight from hook.quoteFee.
  fee: bigint;
  /// what the trader actually receives. DERIVE minOut FROM THIS, never from gross.
  netOut: bigint;
  /// the trader's remaining banked losses
  lossCredit: bigint;
  /// what a conventional 0.5%-of-volume app would have charged
  volumeFee: bigint;
};

type QuoteSellTuple = readonly [bigint, bigint, bigint, bigint, bigint];

export async function quoteSell(
  client: PublicClient,
  args: { trader: Address; key: PoolKey; zeroForOne: boolean; coinIn: bigint },
): Promise<SellQuote> {
  const raw = (await client.readContract({
    address: addr.quoter,
    abi: winCutQuoterAbi,
    functionName: "quoteSell",
    args: [args.trader, args.key, args.zeroForOne, args.coinIn],
  })) as unknown as QuoteSellTuple;

  return {
    grossOut: raw[0],
    fee: raw[1],
    netOut: raw[2],
    lossCredit: raw[3],
    volumeFee: raw[4],
  };
}

export async function quoteBuy(
  client: PublicClient,
  args: { key: PoolKey; zeroForOne: boolean; amountIn: bigint },
): Promise<bigint> {
  const raw = (await client.readContract({
    address: addr.quoter,
    abi: winCutQuoterAbi,
    functionName: "quoteBuy",
    args: [args.key, args.zeroForOne, args.amountIn],
  })) as unknown as bigint;
  return raw;
}
