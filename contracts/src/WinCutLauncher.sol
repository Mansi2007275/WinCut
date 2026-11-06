// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {WinCutCoin} from "./WinCutCoin.sol";
import {WinCutHook} from "./WinCutHook.sol";

/// @title  WinCutLauncher
/// @notice Creates a memecoin and its WinCutHook pool in one transaction.
/// @dev    The initial LP position is owned by THIS contract, which has no
///         liquidity-removal function. The seed liquidity is therefore locked
///         forever and the creator cannot rug it.
contract WinCutLauncher is IUnlockCallback {
    using CurrencyLibrary for Currency;

    IPoolManager public immutable poolManager;
    WinCutHook public immutable hook;
    Currency public immutable QUOTE;

    uint24 public constant POOL_FEE = 3000;
    int24 public constant TICK_SPACING = 60;

    struct Launch {
        address coin;
        address creator;
        uint256 seededQuote;
        uint256 seededCoin;
    }

    mapping(PoolId => Launch) public launches;
    address[] public allCoins;

    struct CallbackData {
        PoolKey key;
        uint256 amount0;
        uint256 amount1;
        uint160 sqrtPriceX96;
    }

    event CoinLaunched(
        address indexed coin,
        address indexed creator,
        PoolId indexed id,
        string name,
        string symbol,
        string metadataURI,
        uint256 seededQuote,
        uint256 seededCoin,
        uint160 sqrtPriceX96
    );

    error OnlyPoolManager();
    error ZeroAmount();
    error WrongMsgValue();

    constructor(IPoolManager _pm, WinCutHook _hook) {
        poolManager = _pm;
        hook = _hook;
        QUOTE = _hook.QUOTE();
    }

    function coinCount() external view returns (uint256) {
        return allCoins.length;
    }

    /// @notice Rebuilds the canonical PoolKey for a launched coin.
    /// @dev    The frontend and indexer both need this; deriving it in two places
    ///         risks a mismatched PoolId, so it lives here once.
    function poolKeyFor(address coinAddr) public view returns (PoolKey memory key) {
        bool quoteIs0 = Currency.unwrap(QUOTE) < coinAddr;
        key = PoolKey({
            currency0: quoteIs0 ? QUOTE : Currency.wrap(coinAddr),
            currency1: quoteIs0 ? Currency.wrap(coinAddr) : QUOTE,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    function poolIdFor(address coinAddr) external view returns (PoolId) {
        return poolKeyFor(coinAddr).toId();
    }

    /// @notice Deploy a coin, open its QUOTE pool on WinCutHook, and seed full-range liquidity.
    /// @param  initialQuote QUOTE to seed. Send as msg.value when QUOTE is native.
    /// @param  initialSupply total coin supply, all of it seeded into the pool.
    function launchCoin(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 initialQuote,
        uint256 initialSupply
    ) external payable returns (address coinAddr, PoolId id) {
        if (initialQuote == 0 || initialSupply == 0) revert ZeroAmount();
        _collectQuote(initialQuote);

        coinAddr = address(new WinCutCoin(name, symbol, metadataURI, initialSupply, msg.sender));

        uint160 sqrtPriceX96;
        (id, sqrtPriceX96) = _openPool(coinAddr, initialQuote, initialSupply);

        launches[id] = Launch(coinAddr, msg.sender, initialQuote, initialSupply);
        allCoins.push(coinAddr);

        emit CoinLaunched(
            coinAddr, msg.sender, id, name, symbol, metadataURI, initialQuote, initialSupply, sqrtPriceX96
        );
    }

    function _collectQuote(uint256 amount) internal {
        if (QUOTE.isAddressZero()) {
            if (msg.value != amount) revert WrongMsgValue();
        } else {
            if (msg.value != 0) revert WrongMsgValue();
            IERC20(Currency.unwrap(QUOTE)).transferFrom(msg.sender, address(this), amount);
        }
    }

    /// @dev Builds the PoolKey, initializes the pool and seeds locked liquidity.
    function _openPool(address coinAddr, uint256 initialQuote, uint256 initialSupply)
        internal
        returns (PoolId id, uint160 sqrtPriceX96)
    {
        // v4 requires currency0 < currency1.
        bool quoteIs0 = Currency.unwrap(QUOTE) < coinAddr;
        PoolKey memory key = PoolKey({
            currency0: quoteIs0 ? QUOTE : Currency.wrap(coinAddr),
            currency1: quoteIs0 ? Currency.wrap(coinAddr) : QUOTE,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        uint256 amount0 = quoteIs0 ? initialQuote : initialSupply;
        uint256 amount1 = quoteIs0 ? initialSupply : initialQuote;

        // sqrtPriceX96 = sqrt(amount1 / amount0) * 2^96, via mulDiv to avoid overflow.
        sqrtPriceX96 = uint160(Math.sqrt(FullMath.mulDiv(amount1, 1 << 192, amount0)));

        id = key.toId();
        poolManager.initialize(key, sqrtPriceX96);
        hook.registerCoin(id, msg.sender);
        poolManager.unlock(abi.encode(CallbackData(key, amount0, amount1, sqrtPriceX96)));
    }

    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        CallbackData memory d = abi.decode(rawData, (CallbackData));

        int24 lower = TickMath.minUsableTick(TICK_SPACING);
        int24 upper = TickMath.maxUsableTick(TICK_SPACING);

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            d.sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(lower),
            TickMath.getSqrtPriceAtTick(upper),
            d.amount0,
            d.amount1
        );

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            d.key,
            ModifyLiquidityParams({
                tickLower: lower,
                tickUpper: upper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        if (delta.amount0() < 0) _settle(d.key.currency0, uint256(uint128(-delta.amount0())));
        if (delta.amount1() < 0) _settle(d.key.currency1, uint256(uint128(-delta.amount1())));

        return "";
    }

    function _settle(Currency currency, uint256 amount) internal {
        if (currency.isAddressZero()) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).transfer(address(poolManager), amount);
            poolManager.settle();
        }
    }

    receive() external payable {}
}
