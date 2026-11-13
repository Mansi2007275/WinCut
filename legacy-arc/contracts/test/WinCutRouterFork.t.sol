// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WinCutHook} from "../src/WinCutHook.sol";
import {WinCutLauncher} from "../src/WinCutLauncher.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice The decisive end-to-end test: real swaps through Arc's REAL Universal
///         Router, proving that msgSender() resolves to the actual trader and
///         that the whole fee pipeline fires on live v4 contracts.
///
///   ARC_RPC=https://rpc.mainnet.arc.io forge test --match-contract WinCutRouter -vv
contract WinCutRouterForkTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant UNIVERSAL_ROUTER = 0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    Currency constant QUOTE = Currency.wrap(address(0)); // native USDC, 18dp

    uint8 constant CMD_V4_SWAP = 0x10;

    IPoolManager pm;
    WinCutHook hook;
    WinCutLauncher launcher;

    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address sam = makeAddr("sam");
    address rahul = makeAddr("rahul");
    address whale = makeAddr("whale");

    PoolKey key;
    PoolId id;
    address coin;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("ARC_RPC", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        forked = true;
        pm = IPoolManager(POOL_MANAGER);

        uint160 flags =
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        bytes memory args = abi.encode(pm, QUOTE, treasury, uint256(0), address(this));
        (address target, bytes32 salt) =
            HookMiner.find(address(this), flags, type(WinCutHook).creationCode, args);
        hook = new WinCutHook{salt: salt}(pm, QUOTE, treasury, 0, address(this));
        require(address(hook) == target, "mined mismatch");

        launcher = new WinCutLauncher(pm, hook);
        hook.setLauncher(address(launcher));
        hook.setTrustedRouter(UNIVERSAL_ROUTER, true);

        vm.deal(creator, 300_000e18);
        vm.deal(alice, 100_000e18);
        vm.deal(whale, 3_000_000e18);

        vm.prank(creator);
        (coin, id) = launcher.launchCoin{value: 200_000e18}(
            "Duke", "DUKE", "ipfs://duke", 200_000e18, 1_000_000_000e18
        );
        key = launcher.poolKeyFor(coin);
    }

    // ------------------------------------------------------------- helpers

    /// @dev Encodes a Universal Router V4_SWAP: SWAP_EXACT_IN_SINGLE -> SETTLE_ALL -> TAKE_ALL.
    function _swap(address user, bool zeroForOne, uint128 amountIn, uint128 minOut, bytes memory hookData)
        internal
    {
        bytes memory actions = abi.encodePacked(
            uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL)
        );

        Currency cIn = zeroForOne ? key.currency0 : key.currency1;
        Currency cOut = zeroForOne ? key.currency1 : key.currency0;

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                minHopPriceX36: 0,
                hookData: hookData
            })
        );
        params[1] = abi.encode(cIn, amountIn);
        params[2] = abi.encode(cOut, minOut);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        // Selling an ERC-20 through Universal Router goes via Permit2.
        if (!cIn.isAddressZero()) {
            address token = Currency.unwrap(cIn);
            vm.startPrank(user);
            IERC20(token).approve(PERMIT2, type(uint256).max);
            IPermit2(PERMIT2).approve(token, UNIVERSAL_ROUTER, type(uint160).max, uint48(block.timestamp + 3600));
            vm.stopPrank();
        }

        uint256 value = cIn.isAddressZero() ? amountIn : 0;
        vm.prank(user);
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: value}(
            abi.encodePacked(CMD_V4_SWAP), inputs, block.timestamp + 300
        );
    }

    function _buy(address user, uint128 usdcIn, bytes memory hookData) internal {
        _swap(user, true, usdcIn, 0, hookData); // native USDC is currency0
    }

    function _sell(address user, uint128 coinIn, uint128 minOut, bytes memory hookData) internal {
        _swap(user, false, coinIn, minOut, hookData);
    }

    function _attr() internal view returns (bytes memory) {
        return abi.encode(sam, rahul);
    }

    // ---------------------------------------------------------------- tests

    /// @notice THE critical test. A buy through the real Universal Router must
    ///         be attributed to alice, not to the router.
    function test_Fork_RealRouter_AttributesTheTrader() public {
        if (!forked) return;

        _buy(alice, 1_000e18, _attr());

        (uint128 amt, uint128 cost) = hook.positionOf(alice, id);
        assertGt(amt, 0, "msgSender() resolved to alice through the REAL router");
        assertApproxEqRel(cost, 1_000e18, 0.02e18, "cost basis is what she paid");

        assertEq(hook.followedOf(alice, id), sam, "copied trader recorded from hookData");
        assertEq(hook.referrerOf(alice), rahul, "referrer recorded and locked");

        // The router itself must never be credited with a position.
        (uint128 routerAmt,) = hook.positionOf(UNIVERSAL_ROUTER, id);
        assertEq(routerAmt, 0, "the router is never treated as the trader");

        console.log("attributed position:", amt);
        console.log("cost basis        :", cost);
    }

    /// @notice Profit through the real router: 10% fee, split 50/20/30.
    function test_Fork_Profit_FeeAndSplit() public {
        if (!forked) return;

        _buy(alice, 1_000e18, _attr());
        (uint128 amt, uint128 cost) = hook.positionOf(alice, id);

        _buy(whale, 400_000e18, ""); // lift the price

        uint256 before = alice.balance;
        _sell(alice, amt, 0, "");
        uint256 proceeds = alice.balance - before;

        assertGt(proceeds, cost, "she exited at a profit");

        uint256 fee = hook.claimable(sam) + hook.claimable(rahul) + hook.claimable(treasury);
        assertGt(fee, 0, "a fee was charged");

        assertApproxEqAbs(hook.claimable(sam), fee / 2, 3, "copied trader 50%");
        assertApproxEqAbs(hook.claimable(rahul), fee / 5, 3, "referrer 20%");
        assertApproxEqAbs(hook.claimable(treasury), fee * 3 / 10, 3, "treasury 30%");

        // The fee really is ~10% of the realised gain.
        uint256 gain = proceeds + fee - cost;
        assertApproxEqRel(fee, gain / 10, 0.02e18, "fee is 10% of the gain");

        console.log("gain:", gain);
        console.log("fee :", fee);
    }

    /// @notice Loss through the real router: zero fee, loss credit banked.
    function test_Fork_Loss_NoFee_BanksCredit() public {
        if (!forked) return;

        _buy(alice, 1_000e18, _attr());
        (uint128 amt, uint128 cost) = hook.positionOf(alice, id);

        // Whale pumps then dumps, leaving the price below alice's entry.
        _buy(whale, 300_000e18, "");
        uint256 whaleBal = IERC20(coin).balanceOf(whale);
        _sell(whale, uint128(whaleBal), 0, "");

        uint256 before = alice.balance;
        _sell(alice, amt, 0, "");
        uint256 proceeds = alice.balance - before;

        assertLt(proceeds, cost, "she exited at a loss");
        assertEq(hook.claimable(sam), 0, "copied trader earns nothing");
        assertEq(hook.claimable(rahul), 0, "referrer earns nothing");
        assertEq(hook.claimable(treasury), 0, "WinCut earns nothing");
        assertEq(hook.lossCredit(alice), uint256(cost) - proceeds, "loss banked exactly");

        console.log("loss credit banked:", hook.lossCredit(alice));
    }

    /// @notice The slippage trap. minOut derived from quoteFee's netOut must NOT
    ///         revert on a large profitable sell, while minOut derived from the
    ///         GROSS quote would. This is the bug that kills demos on stage.
    function test_Fork_QuoteFeeDerivedMinOut_DoesNotRevert() public {
        if (!forked) return;

        _buy(alice, 2_000e18, _attr());
        (uint128 amt,) = hook.positionOf(alice, id);

        _buy(whale, 600_000e18, ""); // a big move, so the fee is large

        // Simulate the gross quote the way V4Quoter would, by measuring the
        // swap in a snapshot and rolling back.
        uint256 snap = vm.snapshotState();
        uint256 b0 = alice.balance;
        _sell(alice, amt, 0, "");
        uint256 netActual = alice.balance - b0;
        vm.revertToState(snap);

        // grossOut = what the user received plus the fee the hook took.
        (uint256 fee,) = hook.quoteFee(alice, id, amt, netActual);
        uint256 grossOut = netActual + fee;

        (uint256 feeOnGross, uint256 netOut) = hook.quoteFee(alice, id, amt, grossOut);
        assertGt(feeOnGross, 0, "there is a real fee to absorb");

        // Correct: 0.5% slippage applied to NET.
        uint128 minOutCorrect = uint128(netOut * 9_950 / 10_000);
        _sell(alice, amt, minOutCorrect, "");
        assertGt(alice.balance, b0, "sell succeeded with quoteFee-derived minOut");

        console.log("grossOut      :", grossOut);
        console.log("fee           :", feeOnGross);
        console.log("minOut (net)  :", minOutCorrect);
        console.log("naive minOut from GROSS would have been:", grossOut * 9_950 / 10_000);
        assertGt(
            grossOut * 9_950 / 10_000,
            netOut,
            "PROOF: a minOut derived from the gross quote exceeds the achievable net, so it would revert"
        );
    }

    /// @notice Claiming real native USDC out of the hook.
    function test_Fork_Claim_PaysRealNativeUsdc() public {
        if (!forked) return;

        _buy(alice, 1_000e18, _attr());
        (uint128 amt,) = hook.positionOf(alice, id);
        _buy(whale, 400_000e18, "");
        _sell(alice, amt, 0, "");

        uint256 owed = hook.claimable(sam);
        assertGt(owed, 0, "sam is owed something");

        uint256 before = sam.balance;
        vm.prank(sam);
        hook.claim();

        assertEq(sam.balance - before, owed, "paid in real native USDC");
        assertEq(hook.claimable(sam), 0, "cleared");

        console.log("claimed (native USDC wei):", owed);
    }
}
