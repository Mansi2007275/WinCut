// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2Approve {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice Shared encoder for Universal Router V4_SWAP calls.
/// @dev    Scripts, tests and the indexer all need the identical encoding.
///         Keeping it in one place is the same discipline as keeping the fee
///         formula only in hook.quoteFee(): two copies drift, and the drift
///         shows up as a revert at the worst possible moment.
library UniversalRouterLib {
    uint8 internal constant CMD_V4_SWAP = 0x10;

    /// @notice Builds the calldata for one exact-input single-hop v4 swap.
    /// @return commands the Universal Router command byte string
    /// @return inputs   the matching inputs array
    /// @return value    the native value to send (non-zero when paying in native USDC)
    function encodeExactInSingle(
        PoolKey memory key,
        bool zeroForOne,
        uint128 amountIn,
        uint128 amountOutMinimum,
        bytes memory hookData
    ) internal pure returns (bytes memory commands, bytes[] memory inputs, uint256 value) {
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
                amountOutMinimum: amountOutMinimum,
                minHopPriceX36: 0,
                hookData: hookData
            })
        );
        params[1] = abi.encode(cIn, amountIn);
        params[2] = abi.encode(cOut, amountOutMinimum);

        inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        commands = abi.encodePacked(CMD_V4_SWAP);
        value = cIn.isAddressZero() ? amountIn : 0;
    }
}
