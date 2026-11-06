// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {WinCutHook} from "../src/WinCutHook.sol";
import {WinCutLauncher} from "../src/WinCutLauncher.sol";
import {WinCutQuoter} from "../src/periphery/WinCutQuoter.sol";

/// @notice Deploys WinCutHook at a mined address, then the launcher, and wires them.
///
/// Required env:
///   POOL_MANAGER     v4 PoolManager on the target chain
///   QUOTE            the quote currency. address(0) for NATIVE USDC on Arc,
///                    0x3600...0000 for the ERC-20 interface. Phase0 decides this;
///                    on Arc mainnet the evidence says NATIVE.
///   UNIVERSAL_ROUTER the router to trust for attribution
///   TREASURY         fee recipient
///   MAX_TRADE_SIZE   per-trade cap in QUOTE units, 0 to disable
contract Deploy is Script {
    struct Config {
        address poolManager;
        address quote;
        address universalRouter;
        address treasury;
        uint256 maxTradeSize;
        address owner;
    }

    /// @dev CREATE2_FACTORY (0x4e59...4956C) comes from forge-std CommonBase.
    ///      It is the canonical deterministic deployer, identical on every EVM
    ///      chain, so the mined hook address never depends on a deployer nonce.
    function run() external {
        Config memory cfg = Config({
            poolManager: vm.envAddress("POOL_MANAGER"),
            quote: vm.envAddress("QUOTE"),
            universalRouter: vm.envAddress("UNIVERSAL_ROUTER"),
            treasury: vm.envAddress("TREASURY"),
            maxTradeSize: vm.envOr("MAX_TRADE_SIZE", uint256(0)),
            // The broadcasting EOA. Deliberately NOT msg.sender inside the hook
            // constructor: the hook is deployed via the CREATE2 factory, so
            // msg.sender there is the factory, which would own the hook and lock
            // the deployer out of setLauncher().
            owner: msg.sender
        });

        (address hook, address launcher, address quoter, address winCutQuoter) = _deploy(cfg);
        _report(cfg, hook, launcher, quoter, winCutQuoter);
    }

    function _deploy(Config memory cfg)
        internal
        returns (address hookAddr, address launcherAddr, address quoterAddr, address winCutQuoterAddr)
    {
        // FROZEN permission bitmap: 0x2044.
        uint160 flags =
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

        bytes memory args = abi.encode(
            IPoolManager(cfg.poolManager),
            Currency.wrap(cfg.quote),
            cfg.treasury,
            cfg.maxTradeSize,
            cfg.owner
        );

        (address target, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, flags, type(WinCutHook).creationCode, args);

        console.log("mined hook address :", target);
        console.log("salt               :", vm.toString(salt));
        console.log("permission bits    :", uint160(target) & Hooks.ALL_HOOK_MASK);
        require((uint160(target) & Hooks.ALL_HOOK_MASK) == 0x2044, "bitmap must be 0x2044");

        vm.startBroadcast();

        (bool ok, bytes memory ret) =
            CREATE2_FACTORY.call(abi.encodePacked(salt, abi.encodePacked(type(WinCutHook).creationCode, args)));
        require(ok, "CREATE2 deploy failed");
        hookAddr = address(uint160(bytes20(ret)));
        require(hookAddr == target, "hook address mismatch");

        WinCutHook hook = WinCutHook(payable(hookAddr));
        WinCutLauncher launcher = new WinCutLauncher(IPoolManager(cfg.poolManager), hook);
        launcherAddr = address(launcher);

        hook.setLauncher(launcherAddr);
        hook.setTrustedRouter(cfg.universalRouter, true);

        // Our own quoter. It simulates a swap and reverts with the delta, so
        // unlike v4-periphery's V4Quoter it reads no PoolManager storage and is
        // immune to layout drift between v4-core versions.
        winCutQuoterAddr = address(new WinCutQuoter(IPoolManager(cfg.poolManager), hook));
        quoterAddr = winCutQuoterAddr;

        vm.stopBroadcast();
    }

    function _report(Config memory cfg, address hook, address launcher, address quoter, address winCutQuoter)
        internal
        pure
    {
        console.log("");
        console.log("=== WinCut deployed ===");
        console.log("WinCutHook     :", hook);
        console.log("WinCutLauncher :", launcher);
        console.log("QUOTE          :", cfg.quote);
        console.log("trusted router :", cfg.universalRouter);
        console.log("treasury       :", cfg.treasury);
        console.log("V4Quoter       :", quoter);
        console.log("WinCutQuoter   :", winCutQuoter);
        console.log("owner          :", cfg.owner);
    }
}
