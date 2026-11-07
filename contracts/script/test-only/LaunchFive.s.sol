// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WinCutHook} from "../../src/WinCutHook.sol";
import {WinCutLauncher} from "../../src/WinCutLauncher.sol";
import {UniversalRouterLib, IUniversalRouter, IPermit2Approve} from "../../src/periphery/UniversalRouterLib.sol";

/// @notice Launches five coins on Arc testnet and puts real trading history on
///         each, so the board, the feed and the price charts have something
///         genuine to show.
///
/// The launch call is byte-for-byte what the web form sends: launchCoin with an
/// empty metadataURI, a fixed 1e9 supply, and the seed amount as msg.value.
///
/// Per coin: alice buys, whale buys (which moves the price up), alice exits.
/// That produces one profitable exit per pool, which is the only path that
/// emits Sold with a non-zero fee and therefore the only way the leaderboard
/// gets a row.
///
///   forge script script/test-only/LaunchFive.s.sol \
///     --rpc-url $ARC_TESTNET_RPC --broadcast --slow
contract LaunchFive is Script {
    address constant UNIVERSAL_ROUTER = 0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// Matches the web form's constant exactly.
    uint256 constant SUPPLY = 1_000_000_000e18;

    uint256 constant SEED = 0.5e18; // per coin, native USDC (18dp)
    uint128 constant BUY_A = 0.2e18;
    uint128 constant BUY_W = 0.6e18; // bigger, so alice's exit is in profit

    WinCutLauncher launcher;
    WinCutHook hook;

    uint256 deployerPk;
    uint256 alicePk;
    uint256 whalePk;
    address alice;
    address whale;
    address sam; // the trader being copied
    address rahul; // the referrer

    string[5] names = ["Chai Break", "Pepe Mumbai", "Doge Arc", "Bhai Coin", "Moon Rupee"];
    string[5] symbols = ["CHAI", "PEPE", "DOGE", "BHAI", "MOON"];

    function run() external {
        launcher = WinCutLauncher(payable(vm.envAddress("LAUNCHER")));
        hook = WinCutHook(payable(vm.envAddress("HOOK")));
        deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        (alice, alicePk) = makeAddrAndKey("wincut.five.alice");
        (whale, whalePk) = makeAddrAndKey("wincut.five.whale");
        sam = makeAddr("wincut.testnet.sam");
        rahul = makeAddr("wincut.testnet.rahul");

        console.log("alice", alice);
        console.log("whale", whale);

        _fund();

        // ONLY / FROM let this be driven one coin at a time. Arc's public RPC
        // rate-limits hard, and a 35-transaction run that dies halfway is
        // worse than five small runs: the launches that already landed cannot
        // be undone, so being able to resume at an index matters.
        uint256 only = vm.envOr("ONLY", type(uint256).max);
        if (only != type(uint256).max) {
            _launchAndTrade(only);
        } else {
            for (uint256 i = vm.envOr("FROM", uint256(0)); i < 5; i++) {
                _launchAndTrade(i);
            }
        }

        console.log("coinCount", launcher.coinCount());
        console.log("deployer left", vm.addr(deployerPk).balance);
    }

    function _fund() internal {
        vm.startBroadcast(deployerPk);
        if (alice.balance < 1.5e18) payable(alice).transfer(1.5e18 - alice.balance);
        if (whale.balance < 3.4e18) payable(whale).transfer(3.4e18 - whale.balance);
        vm.stopBroadcast();
    }

    function _launchAndTrade(uint256 i) internal {
        vm.startBroadcast(deployerPk);
        // Exactly the web form's call: empty metadataURI, fixed supply.
        (address coin, PoolId id) =
            launcher.launchCoin{value: SEED}(names[i], symbols[i], "", SEED, SUPPLY);
        vm.stopBroadcast();

        console.log("launched", symbols[i], coin);

        PoolKey memory key = launcher.poolKeyFor(coin);
        bytes memory attribution = abi.encode(sam, rahul);

        // 1. alice opens a position, attributing sam and rahul.
        vm.startBroadcast(alicePk);
        _swap(key, true, BUY_A, attribution);
        vm.stopBroadcast();

        // 2. the whale buys, pushing the price above alice's basis.
        vm.startBroadcast(whalePk);
        _swap(key, true, BUY_W, "");
        vm.stopBroadcast();

        // 3. alice exits the whole position at a profit.
        (uint128 held,) = hook.positionOf(alice, id);
        if (held > 0) {
            vm.startBroadcast(alicePk);
            IERC20(coin).approve(PERMIT2, type(uint256).max);
            IPermit2Approve(PERMIT2).approve(
                coin, UNIVERSAL_ROUTER, type(uint160).max, uint48(block.timestamp + 3600)
            );
            _swap(key, false, held, attribution);
            vm.stopBroadcast();
        }
    }

    function _swap(PoolKey memory k, bool zeroForOne, uint128 amountIn, bytes memory hookData)
        internal
    {
        (bytes memory commands, bytes[] memory inputs, uint256 value) =
            UniversalRouterLib.encodeExactInSingle(k, zeroForOne, amountIn, 0, hookData);
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: value}(commands, inputs, block.timestamp + 900);
    }
}
