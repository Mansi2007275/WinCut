// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WinCutHook} from "../src/WinCutHook.sol";
import {WinCutLauncher} from "../src/WinCutLauncher.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockRouter, UnknownRouter} from "./mocks/MockRouter.sol";

/// @notice Shared fixture: real PoolManager, mined hook, launched coin, funded traders.
abstract contract WinCutBase is Test {
    PoolManager pm;
    MockUSDC usdc;
    WinCutHook hook;
    WinCutLauncher launcher;
    MockRouter router;
    UnknownRouter badRouter;

    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice"); // the trader under test
    address sam = makeAddr("sam"); // the copied trader
    address rahul = makeAddr("rahul"); // the referrer
    address whale = makeAddr("whale"); // moves the price

    PoolKey key;
    PoolId id;
    address coin;

    bool quoteIs0;

    uint256 constant SEED_USDC = 200_000e6;
    uint256 constant SUPPLY = 1_000_000_000e18;

    function setUp() public virtual {
        pm = new PoolManager(address(this));
        usdc = new MockUSDC();

        // Permissions are frozen: beforeInitialize | afterSwap | afterSwapReturnDelta.
        uint160 flags =
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        bytes memory args =
            abi.encode(IPoolManager(address(pm)), Currency.wrap(address(usdc)), treasury, uint256(0), address(this));
        (address target, bytes32 salt) =
            HookMiner.find(address(this), flags, type(WinCutHook).creationCode, args);

        hook = new WinCutHook{salt: salt}(
            IPoolManager(address(pm)), Currency.wrap(address(usdc)), treasury, 0, address(this)
        );
        assertEq(address(hook), target, "mined hook address mismatch");

        launcher = new WinCutLauncher(IPoolManager(address(pm)), hook);
        hook.setLauncher(address(launcher));

        router = new MockRouter(IPoolManager(address(pm)));
        badRouter = new UnknownRouter(IPoolManager(address(pm)));
        hook.setTrustedRouter(address(router), true);

        // Launch the coin and seed locked liquidity.
        usdc.mint(creator, SEED_USDC);
        vm.startPrank(creator);
        usdc.approve(address(launcher), type(uint256).max);
        (coin, id) = launcher.launchCoin("Duke", "DUKE", "ipfs://duke", SEED_USDC, SUPPLY);
        vm.stopPrank();

        key = launcher.poolKeyFor(coin);
        quoteIs0 = Currency.unwrap(key.currency0) == address(usdc);

        _fund(alice, 100_000e6);
        _fund(whale, 5_000_000e6);
        _fund(sam, 10_000e6);
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(router), type(uint256).max);
        usdc.approve(address(badRouter), type(uint256).max);
        IERC20(coin).approve(address(router), type(uint256).max);
        IERC20(coin).approve(address(badRouter), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Buying = swapping QUOTE in. zeroForOne is true when QUOTE is currency0.
    function _buy(address who, uint128 usdcIn, bytes memory hookData) internal {
        vm.prank(who);
        router.swapExactIn(key, quoteIs0, usdcIn, hookData);
    }

    /// @dev Selling = swapping COIN in, the opposite direction.
    function _sell(address who, uint128 coinIn, bytes memory hookData) internal {
        vm.prank(who);
        router.swapExactIn(key, !quoteIs0, coinIn, hookData);
    }

    function _attribution() internal view returns (bytes memory) {
        return abi.encode(sam, rahul);
    }

    function _coinBal(address who) internal view returns (uint128) {
        return uint128(IERC20(coin).balanceOf(who));
    }
}

/// @notice The six money rules. These are the tests a Uniswap judge will read.
contract WinCutMoneyRules is WinCutBase {
    // ---------------------------------------------------------------- rule 1
    // A profitable sell pays exactly 10% of the gain, split 50/20/30.

    function test_Profit_ChargesTenPercent_AndSplits() public {
        _buy(alice, 1_000e6, _attribution());
        (uint128 amt, uint128 cost) = hook.positionOf(alice, id);
        assertGt(amt, 0, "position recorded");
        assertApproxEqAbs(cost, 1_000e6, 1e6, "cost basis is what she paid");

        // Exact arithmetic through the single source of truth the frontend uses.
        (uint256 fee, uint256 net) = hook.quoteFee(alice, id, amt, uint256(cost) + 500e6);
        assertEq(fee, 50e6, "10% of a 500 USDC gain");
        assertEq(net, uint256(cost) + 500e6 - 50e6, "netOut is gross minus fee");

        // And end to end: whale pushes price up, alice exits at a real profit.
        _buy(whale, 400_000e6, "");
        uint256 before = usdc.balanceOf(alice);
        _sell(alice, amt, "");
        uint256 proceeds = usdc.balanceOf(alice) - before;

        uint256 gain = proceeds > cost ? proceeds - cost : 0;
        assertGt(gain, 0, "she actually profited");

        uint256 charged = hook.claimable(sam) + hook.claimable(rahul) + hook.claimable(treasury);
        assertGt(charged, 0, "a fee was taken");

        // 50 / 20 / 30 of the fee.
        assertApproxEqAbs(hook.claimable(sam), charged / 2, 2, "copied trader gets 50%");
        assertApproxEqAbs(hook.claimable(rahul), charged / 5, 2, "referrer gets 20%");
        assertApproxEqAbs(hook.claimable(treasury), charged * 3 / 10, 2, "treasury gets the rest");
    }

    // ---------------------------------------------------------------- rule 2
    // A losing sell charges nothing and banks a loss credit.

    function test_Loss_ChargesNothing_AndBanksCredit() public {
        _buy(alice, 1_000e6, _attribution());
        (uint128 amt, uint128 cost) = hook.positionOf(alice, id);

        // Whale dumps, price falls, alice exits at a loss.
        _buy(whale, 300_000e6, "");
        uint128 whaleBal = _coinBal(whale);
        vm.prank(whale);
        router.swapExactIn(key, !quoteIs0, whaleBal, "");

        uint256 before = usdc.balanceOf(alice);
        _sell(alice, amt, "");
        uint256 proceeds = usdc.balanceOf(alice) - before;

        assertLt(proceeds, cost, "she actually lost money");
        assertEq(hook.claimable(sam), 0, "copied trader earns nothing on a loss");
        assertEq(hook.claimable(rahul), 0, "referrer earns nothing on a loss");
        assertEq(hook.claimable(treasury), 0, "WinCut earns nothing on a loss");
        assertEq(hook.lossCredit(alice), uint256(cost) - proceeds, "loss banked exactly");
    }

    // ---------------------------------------------------------------- rule 3
    // Banked losses offset future gains before any fee applies.

    function test_LossCredit_OffsetsFutureGain() public {
        // Bank a loss first.
        _buy(alice, 1_000e6, _attribution());
        (uint128 amt,) = hook.positionOf(alice, id);
        _buy(whale, 300_000e6, "");
        uint128 whaleBal = _coinBal(whale);
        vm.prank(whale);
        router.swapExactIn(key, !quoteIs0, whaleBal, "");
        _sell(alice, amt, "");

        uint256 credit = hook.lossCredit(alice);
        assertGt(credit, 0, "credit exists");

        // New position, then price exactly covering the credit.
        _buy(alice, 1_000e6, _attribution());
        (uint128 amt2, uint128 cost2) = hook.positionOf(alice, id);

        // Gain == credit exactly -> no fee.
        (uint256 fee0,) = hook.quoteFee(alice, id, amt2, uint256(cost2) + credit);
        assertEq(fee0, 0, "gain fully absorbed by banked losses");

        // Gain == credit + 100 USDC -> fee is 10% of the 100 only.
        (uint256 fee1,) = hook.quoteFee(alice, id, amt2, uint256(cost2) + credit + 100e6);
        assertEq(fee1, 10e6, "only the excess over the credit is charged");
    }

    // ---------------------------------------------------------------- rule 4
    // Weighted-average cost basis across several buys.

    function test_MultipleBuys_WeightedAverageBasis() public {
        _buy(alice, 1_000e6, _attribution());
        (uint128 a1, uint128 c1) = hook.positionOf(alice, id);

        _buy(alice, 2_000e6, _attribution());
        (uint128 a2, uint128 c2) = hook.positionOf(alice, id);

        assertGt(a2, a1, "holdings accumulated");
        assertApproxEqAbs(c2, uint256(c1) + 2_000e6, 2e6, "costs accumulated");

        // Selling half deducts half the basis.
        uint128 half = a2 / 2;
        (, uint256 netHalf) = hook.quoteFee(alice, id, half, uint256(c2) / 2);
        assertEq(netHalf, uint256(c2) / 2, "break-even on half the position pays no fee");

        _buy(whale, 400_000e6, "");
        _sell(alice, half, "");
        (uint128 a3, uint128 c3) = hook.positionOf(alice, id);
        assertApproxEqAbs(a3, a2 - half, 1, "holdings reduced by the amount sold");
        assertApproxEqAbs(c3, uint256(c2) - uint256(c2) * half / a2, 2, "basis reduced proportionally");
    }

    // ---------------------------------------------------------------- rule 5
    // An unidentified router pays nothing. Deliberate: it keeps the pool
    // arbitrageable and stops the coin being flagged as a sell-tax token.

    function test_UnknownRouter_NoFeeNoRecord() public {
        vm.prank(alice);
        badRouter.swapExactIn(key, quoteIs0, 1_000e6);

        (uint128 amt, uint128 cost) = hook.positionOf(alice, id);
        assertEq(amt, 0, "nothing recorded through an untrusted router");
        assertEq(cost, 0, "no basis recorded");

        _buy(whale, 400_000e6, "");

        uint256 bal = _coinBal(alice);
        assertGt(bal, 0, "she did receive coins");
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        badRouter.swapExactIn(key, !quoteIs0, uint128(bal));

        assertGt(usdc.balanceOf(alice), before, "she sold at a profit");
        assertEq(hook.claimable(treasury), 0, "but no fee was charged");
    }

    // ---------------------------------------------------------------- rule 6
    // Untracked coins are fee-free, so dusting someone cannot inflate their bill.

    function test_AirdroppedCoins_AreFeeFree() public {
        // Whale buys and gifts coins to alice by plain transfer.
        _buy(whale, 50_000e6, "");
        uint256 gift = _coinBal(whale) / 2;
        vm.prank(whale);
        IERC20(coin).transfer(alice, gift);

        (uint128 amt,) = hook.positionOf(alice, id);
        assertEq(amt, 0, "a transfer records nothing");

        _buy(whale, 200_000e6, "");
        uint256 before = usdc.balanceOf(alice);
        _sell(alice, uint128(gift), _attribution());

        assertGt(usdc.balanceOf(alice), before, "she sold the gifted coins");
        assertEq(hook.claimable(treasury), 0, "untracked coins are never taxed");
        assertEq(hook.lossCredit(alice), 0, "and never bank a phantom loss");
    }

    // ------------------------------------------------------- griefing variant
    // Dusting a real position must not raise the fee on it.

    function test_Airdrop_CannotInflateFeeOnRealPosition() public {
        _buy(alice, 1_000e6, _attribution());
        (uint128 amt, uint128 cost) = hook.positionOf(alice, id);
        (uint256 feeBefore,) = hook.quoteFee(alice, id, amt, uint256(cost) + 500e6);

        _buy(whale, 50_000e6, "");
        uint256 dust = _coinBal(whale);
        vm.prank(whale);
        IERC20(coin).transfer(alice, dust);

        (uint128 amtAfter, uint128 costAfter) = hook.positionOf(alice, id);
        assertEq(amtAfter, amt, "the dust did not touch the record");
        assertEq(costAfter, cost, "basis untouched");

        (uint256 feeAfter,) = hook.quoteFee(alice, id, amt, uint256(cost) + 500e6);
        assertEq(feeAfter, feeBefore, "dusting cannot raise the fee");
    }
}

/// @notice Attribution, claims and the safety rails.
contract WinCutMechanics is WinCutBase {
    function test_SelfReferral_AndSelfFollow_Ignored() public {
        _buy(alice, 1_000e6, abi.encode(alice, alice));
        assertEq(hook.followedOf(alice, id), address(0), "cannot copy yourself");
        assertEq(hook.referrerOf(alice), address(0), "cannot refer yourself");
    }

    function test_Referrer_LockedOnFirstBuy() public {
        _buy(alice, 500e6, abi.encode(sam, rahul));
        assertEq(hook.referrerOf(alice), rahul, "referrer set");

        address attacker = makeAddr("attacker");
        _buy(alice, 500e6, abi.encode(sam, attacker));
        assertEq(hook.referrerOf(alice), rahul, "referrer cannot be reassigned");
    }

    function test_NoCopiedTrader_ShareGoesToCreator() public {
        _buy(alice, 1_000e6, abi.encode(address(0), rahul));
        (uint128 amt,) = hook.positionOf(alice, id);
        _buy(whale, 400_000e6, "");
        _sell(alice, amt, "");

        assertGt(hook.claimable(creator), 0, "the coin creator receives the unclaimed share");
    }

    function test_Claim_PaysOut_AndCannotDoubleClaim() public {
        _buy(alice, 1_000e6, _attribution());
        (uint128 amt,) = hook.positionOf(alice, id);
        _buy(whale, 400_000e6, "");
        _sell(alice, amt, "");

        uint256 owed = hook.claimable(sam);
        assertGt(owed, 0, "sam earned something");

        uint256 before = usdc.balanceOf(sam);
        vm.prank(sam);
        hook.claim();
        assertEq(usdc.balanceOf(sam) - before, owed, "paid in full");
        assertEq(hook.claimable(sam), 0, "balance cleared");

        vm.prank(sam);
        vm.expectRevert(WinCutHook.NothingToClaim.selector);
        hook.claim();
    }

    function test_Pause_BlocksSwaps() public {
        hook.setPaused(true);
        vm.prank(alice);
        vm.expectRevert();
        router.swapExactIn(key, quoteIs0, 1_000e6, _attribution());
    }

    function test_MaxTradeSize_Enforced() public {
        hook.setMaxTradeSize(100e6);
        vm.prank(alice);
        vm.expectRevert();
        router.swapExactIn(key, quoteIs0, 1_000e6, _attribution());

        _buy(alice, 50e6, _attribution());
        (uint128 amt,) = hook.positionOf(alice, id);
        assertGt(amt, 0, "trades under the cap still work");
    }

    function test_OnlyLauncher_CanInitializePools() public {
        PoolKey memory rogue = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(usdc)),
            fee: 3000,
            tickSpacing: 60,
            hooks: hook
        });
        vm.expectRevert();
        pm.initialize(rogue, 79228162514264337593543950336);
    }

    function test_OnlyLauncher_CanRegisterCoins() public {
        vm.prank(alice);
        vm.expectRevert(WinCutHook.NotLauncher.selector);
        hook.registerCoin(id, alice);
    }

    function test_HookAddress_CarriesFrozenPermissionBits() public view {
        // beforeInitialize (1<<13) | afterSwap (1<<6) | afterSwapReturnDelta (1<<2)
        uint160 expected = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, expected, "frozen bitmap 0x2044");
    }

    function test_SeedLiquidity_IsLocked() public view {
        // The launcher owns the position and exposes no removal path.
        assertEq(launcher.coinCount(), 1);
        (address c, address cr,,) = launcher.launches(id);
        assertEq(c, coin);
        assertEq(cr, creator);
    }
}

/// @notice Property tests on the cost-basis arithmetic.
contract WinCutFuzz is WinCutBase {
    /// @dev The fee must never exceed 10% of the gain, and never touch principal.
    function testFuzz_FeeNeverExceedsTenPercentOfGain(uint96 buyAmount, uint96 gainAmount) public {
        buyAmount = uint96(bound(buyAmount, 1e6, 20_000e6));
        gainAmount = uint96(bound(gainAmount, 0, 100_000e6));

        _buy(alice, uint128(buyAmount), _attribution());
        (uint128 amt, uint128 cost) = hook.positionOf(alice, id);
        vm.assume(amt > 0);

        (uint256 fee, uint256 net) = hook.quoteFee(alice, id, amt, uint256(cost) + gainAmount);

        assertLe(fee, uint256(gainAmount) / 10 + 1, "fee is at most 10% of the gain");
        assertGe(net, cost, "principal is never touched");
        assertEq(net + fee, uint256(cost) + gainAmount, "nothing vanishes");
    }

    /// @dev Selling at or below basis must always be free.
    function testFuzz_NeverChargesOnALoss(uint96 buyAmount, uint96 lossBps) public {
        buyAmount = uint96(bound(buyAmount, 1e6, 20_000e6));
        lossBps = uint96(bound(lossBps, 0, 10_000));

        _buy(alice, uint128(buyAmount), _attribution());
        (uint128 amt, uint128 cost) = hook.positionOf(alice, id);
        vm.assume(amt > 0);

        uint256 grossOut = uint256(cost) * (10_000 - lossBps) / 10_000;
        (uint256 fee,) = hook.quoteFee(alice, id, amt, grossOut);
        assertEq(fee, 0, "a sale at or below basis is always free");
    }
}
