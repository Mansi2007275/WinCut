// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WinCutHook} from "../src/WinCutHook.sol";
import {WinCutLauncher} from "../src/WinCutLauncher.sol";
import {MockRouter} from "../test/mocks/MockRouter.sol";

/// @notice Generates REAL on-chain trading history so the Feed and Leaderboard
///         are populated at demo time without seeding fake rows.
///
/// Every row this produces is a genuine swap through the hook. Nothing is mocked.
/// "No seeded data" plus a fresh deployment otherwise means an empty leaderboard,
/// which is the one thing that makes a good demo look broken.
///
/// Designed for an Anvil fork, where accounts are pre-funded and impersonation
/// is free:
///   anvil --fork-url $ARC_RPC
///   forge script script/SeedTrades.s.sol --rpc-url http://localhost:8545 --broadcast --unlocked
///
/// It deliberately creates one DUMPER: a trader with strong personal PnL whose
/// followers lose money. That is the row that turns red on the leaderboard and
/// it is the whole point of the second board.
contract SeedTrades is Script {
    WinCutHook hook;
    WinCutLauncher launcher;
    MockRouter router;
    IERC20 quote;

    // Anvil's deterministic accounts.
    uint256 constant N_TRADERS = 12;

    address[] traders;
    address[] coins;

    function run() external {
        hook = WinCutHook(payable(vm.envAddress("HOOK")));
        launcher = WinCutLauncher(payable(vm.envAddress("LAUNCHER")));
        router = MockRouter(vm.envAddress("ROUTER"));
        quote = IERC20(Currency.unwrap(hook.QUOTE()));

        for (uint256 i = 0; i < N_TRADERS; i++) {
            traders.push(vm.addr(uint256(keccak256(abi.encode("wincut.trader", i)))));
        }

        address honest = traders[0]; // good own PnL, followers profit
        address dumper = traders[1]; // good own PnL, followers lose
        address referrer = traders[2];

        console.log("=== seeding real trades ===");
        console.log("honest trader :", honest);
        console.log("dumper        :", dumper);

        _launch("Duke", "DUKE");
        _launch("Tolly", "TOLLY");
        _launch("Cool", "COOL");

        // Scenario A: honest trader buys, price rises, followers exit in profit.
        _round(coins[0], honest, referrer, 3, 11, true);

        // Scenario B: the dumper front-runs his own followers. He exits into
        // their buys, so his PnL is positive while theirs is negative.
        _dumpOnFollowers(coins[1], dumper, referrer, 6, 11);

        // Scenario C: mixed outcomes, which is what banks loss credits.
        _round(coins[2], honest, referrer, 3, 8, false);

        console.log("");
        console.log("=== seeded ===");
        console.log("coins launched:", coins.length);
        console.log("honest  claimable:", hook.claimable(honest));
        console.log("dumper  claimable:", hook.claimable(dumper));
        console.log("Leaderboard now has real rows. Dumper should show negative followers PnL.");
    }

    function _launch(string memory name, string memory symbol) internal {
        address creator = traders[0];
        uint256 seed = 50_000e6;
        _ensureQuote(creator, seed);

        vm.startBroadcast(creator);
        quote.approve(address(launcher), type(uint256).max);
        (address coin,) = launcher.launchCoin(name, symbol, "ipfs://wincut", seed, 500_000_000e18);
        vm.stopBroadcast();

        coins.push(coin);
        console.log("launched", symbol, coin);
    }

    /// @dev `leader` buys first, followers copy, price rises, everyone exits.
    function _round(address coin, address leader, address referrer, uint256 from, uint256 to, bool profitable)
        internal
    {
        PoolKey memory key = launcher.poolKeyFor(coin);
        bool quoteIs0 = Currency.unwrap(key.currency0) == address(quote);

        _buyAs(key, quoteIs0, leader, 2_000e6, abi.encode(address(0), referrer));

        for (uint256 i = from; i < to; i++) {
            _buyAs(key, quoteIs0, traders[i], uint128(500e6 + i * 120e6), abi.encode(leader, referrer));
        }

        if (profitable) {
            // A late buyer lifts the price so the followers exit green.
            _buyAs(key, quoteIs0, traders[3], 25_000e6, "");
        } else {
            // A big exit pushes price down so some followers realise losses,
            // which banks loss credit they can use later.
            _sellAll(key, quoteIs0, traders[3], "");
        }

        for (uint256 i = from; i < to; i++) {
            _sellAll(key, quoteIs0, traders[i], abi.encode(leader, referrer));
        }
        _sellAll(key, quoteIs0, leader, abi.encode(address(0), referrer));
    }

    /// @dev The dumper exits INTO his followers' buys. His own PnL is positive,
    ///      theirs is negative, and under WinCut he earns nothing from them.
    function _dumpOnFollowers(address coin, address dumper, address referrer, uint256 from, uint256 to)
        internal
    {
        PoolKey memory key = launcher.poolKeyFor(coin);
        bool quoteIs0 = Currency.unwrap(key.currency0) == address(quote);

        _buyAs(key, quoteIs0, dumper, 8_000e6, abi.encode(address(0), referrer));

        for (uint256 i = from; i < to; i++) {
            _buyAs(key, quoteIs0, traders[i], uint128(1_200e6), abi.encode(dumper, referrer));
        }

        _sellAll(key, quoteIs0, dumper, abi.encode(address(0), referrer)); // the dump

        for (uint256 i = from; i < to; i++) {
            _sellAll(key, quoteIs0, traders[i], abi.encode(dumper, referrer)); // followers eat it
        }
    }

    function _buyAs(PoolKey memory key, bool quoteIs0, address who, uint128 amountIn, bytes memory hookData)
        internal
    {
        _ensureQuote(who, amountIn);
        vm.startBroadcast(who);
        quote.approve(address(router), type(uint256).max);
        router.swapExactIn(key, quoteIs0, amountIn, hookData);
        vm.stopBroadcast();
    }

    function _sellAll(PoolKey memory key, bool quoteIs0, address who, bytes memory hookData) internal {
        address coin = quoteIs0 ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
        uint256 bal = IERC20(coin).balanceOf(who);
        if (bal == 0) return;

        vm.startBroadcast(who);
        IERC20(coin).approve(address(router), type(uint256).max);
        router.swapExactIn(key, !quoteIs0, uint128(bal), hookData);
        vm.stopBroadcast();
    }

    /// @dev On a fork, top the account up however your QUOTE allows. With MockUSDC
    ///      this mints; against real Arc USDC, pre-fund these addresses instead.
    function _ensureQuote(address who, uint256 amount) internal {
        if (quote.balanceOf(who) >= amount) return;
        (bool ok,) = address(quote).call(abi.encodeWithSignature("mint(address,uint256)", who, amount * 4));
        if (!ok) {
            console.log("WARN: could not fund", who);
            console.log("      pre-fund this address with QUOTE before seeding.");
        }
    }
}
