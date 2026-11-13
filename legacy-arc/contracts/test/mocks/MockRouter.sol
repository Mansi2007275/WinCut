// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal stand-in for Universal Router. It reproduces the only two
///         behaviours WinCutHook depends on:
///         1. it exposes msgSender() so the hook can identify the real trader;
///         2. it performs exactInput swaps and settles the NET delta, which is
///            what makes the hook fee visible to slippage checks.
contract MockRouter is IMsgSender, IUnlockCallback {
    IPoolManager public immutable poolManager;
    address private _current;

    struct Data {
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        bytes hookData;
        address user;
    }

    error OnlyPoolManager();

    constructor(IPoolManager _pm) {
        poolManager = _pm;
    }

    /// @dev Mirrors UniversalRouter: the original caller is readable for the
    ///      duration of the unlock, then cleared.
    function msgSender() external view returns (address) {
        return _current;
    }

    function swapExactIn(PoolKey memory key, bool zeroForOne, uint128 amountIn, bytes memory hookData)
        external
        returns (BalanceDelta delta)
    {
        _current = msg.sender;
        bytes memory res = poolManager.unlock(abi.encode(Data(key, zeroForOne, amountIn, hookData, msg.sender)));
        _current = address(0);
        delta = abi.decode(res, (BalanceDelta));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        Data memory d = abi.decode(raw, (Data));

        BalanceDelta delta = poolManager.swap(
            d.key,
            SwapParams({
                zeroForOne: d.zeroForOne,
                amountSpecified: -int256(uint256(d.amountIn)), // negative == exactInput
                sqrtPriceLimitX96: d.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            d.hookData
        );

        Currency cIn = d.zeroForOne ? d.key.currency0 : d.key.currency1;
        Currency cOut = d.zeroForOne ? d.key.currency1 : d.key.currency0;
        int128 dIn = d.zeroForOne ? delta.amount0() : delta.amount1();
        int128 dOut = d.zeroForOne ? delta.amount1() : delta.amount0();

        if (dIn < 0) {
            uint256 owed = uint256(uint128(-dIn));
            poolManager.sync(cIn);
            IERC20(Currency.unwrap(cIn)).transferFrom(d.user, address(poolManager), owed);
            poolManager.settle();
        }
        // dOut is already NET of the hook fee, because v4 applies
        // swapDelta = swapDelta - hookDelta before returning.
        if (dOut > 0) {
            poolManager.take(cOut, d.user, uint256(uint128(dOut)));
        }

        return abi.encode(delta);
    }
}

/// @notice A router that does NOT implement msgSender(). Used to prove the hook
///         charges nothing rather than taxing the full sale.
contract UnknownRouter is IUnlockCallback {
    IPoolManager public immutable poolManager;

    struct Data {
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        address user;
    }

    constructor(IPoolManager _pm) {
        poolManager = _pm;
    }

    function swapExactIn(PoolKey memory key, bool zeroForOne, uint128 amountIn)
        external
        returns (BalanceDelta delta)
    {
        bytes memory res = poolManager.unlock(abi.encode(Data(key, zeroForOne, amountIn, msg.sender)));
        delta = abi.decode(res, (BalanceDelta));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        Data memory d = abi.decode(raw, (Data));
        BalanceDelta delta = poolManager.swap(
            d.key,
            SwapParams({
                zeroForOne: d.zeroForOne,
                amountSpecified: -int256(uint256(d.amountIn)),
                sqrtPriceLimitX96: d.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        Currency cIn = d.zeroForOne ? d.key.currency0 : d.key.currency1;
        Currency cOut = d.zeroForOne ? d.key.currency1 : d.key.currency0;
        int128 dIn = d.zeroForOne ? delta.amount0() : delta.amount1();
        int128 dOut = d.zeroForOne ? delta.amount1() : delta.amount0();

        if (dIn < 0) {
            poolManager.sync(cIn);
            IERC20(Currency.unwrap(cIn)).transferFrom(d.user, address(poolManager), uint256(uint128(-dIn)));
            poolManager.settle();
        }
        if (dOut > 0) poolManager.take(cOut, d.user, uint256(uint128(dOut)));
        return abi.encode(delta);
    }
}
