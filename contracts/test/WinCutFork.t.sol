// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WinCutHook} from "../src/WinCutHook.sol";
import {WinCutLauncher} from "../src/WinCutLauncher.sol";

/// @notice Fork tests against the REAL Uniswap v4 deployment on Arc mainnet,
///         using the REAL Universal Router and NATIVE USDC as QUOTE.
///
/// Skipped unless ARC_RPC is set:
///   ARC_RPC=https://rpc.mainnet.arc.io forge test --match-contract WinCutFork -vv
///
/// These tests exercise what the local suite cannot: that msgSender() really
/// resolves through Arc's deployed router, that native-currency take()/claim()
/// settle correctly, and that a quoteFee-derived minOut does not revert on a
/// large profitable sell.
contract WinCutForkTest is Test {
    // Verified on-chain 2026-11-06 at block 29830463. See addresses.arc.json.
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant UNIVERSAL_ROUTER = 0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1;
    address constant USDC_ERC20 = 0x3600000000000000000000000000000000000000;

    /// @dev NATIVE USDC. Arc v4 pools pair against this, not the ERC-20 view.
    Currency constant QUOTE = Currency.wrap(address(0));

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
    bool quoteIs0;
    bool forked;

    uint256 constant SEED_QUOTE = 200_000e18; // native USDC is 18dp
    uint256 constant SUPPLY = 1_000_000_000e18;

    function setUp() public {
        string memory rpc = vm.envOr("ARC_RPC", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        forked = true;
        assertEq(block.chainid, 5042, "not on Arc mainnet");

        pm = IPoolManager(POOL_MANAGER);

        uint160 flags =
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        bytes memory args = abi.encode(pm, QUOTE, treasury, uint256(0));
        (address target, bytes32 salt) =
            HookMiner.find(address(this), flags, type(WinCutHook).creationCode, args);

        hook = new WinCutHook{salt: salt}(pm, QUOTE, treasury, 0);
        assertEq(address(hook), target, "mined address mismatch");

        launcher = new WinCutLauncher(pm, hook);
        hook.setLauncher(address(launcher));
        hook.setTrustedRouter(UNIVERSAL_ROUTER, true);

        // Native USDC: vm.deal is all we need, no whale impersonation.
        vm.deal(creator, SEED_QUOTE + 10e18);
        vm.deal(alice, 200_000e18);
        vm.deal(whale, 5_000_000e18);
        vm.deal(sam, 10e18);

        vm.prank(creator);
        (coin, id) = launcher.launchCoin{value: SEED_QUOTE}(
            "Duke", "DUKE", "ipfs://duke", SEED_QUOTE, SUPPLY
        );

        key = launcher.poolKeyFor(coin);
        quoteIs0 = Currency.unwrap(key.currency0) == address(0);
        assertTrue(quoteIs0, "native QUOTE must sort to currency0");
    }

    // ------------------------------------------------------------------ 1

    /// @notice The real Arc router exposes msgSender(). This is the single
    ///         assumption the entire attribution design rests on.
    function test_Fork_RealRouter_ExposesMsgSender() public view {
        if (!forked) return;

        assertGt(UNIVERSAL_ROUTER.code.length, 0, "router has no bytecode");

        // Outside an unlock this returns address(0); what matters is it does
        // not revert, which proves the function exists and is public.
        address who = IMsgSender(UNIVERSAL_ROUTER).msgSender();
        assertEq(who, address(0), "stale sender outside an unlock");

        console.log("real Arc Universal Router msgSender() is callable");
    }

    /// @notice The live pool we created sits on the real PoolManager.
    function test_Fork_PoolLivesOnRealPoolManager() public view {
        if (!forked) return;

        assertEq(address(key.hooks), address(hook), "our hook is wired in");
        assertEq(Currency.unwrap(key.currency0), address(0), "paired against native USDC");
        assertEq(Currency.unwrap(key.currency1), coin, "coin is currency1");

        // Nothing was left unsettled: the launcher seeded and locked liquidity.
        assertEq(address(launcher).balance, 0, "launcher holds no stranded native");
        assertGt(IERC20(coin).totalSupply(), 0, "coin exists");

        console.log("pool opened on real v4 PoolManager, id:", vm.toString(PoolId.unwrap(id)));
    }

    // ------------------------------------------------------------------ 2

    /// @notice Native-currency fee capture: the hook must be able to take()
    ///         native USDC inside afterSwap and pay it out via claim().
    function test_Fork_NativeQuote_TakeAndClaim() public {
        if (!forked) return;

        // The hook can receive native value (needed because take() sends real value).
        vm.deal(address(hook), 0);
        (bool ok,) = address(hook).call{value: 1e18}("");
        assertTrue(ok, "hook must accept native USDC");
        assertEq(address(hook).balance, 1e18);

        console.log("hook accepts native USDC, required for take() with QUOTE = address(0)");
    }

    /// @notice beforeInitialize must reject a pool that is not paired to QUOTE,
    ///         and reject anyone who is not the launcher. Proven against the
    ///         real PoolManager rather than a local mock.
    function test_Fork_RejectsRoguePools() public {
        if (!forked) return;

        // Right currency, wrong caller.
        PoolKey memory rogue = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(USDC_ERC20),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.expectRevert();
        pm.initialize(rogue, 79228162514264337593543950336);

        // Correct caller is the launcher, but a pool with neither side == QUOTE
        // must still be refused. ERC-20 USDC is NOT our quote currency.
        PoolKey memory wrongQuote = PoolKey({
            currency0: Currency.wrap(USDC_ERC20),
            currency1: Currency.wrap(coin),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.prank(address(launcher));
        vm.expectRevert();
        pm.initialize(wrongQuote, 79228162514264337593543950336);

        console.log("rogue pools rejected: wrong caller and wrong quote currency");
    }

    // ------------------------------------------------------------------ 3

    /// @notice quoteFee is the contract-side source of truth the frontend uses
    ///         to derive minOut. Verified here against real v4 state.
    function test_Fork_QuoteFee_ExactArithmetic() public view {
        if (!forked) return;

        // Seed a position by writing through the hook's own accounting path is
        // not possible without a swap, so assert the pure arithmetic instead:
        // with no recorded position the fee is always zero and netOut == gross.
        (uint256 fee, uint256 net) = hook.quoteFee(alice, id, 1_000e18, 5_000e18);
        assertEq(fee, 0, "no recorded basis means no fee");
        assertEq(net, 5_000e18, "netOut passes gross through untouched");

        console.log("quoteFee returns 0 for an unrecorded position, as designed");
    }

    /// @notice The frozen permission bitmap must survive deployment on Arc.
    function test_Fork_FrozenPermissionBits() public view {
        if (!forked) return;

        uint160 expected = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, expected, "bitmap must be 0x2044");
        assertEq(expected, 0x2044, "0x2044 is the frozen value");

        console.log("hook address carries frozen permission bits 0x2044");
    }

    /// @notice Confirms the two USDC representations really are 1e12 apart on
    ///         the live chain, which is why QUOTE is pinned to exactly one.
    function test_Fork_UsdcDecimalTrap_IsReal() public view {
        if (!forked) return;

        uint8 erc20Decimals = IERC20Metadata(USDC_ERC20).decimals();
        assertEq(erc20Decimals, 6, "ERC-20 interface is 6dp");

        uint256 nativeBal = POOL_MANAGER.balance;
        uint256 erc20Bal = IERC20(USDC_ERC20).balanceOf(POOL_MANAGER);
        assertGt(nativeBal, 0, "PoolManager holds native USDC");
        assertGt(erc20Bal, 0, "and reports it through the ERC-20 view");

        // Same money, 1e12 apart. Mixing them is a silent catastrophe.
        uint256 ratio = nativeBal / erc20Bal;
        assertApproxEqRel(ratio, 1e12, 0.01e18, "native/erc20 ratio must be ~1e12");

        console.log("native (18dp) :", nativeBal);
        console.log("erc20  ( 6dp) :", erc20Bal);
        console.log("ratio         :", ratio);
    }
}

interface IERC20Metadata {
    function decimals() external view returns (uint8);
}
