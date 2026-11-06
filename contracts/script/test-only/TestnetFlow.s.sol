// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WinCutHook} from "../../src/WinCutHook.sol";
import {WinCutLauncher} from "../../src/WinCutLauncher.sol";
import {UniversalRouterLib, IUniversalRouter, IPermit2Approve} from "../../src/periphery/UniversalRouterLib.sol";

/// @notice Drives ONE real end-to-end money flow on Arc testnet, through the
///         real Universal Router, so the audit can show tx hashes rather than
///         assertions: buy -> price moves -> profitable sell -> fee split ->
///         claim.
///
///   forge script script/test-only/TestnetFlow.s.sol --rpc-url $ARC_TESTNET_RPC \
///     --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
contract TestnetFlow is Script {
    address constant UNIVERSAL_ROUTER = 0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    WinCutLauncher launcher;
    WinCutHook hook;
    PoolKey key;
    PoolId id;
    address coin;

    function run() external {
        launcher = WinCutLauncher(payable(vm.envAddress("LAUNCHER")));
        hook = WinCutHook(payable(vm.envAddress("HOOK")));
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        coin = launcher.allCoins(0);
        key = launcher.poolKeyFor(coin);
        id = launcher.poolIdFor(coin);

        _trade(deployerPk);
        _report(deployerPk);
    }

    function _trade(uint256 deployerPk) internal {
        (address alice, uint256 alicePk) = makeAddrAndKey("wincut.testnet.alice");
        (address whale, uint256 whalePk) = makeAddrAndKey("wincut.testnet.whale");
        address sam = makeAddr("wincut.testnet.sam");
        address rahul = makeAddr("wincut.testnet.rahul");

        console.log("coin ", coin);
        console.log("alice", alice);
        console.log("whale", whale);
        console.log("sam  ", sam);
        console.log("rahul", rahul);

        // 1. Fund the actors from the deployer.
        vm.startBroadcast(deployerPk);
        if (alice.balance < 1.4e18) payable(alice).transfer(1.4e18);
        if (whale.balance < 9e18) payable(whale).transfer(9e18);
        vm.stopBroadcast();

        // 2. Alice buys 1 USDC of DUKE, attributing sam (copied) and rahul (referrer).
        bytes memory attribution = abi.encode(sam, rahul);
        vm.startBroadcast(alicePk);
        _swap(key, true, 1e18, 0, attribution);
        vm.stopBroadcast();

        (uint128 amt, uint128 cost) = hook.positionOf(alice, id);
        console.log("after buy: alice coins", amt);
        console.log("after buy: alice cost ", cost);
        require(amt > 0, "buy was not recorded -- attribution failed");

        // 3. The whale buys 8 USDC, pushing the price up so alice is in profit.
        vm.startBroadcast(whalePk);
        _swap(key, true, 8e18, 0, "");
        vm.stopBroadcast();

        // 4. Alice sells everything.
        vm.startBroadcast(alicePk);
        IERC20(coin).approve(PERMIT2, type(uint256).max);
        IPermit2Approve(PERMIT2).approve(coin, UNIVERSAL_ROUTER, type(uint160).max, uint48(block.timestamp + 3600));
        _swap(key, false, amt, 0, attribution);
        vm.stopBroadcast();
    }

    function _report(uint256 deployerPk) internal {
        address alice = makeAddr("wincut.testnet.alice");
        (address sam, uint256 samPk) = makeAddrAndKey("wincut.testnet.sam");
        address rahul = makeAddr("wincut.testnet.rahul");

        console.log("alice lossCredit  ", hook.lossCredit(alice));
        console.log("claimable sam     ", hook.claimable(sam));
        console.log("claimable rahul   ", hook.claimable(rahul));
        console.log("claimable treasury", hook.claimable(hook.treasury()));

        // 5. Claim is pull-based: prove a recipient can actually withdraw.
        if (hook.claimable(sam) > 0) {
            vm.startBroadcast(deployerPk);
            payable(sam).transfer(0.05e18);
            vm.stopBroadcast();

            uint256 before = sam.balance;
            vm.startBroadcast(samPk);
            hook.claim();
            vm.stopBroadcast();
            console.log("sam balance before claim", before);
            console.log("sam balance after  claim", sam.balance);
        }
    }

    function _swap(PoolKey memory k, bool zeroForOne, uint128 amountIn, uint128 minOut, bytes memory hookData)
        internal
    {
        (bytes memory commands, bytes[] memory inputs, uint256 value) =
            UniversalRouterLib.encodeExactInSingle(k, zeroForOne, amountIn, minOut, hookData);
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: value}(commands, inputs, block.timestamp + 600);
    }
}
