// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WinCutHook} from "../../src/WinCutHook.sol";
import {WinCutLauncher} from "../../src/WinCutLauncher.sol";
import {UniversalRouterLib, IUniversalRouter, IPermit2Approve} from "../../src/periphery/UniversalRouterLib.sol";

/// @notice Generates REAL trading history through Arc's REAL Universal Router,
///         so the Leaderboard and Me screens have genuine data at demo time.
///
/// Nothing here is mocked or seeded: every row is an actual v4 swap that went
/// through WinCutHook. The alternative, on a fresh deployment, is an empty
/// leaderboard, which is the one thing that makes a working demo look broken.
///
/// Run against an Anvil fork of Arc mainnet:
///   anvil --fork-url $ARC_RPC --chain-id 5042
///   HOOK=.. LAUNCHER=.. forge script script/SeedTrades.s.sol \
///     --rpc-url http://localhost:8545 --broadcast --unlocked
///
/// Scenario design matters. It deliberately produces one DUMPER whose own PnL
/// is positive while his followers lose money, because that is the row the
/// second leaderboard exists to expose.
contract SeedTrades is Script {
    address constant UNIVERSAL_ROUTER = 0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    WinCutHook hook;
    WinCutLauncher launcher;
    Currency QUOTE;
    bool quoteIsNative;

    /// @dev DO NOT use anvil's default accounts as traders on an Arc fork.
    ///      Every well-known test address carries an EIP-7702 delegation on Arc
    ///      mainnet (code 0xef0100... -> 0x8a67b5020ee254ef48e3b6a04927f39baf7e408a),
    ///      a sweeper that instantly forwards any native USDC it receives. A fork
    ///      inherits that, so sell proceeds would vanish and every PnL figure
    ///      would be wrong. These keys are project-specific and undelegated.
    bytes32 constant TRADER_SALT = "wincut.seed.v3";

    uint256[] pks;
    address[] traders;
    address[] coins;

    uint256 honestPk;
    uint256 dumperPk;
    uint256 referrerPk;
    uint256 moverPk;

    address honest;
    address dumper;
    address referrer;
    address mover; // pushes price around

    function run() external {
        hook = WinCutHook(payable(vm.envAddress("HOOK")));
        launcher = WinCutLauncher(payable(vm.envAddress("LAUNCHER")));
        QUOTE = hook.QUOTE();
        quoteIsNative = QUOTE.isAddressZero();

        require(quoteIsNative, "this seed script assumes native USDC on Arc");

        for (uint256 i = 0; i < 14; i++) {
            uint256 pk = uint256(keccak256(abi.encodePacked(TRADER_SALT, i)));
            address who = vm.addr(pk);
            // A delegated address would silently forward its proceeds away.
            require(who.code.length == 0, "demo wallet has code; pick another salt");
            pks.push(pk);
            traders.push(who);
        }
        honestPk = pks[0];
        dumperPk = pks[1];
        referrerPk = pks[2];
        moverPk = pks[3];
        honest = traders[0];
        dumper = traders[1];
        referrer = traders[2];
        mover = traders[3];

        console.log("=== seeding real trades through the real Universal Router ===");
        console.log("honest trader :", honest);
        console.log("dumper        :", dumper);
        console.log("referrer      :", referrer);
        console.log("");

        // Funding is done by scripts/test-only/dev.sh via anvil_setBalance before this
        // runs. vm.deal is a simulation cheatcode and never touches the live
        // chain, and vm.broadcast cannot send value the script contract does
        // not hold, so neither works here.
        require(
            traders[0].balance >= 1_000_000e18,
            "demo wallets unfunded: run via scripts/test-only/dev.sh, which anvil_setBalance's them"
        );

        _launch("Duke", "DUKE");
        _launch("Tolly", "TOLLY");
        _launch("Cool", "COOL");

        // Scenario A: honest leader, followers exit in profit.
        _honestRound(coins[0], 6, 10);

        // Scenario B: dumper exits into his own followers' buys.
        _dumpOnFollowers(coins[1], 10, 14);

        // Scenario C: mixed, so loss credits actually get banked.
        _mixedRound(coins[2], 6, 10);

        _report();
    }

    // ---------------------------------------------------------------- launch

    function _launch(string memory name, string memory symbol) internal {
        uint256 seed = 80_000e18;
        vm.broadcast(honestPk);
        (address coin,) = launcher.launchCoin{value: seed}(name, symbol, "ipfs://wincut", seed, 500_000_000e18);
        coins.push(coin);
        console.log("launched", symbol, coin);
    }

    // -------------------------------------------------------------- scenarios

    /// @dev Leader buys, followers copy, a later buyer lifts price, all exit green.
    function _honestRound(address coin, uint256 from, uint256 to) internal {
        PoolKey memory key = launcher.poolKeyFor(coin);

        _buy(key, honestPk, 4_000e18, abi.encode(address(0), referrer));
        for (uint256 i = from; i < to; i++) {
            _buy(key, pks[i], uint128(900e18 + i * 150e18), abi.encode(honest, referrer));
        }

        _buy(key, moverPk, 90_000e18, ""); // lift

        for (uint256 i = from; i < to; i++) {
            _sellAll(key, coin, pks[i], abi.encode(honest, referrer));
        }
        _sellAll(key, coin, honestPk, abi.encode(address(0), referrer));
    }

    /// @dev The dumper's own PnL is positive, his followers' is negative, and
    ///      under WinCut he earns nothing from the ones who lost.
    function _dumpOnFollowers(address coin, uint256 from, uint256 to) internal {
        PoolKey memory key = launcher.poolKeyFor(coin);

        _buy(key, dumperPk, 20_000e18, abi.encode(address(0), referrer));
        for (uint256 i = from; i < to; i++) {
            _buy(key, pks[i], 2_500e18, abi.encode(dumper, referrer));
        }

        _sellAll(key, coin, dumperPk, abi.encode(address(0), referrer)); // the dump

        for (uint256 i = from; i < to; i++) {
            _sellAll(key, coin, pks[i], abi.encode(dumper, referrer)); // followers eat it
        }
    }

    /// @dev Some win, some lose, which is what banks loss credit.
    function _mixedRound(address coin, uint256 from, uint256 to) internal {
        PoolKey memory key = launcher.poolKeyFor(coin);

        for (uint256 i = from; i < to; i++) {
            _buy(key, pks[i], 1_500e18, abi.encode(honest, referrer));
        }

        // Price falls: the first half exit red and bank credit.
        _buy(key, moverPk, 40_000e18, "");
        _sellAll(key, coin, moverPk, "");
        for (uint256 i = from; i < from + 2; i++) {
            _sellAll(key, coin, pks[i], abi.encode(honest, referrer));
        }

        // Then it recovers and the rest exit green.
        _buy(key, moverPk, 110_000e18, "");
        for (uint256 i = from + 2; i < to; i++) {
            _sellAll(key, coin, pks[i], abi.encode(honest, referrer));
        }
        _sellAll(key, coin, moverPk, "");
    }

    // ----------------------------------------------------------------- swaps

    function _buy(PoolKey memory key, uint256 pk, uint128 amountIn, bytes memory hookData) internal {
        // Native USDC sorts to currency0, so buying is zeroForOne.
        (bytes memory cmds, bytes[] memory inputs, uint256 value) =
            UniversalRouterLib.encodeExactInSingle(key, true, amountIn, 0, hookData);

        vm.broadcast(pk);
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: value}(cmds, inputs, block.timestamp + 600);
    }

    function _sellAll(PoolKey memory key, address coin, uint256 pk, bytes memory hookData) internal {
        address who = vm.addr(pk);
        uint256 bal = IERC20(coin).balanceOf(who);
        if (bal == 0) return;

        // Selling an ERC-20 through Universal Router goes via Permit2.
        vm.broadcast(pk);
        IERC20(coin).approve(PERMIT2, type(uint256).max);
        vm.broadcast(pk);
        IPermit2Approve(PERMIT2).approve(
            coin, UNIVERSAL_ROUTER, type(uint160).max, uint48(block.timestamp + 7 days)
        );

        (bytes memory cmds, bytes[] memory inputs,) =
            UniversalRouterLib.encodeExactInSingle(key, false, uint128(bal), 0, hookData);

        vm.broadcast(pk);
        IUniversalRouter(UNIVERSAL_ROUTER).execute(cmds, inputs, block.timestamp + 600);
    }

    // ---------------------------------------------------------------- report

    function _report() internal view {
        console.log("");
        console.log("=== seeded, all on-chain ===");
        console.log("coins launched :", coins.length);
        console.log("");
        console.log("--- claimable (native USDC wei) ---");
        console.log("honest   :", hook.claimable(honest));
        console.log("dumper   :", hook.claimable(dumper));
        console.log("referrer :", hook.claimable(referrer));
        console.log("treasury :", hook.claimable(hook.treasury()));
        console.log("");
        console.log("--- loss credits banked ---");
        for (uint256 i = 6; i < 14; i++) {
            uint256 c = hook.lossCredit(traders[i]);
            if (c > 0) {
                console.log("  trader", i, "credit:", c);
            }
        }
        console.log("");
        console.log("The dumper should show POSITIVE own PnL and NEGATIVE followers PnL.");
        console.log("That is the row the Leaderboard flags red.");
    }
}
