// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {WinCutHook} from "../src/WinCutHook.sol";
import {WinCutLauncher} from "../src/WinCutLauncher.sol";

/// @notice Deploys WinCutHook at a mined address, then the launcher, and wires them.
///
/// Required env:
///   POOL_MANAGER     v4 PoolManager on the target chain
///   QUOTE            the quote currency. address(0) for NATIVE USDC on Arc,
///                    or 0x3600000000000000000000000000000000000000 for the ERC-20 interface.
///                    Run Phase0.s.sol FIRST to find out which the live pools use.
///   UNIVERSAL_ROUTER the router to trust for attribution
///   TREASURY         fee recipient
///   MAX_TRADE_SIZE   per-trade cap in QUOTE units, 0 to disable
contract Deploy is Script {
    /// @dev CREATE2_FACTORY (0x4e59...4956C) is inherited from forge-std CommonBase.
    ///      It is the canonical deterministic deployer, identical on every EVM chain,
    ///      so the mined hook address does not depend on the deployer's nonce.
    function run() external {
        address poolManager = vm.envAddress("POOL_MANAGER");
        address quote = vm.envAddress("QUOTE");
        address universalRouter = vm.envAddress("UNIVERSAL_ROUTER");
        address treasury = vm.envAddress("TREASURY");
        uint256 maxTradeSize = vm.envOr("MAX_TRADE_SIZE", uint256(0));

        // FROZEN permission bitmap: 0x2044.
        uint160 flags =
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

        bytes memory args =
            abi.encode(IPoolManager(poolManager), Currency.wrap(quote), treasury, maxTradeSize);

        (address target, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, flags, type(WinCutHook).creationCode, args);

        console.log("mined hook address :", target);
        console.log("salt               :", vm.toString(salt));
        console.log("permission bits     :", uint160(target) & Hooks.ALL_HOOK_MASK);

        vm.startBroadcast();

        bytes memory initcode = abi.encodePacked(type(WinCutHook).creationCode, args);
        (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(salt, initcode));
        require(ok, "CREATE2 deploy failed");
        address hookAddr = address(uint160(bytes20(ret)));
        require(hookAddr == target, "hook address mismatch");

        WinCutHook hook = WinCutHook(payable(hookAddr));
        WinCutLauncher launcher = new WinCutLauncher(IPoolManager(poolManager), hook);

        hook.setLauncher(address(launcher));
        hook.setTrustedRouter(universalRouter, true);

        vm.stopBroadcast();

        console.log("");
        console.log("=== WinCut deployed ===");
        console.log("WinCutHook     :", address(hook));
        console.log("WinCutLauncher :", address(launcher));
        console.log("QUOTE          :", quote);
        console.log("trusted router :", universalRouter);
        console.log("treasury       :", treasury);
    }
}
