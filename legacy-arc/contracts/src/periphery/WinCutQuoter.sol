// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {WinCutHook} from "../WinCutHook.sol";

/// @title  WinCutQuoter
/// @notice One eth_call that returns everything needed to build a sell: the
///         gross output, the WinCut fee, and the net the trader receives.
///
/// @dev    WHY NOT v4-periphery's V4Quoter?
///         V4Quoter determines whether a pool exists by reading PoolManager
///         storage through extsload. Compiled against v4-core HEAD it reports
///         PoolNotInitialized() for pools that demonstrably work on Arc, whose
///         PoolManager was deployed earlier - a storage-layout version mismatch.
///
///         This quoter reads NO PoolManager storage. It simulates the swap
///         inside an unlock and reverts with the resulting delta, so it is
///         immune to layout drift between v4-core versions. It is the same
///         revert-to-return trick V4Quoter uses, minus the fragile precondition.
///
///         The fee itself is NEVER recomputed here. It comes from
///         hook.quoteFee(), the single on-chain source of truth. Duplicating
///         that formula off-chain is what makes profitable sells revert, since
///         Universal Router validates amountOutMinimum against the POST-hook
///         amount.
///
///         A neat consequence of the hook's design: this quoter is not a
///         trusted router, so during the simulation the hook charges nothing
///         and records nothing. The simulated figure is therefore a clean
///         GROSS amount, and the fee layers on top deterministically.
contract WinCutQuoter is IUnlockCallback {
    IPoolManager public immutable poolManager;
    WinCutHook public immutable hook;

    /// @dev The carrier for a successful simulation. Not a failure.
    error QuoteResult(int256 amount0, int256 amount1);
    error UnexpectedQuoteSuccess();
    error OnlyPoolManager();

    struct SimParams {
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
    }

    constructor(IPoolManager _pm, WinCutHook _hook) {
        poolManager = _pm;
        hook = _hook;
    }

    // ------------------------------------------------------------------ views

    /// @notice Quote a BUY: quote currency in, coins out. Buys are never charged.
    /// @dev    Not view, because it unlocks the PoolManager. Use eth_call.
    function quoteBuy(PoolKey calldata key, bool zeroForOne, uint128 amountIn)
        external
        returns (uint256 coinsOut)
    {
        (, uint256 out) = _simulate(key, zeroForOne, amountIn);
        return out;
    }

    /// @notice Quote a SELL for a specific trader, including their WinCut fee.
    /// @return grossOut   what the pool pays before the hook takes anything
    /// @return fee        10% of realised profit, after loss credits
    /// @return netOut     what the trader actually receives. DERIVE minOut FROM THIS.
    /// @return lossCredit the trader's remaining banked losses, for the UI
    /// @return volumeFeeComparison what a conventional 0.5%-of-volume app would charge
    function quoteSell(address trader, PoolKey calldata key, bool zeroForOne, uint128 coinIn)
        external
        returns (
            uint256 grossOut,
            uint256 fee,
            uint256 netOut,
            uint256 lossCredit,
            uint256 volumeFeeComparison
        )
    {
        (, grossOut) = _simulate(key, zeroForOne, coinIn);

        (fee, netOut) = hook.quoteFee(trader, key.toId(), coinIn, grossOut);
        // quoteFee returns (0, grossOut) when there is no recorded position.
        if (fee == 0) netOut = grossOut;

        lossCredit = hook.lossCredit(trader);
        volumeFeeComparison = (grossOut * 50) / 10_000; // 0.5% of volume
    }

    // -------------------------------------------------------------- internals

    function _simulate(PoolKey calldata key, bool zeroForOne, uint128 amountIn)
        internal
        returns (uint256 spent, uint256 received)
    {
        try poolManager.unlock(abi.encode(SimParams(key, zeroForOne, amountIn))) {
            revert UnexpectedQuoteSuccess();
        } catch (bytes memory reason) {
            return _decode(reason, zeroForOne);
        }
    }

    function _decode(bytes memory reason, bool zeroForOne)
        internal
        pure
        returns (uint256 spent, uint256 received)
    {
        // QuoteResult(int256,int256) => 4 byte selector + 2 words
        if (reason.length < 68) {
            // Propagate a genuine failure (no liquidity, bad pool, hook revert).
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }

        int256 a0;
        int256 a1;
        assembly {
            a0 := mload(add(reason, 36))
            a1 := mload(add(reason, 68))
        }

        // Negative = the swapper owes the pool (input), positive = owed to them.
        int256 inDelta = zeroForOne ? a0 : a1;
        int256 outDelta = zeroForOne ? a1 : a0;

        spent = inDelta < 0 ? uint256(-inDelta) : 0;
        received = outDelta > 0 ? uint256(outDelta) : 0;
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        SimParams memory p = abi.decode(raw, (SimParams));

        BalanceDelta d = poolManager.swap(
            p.key,
            SwapParams({
                zeroForOne: p.zeroForOne,
                amountSpecified: -int256(uint256(p.amountIn)), // exactInput
                sqrtPriceLimitX96: p.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // Revert to return. Nothing settles, so no state survives this call.
        revert QuoteResult(int256(d.amount0()), int256(d.amount1()));
    }
}
