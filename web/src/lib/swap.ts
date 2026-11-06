import { encodeAbiParameters, encodePacked, type Address, type Hex } from "viem";
import { poolKeyComponents } from "@/config/abis";
import type { PoolKey } from "./chain";

/// Mirror of contracts/src/periphery/UniversalRouterLib.sol.
/// If you change one, change the other.
const CMD_V4_SWAP = 0x10;
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const ACTION_SETTLE_ALL = 0x0c;
const ACTION_TAKE_ALL = 0x0f;

const exactInputSingleParams = [
  {
    type: "tuple",
    components: [
      { name: "poolKey", type: "tuple", components: poolKeyComponents },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      // Present in the current v4-periphery layout. The deployed Arc router
      // accepts it, confirmed by real swaps in test/WinCutRouterFork.t.sol.
      { name: "minHopPriceX36", type: "uint256" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

export type SwapPlan = {
  commands: Hex;
  inputs: readonly Hex[];
  value: bigint;
};

/**
 * Builds a Universal Router V4_SWAP for one exact-input single-hop swap.
 *
 * `amountOutMinimum` MUST come from WinCutQuoter.quoteSell's netOut, not from
 * the gross quote: the router validates it against the POST-hook amount, so a
 * gross-derived figure makes every profitable sell revert.
 */
export function buildSwap(args: {
  key: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  hookData: Hex;
  quoteIsNative: boolean;
}): SwapPlan {
  const { key, zeroForOne, amountIn, amountOutMinimum, hookData, quoteIsNative } = args;

  const actions = encodePacked(
    ["uint8", "uint8", "uint8"],
    [ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL],
  );

  const currencyIn = zeroForOne ? key.currency0 : key.currency1;
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;

  const params: Hex[] = [
    encodeAbiParameters(exactInputSingleParams, [
      {
        poolKey: {
          currency0: key.currency0,
          currency1: key.currency1,
          fee: key.fee,
          tickSpacing: key.tickSpacing,
          hooks: key.hooks,
        },
        zeroForOne,
        amountIn,
        amountOutMinimum,
        minHopPriceX36: 0n,
        hookData,
      },
    ]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyIn, amountIn]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyOut, amountOutMinimum]),
  ];

  const inputs = [encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params])];

  // Paying in the native currency means sending value.
  const payingNative = quoteIsNative && currencyIn === "0x0000000000000000000000000000000000000000";

  return {
    commands: encodePacked(["uint8"], [CMD_V4_SWAP]),
    inputs,
    value: payingNative ? amountIn : 0n,
  };
}

/// Attribution travels to the hook as hookData. The hook ignores self-follow and
/// self-referral, and locks the referrer on the first buy.
export function encodeAttribution(followed?: Address, referrer?: Address): Hex {
  const zero = "0x0000000000000000000000000000000000000000" as Address;
  return encodeAbiParameters(
    [{ type: "address" }, { type: "address" }],
    [followed ?? zero, referrer ?? zero],
  );
}

export const MAX_UINT160 = (1n << 160n) - 1n;
export const deadline = (seconds = 900) => BigInt(Math.floor(Date.now() / 1000) + seconds);
