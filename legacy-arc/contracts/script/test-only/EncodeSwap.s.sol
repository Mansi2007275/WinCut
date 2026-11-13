// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

import {UniversalRouterLib} from "../../src/periphery/UniversalRouterLib.sol";

/**
 * @notice Prints the Universal Router calldata for one v4 swap, offline.
 *
 * Arc's public RPC rate-limits hard enough that `forge script` cannot even
 * finish its local fork execution -- it bursts account fetches and Cloudflare
 * answers 429 before the first transaction is built. Everything needed to
 * encode a swap is known without the network though: the pool key is fixed by
 * the launcher (native quote, 0.3%, tick spacing 60, our hook) and the coin
 * address comes out of the launch receipt.
 *
 * So this runs with no --rpc-url at all, prints the hex, and `cast send`
 * delivers it. That turns a burst of fork reads into one paced transaction.
 *
 *   COIN=0x.. ZERO_FOR_ONE=true AMOUNT_IN=200000000000000000 \
 *   FOLLOWED=0x.. REFERRER=0x.. forge script script/test-only/EncodeSwap.s.sol
 */
contract EncodeSwap is Script {
    function run() external view {
        address coin = vm.envAddress("COIN");
        address hook = vm.envAddress("HOOK");
        bool zeroForOne = vm.envBool("ZERO_FOR_ONE");
        uint128 amountIn = uint128(vm.envUint("AMOUNT_IN"));

        // Exactly what WinCutLauncher.poolKeyFor builds: native USDC is
        // address(0) and therefore always currency0.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(coin),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(hook)
        });

        // Attribution is only carried on the buy; a sell reads what the hook
        // already recorded.
        bytes memory hookData = "";
        address followed = vm.envOr("FOLLOWED", address(0));
        address referrer = vm.envOr("REFERRER", address(0));
        if (followed != address(0) || referrer != address(0)) {
            hookData = abi.encode(followed, referrer);
        }

        (bytes memory commands, bytes[] memory inputs,) =
            UniversalRouterLib.encodeExactInSingle(key, zeroForOne, amountIn, 0, hookData);

        // The deadline MUST come from outside. Running with no --rpc-url means
        // block.timestamp is forge's local default, not chain time, so
        // encoding `block.timestamp + 1 day` produced a deadline already in
        // the past and the router reverted TransactionDeadlinePassed.
        uint256 deadline = vm.envUint("DEADLINE");
        bytes memory callData =
            abi.encodeWithSignature("execute(bytes,bytes[],uint256)", commands, inputs, deadline);

        console.log("CALLDATA");
        console.logBytes(callData);
        console.log("VALUE");
        console.log(zeroForOne ? amountIn : 0);
    }
}
